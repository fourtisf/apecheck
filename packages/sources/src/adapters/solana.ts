/**
 * Solana JSON-RPC (read-only): mint authorities, largest holders, transaction simulation.
 * RPC: RPC_SOLANA, else Helius with HELIUS_API_KEY, else the public mainnet-beta endpoint (rate limited).
 */
import { z } from 'zod';
import type { Env } from '@apecheck/core';
import { warnOnce } from '@apecheck/core/node';
import type { Http, SimResult, SolMintInfo, SolanaWalletSource } from '../types';
import { jsonRpc } from '../rpc';
import { ErrorState, RE_SOL_ADDRESS, errMsg, reportError, toUnits } from '../util';

const TIMEOUT_MS = 8_000;
/**
 * A busy node's quick refusal ("account index service overloaded, please try again", a 429, a 5xx): the next request
 * usually goes through. Timeouts are not retried (the check's budget is spent already).
 */
export const SOLANA_BUSY = /overloaded|try again|too many requests|rate limit|HTTP (429|50[0234])\b/i;
const BUSY_PAUSE_MS = 400;
/**
 * Reported (not as a "solana." error, so the RPC isn't called down) when the public node answered for a busy one:
 * the check log and the doctor show that the configured RPC keeps refusing.
 */
export const SOLANA_PUBLIC_FALLBACK = 'fallback.solana.largestHolders';

export const SPL_TOKEN_PROGRAM = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
export const TOKEN_2022_PROGRAM = 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb';
export const PUBLIC_SOLANA_RPC = 'https://api.mainnet-beta.solana.com';

/** The only methods this adapter may send. No sendTransaction, ever. */
export const SOL_READ_METHODS: ReadonlySet<string> = new Set([
  'getAccountInfo', 'getMultipleAccounts', 'getTokenLargestAccounts', 'getTokenSupply', 'simulateTransaction', 'getTokenAccountsByOwner',
]);

const AccountZ = z.object({ value: z.object({ owner: z.string(), data: z.unknown() }).nullable() });
const ParsedMintZ = z.object({
  parsed: z.object({
    type: z.literal('mint'),
    info: z.object({
      decimals: z.number().int().nullish(),
      supply: z.string().nullish(),
      mintAuthority: z.string().nullish(),
      freezeAuthority: z.string().nullish(),
      /** Token-2022: [{ extension, state }] (read leniently by mintExtensions: an unknown shape never hides the mint) */
      extensions: z.unknown().optional(),
    }),
  }),
});

/**
 * The Token-2022 extension settings that change only when an authority acts: who can tax, hook, move, pause or freeze
 * holders' tokens. Counters that move on their own (withheld fees, the older fee, timestamps) are left out. An
 * extension not listed here counts by its presence (extensions are fixed when the mint is created).
 */
const EXTENSION_FIELDS: Record<string, string[]> = {
  transferFeeConfig: ['transferFeeConfigAuthority', 'withdrawWithheldAuthority', 'newerTransferFee.transferFeeBasisPoints', 'newerTransferFee.maximumFee'],
  transferHook: ['authority', 'programId'],
  permanentDelegate: ['delegate'],
  pausableConfig: ['authority', 'paused'],
  mintCloseAuthority: ['closeAuthority'],
  defaultAccountState: ['accountState'],
  interestBearingConfig: ['rateAuthority', 'currentRate'],
  scaledUiAmountConfig: ['authority', 'multiplier', 'newMultiplier'],
  confidentialTransferMint: ['authority', 'autoApproveNewAccounts'],
  metadataPointer: ['authority', 'metadataAddress'],
  tokenMetadata: ['updateAuthority'],
};

/** jsonParsed `info.extensions` of a Token-2022 mint → sorted "<extension> <field>=<value> …" (see SolMintInfo.extensions) */
export function mintExtensions(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const show = (v: unknown) => (v == null ? 'none' : typeof v === 'object' ? JSON.stringify(v) : String(v));
  const out: string[] = [];
  for (const e of raw) {
    const name = (e as { extension?: unknown } | null)?.extension;
    if (typeof name !== 'string' || !name) continue;
    const state = (e as { state?: unknown }).state;
    const fields = EXTENSION_FIELDS[name] ?? [];
    const values = fields.map(f => {
      let v: unknown = state;
      for (const k of f.split('.')) v = v && typeof v === 'object' ? (v as Record<string, unknown>)[k] : undefined;
      return `${f}=${show(v)}`;
    });
    out.push([name, ...values].join(' '));
  }
  return out.sort();
}
const LargestZ = z.object({
  value: z.array(z.object({ address: z.string(), amount: z.string() })),
});
const SupplyZ = z.object({ value: z.object({ amount: z.string() }) });
const MultipleZ = z.object({ value: z.array(z.object({ data: z.unknown() }).nullable()) });
const ParsedTokenAccountZ = z.object({ parsed: z.object({ info: z.object({ owner: z.string() }) }) });
/** getTokenAccountsByOwner (jsonParsed): the token accounts of one owner for one mint */
const OwnerAccountsZ = z.object({
  value: z.array(
    z.object({
      pubkey: z.string(),
      account: z.object({
        owner: z.string(),
        data: z.unknown(),
      }),
    }),
  ),
});
const ParsedHoldingZ = z.object({
  parsed: z.object({
    info: z.object({
      mint: z.string(),
      tokenAmount: z.object({
        amount: z.string().regex(/^\d+$/),
        decimals: z.number().int().min(0).max(255),
        uiAmountString: z.string().nullish(),
      }),
    }),
  }),
});

const SimZ = z.object({
  value: z.object({
    err: z.unknown().nullable(),
    logs: z.array(z.string()).nullish(),
    unitsConsumed: z.number().nullish(),
  }),
});

export function solanaRpcUrl(env: Pick<Env, 'RPC_SOLANA' | 'HELIUS_API_KEY'>): string {
  if (env.RPC_SOLANA) return env.RPC_SOLANA;
  if (env.HELIUS_API_KEY) return `https://mainnet.helius-rpc.com/?api-key=${encodeURIComponent(env.HELIUS_API_KEY)}`;
  return PUBLIC_SOLANA_RPC;
}

/** InstructionError etc. → one readable line, preferring the program's own error log line. */
export function describeSolanaError(err: unknown, logs: string[]): string {
  const logLine = [...logs].reverse().find(l => /Error (Message|Code)?:|failed:/i.test(l));
  let base: string;
  if (typeof err === 'string') base = err;
  else if (err && typeof err === 'object' && 'InstructionError' in err) {
    const [idx, detail] = (err as { InstructionError: [number, unknown] }).InstructionError;
    base = `instruction ${idx} failed: ${typeof detail === 'string' ? detail : JSON.stringify(detail)}`;
  } else base = JSON.stringify(err);
  return logLine ? `${base} (${logLine.replace(/^Program log:\s*/, '').slice(0, 200)})` : base;
}

export class SolanaAdapter implements SolanaWalletSource {
  readonly configured = true;
  private readonly errors = new ErrorState('solana');
  private readonly url: string;

  constructor(env: Pick<Env, 'RPC_SOLANA' | 'HELIUS_API_KEY'>, private readonly http: Http) {
    this.url = solanaRpcUrl(env);
    if (this.url === PUBLIC_SOLANA_RPC) {
      warnOnce('solana-public', 'Solana RPC not configured (RPC_SOLANA and HELIUS_API_KEY empty): using the public mainnet-beta RPC, which is heavily rate limited');
    }
  }

  get lastError() {
    return this.errors.lastError;
  }

  private rpc(method: string, params: unknown[], url = this.url): Promise<unknown> {
    return jsonRpc(this.http, url, method, params, SOL_READ_METHODS, { timeoutMs: TIMEOUT_MS });
  }

  /**
   * getTokenLargestAccounts leans on the node's token index, which a busy provider refuses at times: one more try
   * after a short pause, then the public mainnet-beta node (it serves the call for a coin's size of holder list).
   */
  private async largestAccounts(mint: string): Promise<unknown> {
    const params = [mint, { commitment: 'confirmed' }];
    try {
      return await this.rpc('getTokenLargestAccounts', params);
    } catch (e) {
      if (!SOLANA_BUSY.test(errMsg(e))) throw e;
    }
    await new Promise(r => setTimeout(r, BUSY_PAUSE_MS));
    let busy: string;
    try {
      return await this.rpc('getTokenLargestAccounts', params);
    } catch (e) {
      busy = errMsg(e);
      if (this.url === PUBLIC_SOLANA_RPC || !SOLANA_BUSY.test(busy)) throw e;
    }
    const host = new URL(this.url).host;
    try {
      const out = await this.rpc('getTokenLargestAccounts', params, PUBLIC_SOLANA_RPC);
      reportError(`${SOLANA_PUBLIC_FALLBACK}: ${host} refused as busy (${busy}), the public node answered`);
      return out;
    } catch (e) {
      throw new Error(`${host} refused as busy (${busy}); public node: ${errMsg(e)}`);
    }
  }

  async mintInfo(mint: string): Promise<SolMintInfo | null> {
    if (!RE_SOL_ADDRESS.test(mint)) return null;
    try {
      const v = AccountZ.parse(await this.rpc('getAccountInfo', [mint, { encoding: 'jsonParsed', commitment: 'confirmed' }])).value;
      const notMint: SolMintInfo = { exists: false, decimals: null, supply: null, mintAuthority: null, freezeAuthority: null, token2022: false };
      if (!v || (v.owner !== SPL_TOKEN_PROGRAM && v.owner !== TOKEN_2022_PROGRAM)) return notMint;
      const parsed = ParsedMintZ.safeParse(v.data);
      if (!parsed.success) return notMint;
      const info = parsed.data.parsed.info;
      return {
        exists: true,
        decimals: info.decimals ?? null,
        supply: info.supply ?? null,
        mintAuthority: info.mintAuthority ?? null,
        freezeAuthority: info.freezeAuthority ?? null,
        token2022: v.owner === TOKEN_2022_PROGRAM,
        ...(v.owner === TOKEN_2022_PROGRAM ? { extensions: mintExtensions(info.extensions) } : {}),
      };
    } catch (e) {
      this.errors.fail('mintInfo', e);
      return null;
    }
  }

  async largestHolders(mint: string): Promise<{ owner: string | null; account: string; amount: string; pct: number }[]> {
    if (!RE_SOL_ADDRESS.test(mint)) return [];
    try {
      const [largestRaw, supplyRaw] = await Promise.all([
        this.largestAccounts(mint),
        this.rpc('getTokenSupply', [mint, { commitment: 'confirmed' }]),
      ]);
      const accounts = LargestZ.parse(largestRaw).value;
      const supply = BigInt(SupplyZ.parse(supplyRaw).value.amount);
      if (!accounts.length) return [];
      let owners: (string | null)[] = accounts.map(() => null);
      try {
        const multi = MultipleZ.parse(
          await this.rpc('getMultipleAccounts', [accounts.map(a => a.address), { encoding: 'jsonParsed', commitment: 'confirmed' }]),
        );
        owners = accounts.map((_, i) => {
          const d = ParsedTokenAccountZ.safeParse(multi.value[i]?.data);
          return d.success ? d.data.parsed.info.owner : null;
        });
      } catch (e) {
        this.errors.fail('largestHolders owners', e);
      }
      return accounts.map((a, i) => ({
        owner: owners[i],
        account: a.address,
        amount: a.amount,
        pct: supply > 0n ? Number((BigInt(a.amount) * 10_000_000n) / supply) / 100_000 : 0,
      }));
    } catch (e) {
      this.errors.fail('largestHolders', e);
      return [];
    }
  }

  /**
   * Whole `mint` tokens held by `owner`: one getTokenAccountsByOwner (jsonParsed) filtered by the mint, so the RPC
   * resolves the mint's program (SPL Token or Token-2022) and answers with that token's accounts only, summed here.
   * Never a programId-wide scan: its size is set by the owner (every spam token account adds ~500 bytes), and a reply
   * past the RPC's size cap or timeout would make the read fail at will. A failed query → null (never a partial sum).
   */
  async tokenBalance(owner: string, mint: string): Promise<number | null> {
    if (!RE_SOL_ADDRESS.test(owner) || !RE_SOL_ADDRESS.test(mint)) return null;
    try {
      const accounts = OwnerAccountsZ.parse(
        await this.rpc('getTokenAccountsByOwner', [owner, { mint }, { encoding: 'jsonParsed', commitment: 'confirmed' }]),
      ).value;
      let raw = 0n;
      let decimals: number | null = null;
      for (const acc of accounts) {
        if (acc.account.owner !== SPL_TOKEN_PROGRAM && acc.account.owner !== TOKEN_2022_PROGRAM) continue;
        const d = ParsedHoldingZ.safeParse(acc.account.data);
        if (!d.success || d.data.parsed.info.mint !== mint) continue;
        raw += BigInt(d.data.parsed.info.tokenAmount.amount);
        decimals = d.data.parsed.info.tokenAmount.decimals;
      }
      return decimals == null ? 0 : toUnits(raw, decimals);
    } catch (e) {
      this.errors.fail('tokenBalance', e);
      return null;
    }
  }

  async simulate(txBase64: string): Promise<SimResult> {
    const tx = txBase64.trim();
    if (!tx || !/^[A-Za-z0-9+/]+={0,2}$/.test(tx)) return { ok: false, error: 'not a base64 transaction', gas: null, logs: [] };
    try {
      const res = SimZ.parse(
        await this.rpc('simulateTransaction', [
          tx,
          { encoding: 'base64', sigVerify: false, replaceRecentBlockhash: true, commitment: 'confirmed' },
        ]),
      );
      const logs = res.value.logs ?? [];
      const units = res.value.unitsConsumed;
      if (res.value.err != null) {
        return { ok: false, error: describeSolanaError(res.value.err, logs), gas: units != null ? String(units) : null, logs };
      }
      return { ok: true, error: null, gas: units != null ? String(units) : null, logs };
    } catch (e) {
      return { ok: false, error: `simulation unavailable: ${errMsg(e)}`, gas: null, logs: [] };
    }
  }
}

export function createSolana(env: Pick<Env, 'RPC_SOLANA' | 'HELIUS_API_KEY'>, http: Http): SolanaAdapter {
  return new SolanaAdapter(env, http);
}
