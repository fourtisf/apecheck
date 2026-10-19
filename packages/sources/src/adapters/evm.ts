/**
 * EVM chains over JSON-RPC (read-only) + Etherscan V2 for the contract creator.
 * Transactions captured from a site's wallet request are only ever simulated (eth_call + eth_estimateGas).
 */
import { z } from 'zod';
import { CHAINS, EVM_DETECT_ORDER, type ChainKey, type Env } from '@apecheck/core';
import { warnOnce } from '@apecheck/core/node';
import type { EvmSource, EvmTokenBasics, EvmTxRequest, Http, SimResult } from '../types';
import {
  BURN_ADDRESSES, EIP1967_IMPL_SLOT, MINT_SELECTORS, OWNER_SELECTORS, SELECTORS,
  decodeAbiString, decodeAddress, decodeRevert, decodeUint, hasAnySelector, minimalProxyTarget, toQuantity,
} from '../abi';
import { RpcError, jsonRpc } from '../rpc';
import { ErrorState, RE_EVM_ADDRESS, errMsg, isoFromSeconds } from '../util';

const TIMEOUT_MS = 8_000;

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

/** 'value' = returned data, 'absent' = reverted or empty (function not there), 'error' = transport failure */
type CallOutcome = { kind: 'value'; data: string } | { kind: 'absent' } | { kind: 'error'; error: unknown };

function revertReason(e: unknown): string {
  if (e instanceof RpcError) {
    const data = typeof e.data === 'string' ? e.data : (e.data as { data?: unknown } | null)?.data;
    const decoded = typeof data === 'string' ? decodeRevert(data) : null;
    if (decoded) return decoded;
    return e.message.replace(/^execution reverted:?\s*/i, '') || 'execution reverted';
  }
  return `simulation failed: ${errMsg(e)}`;
}

export class EvmAdapter implements EvmSource {
  private readonly errors = new ErrorState('evm');
  private readonly rpcUrls: Partial<Record<ChainKey, string>> = {};

  constructor(private readonly env: EvmEnv, private readonly http: Http) {
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

  private rpc(chain: ChainKey, method: string, params: unknown[]): Promise<unknown> {
    const url = this.rpcUrls[chain];
    if (!url) return Promise.reject(new Error(`no RPC configured for ${CHAINS[chain].name}`));
    return jsonRpc(this.http, url, method, params, EVM_READ_METHODS, { timeoutMs: TIMEOUT_MS });
  }

  private async call(chain: ChainKey, to: string, data: string): Promise<CallOutcome> {
    try {
      const res = await this.rpc(chain, 'eth_call', [{ to, data }, 'latest']);
      return typeof res === 'string' && res !== '0x' ? { kind: 'value', data: res } : { kind: 'absent' };
    } catch (e) {
      return e instanceof RpcError ? { kind: 'absent' } : { kind: 'error', error: e };
    }
  }

  async getCode(chain: ChainKey, address: string): Promise<string | null> {
    if (!RE_EVM_ADDRESS.test(address) || !this.rpcUrls[chain]) return null;
    try {
      const code = await this.rpc(chain, 'eth_getCode', [address, 'latest']);
      return typeof code === 'string' ? code.toLowerCase() : null;
    } catch (e) {
      this.errors.fail(`getCode ${chain}`, e);
      return null;
    }
  }

  async detectChain(address: string): Promise<ChainKey | null> {
    if (!RE_EVM_ADDRESS.test(address)) return null;
    const order = EVM_DETECT_ORDER.filter(c => !!this.rpcUrls[c]);
    // all chains are asked at once; the answer still respects the detection order
    const pending = order.map(c => this.getCode(c, address));
    for (let i = 0; i < order.length; i++) {
      const code = await pending[i];
      if (code && code !== '0x') return order[i];
    }
    return null;
  }

  /** Implementation behind an EIP-1167 / EIP-1967 proxy, so selector scans see the real logic. */
  private async implementationCode(chain: ChainKey, address: string, code: string): Promise<string | null> {
    let impl = minimalProxyTarget(code);
    if (!impl) {
      try {
        const slot = await this.rpc(chain, 'eth_getStorageAt', [address, EIP1967_IMPL_SLOT, 'latest']);
        const a = typeof slot === 'string' ? decodeAddress('0x' + slot.replace(/^0x/i, '').padStart(64, '0')) : null;
        if (a && !BURN_ADDRESSES.has(a)) impl = a;
      } catch {
        impl = null;
      }
    }
    return impl ? this.getCode(chain, impl) : null;
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
    if (code) {
      const implCode = await this.implementationCode(chain, address, code);
      if (implCode && implCode !== '0x') scanCode = code + implCode.replace(/^0x/, '');
    }
    const hasMintFunction = scanCode ? hasAnySelector(scanCode, MINT_SELECTORS) : null;
    const hasOwnerFunction = scanCode ? hasAnySelector(scanCode, OWNER_SELECTORS) : null;

    const val = (o: CallOutcome) => (o.kind === 'value' ? o.data : null);
    const dec = decodeUint(val(decimals));
    const supply = decodeUint(val(totalSupply));

    let ownerAddr: string | null = null;
    let ownerRenounced: boolean | null = null;
    const ownerHit = [owner, getOwner].find(o => o.kind === 'value' && decodeAddress(o.data));
    if (ownerHit) {
      ownerAddr = decodeAddress(val(ownerHit));
      ownerRenounced = ownerAddr != null && BURN_ADDRESSES.has(ownerAddr);
    } else if (owner.kind === 'absent' && getOwner.kind === 'absent') {
      // no owner function at all counts as renounced, unless the bytecode says one exists
      ownerRenounced = hasOwnerFunction === true ? null : true;
    }

    return {
      name: decodeAbiString(val(name)),
      symbol: decodeAbiString(val(symbol)),
      decimals: dec != null && dec < 256n ? Number(dec) : null,
      totalSupply: supply != null ? supply.toString() : null,
      owner: ownerAddr,
      ownerRenounced,
      hasMintFunction,
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
}

export function createEvm(env: EvmEnv, http: Http): EvmAdapter {
  return new EvmAdapter(env, http);
}
