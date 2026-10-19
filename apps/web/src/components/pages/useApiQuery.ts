'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import { isAbortError } from '@/lib/api';

export interface ApiQuery<T> {
  data: T | null;
  /** the last request for the current params failed (API down, rate limited) */
  failed: boolean;
  retry: () => void;
}

/**
 * Data for a filtered list page: starts from the server render, then re-asks the API whenever `params`
 * changes (compared as JSON). The previous rows stay up until the answer arrives; older requests are aborted
 * so a slow answer can't overwrite a newer one.
 * If the server render had nothing (API down), it tries once more from the browser on mount.
 */
export function useApiQuery<P, T>(params: P, fetcher: (p: P, signal: AbortSignal) => Promise<T>, initial: T | null, initialParams: P): ApiQuery<T> {
  const key = JSON.stringify(params);
  const [data, setData] = useState<T | null>(initial);
  const [failed, setFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const loadedKey = useRef<string | null>(initial ? JSON.stringify(initialParams) : null);
  const fetcherRef = useRef(fetcher);
  fetcherRef.current = fetcher;
  const paramsRef = useRef(params);
  paramsRef.current = params;

  useEffect(() => {
    if (key === loadedKey.current) return;
    const ac = new AbortController();
    fetcherRef.current(paramsRef.current, ac.signal).then(
      res => {
        loadedKey.current = key;
        setData(res);
        setFailed(false);
      },
      e => {
        if (isAbortError(e) || ac.signal.aborted) return;
        loadedKey.current = key;
        setData(null);
        setFailed(true);
      },
    );
    return () => ac.abort();
  }, [key, attempt]);

  const retry = useCallback(() => {
    loadedKey.current = null;
    setAttempt(n => n + 1);
  }, []);

  return { data, failed, retry };
}

/** Keep the address bar in step with the page's filters (shareable links) without a navigation or a server round trip. */
export function useSyncUrl(path: string) {
  useEffect(() => {
    if (window.location.pathname + window.location.search === path) return;
    window.history.replaceState(null, '', path);
  }, [path]);
}
