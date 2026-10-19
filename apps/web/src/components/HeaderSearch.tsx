'use client';
import { useRouter } from 'next/navigation';
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { detect } from '@apecheck/core';
import { feed } from '@/lib/api';
import { reportPath } from '@/lib/env';
import { useActions } from './Actions';
import { SearchIcon } from './icons';

/**
 * Header search (.hsearch) with the prototype's rules:
 * 1. an exact ticker / handle / domain / CA match among checked projects opens that report;
 * 2. otherwise something checkable (CA, X post, site) starts a check;
 * 3. otherwise it filters the feed's verdict list and scrolls to it.
 * "/" focuses it from anywhere (or the hero input when the header search is hidden on small screens).
 */
export function HeaderSearch() {
  const router = useRouter();
  const { startCheck, requestFeedSearch } = useActions();
  const [value, setValue] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);
  const busy = useRef(false);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== '/' || e.metaKey || e.ctrlKey || e.altKey) return;
      const a = document.activeElement as HTMLElement | null;
      if (a && (/^(INPUT|TEXTAREA|SELECT)$/.test(a.tagName) || a.isContentEditable)) return;
      e.preventDefault();
      const h = inputRef.current;
      if (h && h.offsetParent) return h.focus();
      const t = document.getElementById('target');
      if (t) t.focus();
      else router.push('/');
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [router]);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    const v = value.trim();
    if (!v || busy.current) return;
    busy.current = true;
    try {
      const lv = v.toLowerCase().replace(/^[$@]/, '');
      let hitId: string | null = null;
      try {
        // the API caps q at 120 chars; anything longer is a link or CA to check, not a name
        const res = v.length <= 120 ? await feed({ q: v, limit: 50 }) : { items: [] };
        const hit = res.items.find(i => [i.ticker, i.handle, i.domain, i.ca].some(x => !!x && x.toLowerCase() === lv));
        hitId = hit?.id ?? null;
      } catch {
        // search unavailable: fall through to checking / filtering
      }
      if (hitId) {
        setValue('');
        router.push(reportPath(hitId));
        return;
      }
      const d = detect(v);
      if (d && d.kind !== 'bad' && (d.kind !== 'site' || v.includes('.'))) {
        setValue('');
        await startCheck(v);
        return;
      }
      setValue('');
      requestFeedSearch(v);
    } finally {
      busy.current = false;
    }
  }

  return (
    <form className="hsearch" id="hsearch" role="search" onSubmit={onSubmit}>
      <SearchIcon />
      <input
        id="hq"
        ref={inputRef}
        value={value}
        onChange={e => setValue(e.target.value)}
        placeholder="Search coins, or paste a CA, X post or link"
        autoComplete="off"
        spellCheck={false}
        aria-label="Search or check"
        maxLength={2048}
      />
      <kbd>/</kbd>
    </form>
  );
}
