/**
 * EVM chains over JSON-RPC (read-only) + Etherscan V2 for the contract creator.
 * Transactions captured from a site's wallet request are only ever simulated (eth_call + eth_estimateGas).
 */
import { z } from 'zod';
import { CHAINS, EVM_DETECT_ORDER, type ChainKey, type Env } from '@apecheck/core';
import { warnOnce } from '@apecheck/core/node';
import type { EvmTokenBasics, EvmTxRequest, EvmWalletSource, Http, SimResult } from '../types';
import {
  BURN_ADDRESSES, EIP1967_BEACON_SLOT, EIP1967_IMPL_SLOT, MINT_SELECTORS, SELECTORS,
  decodeAbiString, decodeAddress, decodeRevert, decodeUint, encodeAddressArg, hasAnySelector, minimalProxyTarget, ownerlessRenounced, toQuantity,
} from '../abi';
import { RpcError, jsonRpc } from '../rpc';
import { ErrorState, RE_EVM_ADDRESS, errMsg, isoFromSeconds, toUnits } from '../util';

const TIMEOUT_MS = 8_000;
/** EIP-1271 checks run while someone waits on sign-in: keep them short */
export const ERC1271_TIMEOUT_MS = 4_000;
/** bytes4(keccak256("isValidSignature(bytes32,bytes)")): the selector and the magic value a valid signature returns */
export const ERC1271_MAGIC = '0x1626ba7e';
/**
 * What a valid signature returns: the magic value as one ABI word (bytes4 left-aligned in 32 bytes, zero-padded), as
 * OpenZeppelin's SignatureChecker requires. Matching only the first 4 bytes would accept any contract that echoes its
 * call data, which starts with the same selector (the identity precompile 0x…04, a fallback returning msg.data).
 */
export const ERC1271_MAGIC_WORD = ERC1271_MAGIC + '0'.repeat(56);
/** precompiles and other reserved addresses below 0x10000: never a wallet (the identity precompile 0x…04 echoes its input) */
const RE_RESERVED_ADDRESS = /^0x0{36}/;
const RE_BYTES32 = /^0x[0-9a-fA-F]{64}$/;
const RE_HEX_BYTES = /^0x(?:[0-9a-fA-F]{2})+$/;

/** ABI-encode isValidSignature(bytes32 hash, bytes signature) call data */
export function encodeIsValidSignature(hash: string, signature: string): string {
  const sig = signature.replace(/^0x/i, '').toLowerCase();
  const len = sig.length / 2;
  const padded = sig.padEnd(Math.ceil(sig.length / 64) * 64, '0');
  return ERC1271_MAGIC + hash.replace(/^0x/i, '').toLowerCase() + (64).toString(16).padStart(64, '0') + len.toString(16).padStart(64, '0') + padded;
}

/** The only JSON-RPC methods this adapter may send. No eth_sendTransaction / eth_sendRawTransaction, ever. */
export const EVM_READ_METHODS: ReadonlySet<string> = new Set([
  'eth_chainId', 'eth_blockNumber', 'eth_getCode', 'eth_getStorageAt', 'eth_call', 'eth_estimateGas',
]);

export const PUBLIC_EVM_RPC: Partial<Record<ChainKey, string>> = {
  base: 'https://mainnet.base.org',
  eth: 'https://ethereum-rpc.publicnode.com',
  bnb: 'https://bsc-dataseed.binance.org',
  arb: 'https://arb1.arbitrum.io/rpc',
};

export const ETHERSCAN_V2 = 'https://api.etherscan.io/v2/api';

type EvmEnv = Pick<Env, 'RPC_BASE' | 'RPC_ETH' | 'RPC_BSC' | 'RPC_ARB' | 'RPC_ROBINHOOD' | 'ETHERSCAN_API_KEY'>;

const EVM_CHAINS = (Object.keys(CHAINS) as ChainKey[]).filter(c => CHAINS[c].family === 'evm');

const CreationZ = z.object({
  status: z.string().optional(),
  message: z.string().optional(),
  result: z.union([
    z.array(
      z.object({
        contractAddress: z.string().optional(),
        contractCreator: z.string(),
        txHash: z.string().nullish(),
        timestamp: z.union([z.string(), z.number()]).nullish(),
      }),
    ),
    z.string(),
  ]).nullish(),
});

/**
 * 'value' = returned data, 'absent' = the contract ran and reverted, or returned nothing (the function isn't there),
 * 'error' = the node didn't run it (transport failure, rate limit, overloaded or lagging node: see isExecutionFailure)
 */
type CallOutcome = { kind: 'value'; data: string } | { kind: 'absent' } | { kind: 'error'; error: unknown };
/** eth_getCode: the chain answered (code, '0x' or a malformed null) or it didn't */
type CodeOutcome = { code: string | null } | { error: unknown };

/** Wait before asking a chain whose RPC failed once more during detection. */
export const DETECT_RETRY_DELAY_MS = 500;

export interface EvmOptions {
  /** delay before a failed chain is retried in detectChain (default DETECT_RETRY_DELAY_MS) */
  detectRetryDelayMs?: number;
}

function revertReason(e: unknown): string {
  if (e instanceof RpcError) {
    const data = typeof e.data === 'string' ? e.data : (e.data as { data?: unknown } | null)?.data;
    const decoded = typeof data === 'string' ? decodeRevert(data) : null;
    if (decoded) return decoded;
    return e.message.replace(/^execution reverted:?\s*/i, '') || 'execution reverted';
  }
  return `simulation failed: ${errMsg(e)}`;
}

const RE_EXECUTION_FAILURE =
  /revert|invalid opcode|invalid jump|out of gas|stack (?:underflow|overflow|limit)|vm execution error|vm exception|write protection|return data out of bounds|bad instruction/i;

/**
 * An eth_call the node answered with a JSON-RPC error: did the contract run and fail (it reverted, hit an invalid
 * opcode, ran out of gas: the function isn't there, or it refused), or did the node not run it (HTTP 429 / -32005 rate
 * limits, -32603 internal errors, "header not found", "missing trie node", timeouts, a busy node)? Only an execution
 * failure is an answer. Anything else is a failed read, so a throttled RPC never reads as "this contract has no
 * owner() function" (geth answers a missing function with code 3 or -32000 "execution reverted", Nethermind with
 * -32015 "VM execution error.", some nodes with an HTTP error status around the same body).
 */
export function isExecutionFailure(e: RpcError): boolean {
  if (e.code === 3) return true;
  if (RE_EXECUTION_FAILURE.test(e.message)) return true;
  return typeof e.data === 'string' && /^revert/i.test(e.data);
}

export class EvmAdapter implements EvmWalletSource {
  private readonly errors = new ErrorState('evm');
  private readonly rpcUrls: Partial<Record<ChainKey, string>> = {};
  /** decimals() per chain:token (they never change) */
  private readonly decimalsCache = new Map<string, number>();

  constructor(private readonly env: EvmEnv, private readonly http: Http, private readonly opts: EvmOptions = {}) {
    for (const c of EVM_CHAINS) {
      const fromEnv = (env as Record<string, string | undefined>)[CHAINS[c].rpcEnv];
      const url = fromEnv || PUBLIC_EVM_RPC[c];
      if (url) this.rpcUrls[c] = url;
    }
    if (!this.rpcUrls.rh) {
      warnOnce('rpc-rh', 'Robinhood Chain RPC not configured (RPC_ROBINHOOD empty): Robinhood Chain contracts are skipped');
    }
    if (!env.ETHERSCAN_API_KEY) {
      warnOnce('etherscan', 'Etherscan not configured (ETHERSCAN_API_KEY empty): EVM contract creator lookups are skipped');
    }
  }

  get lastError() {
    return this.errors.lastError;
  }

  /** Stubbed parts, for Sources.stubbed() */
  stubs(): string[] {
    const out: string[] = [];
    if (!this.env.ETHERSCAN_API_KEY) out.push('etherscan');
    if (!this.rpcUrls.rh) out.push('rpc-rh');
    return out;
  }

  chains(): ChainKey[] {
    return EVM_CHAINS.filter(c => !!this.rpcUrls[c]);
  }

  private rpc(chain: ChainKey, method: string, params: unknown[], timeoutMs = TIMEOUT_MS): Promise<unknown> {
    const url = this.rpcUrls[chain];
    if (!url) return Promise.reject(new Error(`no RPC configured for ${CHAINS[chain].name}`));
    return jsonRpc(this.http, url, method, params, EVM_READ_METHODS, { timeoutMs });
  }

  private async call(chain: ChainKey, to: string, data: string, timeoutMs = TIMEOUT_MS): Promise<CallOutcome> {
    try {
      const res = await this.rpc(chain, 'eth_call', [{ to, data }, 'latest'], timeoutMs);
      return typeof res === 'string' && res !== '0x' ? { kind: 'value', data: res } : { kind: 'absent' };
    } catch (e) {
      return e instanceof RpcError && isExecutionFailure(e) ? { kind: 'absent' } : { kind: 'error', error: e };
    }
  }

  /** eth_getCode without recording a failure (detectChain decides which failures count) */
  private async codeAt(chain: ChainKey, address: string): Promise<CodeOutcome> {
    try {
      const code = await this.rpc(chain, 'eth_getCode', [address, 'latest']);
      return { code: typeof code === 'string' ? code.toLowerCase() : null };
    } catch (error) {
      return { error };
    }
  }

  async getCode(chain: ChainKey, address: string): Promise<string | null> {
    if (!RE_EVM_ADDRESS.test(address) || !this.rpcUrls[chain]) return null;
    const r = await this.codeAt(chain, address);
    if ('code' in r) return r.code;
    this.errors.fail(`getCode ${chain}`, r.error);
    return null;
  }

  /**
   * First chain in EVM_DETECT_ORDER with code at the address. All chains are asked at once. A chain whose
   * RPC failed is never skipped silently: when it comes before the first hit (or there is no hit), it is
   * asked once more before a later chain's answer is accepted. Only chains that never answered are reported
   * (`evm.getCode <chain>: …` in lastError and the captureErrors scope), so a caller can tell "no code there"
   * from "that RPC didn't answer", including when a later chain was chosen.
   */
  async detectChain(address: string): Promise<ChainKey | null> {
    if (!RE_EVM_ADDRESS.test(address)) return null;
    const order = EVM_DETECT_ORDER.filter(c => !!this.rpcUrls[c]);
    const hasCode = (r: CodeOutcome) => 'code' in r && !!r.code && r.code !== '0x';
    const pending = order.map(c => this.codeAt(c, address));
    const failed = new Map<ChainKey, unknown>();
    let hit: ChainKey | null = null;
    for (let i = 0; i < order.length && !hit; i++) {
      const r = await pending[i];
      if ('error' in r) failed.set(order[i], r.error);
      else if (hasCode(r)) hit = order[i];
    }
    if (failed.size) {
      // rate limits (the public Base RPC) usually clear within a moment
      await new Promise(res => setTimeout(res, this.opts.detectRetryDelayMs ?? DETECT_RETRY_DELAY_MS));
      const retried = [...failed.keys()].map(c => [c, this.codeAt(c, address)] as const);
      for (const [c, p] of retried) {
        const r = await p;
        if ('error' in r) failed.set(c, r.error);
        else failed.delete(c);
        // the earlier chain answered with code: it wins over the later hit
        if (hasCode(r)) {
          hit = c;
          break;
        }
      }
    }
    for (const [c, e] of failed) {
      if (!hit || order.indexOf(c) < order.indexOf(hit)) this.errors.fail(`getCode ${c}`, e);
    }
    return hit;
  }

  /** The address an address-holding storage slot holds (null when empty or a burn address); throws when unread. */
  private async slotAddress(chain: ChainKey, address: string, slot: string): Promise<string | null> {
    const v = await this.rpc(chain, 'eth_getStorageAt', [address, slot, 'latest']);
    if (typeof v !== 'string') throw new Error('eth_getStorageAt answered without a value');
    const a = decodeAddress('0x' + v.replace(/^0x/i, '').padStart(64, '0'));
    return a && !BURN_ADDRESSES.has(a) ? a : null;
  }

  /**
   * The logic contract behind a proxy, so selector scans see the real logic and an upgrade is visible: an EIP-1167
   * minimal proxy's target, the EIP-1967 implementation slot, or the implementation() of the EIP-1967 beacon. null when
   * the contract is none of those; undefined when it couldn't be read (recorded: an unread slot is never "no proxy").
   */
  private async implementationOf(chain: ChainKey, address: string, code: string): Promise<string | null | undefined> {
    const minimal = minimalProxyTarget(code);
    if (minimal) return minimal;
    try {
      const [impl, beacon] = await Promise.all([
        this.slotAddress(chain, address, EIP1967_IMPL_SLOT),
        this.slotAddress(chain, address, EIP1967_BEACON_SLOT),
      ]);
      if (impl) return impl;
      if (!beacon) return null;
      const r = await this.call(chain, beacon, SELECTORS.implementation);
      if (r.kind === 'error') throw r.error;
      const a = r.kind === 'value' ? decodeAddress(r.data) : null;
      return a && !BURN_ADDRESSES.has(a) ? a : null;
    } catch (e) {
      this.errors.fail(`implementation ${chain}`, e);
      return undefined;
    }
  }

  async tokenBasics(chain: ChainKey, address: string): Promise<EvmTokenBasics | null> {
    if (!RE_EVM_ADDRESS.test(address) || !this.rpcUrls[chain]) return null;
    const [code, name, symbol, decimals, totalSupply, owner, getOwner] = await Promise.all([
      this.getCode(chain, address),
      this.call(chain, address, SELECTORS.name),
      this.call(chain, address, SELECTORS.symbol),
      this.call(chain, address, SELECTORS.decimals),
      this.call(chain, address, SELECTORS.totalSupply),
      this.call(chain, address, SELECTORS.owner),
      this.call(chain, address, SELECTORS.getOwner),
    ]);
    if (code === '0x') return null;
    const outcomes = [name, symbol, decimals, totalSupply, owner, getOwner];
    if (code == null && outcomes.every(o => o.kind === 'error')) {
      this.errors.fail(`tokenBasics ${chain}`, (outcomes[0] as { error: unknown }).error);
      return null;
    }

    let scanCode: string | null = code;
    let implementation: string | null = null;
    let implUnread = false;
    if (code) {
      const impl = await this.implementationOf(chain, address, code);
      if (impl === undefined) implUnread = true;
      else if (impl) {
        implementation = impl;
        const implCode = await this.getCode(chain, impl); // a failure is recorded by getCode
        if (implCode == null) implUnread = true;
        else if (implCode !== '0x') scanCode = code + implCode.replace(/^0x/, '');
      }
    }
    // without the logic behind the proxy, "no mint selector" is unknown, not false
    const hasMintFunction = !scanCode ? null : hasAnySelector(scanCode, MINT_SELECTORS) ? true : implUnread ? null : false;

    const val = (o: CallOutcome) => (o.kind === 'value' ? o.data : null);
    const dec = decodeUint(val(decimals));
    const supply = decodeUint(val(totalSupply));

    let ownerAddr: string | null = null;
    let ownerRenounced: boolean | null = null;
    const ownerHit = [owner, getOwner].find(o => o.kind === 'value' && decodeAddress(o.data));
    const ownerFailed = ownerHit ? undefined : [owner, getOwner].find((o): o is Extract<CallOutcome, { kind: 'error' }> => o.kind === 'error');
    if (ownerHit) {
      ownerAddr = decodeAddress(val(ownerHit));
      ownerRenounced = ownerAddr != null && BURN_ADDRESSES.has(ownerAddr);
    } else if (ownerFailed) {
      // owner()/getOwner() not answered (a rate limit, a lagging node): who controls the token is unknown, and the
      // failure is reported (never read as "no owner function")
      this.errors.fail(`tokenBasics owner ${chain}`, ownerFailed.error);
    } else if (owner.kind === 'absent' && getOwner.kind === 'absent') {
      // no owner function: renounced only when nothing else (roles, a mint function) can control the supply
      ownerRenounced = ownerlessRenounced(scanCode, hasMintFunction);
    }

    return {
      name: decodeAbiString(val(name)),
      symbol: decodeAbiString(val(symbol)),
      decimals: dec != null && dec < 256n ? Number(dec) : null,
      totalSupply: supply != null ? supply.toString() : null,
      owner: ownerAddr,
      ownerRenounced,
      hasMintFunction,
      implementation,
    };
  }

  async simulate(chain: ChainKey, tx: EvmTxRequest): Promise<SimResult> {
    if (!this.rpcUrls[chain]) return { ok: false, error: `no RPC configured for ${CHAINS[chain].name}`, gas: null };
    const call: Record<string, string> = { from: tx.from };
    if (tx.to) call.to = tx.to;
    if (tx.data) call.data = tx.data;
    const value = toQuantity(tx.value);
    if (value) call.value = value;
    const gas = toQuantity(tx.gas);
    if (gas) call.gas = gas;
    try {
      await this.rpc(chain, 'eth_call', [call, 'latest']);
    } catch (e) {
      return { ok: false, error: revertReason(e), gas: null };
    }
    try {
      const est = await this.rpc(chain, 'eth_estimateGas', [call]);
      return { ok: true, error: null, gas: typeof est === 'string' ? BigInt(est).toString() : null };
    } catch (e) {
      return { ok: false, error: revertReason(e), gas: null };
    }
  }

  async creator(chain: ChainKey, address: string): Promise<{ creator: string; txHash: string | null; createdAt: string | null } | null> {
    const key = this.env.ETHERSCAN_API_KEY;
    const chainId = CHAINS[chain].chainId;
    if (!key || !chainId || !RE_EVM_ADDRESS.test(address)) return null;
    const url =
      `${ETHERSCAN_V2}?chainid=${chainId}&module=contract&action=getcontractcreation` +
      `&contractaddresses=${address}&apikey=${encodeURIComponent(key)}`;
    try {
      const parsed = CreationZ.parse(await this.http.json(url, { timeoutMs: TIMEOUT_MS }));
      if (!Array.isArray(parsed.result) || !parsed.result.length) {
        if (parsed.status !== '1') this.errors.fail('creator', new Error(typeof parsed.result === 'string' ? parsed.result : parsed.message ?? 'no result'));
        return null;
      }
      const r = parsed.result[0];
      return {
        creator: r.contractCreator.toLowerCase(),
        txHash: r.txHash ?? null,
        createdAt: r.timestamp != null ? isoFromSeconds(r.timestamp) : null,
      };
    } catch (e) {
      this.errors.fail('creator', e);
      return null;
    }
  }

  /** decimals() of a token, cached; null (with the reason recorded) when it can't be read */
  private async decimalsOf(chain: ChainKey, token: string): Promise<number | null> {
    const key = `${chain}:${token.toLowerCase()}`;
    const hit = this.decimalsCache.get(key);
    if (hit != null) return hit;
    const r = await this.call(chain, token, SELECTORS.decimals);
    if (r.kind === 'error') {
      this.errors.fail(`tokenBalance ${chain}`, r.error);
      return null;
    }
    const dec = r.kind === 'value' ? decodeUint(r.data) : null;
    if (dec == null || dec > 77n) {
      // never guess 18: a wrong scale would put a wallet in the wrong tier
      this.errors.fail(`tokenBalance ${chain}`, new Error('decimals() unreadable at the token address'));
      return null;
    }
    this.decimalsCache.set(key, Number(dec));
    return Number(dec);
  }

  async tokenBalance(chain: ChainKey, token: string, owner: string): Promise<number | null> {
    if (!RE_EVM_ADDRESS.test(token) || !RE_EVM_ADDRESS.test(owner) || !this.rpcUrls[chain]) return null;
    const [bal, decimals] = await Promise.all([
      this.call(chain, token, SELECTORS.balanceOf + encodeAddressArg(owner)),
      this.decimalsOf(chain, token),
    ]);
    if (bal.kind === 'error') {
      this.errors.fail(`tokenBalance ${chain}`, bal.error);
      return null;
    }
    const raw = bal.kind === 'value' ? decodeUint(bal.data) : null;
    if (raw == null) {
      this.errors.fail(`tokenBalance ${chain}`, new Error('balanceOf() unreadable at the token address'));
      return null;
    }
    return decimals == null ? null : toUnits(raw, decimals);
  }

  async isValidSignature(chain: ChainKey, address: string, hash: string, signature: string, opts: { timeoutMs?: number } = {}): Promise<boolean | null> {
    if (!RE_EVM_ADDRESS.test(address) || !RE_BYTES32.test(hash) || !RE_HEX_BYTES.test(signature) || !this.rpcUrls[chain]) return null;
    if (RE_RESERVED_ADDRESS.test(address)) return false;
    const r = await this.call(chain, address, encodeIsValidSignature(hash, signature), opts.timeoutMs ?? ERC1271_TIMEOUT_MS);
    if (r.kind === 'error') {
      this.errors.fail(`isValidSignature ${chain}`, r.error);
      return null;
    }
    // the whole first word must be the magic value (at least 32 bytes back), never just its first 4 bytes
    return r.kind === 'value' && r.data.length >= ERC1271_MAGIC_WORD.length && r.data.slice(0, ERC1271_MAGIC_WORD.length).toLowerCase() === ERC1271_MAGIC_WORD;
  }
}

export function createEvm(env: EvmEnv, http: Http, opts: EvmOptions = {}): EvmAdapter {
  return new EvmAdapter(env, http, opts);
}
