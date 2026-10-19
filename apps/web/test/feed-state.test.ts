/**
 * The feed's Verdicts list keeps its tab, layout, filters and rows for the visit (the prototype's S), so opening a
 * verdict and pressing Back shows the same list. These are the rules <Verdicts> mounts with.
 */
import { describe, expect, it } from 'vitest';
import type { CheckSummaryDTO, FeedResponse } from '@apecheck/core';
import {
  DEFAULT_FEED,
  NO_FILTERS,
  feedKey,
  feedParams,
  restoreFeed,
  searchFeed,
  serverFeedKey,
  startRows,
  urlQuery,
  type SavedFeed,
} from '@/components/FeedState';

const page = (ids: string[], nextCursor: string | null = null): FeedResponse => ({
  items: ids.map(id => ({ id }) as CheckSummaryDTO),
  total: 60,
  nextCursor,
});

const sitesOnMostReal: SavedFeed = {
  tab: 'real',
  view: 'grid',
  f: { ...NO_FILTERS, type: 'site' },
  rows: { key: feedKey(feedParams('real', { ...NO_FILTERS, type: 'site' }, [])), res: page(['s1', 's2']) },
};

describe('restoreFeed', () => {
  it('starts from the defaults on the first visit', () => {
    expect(restoreFeed(null, '')).toEqual({ ...DEFAULT_FEED, scrollToList: false });
  });

  it('restores the tab, layout, filters and rows the visitor left with (Back from a report, or the Feed pill)', () => {
    const s = restoreFeed(sitesOnMostReal, '');
    expect(s).toMatchObject({ tab: 'real', view: 'grid', f: { type: 'site' }, scrollToList: false });
    expect(s.rows).toBe(sitesOnMostReal.rows);
  });

  it('a ?q= the saved list does not have (a link, a first visit) searches like the header search', () => {
    const s = restoreFeed(sitesOnMostReal, 'orbit');
    // the prototype: S.f.q = v; S.tab = 'latest' — other filters and the layout stay
    expect(s).toMatchObject({ tab: 'latest', view: 'grid', f: { type: 'site', q: 'orbit' }, rows: null, scrollToList: true });
    expect(restoreFeed(null, 'orbit')).toMatchObject({ tab: 'latest', f: { ...NO_FILTERS, q: 'orbit' }, scrollToList: true });
  });

  it('Back to /?q=… keeps the list as it was when the saved search is the same', () => {
    const saved: SavedFeed = { ...sitesOnMostReal, f: { ...sitesOnMostReal.f, q: 'orbit' } };
    expect(restoreFeed(saved, 'orbit')).toMatchObject({ tab: 'real', view: 'grid', f: { q: 'orbit' }, scrollToList: false });
  });

  it('a header search on another page leaves q on the Latest tab and asks for a scroll to the list', () => {
    const saved = searchFeed(sitesOnMostReal, '  kairo ');
    expect(saved).toMatchObject({ tab: 'latest', view: 'grid', f: { type: 'site', q: 'kairo' }, rows: null, scrollToList: true });
    // the feed then mounts on /?q=kairo
    expect(restoreFeed(saved, 'kairo')).toMatchObject({ tab: 'latest', f: { q: 'kairo' }, scrollToList: true });
    // the scroll is asked once: the next save (what <Verdicts> writes after mounting) drops it
    expect(restoreFeed({ ...saved, scrollToList: undefined }, 'kairo').scrollToList).toBe(false);
  });

  it('reads ?q= like the page server render does (trimmed, at most 120 characters)', () => {
    expect(urlQuery(new URLSearchParams('q=%20orbit%20'))).toBe('orbit');
    expect(urlQuery(new URLSearchParams(`q=${'a'.repeat(130)}`))).toHaveLength(120);
    expect(urlQuery(null)).toBe('');
  });
});

describe('startRows', () => {
  const ssr = page(['l1', 'l2', 'l3']);
  const ssrKey = serverFeedKey('');

  it('shows the server page when it was rendered for these params', () => {
    expect(startRows(ssrKey, ssrKey, ssr, null)).toEqual({ res: ssr, key: ssrKey, refresh: false });
  });

  it('never presents the server page (Latest, no filters) as rows for restored filters: it loads them instead', () => {
    // the old code seeded "loaded" with the current key, so restored non-default filters would never load
    const key = sitesOnMostReal.rows!.key;
    expect(key).not.toBe(ssrKey);
    expect(startRows(key, ssrKey, ssr, null)).toEqual({ res: null, key: null, refresh: false });
  });

  it('shows the saved rows of the last visit at once, then refreshes them quietly', () => {
    const key = sitesOnMostReal.rows!.key;
    expect(startRows(key, ssrKey, ssr, sitesOnMostReal.rows)).toEqual({ res: sitesOnMostReal.rows!.res, key, refresh: true });
  });

  it('keeps "Show 25 more" pages: saved rows longer than the server page win', () => {
    const saved = { key: ssrKey, res: page(['l1', 'l2', 'l3', 'l4', 'l5'], 'c2') };
    expect(startRows(ssrKey, ssrKey, ssr, saved)).toEqual({ res: saved.res, key: ssrKey, refresh: true });
    // ...but a fresh server page at least as long is preferred to stale saved rows
    expect(startRows(ssrKey, ssrKey, ssr, { key: ssrKey, res: page(['old']) })).toEqual({ res: ssr, key: ssrKey, refresh: false });
  });

  it('ignores saved rows that belong to other params', () => {
    expect(startRows(ssrKey, ssrKey, null, sitesOnMostReal.rows)).toEqual({ res: null, key: null, refresh: false });
  });
});

describe('feedParams', () => {
  it('asks for the watched ids on the Watchlist tab only', () => {
    expect(feedParams('watch', NO_FILTERS, ['a', 'b']).ids).toEqual(['a', 'b']);
    expect(feedParams('latest', NO_FILTERS, ['a', 'b']).ids).toBeUndefined();
  });

  it('the server key matches what <Verdicts> builds for the Latest tab without filters', () => {
    expect(serverFeedKey('orbit')).toBe(feedKey(feedParams('latest', { ...NO_FILTERS, q: 'orbit' }, ['ignored'])));
  });
});
