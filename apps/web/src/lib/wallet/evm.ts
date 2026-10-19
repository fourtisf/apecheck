/**
 * EVM wallets: EIP-6963 discovery (every installed wallet announces itself), window.ethereum as the fallback when
 * none does, and the EIP-1193 calls of Sign-In with Ethereum (eth_requestAccounts, eth_chainId, personal_sign).
 */
import { hexUtf8, RE_EVM_ADDRESS, safeIcon } from './encoding';
import { WalletFlowError } from './errors';
import type { Eip1193Provider, Eip6963Info, WalletOption, WalletWindow } from './types';

export const EIP6963_ANNOUNCE = 'eip6963:announceProvider';
export const EIP6963_REQUEST = 'eip6963:requestProvider';

export function isEip1193(p: unknown): p is Eip1193Provider {
  return !!p && (typeof p === 'object' || typeof p === 'function') && typeof (p as Eip1193Provider).request === 'function';
}

/** A valid EIP-6963 announcement's detail, or null. */
export function readAnnouncement(e: Event): { info: Eip6963Info; provider: Eip1193Provider } | null {
  const detail = (e as CustomEvent<unknown>).detail as { info?: Partial<Eip6963Info>; provider?: unknown } | null | undefined;
  const info = detail?.info;
  if (!info || typeof info.uuid !== 'string' || !info.uuid || typeof info.name !== 'string' || !info.name.trim()) return null;
  if (!isEip1193(detail.provider)) return null;
  return {
    info: { uuid: info.uuid, name: info.name.trim().slice(0, 60), icon: typeof info.icon === 'string' ? info.icon : '', rdns: typeof info.rdns === 'string' ? info.rdns : '' },
    provider: detail.provider,
  };
}

/** The name an old-style injected provider goes by (its isX flags), for the window.ethereum fallback. */
export function injectedName(p: unknown): string {
  const f = (p ?? {}) as Record<string, unknown>;
  if (f.isRabby) return 'Rabby';
  if (f.isCoinbaseWallet) return 'Coinbase Wallet';
  if (f.isBraveWallet) return 'Brave Wallet';
  if (f.isPhantom) return 'Phantom';
  if (f.isOkxWallet || f.isOKExWallet) return 'OKX Wallet';
  if (f.isTrust || f.isTrustWallet) return 'Trust Wallet';
  if (f.isMetaMask) return 'MetaMask';
  return 'Browser wallet';
}

/** "0x2105" | 8453 → 8453; anything else → null. */
export function parseChainId(v: unknown): number | null {
  const n = typeof v === 'number' ? v : typeof v === 'string' ? (/^0x[0-9a-f]+$/i.test(v) ? parseInt(v, 16) : /^\d+$/.test(v) ? Number(v) : NaN) : NaN;
  return Number.isSafeInteger(n) && n > 0 ? n : null;
}

/** eth_requestAccounts (the wallet's own prompt) → the first account, and eth_chainId when the wallet answers it. */
export async function connectEvm(provider: Eip1193Provider): Promise<{ address: string; chainId: number | null }> {
  const accounts = await provider.request({ method: 'eth_requestAccounts' });
  const address = Array.isArray(accounts) ? accounts.find((a): a is string => typeof a === 'string' && RE_EVM_ADDRESS.test(a)) : undefined;
  if (!address) throw new WalletFlowError('no_account');
  let chainId: number | null = null;
  try {
    chainId = parseChainId(await provider.request({ method: 'eth_chainId' }));
  } catch {
    // the API's message then names its smart-wallet chain; a key wallet's signature doesn't depend on it
  }
  return { address, chainId };
}

/** personal_sign [0x-hex of the UTF-8 message, address] → the 0x signature. */
export async function signEvm(provider: Eip1193Provider, address: string, message: string): Promise<string> {
  const sig = await provider.request({ method: 'personal_sign', params: [hexUtf8(message), address] });
  if (typeof sig !== 'string' || !/^0x(?:[0-9a-fA-F]{2})+$/.test(sig)) throw new WalletFlowError('bad_signature');
  return sig;
}

export function evmOption(provider: Eip1193Provider, meta: { key: string; name: string; icon?: unknown; rdns?: string | null; via: 'eip6963' | 'injected' }): WalletOption {
  return {
    key: meta.key,
    chain: 'evm',
    name: meta.name,
    icon: safeIcon(meta.icon),
    rdns: meta.rdns || null,
    via: meta.via,
    connect: () => connectEvm(provider),
    signMessage: (address, message) => signEvm(provider, address, message),
  };
}

/**
 * Keeps every EIP-6963 announcement (wallets also announce on their own when they load late) and asks for them
 * again on `request()`. window.ethereum counts only while nothing announced.
 */
export function watchEvm(win: WalletWindow, onChange: () => void) {
  const announced = new Map<string, WalletOption>();
  const fallback = new WeakMap<object, WalletOption>();

  const onAnnounce = (e: Event) => {
    const a = readAnnouncement(e);
    if (!a) return;
    const prev = announced.get(a.info.uuid);
    // the same wallet answers every request: keep the option (and its key) unless the provider changed
    if (prev && prev.name === a.info.name) return;
    announced.set(a.info.uuid, evmOption(a.provider, { key: `evm:${a.info.uuid}`, name: a.info.name, icon: a.info.icon, rdns: a.info.rdns, via: 'eip6963' }));
    onChange();
  };
  win.addEventListener(EIP6963_ANNOUNCE, onAnnounce);

  const request = () => {
    win.dispatchEvent(new Event(EIP6963_REQUEST));
  };

  const list = (): WalletOption[] => {
    if (announced.size) return [...announced.values()];
    const eth = win.ethereum;
    if (!isEip1193(eth)) return [];
    let opt = fallback.get(eth as object);
    if (!opt) {
      opt = evmOption(eth, { key: 'evm:injected', name: injectedName(eth), via: 'injected' });
      fallback.set(eth as object, opt);
    }
    return [opt];
  };

  return { list, request, stop: () => win.removeEventListener(EIP6963_ANNOUNCE, onAnnounce) };
}
