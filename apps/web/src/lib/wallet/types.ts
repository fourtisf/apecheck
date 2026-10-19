import type { WalletChain } from '@apecheck/core';

/** EIP-1193: the one method every injected EVM wallet has. */
export interface Eip1193Provider {
  request(args: { method: string; params?: unknown[] | Record<string, unknown> }): Promise<unknown>;
}

/** EIP-6963 `info` of an announced provider. */
export interface Eip6963Info {
  uuid: string;
  name: string;
  /** a data: URI per the EIP; anything else is not rendered */
  icon: string;
  rdns: string;
}

/** The slice of `window` wallet discovery uses (a fake one in tests). */
export interface WalletWindow {
  addEventListener(type: string, listener: (e: Event) => void): void;
  removeEventListener(type: string, listener: (e: Event) => void): void;
  dispatchEvent(e: Event): boolean;
  ethereum?: unknown;
  phantom?: { solana?: unknown } | null;
  solana?: unknown;
}

/** One way to sign in that the browser offers: an EVM provider or a Solana wallet. */
export interface WalletOption {
  /** stable within the page, for React keys */
  key: string;
  chain: WalletChain;
  name: string;
  /** data: image URL to show, or null (only data: images are ever rendered) */
  icon: string | null;
  /** EIP-6963 reverse-DNS id, when the wallet announced one */
  rdns: string | null;
  /** how it was found */
  via: 'eip6963' | 'injected' | 'standard' | 'legacy';
  /** asks the wallet for an account; resolves to the address to sign in with (and the EVM chain id, when known) */
  connect(): Promise<{ address: string; chainId: number | null }>;
  /** signs the exact sign-in message; resolves to the signature string POST /v1/auth/verify takes */
  signMessage(address: string, message: string): Promise<string>;
}
