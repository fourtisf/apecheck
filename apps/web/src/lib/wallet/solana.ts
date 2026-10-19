/**
 * Solana wallets: the Wallet Standard (wallets register through the 'wallet-standard:app-ready' /
 * 'wallet-standard:register-wallet' handshake and expose 'standard:connect' + 'solana:signMessage'), with
 * window.phantom.solana / window.solana as the fallback while no standard wallet registered.
 */
import { RE_SOL_ADDRESS, safeIcon, toBase58, toBase64, utf8 } from './encoding';
import { WalletFlowError } from './errors';
import type { WalletOption, WalletWindow } from './types';

export const WS_APP_READY = 'wallet-standard:app-ready';
export const WS_REGISTER = 'wallet-standard:register-wallet';
export const CONNECT = 'standard:connect';
export const SIGN_MESSAGE = 'solana:signMessage';

/** The parts of a Wallet Standard wallet we use. */
export interface StandardAccount {
  address: string;
  publicKey?: Uint8Array;
  chains?: readonly string[];
  features?: readonly string[];
}
export interface StandardWallet {
  name: string;
  icon?: string;
  version?: string;
  chains?: readonly string[];
  accounts?: readonly StandardAccount[];
  features: Record<string, unknown>;
}
interface ConnectFeature {
  connect(input?: { silent?: boolean }): Promise<{ accounts: readonly StandardAccount[] }>;
}
interface SignMessageFeature {
  signMessage(...inputs: { account: StandardAccount; message: Uint8Array }[]): Promise<readonly { signedMessage?: Uint8Array; signature: Uint8Array }[]>;
}

/** A registered wallet we can sign in with: 'standard:connect' and 'solana:signMessage'. */
export function isSolanaSignInWallet(w: unknown): w is StandardWallet {
  if (!w || typeof w !== 'object') return false;
  const f = (w as StandardWallet).features;
  if (!f || typeof f !== 'object') return false;
  const c = f[CONNECT] as Partial<ConnectFeature> | undefined;
  const s = f[SIGN_MESSAGE] as Partial<SignMessageFeature> | undefined;
  return typeof (w as StandardWallet).name === 'string' && typeof c?.connect === 'function' && typeof s?.signMessage === 'function';
}

const isSolanaAccount = (a: StandardAccount) => !a.chains?.length || a.chains.some(c => c.startsWith('solana:'));

/** 64 signature bytes → base64 (the API reads base58 or base64). */
function encodeSignature(sig: unknown): string {
  if (!(sig instanceof Uint8Array) || sig.length !== 64) throw new WalletFlowError('bad_signature');
  return toBase64(sig);
}

export function standardOption(wallet: StandardWallet, key: string): WalletOption {
  const connectF = wallet.features[CONNECT] as ConnectFeature;
  const signF = wallet.features[SIGN_MESSAGE] as SignMessageFeature;
  // the account objects the wallet handed out: signMessage wants one of its own, not a copy
  let accounts: readonly StandardAccount[] = [];
  return {
    key,
    chain: 'sol',
    name: wallet.name.trim().slice(0, 60) || 'Solana wallet',
    icon: safeIcon(wallet.icon),
    rdns: null,
    via: 'standard',
    async connect() {
      const res = await connectF.connect();
      accounts = (res?.accounts?.length ? res.accounts : wallet.accounts) ?? [];
      const account = accounts.find(a => isSolanaAccount(a) && typeof a.address === 'string' && RE_SOL_ADDRESS.test(a.address));
      if (!account) throw new WalletFlowError('no_account');
      return { address: account.address, chainId: null };
    },
    async signMessage(address, message) {
      const account = [...accounts, ...(wallet.accounts ?? [])].find(a => a.address === address);
      if (!account) throw new WalletFlowError('no_account');
      const out = await signF.signMessage({ account, message: utf8(message) });
      return encodeSignature(out?.[0]?.signature);
    },
  };
}

/** Old-style injected Solana provider (Phantom's window.phantom.solana, window.solana). */
interface LegacySolana {
  isPhantom?: boolean;
  isSolflare?: boolean;
  publicKey?: { toBase58?(): string; toString(): string; toBytes?(): Uint8Array } | null;
  connect(opts?: unknown): Promise<{ publicKey?: LegacySolana['publicKey'] } | undefined>;
  signMessage(message: Uint8Array, display?: string): Promise<{ signature?: Uint8Array } | Uint8Array>;
}

export function isLegacySolana(p: unknown): p is LegacySolana {
  return !!p && typeof p === 'object' && typeof (p as LegacySolana).connect === 'function' && typeof (p as LegacySolana).signMessage === 'function';
}

function keyToAddress(k: LegacySolana['publicKey']): string | null {
  if (!k) return null;
  let s: string | null = null;
  if (typeof k.toBase58 === 'function') s = k.toBase58();
  else if (typeof k.toBytes === 'function') s = toBase58(k.toBytes());
  else s = String(k);
  return s && RE_SOL_ADDRESS.test(s) ? s : null;
}

export function legacyName(p: LegacySolana): string {
  if (p.isPhantom) return 'Phantom';
  if (p.isSolflare) return 'Solflare';
  return 'Solana wallet';
}

export function legacyOption(provider: LegacySolana): WalletOption {
  return {
    key: 'sol:injected',
    chain: 'sol',
    name: legacyName(provider),
    icon: null,
    rdns: null,
    via: 'legacy',
    async connect() {
      const res = await provider.connect();
      const address = keyToAddress(res?.publicKey ?? null) ?? keyToAddress(provider.publicKey ?? null);
      if (!address) throw new WalletFlowError('no_account');
      return { address, chainId: null };
    },
    async signMessage(_address, message) {
      const out = await provider.signMessage(utf8(message), 'utf8');
      return encodeSignature(out instanceof Uint8Array ? out : out?.signature);
    },
  };
}

/**
 * The app side of the Wallet Standard handshake: listens for wallets registering themselves (now and later) and
 * announces that the app is ready, so wallets that loaded first register too.
 */
export function watchSolana(win: WalletWindow, onChange: () => void) {
  const wallets = new Set<StandardWallet>();
  const options = new WeakMap<StandardWallet, WalletOption>();
  const fallback = new WeakMap<object, WalletOption>();
  let n = 0;

  const api = Object.freeze({
    register(...ws: unknown[]) {
      const added = ws.filter(isSolanaSignInWallet).filter(w => !wallets.has(w));
      for (const w of added) wallets.add(w);
      if (added.length) onChange();
      return () => {
        let removed = false;
        for (const w of added) removed = wallets.delete(w) || removed;
        if (removed) onChange();
      };
    },
  });

  const onRegister = (e: Event) => {
    const cb = (e as CustomEvent<unknown>).detail;
    if (typeof cb !== 'function') return;
    try {
      cb(api);
    } catch {
      // a broken wallet doesn't stop the others
    }
  };
  win.addEventListener(WS_REGISTER, onRegister);
  win.dispatchEvent(new CustomEvent(WS_APP_READY, { detail: api }));

  const list = (): WalletOption[] => {
    if (wallets.size) {
      return [...wallets].map(w => {
        let o = options.get(w);
        if (!o) {
          o = standardOption(w, `sol:${++n}`);
          options.set(w, o);
        }
        return o;
      });
    }
    const p = win.phantom?.solana ?? win.solana;
    if (!isLegacySolana(p)) return [];
    let o = fallback.get(p);
    if (!o) {
      o = legacyOption(p);
      fallback.set(p, o);
    }
    return [o];
  };

  return { list, stop: () => win.removeEventListener(WS_REGISTER, onRegister) };
}
