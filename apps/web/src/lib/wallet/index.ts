/**
 * Wallet sign-in without wallet libraries: discovery of the wallets this browser has (EIP-6963 + window.ethereum for
 * EVM, the Wallet Standard + window.phantom.solana / window.solana for Solana) and the sign-in flow
 * connect → GET /v1/auth/nonce → sign the exact message → POST /v1/auth/verify.
 */
import type { AuthNonceResponse, AuthVerifyBody, MeDTO, WalletChain } from '@apecheck/core';
import { WalletFlowError, walletError } from './errors';
import { watchEvm } from './evm';
import { watchSolana } from './solana';
import type { WalletOption, WalletWindow } from './types';

export * from './types';
export { WalletFlowError, isUserRejection, signInErrorText, walletError } from './errors';
export { hexUtf8, safeIcon, toBase58, toBase64 } from './encoding';

export interface WalletRegistry {
  /** every wallet found so far, EVM first; only one chain's with `chain` */
  list(chain?: WalletChain): WalletOption[];
  /** asks EVM wallets to announce themselves again (EIP-6963 requestProvider) */
  refresh(): void;
  /** called whenever a wallet appears or goes; returns the unsubscribe */
  subscribe(fn: () => void): () => void;
  stop(): void;
}

export function createWalletRegistry(win: WalletWindow): WalletRegistry {
  const subs = new Set<() => void>();
  const changed = () => {
    for (const fn of [...subs]) fn();
  };
  const evm = watchEvm(win, changed);
  const sol = watchSolana(win, changed);
  evm.request();
  return {
    list(chain) {
      const all = [...evm.list(), ...sol.list()];
      return chain ? all.filter(o => o.chain === chain) : all;
    },
    refresh: () => evm.request(),
    subscribe(fn) {
      subs.add(fn);
      return () => subs.delete(fn);
    },
    stop() {
      evm.stop();
      sol.stop();
      subs.clear();
    },
  };
}

let registry: WalletRegistry | null = null;

/** The page's one registry (browser only): created on first use, then it keeps listening for wallets. */
export function walletRegistry(): WalletRegistry | null {
  if (typeof window === 'undefined') return null;
  return (registry ??= createWalletRegistry(window as unknown as WalletWindow));
}

export type SignInStep = 'connect' | 'sign' | 'verify';

export interface SignInApi {
  nonce(chain: WalletChain, address: string, chainId?: number | null): Promise<AuthNonceResponse>;
  verify(body: AuthVerifyBody): Promise<MeDTO>;
}

/**
 * The whole sign-in with one wallet. Wallet failures come out as WalletFlowError (declined, a request already open,
 * no account, a malformed signature); API failures as ApiRequestError with the API's message (signInErrorText()).
 * `alive()` is asked after every wallet or API answer: once it says false (the visitor closed the wallet modal or
 * started over) the flow stops with WalletFlowError('cancelled') before the next step, so a wallet that answers late
 * never gets a nonce, a signature request or a sign-in out of it.
 */
export async function walletSignIn(
  option: WalletOption,
  api: SignInApi,
  onStep?: (s: SignInStep) => void,
  alive: () => boolean = () => true,
): Promise<MeDTO> {
  const live = () => {
    if (!alive()) throw new WalletFlowError('cancelled');
  };
  onStep?.('connect');
  let account: { address: string; chainId: number | null };
  try {
    account = await option.connect();
  } catch (e) {
    live();
    throw walletError(e, 'connect');
  }
  live();
  const { message } = await api.nonce(option.chain, account.address, option.chain === 'evm' ? account.chainId : null);
  live();
  onStep?.('sign');
  let signature: string;
  try {
    signature = await option.signMessage(account.address, message);
  } catch (e) {
    live();
    throw walletError(e, 'sign');
  }
  live();
  onStep?.('verify');
  return api.verify({ chain: option.chain, address: account.address, message, signature });
}
