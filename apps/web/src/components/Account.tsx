'use client';
import { useRouter } from 'next/navigation';
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { short, type WalletChain } from '@apecheck/core';
import { authNonce, authVerify, logout, NETWORK_ERROR, xLinkUrl, xUnlink } from '@/lib/api';
import { WalletFlowError, signInErrorText, walletSignIn, type SignInStep, type WalletOption } from '@/lib/wallet';
import { useMe } from './Me';
import { useModal } from './Modal';
import { useToast } from './Toast';
import { WalletModal } from './WalletModal';

export interface PendingSignIn {
  /** WalletOption.key of the wallet being used */
  key: string;
  step: SignInStep;
}

export interface AccountApi {
  /** the wallet modal: sign in, or with `chain` link that chain's wallet to the signed-in user */
  openWallets(opts?: { chain?: WalletChain }): void;
  /**
   * connect → nonce → sign → verify with one wallet; resolves true when signed in (or linked). Picking a wallet while
   * another attempt waits on its wallet starts over with this one (the older attempt is dropped, see cancel()).
   */
  signIn(option: WalletOption): Promise<boolean>;
  /**
   * Give up on the attempt in progress (the wallet modal calls it when it closes): the modal is usable again, and
   * whatever the wallet answers later is dropped before a nonce, a signature request or verify. Once verify was sent
   * the browser is signed in either way; that answer is still applied, without closing whatever modal is open by then.
   */
  cancel(): void;
  /** the sign-in in progress (the wallet modal shows it) */
  pending: PendingSignIn | null;
  signOut(): Promise<void>;
  /** "Link your X": the API sends the browser to X and back to /?x=linked|error */
  linkX(): void;
  unlinkX(): Promise<void>;
}

const AccountCtx = createContext<AccountApi>({
  openWallets() {},
  signIn: async () => false,
  cancel() {},
  pending: null,
  async signOut() {},
  linkX() {},
  async unlinkX() {},
});

const CHAIN_NAME: Record<WalletChain, string> = { evm: 'EVM', sol: 'Solana' };

/** What the X OAuth callback put in the address bar (?x=linked | ?x=error[&reason=denied|taken]) as a toast. */
export function xLinkToast(params: URLSearchParams): string | null {
  const x = params.get('x');
  if (x === 'linked') return 'Your X account is linked';
  if (x !== 'error') return null;
  const reason = params.get('reason');
  if (reason === 'denied') return 'X linking was cancelled';
  if (reason === 'taken') return 'That X account is linked to another ApeCheck account';
  return "Couldn't link your X account. Try again.";
}

/**
 * Wallet sign-in (SIWE / SIWS), the X link and sign-out for every page. Mounted once in AppProvider inside the modal
 * store (it opens the wallet modal) and above the actions (connectWallet() opens it).
 */
export function AccountProvider({ children }: { children: ReactNode }) {
  const router = useRouter();
  const toast = useToast();
  const { open: openModal, close: closeModal } = useModal();
  const { me, apply, refresh } = useMe();
  const [pending, setPending] = useState<PendingSignIn | null>(null);
  const pendingRef = useRef(pending);
  pendingRef.current = pending;
  const busy = useRef(false);
  const meRef = useRef(me);
  meRef.current = me;

  const openWallets = useCallback(
    (opts: { chain?: WalletChain } = {}) => {
      const linking = !!opts.chain && !!meRef.current?.user;
      const label = linking ? `Link a${opts.chain === 'evm' ? 'n' : ''} ${CHAIN_NAME[opts.chain!]} wallet` : 'Connect a wallet';
      openModal(<WalletModal chain={opts.chain} linking={linking} />, { narrow: true, label });
    },
    [openModal],
  );

  /** bumps on every attempt and on cancel(): an attempt whose number is no longer current is dropped */
  const attempt = useRef(0);

  const cancel = useCallback(() => {
    attempt.current++;
    busy.current = false;
    setPending(null);
  }, []);

  const signIn = useCallback(
    async (option: WalletOption) => {
      if (busy.current && pendingRef.current?.step === 'verify') return false;
      // a wallet that never answered (popup dismissed, locked, lost behind a window) must not hold the modal: start over
      const my = ++attempt.current;
      const alive = () => attempt.current === my;
      busy.current = true;
      const before = meRef.current?.user ?? null;
      setPending({ key: option.key, step: 'connect' });
      try {
        const next = await walletSignIn(
          option,
          { nonce: authNonce, verify: authVerify },
          step => {
            if (alive()) setPending({ key: option.key, step });
          },
          alive,
        );
        // verify answered: the API has set the session cookie, so apply it even when the modal was closed meanwhile,
        // but close only the wallet modal this attempt belongs to
        apply(next);
        if (alive()) closeModal();
        const u = next.user;
        const addr = option.chain === 'evm' ? u?.evmAddress : u?.solAddress;
        const had = option.chain === 'evm' ? before?.evmAddress : before?.solAddress;
        // the same account with a wallet of this chain it didn't have: a link (signing again with a known wallet is not)
        const linked = !!before && !!u && before.id === u.id && !had && !!addr;
        toast(linked ? `${CHAIN_NAME[option.chain]} wallet linked` : addr ? `Signed in as ${short(addr)}` : 'Signed in');
        // server-rendered parts (private reports, "mine") follow the new session
        router.refresh();
        return true;
      } catch (e) {
        // a dropped attempt says nothing (the visitor closed the modal or picked again)
        if (alive() && !(e instanceof WalletFlowError && e.code === 'cancelled')) toast(signInErrorText(e));
        return false;
      } finally {
        if (alive()) {
          busy.current = false;
          setPending(null);
        }
      }
    },
    [apply, closeModal, toast, router],
  );

  const signOut = useCallback(async () => {
    try {
      await logout();
    } catch (e) {
      toast(e instanceof Error && e.message ? e.message : NETWORK_ERROR);
      return;
    }
    // signed out at once. What this browser has left to check comes from /v1/me: until it answers, the credits are a
    // placeholder (creditsKnown false: "–/–"), never the old tier's "30/30"
    const cur = meRef.current;
    if (cur) {
      const placeholder = cur.tier === 'free' ? {} : { credits: 0, max: 0 };
      apply({ ...cur, ...placeholder, user: null, tier: 'free', notificationsUnread: 0 }, { creditsKnown: false });
    }
    toast('Signed out');
    void refresh();
    router.refresh();
  }, [apply, refresh, toast, router]);

  const linkX = useCallback(() => {
    window.location.assign(xLinkUrl());
  }, []);

  const unlinkX = useCallback(async () => {
    try {
      apply(await xUnlink());
      toast('X account unlinked');
    } catch (e) {
      toast(e instanceof Error && e.message ? e.message : NETWORK_ERROR);
    }
  }, [apply, toast]);

  // back from X (GET /v1/auth/x/callback → /?x=linked | ?x=error): say how it went once, then tidy the address bar
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const text = xLinkToast(params);
    if (!params.has('x')) return;
    params.delete('x');
    params.delete('reason');
    const qs = params.toString();
    window.history.replaceState(null, '', `${window.location.pathname}${qs ? `?${qs}` : ''}${window.location.hash}`);
    if (text) toast(text);
    void refresh();
  }, [toast, refresh]);

  const api = useMemo<AccountApi>(
    () => ({ openWallets, signIn, cancel, pending, signOut, linkX, unlinkX }),
    [openWallets, signIn, cancel, pending, signOut, linkX, unlinkX],
  );
  return <AccountCtx.Provider value={api}>{children}</AccountCtx.Provider>;
}

export const useAccount = () => useContext(AccountCtx);
