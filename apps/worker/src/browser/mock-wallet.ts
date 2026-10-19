/**
 * Mock wallet (HANDOFF §4 Stage B.4, §11). Injected with addInitScript before any page script runs:
 *  - EVM: an EIP-1193 provider on window.ethereum (isMetaMask, EIP-6963 announce, events) for a fixed burner
 *    address. Signing returns a dummy signature; eth_sendTransaction records the payload and rejects (4001).
 *  - Solana: window.solana / window.phantom.solana plus a Wallet Standard registration. connect returns a
 *    fixed burner key; sign* record the serialized transaction and reject.
 * No private key exists anywhere: nothing can be signed for real or broadcast. Every request is reported to
 * Node through one exposed binding; captured transactions are only ever simulated (sources.evm/sol.simulate).
 */
import { z } from 'zod';
import { CHAINS, type ChainKey } from '@apecheck/core';
import type { EvmTxRequest } from '@apecheck/sources';

const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

/** Fixed, well-formed burner address (never holds funds; 0x…dEaD is not usable as a simulation sender). */
export const BURNER_EVM = '0x4bb0dc5d1f2a2d4e8d8bd4a9e0bc6f8c7c2b3a10';
/** Fixed Solana burner public key (32 bytes, no secret key exists for it in this code). */
export const BURNER_SOL_BYTES = [
  0x4b, 0xb0, 0xdc, 0x5d, 0x1f, 0x2a, 0x2d, 0x4e, 0x8d, 0x8b, 0xd4, 0xa9, 0xe0, 0xbc, 0x6f, 0x8c,
  0x7c, 0x2b, 0x3a, 0x10, 0x61, 0x70, 0x65, 0x63, 0x68, 0x65, 0x63, 0x6b, 0x2d, 0x74, 0x73, 0x74,
];
export const BURNER_SOL = base58(Uint8Array.from(BURNER_SOL_BYTES));
export const WALLET_BINDING = '__apecheckWallet';

export function base58(bytes: Uint8Array): string {
  let n = 0n;
  for (const b of bytes) n = n * 256n + BigInt(b);
  let out = '';
  while (n > 0n) {
    out = B58[Number(n % 58n)] + out;
    n /= 58n;
  }
  for (const b of bytes) {
    if (b !== 0) break;
    out = '1' + out;
  }
  return out;
}

export function evmChainIdHex(chain: ChainKey | null | undefined): string {
  const id = chain ? CHAINS[chain].chainId : undefined;
  return '0x' + (id ?? 1).toString(16);
}
export function chainFromHex(hex: string | null | undefined): ChainKey | null {
  if (!hex) return null;
  const id = Number.parseInt(hex, 16);
  const hit = Object.values(CHAINS).find(c => c.chainId === id);
  return hit ? hit.key : null;
}

/** EVM methods the wallet forwards to our RPC (read-only; never anything that signs or sends). */
export const EVM_READ_METHODS = new Set([
  'eth_call', 'eth_getBalance', 'eth_blockNumber', 'eth_estimateGas', 'eth_gasPrice', 'eth_getTransactionCount',
  'eth_getCode', 'eth_getBlockByNumber', 'eth_feeHistory', 'eth_maxPriorityFeePerGas', 'eth_getTransactionReceipt',
  'eth_getTransactionByHash', 'eth_getStorageAt',
]);

/* ---------------- page script ---------------- */

export interface MockWalletOptions {
  evmChainId: string;
}

export function mockWalletScript(opts: MockWalletOptions): string {
  const cfg = JSON.stringify({
    addr: BURNER_EVM,
    chainId: opts.evmChainId,
    sol: BURNER_SOL,
    solBytes: BURNER_SOL_BYTES,
    binding: WALLET_BINDING,
    reads: [...EVM_READ_METHODS],
  });
  return `(() => {
  if (window.__apecheckWalletInstalled) return;
  Object.defineProperty(window, '__apecheckWalletInstalled', { value: true });
  const C = ${cfg};
  const READS = new Set(C.reads);
  const report = (msg) => {
    try { const fn = window[C.binding]; if (typeof fn === 'function') return Promise.resolve(fn(msg)).catch(() => null); } catch (e) {}
    return Promise.resolve(null);
  };
  const rpcError = (code, message) => { const e = new Error(message); e.code = code; return e; };
  const DUMMY_SIG = '0x' + '11'.repeat(64) + '1b';
  const ICON = 'data:image/svg+xml;base64,' + btoa('<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32"><rect width="32" height="32" rx="6" fill="#888"/></svg>');

  /* ---------- EVM (EIP-1193 + EIP-6963) ---------- */
  let chainId = C.chainId;
  let connected = false;
  const listeners = {};
  const emit = (ev, data) => { (listeners[ev] || []).slice().forEach(fn => { try { fn(data); } catch (e) {} }); };
  const handle = async (method, params) => {
    switch (method) {
      case 'eth_requestAccounts':
      case 'enable':
        report({ kind: 'evm', method: 'eth_requestAccounts' });
        if (!connected) { connected = true; emit('connect', { chainId }); emit('accountsChanged', [C.addr]); }
        provider.selectedAddress = C.addr;
        return [C.addr];
      case 'eth_accounts':
        return connected ? [C.addr] : [];
      case 'eth_coinbase':
        return connected ? C.addr : null;
      case 'eth_chainId':
        return chainId;
      case 'net_version':
        return String(parseInt(chainId, 16));
      case 'wallet_switchEthereumChain': {
        const next = params && params[0] && params[0].chainId;
        report({ kind: 'evm', method, params });
        if (typeof next === 'string' && /^0x[0-9a-fA-F]+$/.test(next) && next.toLowerCase() !== chainId.toLowerCase()) {
          chainId = next.toLowerCase(); provider.chainId = chainId; provider.networkVersion = String(parseInt(chainId, 16));
          emit('chainChanged', chainId);
        }
        return null;
      }
      case 'wallet_addEthereumChain':
      case 'wallet_watchAsset':
        report({ kind: 'evm', method, params });
        return method === 'wallet_watchAsset' ? true : null;
      case 'wallet_requestPermissions':
        report({ kind: 'evm', method: 'eth_requestAccounts' });
        connected = true; provider.selectedAddress = C.addr; emit('accountsChanged', [C.addr]);
        return [{ parentCapability: 'eth_accounts' }];
      case 'wallet_getPermissions':
        return connected ? [{ parentCapability: 'eth_accounts' }] : [];
      case 'wallet_revokePermissions':
        connected = false; emit('accountsChanged', []); return null;
      case 'personal_sign':
      case 'eth_sign':
      case 'eth_signTypedData':
      case 'eth_signTypedData_v3':
      case 'eth_signTypedData_v4':
        report({ kind: 'evm', method, params });
        return DUMMY_SIG;
      case 'eth_sendTransaction': {
        const tx = (params && params[0]) || {};
        report({ kind: 'evm', method, chainId, tx: { from: tx.from, to: tx.to, data: tx.data || tx.input, value: tx.value, gas: tx.gas || tx.gasLimit } });
        throw rpcError(4001, 'User rejected the request.');
      }
      case 'eth_sendRawTransaction':
      case 'eth_signTransaction':
        report({ kind: 'evm', method });
        throw rpcError(4001, 'User rejected the request.');
      default:
        if (READS.has(method)) {
          const r = await report({ kind: 'evm', method, params, chainId, read: true });
          if (r && Object.prototype.hasOwnProperty.call(r, 'result')) return r.result;
          throw rpcError(-32603, (r && r.error) || 'The test wallet could not serve ' + method);
        }
        report({ kind: 'evm', method });
        throw rpcError(4200, 'The test wallet does not support ' + method);
    }
  };
  const provider = {
    isMetaMask: true,
    _metamask: { isUnlocked: async () => true },
    chainId,
    networkVersion: String(parseInt(chainId, 16)),
    selectedAddress: null,
    isConnected: () => true,
    request: (args) => {
      if (!args || typeof args.method !== 'string') return Promise.reject(rpcError(-32600, 'Invalid request'));
      return handle(args.method, Array.isArray(args.params) ? args.params : args.params == null ? [] : [args.params]);
    },
    enable: () => handle('eth_requestAccounts', []),
    send: (a, b) => {
      if (typeof a === 'string') return handle(a, b || []);
      if (typeof b === 'function') { handle(a.method, a.params || []).then(r => b(null, { id: a.id, jsonrpc: '2.0', result: r }), e => b(e)); return; }
      return handle(a.method, a.params || []);
    },
    sendAsync: (a, cb) => { handle(a.method, a.params || []).then(r => cb(null, { id: a.id, jsonrpc: '2.0', result: r }), e => cb(e)); },
    on: (ev, fn) => { (listeners[ev] = listeners[ev] || []).push(fn); return provider; },
    once: (ev, fn) => { const w = (d) => { provider.removeListener(ev, w); fn(d); }; return provider.on(ev, w); },
    removeListener: (ev, fn) => { listeners[ev] = (listeners[ev] || []).filter(f => f !== fn); return provider; },
    off: (ev, fn) => provider.removeListener(ev, fn),
    removeAllListeners: (ev) => { if (ev) delete listeners[ev]; else Object.keys(listeners).forEach(k => delete listeners[k]); return provider; },
  };
  try { Object.defineProperty(window, 'ethereum', { value: provider, writable: true, configurable: true }); } catch (e) { window.ethereum = provider; }
  const info = Object.freeze({ uuid: '6f1d2c3b-4a5e-4f60-8a7b-9c0d1e2f3a4b', name: 'MetaMask', icon: ICON, rdns: 'io.metamask' });
  const announce = () => { try { window.dispatchEvent(new CustomEvent('eip6963:announceProvider', { detail: Object.freeze({ info, provider }) })); } catch (e) {} };
  window.addEventListener('eip6963:requestProvider', announce);
  announce();

  /* ---------- Solana (Phantom-style injection + Wallet Standard) ---------- */
  const toB64 = (bytes) => { let s = ''; const u = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes); for (let i = 0; i < u.length; i++) s += String.fromCharCode(u[i]); return btoa(s); };
  const serialize = (tx) => {
    try {
      if (tx instanceof Uint8Array) return toB64(tx);
      if (tx && typeof tx.serialize === 'function') {
        try { return toB64(tx.serialize({ requireAllSignatures: false, verifySignatures: false })); } catch (e) { return toB64(tx.serialize()); }
      }
    } catch (e) {}
    return null;
  };
  const pkBytes = new Uint8Array(C.solBytes);
  const publicKey = {
    toBase58: () => C.sol, toString: () => C.sol, toJSON: () => C.sol,
    toBytes: () => new Uint8Array(pkBytes), toBuffer: () => new Uint8Array(pkBytes),
    equals: (o) => !!o && typeof o.toBase58 === 'function' && o.toBase58() === C.sol,
  };
  const solListeners = {};
  const solEmit = (ev, d) => { (solListeners[ev] || []).slice().forEach(fn => { try { fn(d); } catch (e) {} }); };
  const reject = () => Promise.reject(rpcError(4001, 'User rejected the request.'));
  const recordSolTx = (method, txs) => { txs.forEach(tx => report({ kind: 'sol', method, txBase64: serialize(tx) })); };
  const solana = {
    isPhantom: true,
    publicKey: null,
    isConnected: false,
    connect: async (o) => {
      if (o && o.onlyIfTrusted) throw rpcError(4001, 'User rejected the request.');
      report({ kind: 'sol', method: 'connect' });
      solana.publicKey = publicKey; solana.isConnected = true; solEmit('connect', publicKey);
      return { publicKey };
    },
    disconnect: async () => { solana.publicKey = null; solana.isConnected = false; solEmit('disconnect'); },
    signTransaction: (tx) => { recordSolTx('signTransaction', [tx]); return reject(); },
    signAllTransactions: (txs) => { recordSolTx('signAllTransactions', Array.from(txs || [])); return reject(); },
    signAndSendTransaction: (tx) => { recordSolTx('signAndSendTransaction', [tx]); return reject(); },
    signMessage: async (msg) => { report({ kind: 'sol', method: 'signMessage' }); return { signature: new Uint8Array(64), publicKey }; },
    request: async (a) => {
      const m = a && a.method;
      if (m === 'connect') return solana.connect(a.params);
      if (m === 'disconnect') return solana.disconnect();
      report({ kind: 'sol', method: String(m) });
      return reject();
    },
    on: (ev, fn) => { (solListeners[ev] = solListeners[ev] || []).push(fn); return solana; },
    off: (ev, fn) => { solListeners[ev] = (solListeners[ev] || []).filter(f => f !== fn); return solana; },
    removeListener: (ev, fn) => solana.off(ev, fn),
  };
  try { Object.defineProperty(window, 'solana', { value: solana, writable: true, configurable: true }); } catch (e) { window.solana = solana; }
  try { Object.defineProperty(window, 'phantom', { value: { solana }, writable: true, configurable: true }); } catch (e) {}

  const CHAINS_SOL = ['solana:mainnet', 'solana:devnet', 'solana:testnet'];
  const account = Object.freeze({ address: C.sol, publicKey: new Uint8Array(pkBytes), chains: CHAINS_SOL, features: ['solana:signTransaction', 'solana:signAndSendTransaction', 'solana:signMessage'] });
  const stdListeners = { change: [] };
  const wallet = {
    version: '1.0.0', name: 'Phantom', icon: ICON, chains: CHAINS_SOL,
    get accounts() { return solana.isConnected ? [account] : []; },
    features: {
      'standard:connect': { version: '1.0.0', connect: async (o) => {
        if (o && o.silent) return { accounts: solana.isConnected ? [account] : [] };
        await solana.connect(); stdListeners.change.slice().forEach(fn => { try { fn({ accounts: [account] }); } catch (e) {} });
        return { accounts: [account] };
      } },
      'standard:disconnect': { version: '1.0.0', disconnect: async () => { await solana.disconnect(); } },
      'standard:events': { version: '1.0.0', on: (ev, fn) => { (stdListeners[ev] = stdListeners[ev] || []).push(fn); return () => { stdListeners[ev] = stdListeners[ev].filter(f => f !== fn); }; } },
      'solana:signTransaction': { version: '1.0.0', supportedTransactionVersions: ['legacy', 0], signTransaction: (...inputs) => { recordSolTx('solana:signTransaction', inputs.map(i => i && i.transaction)); return reject(); } },
      'solana:signAndSendTransaction': { version: '1.0.0', supportedTransactionVersions: ['legacy', 0], signAndSendTransaction: (...inputs) => { recordSolTx('solana:signAndSendTransaction', inputs.map(i => i && i.transaction)); return reject(); } },
      'solana:signMessage': { version: '1.0.0', signMessage: async (...inputs) => { report({ kind: 'sol', method: 'solana:signMessage' }); return inputs.map(i => ({ signedMessage: i.message, signature: new Uint8Array(64) })); } },
    },
  };
  const register = (api) => { try { api.register(wallet); } catch (e) {} };
  try {
    class RegisterWalletEvent extends Event {
      constructor(cb) { super('wallet-standard:register-wallet', { bubbles: false, cancelable: false, composed: false }); this._cb = cb; }
      get detail() { return this._cb; }
      get type() { return 'wallet-standard:register-wallet'; }
    }
    window.dispatchEvent(new RegisterWalletEvent(register));
  } catch (e) {}
  window.addEventListener('wallet-standard:app-ready', (ev) => { if (ev && ev.detail) register(ev.detail); });
})();`;
}

/* ---------------- Node side ---------------- */

const MsgZ = z.object({
  kind: z.enum(['evm', 'sol']),
  method: z.string().max(80),
  params: z.unknown().optional(),
  chainId: z.string().max(20).optional(),
  read: z.boolean().optional(),
  tx: z
    .object({
      from: z.string().max(64).nullish(),
      to: z.string().max(64).nullish(),
      data: z.string().max(200_000).nullish(),
      value: z.union([z.string().max(80), z.number()]).nullish(),
      gas: z.union([z.string().max(80), z.number()]).nullish(),
    })
    .optional(),
  txBase64: z.string().max(400_000).nullish(),
});
export type WalletMsg = z.infer<typeof MsgZ>;

export interface CapturedTx {
  kind: 'evm' | 'sol';
  method: string;
  chainId: string | null;
  evm: EvmTxRequest | null;
  base64: string | null;
}

export interface WalletRecorderOptions {
  /** forward a read-only EVM call to our RPC; null when no RPC is configured for that chain */
  readRpc?: ((chainId: string, method: string, params: unknown[]) => Promise<unknown>) | null;
  /** cap on forwarded reads per check */
  maxReads?: number;
}

const CONNECT_METHODS = new Set(['eth_requestAccounts', 'connect']);
const SIGN_METHODS = /sign/i;

/** Everything the mock wallet saw during one check. */
export class WalletRecorder {
  requested = false;
  connected = false;
  signatures = 0;
  readonly methods = new Set<string>();
  readonly txs: CapturedTx[] = [];
  /** increments on every non-read request (used to tell whether an action touched the wallet) */
  activity = 0;
  private reads = 0;

  constructor(private readonly opts: WalletRecorderOptions = {}) {}

  /** Binding handler: validate, record, and answer forwarded reads. */
  async handle(raw: unknown): Promise<unknown> {
    const parsed = MsgZ.safeParse(raw);
    if (!parsed.success) return null;
    const m = parsed.data;
    if (m.read) {
      if (m.kind !== 'evm' || !EVM_READ_METHODS.has(m.method) || !this.opts.readRpc) return { error: 'not available' };
      if (this.reads >= (this.opts.maxReads ?? 200)) return { error: 'read limit reached' };
      this.reads++;
      try {
        const params = Array.isArray(m.params) ? m.params : [];
        return { result: await this.opts.readRpc(m.chainId ?? '0x1', m.method, params) };
      } catch (e) {
        return { error: e instanceof Error ? e.message.slice(0, 200) : 'read failed' };
      }
    }
    if (this.methods.size < 64) this.methods.add(m.method);
    this.activity++;
    if (CONNECT_METHODS.has(m.method)) {
      this.requested = true;
      this.connected = true;
    }
    if (SIGN_METHODS.test(m.method) && !/Transaction/i.test(m.method)) this.signatures++;
    if (this.txs.length < 10) {
      if (m.kind === 'evm' && m.method === 'eth_sendTransaction' && m.tx) {
        const t = m.tx;
        const str = (v: string | number | null | undefined) => (v == null ? null : typeof v === 'number' ? '0x' + Math.trunc(v).toString(16) : v);
        this.txs.push({
          kind: 'evm',
          method: m.method,
          chainId: m.chainId ?? null,
          // the burner is always the sender, whatever the page put in `from`
          evm: {
            from: BURNER_EVM,
            to: t.to && /^0x[0-9a-fA-F]{40}$/.test(t.to) ? t.to : null,
            data: t.data && /^0x[0-9a-fA-F]*$/.test(t.data) ? t.data : null,
            value: str(t.value),
            gas: str(t.gas),
          },
          base64: null,
        });
      } else if (m.kind === 'sol' && /Transaction/i.test(m.method)) {
        const b64 = m.txBase64 && /^[A-Za-z0-9+/]+={0,2}$/.test(m.txBase64) ? m.txBase64 : null;
        this.txs.push({ kind: 'sol', method: m.method, chainId: null, evm: null, base64: b64 });
      }
    }
    return null;
  }
}
