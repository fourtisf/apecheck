import { isApiError, NETWORK_ERROR } from '../api';

export type WalletFlowCode =
  /** the user said no to sharing an account */
  | 'declined_connect'
  /** the user said no to the signature */
  | 'declined_sign'
  /** the wallet already shows a request (EIP-1193 -32002) */
  | 'pending'
  /** the wallet answered without a usable account */
  | 'no_account'
  /** the wallet answered with something that isn't a signature */
  | 'bad_signature'
  /** anything else the wallet threw */
  | 'wallet_error'
  /** the visitor gave up on this attempt (closed the wallet modal, picked a wallet again): nothing to say */
  | 'cancelled';

export class WalletFlowError extends Error {
  constructor(
    readonly code: WalletFlowCode,
    message: string = code,
    readonly cause?: unknown,
  ) {
    super(message);
    this.name = 'WalletFlowError';
  }
}

const REJECT_RE = /user (?:rejected|denied|declined|cancel+ed|closed)|rejected the request|request (?:was )?(?:rejected|declined|cancel+ed)|declined by user|approval denied|cancel+ed by user/i;

/** EIP-1193 4001, ethers' ACTION_REJECTED, and the plain-English rejections Solana wallets throw. */
export function isUserRejection(e: unknown): boolean {
  if (!e || typeof e !== 'object') return false;
  const err = e as { code?: unknown; message?: unknown; name?: unknown; cause?: unknown };
  if (err.code === 4001 || err.code === '4001' || err.code === 'ACTION_REJECTED') return true;
  if (typeof err.message === 'string' && REJECT_RE.test(err.message)) return true;
  if (err.cause && err.cause !== e) return isUserRejection(err.cause);
  return false;
}

/** A wallet error at the given step as a WalletFlowError (rejections, a request already open, anything else). */
export function walletError(e: unknown, step: 'connect' | 'sign'): WalletFlowError {
  if (e instanceof WalletFlowError) return e;
  if (isUserRejection(e)) return new WalletFlowError(step === 'connect' ? 'declined_connect' : 'declined_sign', undefined, e);
  const code = e && typeof e === 'object' ? (e as { code?: unknown }).code : undefined;
  if (code === -32002) return new WalletFlowError('pending', undefined, e);
  return new WalletFlowError('wallet_error', e instanceof Error ? e.message : String(e), e);
}

/** What the toast says when sign-in stops. */
export function signInErrorText(e: unknown): string {
  if (e instanceof WalletFlowError) {
    switch (e.code) {
      case 'declined_sign':
        return 'Signature request was declined';
      case 'declined_connect':
        return 'Connection request was declined';
      case 'pending':
        return 'Your wallet already has a request open. Check it and try again.';
      case 'no_account':
        return "The wallet didn't share an account. Unlock it and try again.";
      case 'cancelled':
        return 'Sign-in was cancelled';
      default:
        return "Couldn't sign in with this wallet. Try again.";
    }
  }
  if (isApiError(e)) return e.message || NETWORK_ERROR;
  return "Couldn't sign in with this wallet. Try again.";
}
