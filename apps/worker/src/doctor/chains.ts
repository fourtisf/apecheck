/**
 * Chain probes: the four EVM RPCs (and Robinhood Chain when RPC_ROBINHOOD is set), Etherscan V2, Solana and TronGrid.
 * Each one goes through the adapter the check pipeline uses (createSources(env), errors read with captureErrors) on
 * one well-known mainnet token, so a PASS here means a coin check on that chain gets its on-chain facts.
 */
import { CHAINS, type ChainKey, type Env } from '@apecheck/core';
import {
  COIN_CALL_TIMEOUT_MS, COIN_SECTION_BUDGET_MS, EVM_READ_METHODS, TRONGRID_BASE, captureErrors, jsonRpc, resolveEvmRpc, solanaRpcUrl,
  type EvmSource, type Http, type SolanaSource, type TronSource,
} from '@apecheck/sources';
import { hostOf } from './redact';
import { errorText, fail, networkRemedy, outcome, type ProbeOutcome } from './result';

/**
 * What a check gives a coinFacts call that sends `rounds` requests one after another (packages/sources/src/coin-facts.ts):
 * a slower read shows as "RPC unavailable" in a check.
 */
export const coinCallBudgetMs = (rounds: number) => Math.max(COIN_CALL_TIMEOUT_MS, Math.min(COIN_CALL_TIMEOUT_MS * rounds, COIN_SECTION_BUDGET_MS));
/** evm.tokenBasics: code + calls, proxy slots, a beacon's implementation(), the implementation's code */
const TOKEN_BASICS_BUDGET_MS = coinCallBudgetMs(4);
/** solana.largestHolders: largest accounts + supply, then their owners */
const HOLDERS_BUDGET_MS = coinCallBudgetMs(2);
/** tron.tokenInfo: the contract, then its calls */
const TRON_INFO_BUDGET_MS = coinCallBudgetMs(2);
const RPC_TIMEOUT_MS = 8_000;

export type EvmProbeChain = 'base' | 'eth' | 'bnb' | 'arb';
/** Same order as EVM_DETECT_ORDER (Robinhood Chain has its own probe). */
export const EVM_PROBE_CHAINS: EvmProbeChain[] = ['base', 'eth', 'bnb', 'arb'];

/**
 * One well-known token per chain. Only liveness and decoding are asserted (symbol, decimals): owner and mint follow
 * the token's own upgrades, so they prove nothing about the endpoint.
 */
export const EVM_PROBE_TOKENS: Record<EvmProbeChain, { address: string; symbol: string; decimals: number }> = {
  base: { address: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', symbol: 'USDC', decimals: 6 },
  eth: { address: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48', symbol: 'USDC', decimals: 6 },
  bnb: { address: '0x55d398326f99059fF775485246999027B3197955', symbol: 'USDT', decimals: 18 },
  arb: { address: '0xaf88d065e77c8cC2239327C5EDb3A432268e5831', symbol: 'USDC', decimals: 6 },
};

const PROVIDERS = 'Alchemy, Infura, QuickNode, Ankr, dRPC or Chainstack; free tiers exist';
const ALCHEMY_HINT = 'set ALCHEMY_API_KEY (alchemy.com, free tier: one key covers Ethereum, Base and Arbitrum)';
export const EVM_REMEDY: Record<EvmProbeChain | 'rh', string> = {
  base: `${ALCHEMY_HINT}, or set RPC_BASE to your own Base mainnet HTTPS endpoint (Coinbase Developer Platform, ${PROVIDERS})`,
  eth: `${ALCHEMY_HINT}, or set RPC_ETH to your own Ethereum mainnet HTTPS endpoint (${PROVIDERS})`,
  bnb: 'set RPC_BSC (not RPC_BNB) to your own BNB Chain mainnet endpoint (NodeReal MegaNode, Ankr, QuickNode, Alchemy or Chainstack; free tiers exist)',
  arb: `${ALCHEMY_HINT}, or set RPC_ARB to your own Arbitrum One HTTPS endpoint (${PROVIDERS})`,
  rh: 'set RPC_ROBINHOOD to a Robinhood Chain mainnet RPC URL (Robinhood Chain developer docs, or a node provider that lists it)',
};

/** chain ids an RPC may answer, so a wrong network reads clearly (a testnet URL is the usual mistake) */
const KNOWN_CHAIN_IDS: Record<number, string> = {
  1: 'Ethereum', 8453: 'Base', 56: 'BNB Chain', 42161: 'Arbitrum One', 10: 'OP Mainnet', 137: 'Polygon',
  11155111: 'Sepolia', 17000: 'Holesky', 84532: 'Base Sepolia', 97: 'BNB Chain testnet', 421614: 'Arbitrum Sepolia',
};

/**
 * The URL the EvmAdapter uses for `chain` (resolveEvmRpc: its RPC_* variable, else Alchemy, else the public fallback;
 * none for Robinhood Chain) and the variable that keys it, when one does.
 */
export function evmRpc(env: Env, chain: ChainKey): { url: string | null; envVar: string; keyVar: string; keyed: boolean } {
  const envVar = CHAINS[chain].rpcEnv;
  const rpc = resolveEvmRpc(env, chain);
  const keyed = rpc?.source === 'env' || rpc?.source === 'alchemy';
  return { url: rpc?.url ?? null, envVar, keyVar: rpc?.source === 'alchemy' ? 'ALCHEMY_API_KEY' : envVar, keyed };
}

const hexNum = (v: unknown): bigint | null => (typeof v === 'string' && /^0x[0-9a-f]+$/i.test(v) ? BigInt(v) : null);
const hex = (n: bigint) => `0x${n.toString(16)}`;
const grouped = (n: bigint) => n.toLocaleString('en-US');

/** eth_chainId + eth_blockNumber, sent the way the adapter sends JSON-RPC (jsonRpc with its read-only method list) */
async function chainHead(http: Http, url: string): Promise<{ chainId: bigint; block: bigint }> {
  const [id, block] = await Promise.all([
    jsonRpc(http, url, 'eth_chainId', [], EVM_READ_METHODS, { timeoutMs: RPC_TIMEOUT_MS }),
    jsonRpc(http, url, 'eth_blockNumber', [], EVM_READ_METHODS, { timeoutMs: RPC_TIMEOUT_MS }),
  ]);
  const chainId = hexNum(id);
  const head = hexNum(block);
  if (chainId == null || head == null) throw new Error('unexpected answer to eth_chainId / eth_blockNumber');
  return { chainId, block: head };
}

export interface EvmProbeDeps {
  env: Env;
  http: Http;
  evm: Pick<EvmSource, 'tokenBasics'>;
  now?: () => number;
}

/**
 * EVM RPC of one chain: the endpoint answers for the right chain id (a wrong RPC_BASE would put every Ethereum contract
 * on Base), and the adapter's tokenBasics decodes a known token within the 8 s a check gives it.
 */
export async function probeEvm(chain: EvmProbeChain, deps: EvmProbeDeps): Promise<ProbeOutcome> {
  const { env, http, evm } = deps;
  const now = deps.now ?? Date.now;
  const { url, envVar, keyVar, keyed } = evmRpc(env, chain);
  const remedy = EVM_REMEDY[chain];
  if (!url) return fail(`no RPC URL for ${CHAINS[chain].name}`, remedy);
  const where = keyed ? `${hostOf(url)} (${keyVar})` : `${hostOf(url)} (public fallback, ${envVar} empty)`;
  const f = { configured: keyed, importance: 'recommended' as const };

  let head: { chainId: bigint; block: bigint };
  try {
    head = await chainHead(http, url);
  } catch (e) {
    const msg = errorText(e);
    return outcome({ ...f, ok: false }, `${where}: ${msg}`, networkRemedy(msg, hostOf(url)) ?? (keyed ? `${keyVar} does not answer: check the URL and its key; ${remedy}` : remedy));
  }
  const expected = BigInt(CHAINS[chain].chainId ?? 0);
  if (head.chainId !== expected) {
    const name = KNOWN_CHAIN_IDS[Number(head.chainId)] ?? 'unknown chain';
    return fail(
      `${where}: wrong network, chainId ${hex(head.chainId)} (${name}), expected ${hex(expected)} (${CHAINS[chain].name})`,
      `${keyVar} must give a ${CHAINS[chain].name} mainnet endpoint: contracts are looked up on this chain through it`,
    );
  }

  const t = EVM_PROBE_TOKENS[chain];
  const started = now();
  const { value, errors } = await captureErrors(() => evm.tokenBasics(chain, t.address));
  const ms = now() - started;
  const headText = `${where}, chainId ${hex(head.chainId)}, block ${grouped(head.block)}`;
  if (!value) {
    const msg = errors[0] ?? 'no contract at the probe address';
    return outcome({ ...f, ok: false }, `${headText}; ${t.symbol} token read failed: ${msg}`, networkRemedy(msg, hostOf(url)) ?? remedy);
  }
  if (value.symbol !== t.symbol || value.decimals !== t.decimals) {
    // null: the node did not run eth_call (the adapter keeps no reason for these reads); a value: it answered wrongly
    const unread = value.symbol == null || value.decimals == null;
    const fix = unread
      ? (keyed ? `${keyVar} did not run eth_call (rate limit or plan): check the provider's dashboard` : remedy)
      : `${keyVar} answers eth_call unexpectedly: try another provider`;
    return fail(`${headText}; ${t.symbol} decoded as symbol=${value.symbol} decimals=${value.decimals}${errors.length ? ` (${errors[0]})` : ''}`, fix);
  }
  const notes: string[] = [];
  if (errors.length) notes.push(`${errors.length} read(s) failed: ${errors[0]}`);
  if (ms > TOKEN_BASICS_BUDGET_MS) notes.push(`token read took ${ms} ms, over the ${TOKEN_BASICS_BUDGET_MS / 1000} s a check gives it`);
  const detail = `${headText}, ${t.symbol} symbol=${value.symbol} decimals=${value.decimals} in ${ms} ms${notes.length ? `; ${notes.join('; ')}` : ''}`;
  return outcome({ ...f, ok: true, degraded: notes.length > 0 }, detail, keyed ? `${keyVar} is slow or rate limited: use a faster plan or provider` : remedy);
}

/** Robinhood Chain: no public fallback and no expected chain id in the code, so liveness only. */
export async function probeRobinhood(deps: { env: Env; http: Http }): Promise<ProbeOutcome> {
  const { url } = evmRpc(deps.env, 'rh');
  if (!url) {
    return outcome(
      { ok: null, configured: false, importance: 'optional' },
      'not configured (RPC_ROBINHOOD empty): Robinhood Chain contracts are skipped; only DexScreener can name the chain',
      EVM_REMEDY.rh,
    );
  }
  try {
    const head = await chainHead(deps.http, url);
    return outcome(
      { ok: true, configured: true, importance: 'optional' },
      `${hostOf(url)} (RPC_ROBINHOOD), chainId ${hex(head.chainId)} (compare with the Robinhood Chain docs), block ${grouped(head.block)}`,
    );
  } catch (e) {
    const msg = errorText(e);
    return fail(`${hostOf(url)} (RPC_ROBINHOOD): ${msg}`, networkRemedy(msg, hostOf(url)) ?? 'RPC_ROBINHOOD does not answer: check the URL and its key');
  }
}

export const ETHERSCAN_REMEDY =
  'set ETHERSCAN_API_KEY (etherscan.io/myapikey; one V2 key covers every chain id; the free plan is rate limited and may not cover every chain)';

/** Etherscan V2 contract creator on each EVM chain with a chain id, one call at a time (the free plan allows a few per second). */
export async function probeEtherscan(deps: { env: Env; evm: Pick<EvmSource, 'creator'> }): Promise<ProbeOutcome> {
  if (!deps.env.ETHERSCAN_API_KEY) {
    return outcome(
      { ok: null, configured: false, importance: 'optional' },
      'not configured: EVM deployer wallets are not looked up (no deployer address and no deployer history for EVM coins)',
      ETHERSCAN_REMEDY,
    );
  }
  const rows: { chain: EvmProbeChain; ok: boolean; error: string | null }[] = [];
  for (const chain of ['eth', 'base', 'bnb', 'arb'] as const) {
    const { value, errors } = await captureErrors(() => deps.evm.creator(chain, EVM_PROBE_TOKENS[chain].address));
    rows.push({ chain, ok: !!value?.creator, error: value ? null : errors[0] ?? 'no creator returned' });
  }
  const [eth] = rows;
  if (!eth.ok) {
    const msg = eth.error ?? 'no creator returned';
    const remedy = /invalid api key|missing\/invalid/i.test(msg)
      ? 'ETHERSCAN_API_KEY is rejected: create a new key at etherscan.io/myapikey'
      : networkRemedy(msg, 'api.etherscan.io') ?? 'Etherscan answered with an error: check the key and its plan at etherscan.io/myapikey';
    return fail(`api.etherscan.io: ${msg}`, remedy);
  }
  const good = rows.filter(r => r.ok).map(r => r.chain);
  const bad = rows.filter(r => !r.ok);
  const detail = `api.etherscan.io: creator found on ${good.join(', ')}${bad.length ? `; not on ${bad.map(r => `${r.chain} (${r.error})`).join(', ')}` : ''}`;
  return outcome(
    { ok: true, configured: true, importance: 'optional', degraded: bad.length > 0 },
    detail,
    'your Etherscan plan does not cover those chains: their deployer address stays empty (upgrade the plan, or accept it)',
  );
}

export const SOL_USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
/** holders probe: a large mint, but not USDC (public nodes may refuse getTokenLargestAccounts on the very largest) */
export const SOL_HOLDERS_MINT = 'JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN';
export const SOLANA_REMEDY =
  'set HELIUS_API_KEY (dashboard.helius.dev, free plan) or RPC_SOLANA to any Solana mainnet RPC URL with its key inside the URL (RPC_SOLANA wins)';

/** Which Solana endpoint the adapter uses (host only) and which variable chose it. */
export function solanaRpc(env: Env): { host: string; source: string; configured: boolean } {
  const host = hostOf(solanaRpcUrl(env));
  if (env.RPC_SOLANA) return { host, source: 'RPC_SOLANA', configured: true };
  if (env.HELIUS_API_KEY) return { host, source: 'HELIUS_API_KEY', configured: true };
  return { host, source: 'public fallback, RPC_SOLANA and HELIUS_API_KEY empty', configured: false };
}

/** Solana: mint authorities (USDC) and the largest holders (JUP), as coinFacts reads them. */
export async function probeSolana(deps: { env: Env; sol: Pick<SolanaSource, 'mintInfo' | 'largestHolders'>; now?: () => number }): Promise<ProbeOutcome> {
  const now = deps.now ?? Date.now;
  const rpc = solanaRpc(deps.env);
  const where = `${rpc.host} (${rpc.source})`;
  const f = { configured: rpc.configured, importance: 'recommended' as const };
  const [mint, holders] = await Promise.all([
    captureErrors(() => deps.sol.mintInfo(SOL_USDC)),
    captureErrors(async () => {
      const started = now();
      const rows = await deps.sol.largestHolders(SOL_HOLDERS_MINT);
      return { rows, ms: now() - started };
    }),
  ]);
  const m = mint.value;
  if (!m) {
    const msg = mint.errors[0] ?? 'no answer';
    const remedy = networkRemedy(msg, rpc.host) ?? (rpc.configured ? `${rpc.source} is refused or does not answer: check the URL or the key` : SOLANA_REMEDY);
    return outcome({ ...f, ok: false }, `${where}: USDC mint read failed: ${msg}`, remedy);
  }
  if (!m.exists) return fail(`${where}: the USDC mint does not exist there: not a mainnet endpoint?`, 'RPC_SOLANA must be a Solana mainnet-beta endpoint (not devnet or testnet)');
  if (m.decimals !== 6 || !m.mintAuthority) {
    return fail(`${where}: USDC decoded as decimals=${m.decimals} mintAuthority=${m.mintAuthority ?? 'none'}`, 'the RPC answers getAccountInfo (jsonParsed) unexpectedly: try another provider');
  }
  const notes: string[] = [];
  const h = holders.value;
  if (!h.rows.length) notes.push(`largest holders failed: ${holders.errors[0] ?? 'empty answer'}`);
  else {
    if (h.rows.every(r => !r.owner)) notes.push(`holder owners unread: ${holders.errors[0] ?? 'getMultipleAccounts failed'}`);
    if (h.ms > HOLDERS_BUDGET_MS) notes.push(`holders took ${h.ms} ms, over the ${HOLDERS_BUDGET_MS / 1000} s a check gives them`);
  }
  const detail = `${where}, USDC decimals=6 mint authority set${h.rows.length ? `, JUP top ${h.rows.length} holders in ${h.ms} ms` : ''}${notes.length ? `; ${notes.join('; ')}` : ''}`;
  return outcome(
    { ...f, ok: true, degraded: notes.length > 0 },
    detail,
    rpc.configured ? `${rpc.source} is slow or refuses getTokenLargestAccounts: holders read "unknown" in checks; use a plan that serves it` : SOLANA_REMEDY,
  );
}

export const TRON_USDT = 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t';
export const TRON_REMEDY = 'set TRONGRID_API_KEY (trongrid.io dashboard > API keys, free tier; sent as the TRON-PRO-API-KEY header)';

/**
 * The adapter swallows failures of name()/symbol()/decimals() (they become null), so when those are missing the
 * same request is sent once more to show TronGrid's HTTP status (a keyless 429, usually).
 */
async function tronNameStatus(env: Env, http: Http): Promise<string> {
  try {
    const res = await http.request(`${TRONGRID_BASE}/wallet/triggerconstantcontract`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(env.TRONGRID_API_KEY ? { 'TRON-PRO-API-KEY': env.TRONGRID_API_KEY } : {}) },
      body: JSON.stringify({ owner_address: TRON_USDT, contract_address: TRON_USDT, function_selector: 'name()', parameter: '', visible: true }),
      timeoutMs: RPC_TIMEOUT_MS,
      maxBytes: 64 * 1024,
    });
    let code = '';
    try {
      const c = (JSON.parse(res.text) as { result?: { code?: unknown } })?.result?.code;
      code = typeof c === 'string' ? ` ${c}` : '';
    } catch {
      code = '';
    }
    return `TronGrid answered HTTP ${res.status}${code} to name()`;
  } catch (e) {
    return `name(): ${errorText(e)}`;
  }
}

/** Tron: TRC-20 basics, owner and creator of USDT through the adapter's tokenInfo. */
export async function probeTron(deps: { env: Env; http: Http; tron: Pick<TronSource, 'tokenInfo'>; now?: () => number }): Promise<ProbeOutcome> {
  const now = deps.now ?? Date.now;
  const keyed = !!deps.env.TRONGRID_API_KEY;
  const where = `${hostOf(TRONGRID_BASE)} (${keyed ? 'TRONGRID_API_KEY' : 'keyless, TRONGRID_API_KEY empty'})`;
  const f = { configured: keyed, importance: 'recommended' as const };
  const started = now();
  const { value, errors } = await captureErrors(() => deps.tron.tokenInfo(TRON_USDT));
  const ms = now() - started;
  if (!value) {
    const msg = errors[0] ?? 'no contract in the answer';
    const remedy = networkRemedy(msg, hostOf(TRONGRID_BASE)) ?? (keyed ? 'TronGrid refuses the key or is down: check TRONGRID_API_KEY in the dashboard' : TRON_REMEDY);
    return outcome({ ...f, ok: false }, `${where}: USDT getcontract failed: ${msg}`, remedy);
  }
  const notes: string[] = [];
  if (value.symbol == null || value.decimals == null) notes.push(`symbol/decimals unread (${await tronNameStatus(deps.env, deps.http)})`);
  else if (value.symbol !== 'USDT' || value.decimals !== 6) {
    return fail(`${where}: USDT decoded as symbol=${value.symbol} decimals=${value.decimals}`, 'TronGrid answered unexpectedly: run the doctor again later');
  }
  if (errors.length) notes.push(errors[0]);
  if (ms > TRON_INFO_BUDGET_MS) notes.push(`took ${ms} ms, over the ${TRON_INFO_BUDGET_MS / 1000} s a check gives it`);
  const owner = value.owner ? 'owner set' : 'owner unread';
  const detail = `${where}, USDT symbol=${value.symbol} decimals=${value.decimals} ${owner} in ${ms} ms${notes.length ? `; ${notes.join('; ')}` : ''}`;
  return outcome({ ...f, ok: true, degraded: notes.length > 0 }, detail, keyed ? 'TronGrid is throttling this key: check its quota in the dashboard' : TRON_REMEDY);
}

/** For the header: every chain's endpoint, host only, and where it came from. */
export function endpointRows(env: Env): [label: string, host: string, source: string][] {
  const rows: [string, string, string][] = [];
  for (const chain of [...EVM_PROBE_CHAINS, 'rh'] as ChainKey[]) {
    const { url, envVar, keyVar, keyed } = evmRpc(env, chain);
    rows.push([CHAINS[chain].name, url ? hostOf(url) : '-', keyed ? keyVar : url ? `public fallback (${envVar} empty)` : `not configured (${envVar} empty)`]);
  }
  const sol = solanaRpc(env);
  rows.push(['Solana', sol.host, sol.source]);
  rows.push(['Tron', hostOf(TRONGRID_BASE), env.TRONGRID_API_KEY ? 'TRONGRID_API_KEY' : 'keyless (TRONGRID_API_KEY empty)']);
  return rows;
}

