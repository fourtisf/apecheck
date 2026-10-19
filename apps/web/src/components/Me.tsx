'use client';
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { MeDTO } from '@apecheck/core';
import { me as fetchMe } from '@/lib/api';

export interface MeApi {
  /**
   * GET /v1/me: credits, tier, the signed-in user. The root layout renders it on the server with the visitor's
   * cookies (first paint shows the right header); null when that failed and the browser's own request hasn't answered.
   */
  me: MeDTO | null;
  /** false until /v1/me answered once (server render or browser) or failed in the browser */
  loaded: boolean;
  /**
   * false while `me.credits` / `me.max` are a placeholder (right after sign-out, before /v1/me says what this browser
   * has left): the header shows "–/–" and the hero line stays blank instead of the old tier's numbers
   */
  creditsKnown: boolean;
  refresh(): Promise<MeDTO | null>;
  /** apply the credits count a POST /v1/checks returned, before the next refresh */
  setCredits(credits: number): void;
  /** a MeDTO another call returned (sign-in, X unlink); `creditsKnown: false` when its credits are a placeholder */
  apply(me: MeDTO, opts?: { creditsKnown?: boolean }): void;
  /** unread re-check alerts after marking some read */
  setUnread(n: number): void;
}

const MeCtx = createContext<MeApi>({ me: null, loaded: false, creditsKnown: false, refresh: async () => null, setCredits() {}, apply() {}, setUnread() {} });

/**
 * Re-read /v1/me when the tab comes back after this long (credits reset at 00:00 UTC, other tabs spend them), and this
 * often while a visible tab shows something that moves: the $APECHECK quote (the API caches it 60 s) or a signed-in
 * viewer's unread re-check alerts.
 */
const STALE_MS = 60_000;
/** how often a visible page looks whether /v1/me is STALE_MS old */
const POLL_TICK_MS = 15_000;

export function MeProvider({ children, initial = null }: { children: ReactNode; initial?: MeDTO | null }) {
  const [me, setMe] = useState<MeDTO | null>(initial);
  const [loaded, setLoaded] = useState(!!initial);
  const [creditsKnown, setCreditsKnown] = useState(true);
  const loadedAt = useRef(0);
  /** bumps on apply(): an older refresh that answers later must not undo a sign-in or sign-out */
  const gen = useRef(0);

  const refresh = useCallback(async () => {
    const my = gen.current;
    try {
      const m = await fetchMe();
      if (my !== gen.current) return null;
      loadedAt.current = Date.now();
      setMe(m);
      setCreditsKnown(true);
      return m;
    } catch {
      return null;
    } finally {
      if (my === gen.current) setLoaded(true);
    }
  }, []);

  const setCredits = useCallback((credits: number) => {
    setMe(m => (m ? { ...m, credits: Math.max(0, credits) } : m));
    setCreditsKnown(true);
  }, []);
  const apply = useCallback((m: MeDTO, opts: { creditsKnown?: boolean } = {}) => {
    gen.current++;
    const known = opts.creditsKnown !== false;
    // a placeholder is stale at once: the next visibility check or poll asks /v1/me
    loadedAt.current = known ? Date.now() : 0;
    setMe(m);
    setCreditsKnown(known);
    setLoaded(true);
  }, []);
  const setUnread = useCallback((n: number) => setMe(m => (m ? { ...m, notificationsUnread: Math.max(0, n) } : m)), []);

  useEffect(() => {
    void refresh();
    const onVis = () => {
      if (!document.hidden && Date.now() - loadedAt.current > STALE_MS) void refresh();
    };
    document.addEventListener('visibilitychange', onVis);
    return () => document.removeEventListener('visibilitychange', onVis);
  }, [refresh]);

  // the header's price and the alert dot keep up while the page stays open (only when there is something to update)
  const moving = !!(me?.tokenLive || me?.user);
  useEffect(() => {
    if (!moving) return;
    let asked = 0;
    const t = window.setInterval(() => {
      const now = Date.now();
      // at most one ask a minute, also while the API is down or slow (`asked`)
      if (document.hidden || now - Math.max(loadedAt.current, asked) < STALE_MS) return;
      asked = now;
      void refresh();
    }, POLL_TICK_MS);
    return () => window.clearInterval(t);
  }, [moving, refresh]);

  // credits come back at 00:00 UTC: refresh right after the reset if the page stays open
  const resetsAt = me?.resetsAt;
  useEffect(() => {
    if (!resetsAt) return;
    const ms = new Date(resetsAt).getTime() - Date.now() + 2000;
    if (!Number.isFinite(ms) || ms <= 0 || ms > 2 ** 31 - 1) return;
    const t = window.setTimeout(() => void refresh(), ms);
    return () => window.clearTimeout(t);
  }, [resetsAt, refresh]);

  const api = useMemo(
    () => ({ me, loaded, creditsKnown, refresh, setCredits, apply, setUnread }),
    [me, loaded, creditsKnown, refresh, setCredits, apply, setUnread],
  );
  return <MeCtx.Provider value={api}>{children}</MeCtx.Provider>;
}

export const useMe = () => useContext(MeCtx);

/** Signed-in user's display bits. */
export const tierName = (t: MeDTO['tier']) => (t === 'max' ? 'Max' : t === 'pro' ? 'Pro' : 'Free');
