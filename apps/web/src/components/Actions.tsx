'use client';
import { usePathname, useRouter } from 'next/navigation';
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { detect } from '@apecheck/core';
import { createCheck, isApiError, NETWORK_ERROR } from '@/lib/api';
import { reportPath } from '@/lib/env';
import { AccessModal } from './AccessModal';
import { useLive } from './Live';
import { useMe } from './Me';
import { useModal } from './Modal';
import { ShareModal, type ShareModalProps } from './ShareModal';
import { useToast } from './Toast';
import type { VCardItem } from './VCard';

/** Same words as the prototype's startCheck() toast. */
export const BAD_TARGET_MSG = 'Paste a contract address, an X post link or a website';

/** Wallet sign-in (SIWE / SIWS) arrives in M3; until then "Connect wallet" opens the access modal. */
const WALLET_SIGN_IN = false;

export interface ActionsApi {
  /** the access modal; out=true when the viewer has no checks left */
  openAccess(out?: boolean): void;
  /** the share-card modal */
  openShare(item: VCardItem, opts?: Omit<ShareModalProps, 'item'>): void;
  /**
   * Start a check like the hero form: bad input → toast, no credits → access modal, otherwise
   * POST /v1/checks, refresh credits and go to the report. Resolves to the check id, or null.
   */
  startCheck(raw: string, opts?: { recheck?: boolean }): Promise<string | null>;
  /** header "Connect wallet" */
  connectWallet(): void;
  /** header search fallback: filter the feed's verdict list by `q` (on "/" only; elsewhere navigate to /?q=) */
  requestFeedSearch(q: string): void;
}

export interface FeedSearchRequest {
  q: string;
  /** bumps on every request, so the same text twice still applies */
  n: number;
}

const ActionsCtx = createContext<ActionsApi>({
  openAccess() {},
  openShare() {},
  startCheck: async () => null,
  connectWallet() {},
  requestFeedSearch() {},
});
const FeedSearchCtx = createContext<FeedSearchRequest | null>(null);

export function ActionsProvider({ children }: { children: ReactNode }) {
  const router = useRouter();
  const pathname = usePathname();
  const toast = useToast();
  const { open: openModal } = useModal();
  const { me, refresh, setCredits } = useMe();
  const { trackMine } = useLive();
  const [feedSearch, setFeedSearch] = useState<FeedSearchRequest | null>(null);

  const meRef = useRef(me);
  useEffect(() => {
    meRef.current = me;
  }, [me]);
  const busy = useRef(false);

  const openAccess = useCallback(
    (out = false) => {
      openModal(<AccessModal out={out} />, { label: out ? "You've used today's free checks" : 'Checks and access' });
    },
    [openModal],
  );

  const openShare = useCallback(
    (item: VCardItem, opts: Omit<ShareModalProps, 'item'> = {}) => {
      openModal(<ShareModal item={item} {...opts} />, { narrow: true, label: 'Share card' });
    },
    [openModal],
  );

  const startCheck = useCallback(
    async (raw: string, opts: { recheck?: boolean } = {}) => {
      const d = detect(raw);
      if (!d || d.kind === 'bad') {
        toast(BAD_TARGET_MSG);
        return null;
      }
      if (meRef.current && meRef.current.credits <= 0) {
        openAccess(true);
        return null;
      }
      if (busy.current) return null;
      busy.current = true;
      try {
        const res = await createCheck({ target: raw.trim(), recheck: opts.recheck || undefined });
        setCredits(res.credits);
        if (!res.cached && (res.status === 'queued' || res.status === 'running')) trackMine(res.id);
        router.push(reportPath(res.id));
        void refresh();
        return res.id;
      } catch (e) {
        if (isApiError(e, 'no_credits')) {
          setCredits(0);
          openAccess(true);
        } else {
          toast(e instanceof Error && e.message ? e.message : NETWORK_ERROR);
        }
        return null;
      } finally {
        busy.current = false;
      }
    },
    [toast, openAccess, setCredits, trackMine, router, refresh],
  );

  const connectWallet = useCallback(() => {
    if (!WALLET_SIGN_IN) openAccess(false);
  }, [openAccess]);

  const requestFeedSearch = useCallback(
    (q: string) => {
      if (pathname === '/') setFeedSearch(s => ({ q, n: (s?.n ?? 0) + 1 }));
      else router.push(`/?q=${encodeURIComponent(q)}`);
    },
    [pathname, router],
  );

  const api = useMemo<ActionsApi>(
    () => ({ openAccess, openShare, startCheck, connectWallet, requestFeedSearch }),
    [openAccess, openShare, startCheck, connectWallet, requestFeedSearch],
  );

  return (
    <ActionsCtx.Provider value={api}>
      <FeedSearchCtx.Provider value={feedSearch}>{children}</FeedSearchCtx.Provider>
    </ActionsCtx.Provider>
  );
}

export const useActions = () => useContext(ActionsCtx);
/** The latest header-search request for the feed (null until one is made). */
export const useFeedSearchRequest = () => useContext(FeedSearchCtx);
