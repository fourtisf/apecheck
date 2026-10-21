/**
 * M3 rules and markup without a browser: tier cards for each viewer, the header's $APECHECK quote, the account
 * menu's holding line, Watch toasts, the signed-in watchlist filters and the move of this browser's list to the
 * account, the cookies a server render forwards, and what ?x= says.
 */
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type { MeDTO } from '@apecheck/core';
import { creditsLeftText } from '@/components/AccessModal';
import { xLinkToast } from '@/components/Account';
import { NO_FILTERS, filterRows } from '@/components/FeedState';
import { MeProvider } from '@/components/Me';
import { notesClosedText } from '@/components/report/NotesTab';
import { watchToast } from '@/components/report/ReportHeader';
import { askErrorText } from '@/components/report/AsksTab';
import { Tiers, TiersNote } from '@/components/Tiers';
import { TokenPrice } from '@/components/TokenPrice';
import { fmtHolding, holdingLine } from '@/components/WalletButton';
import { MIGRATE_PER_PASS, WATCH_MAX_IDS, migrateLocalWatchlist, watchEmptyText } from '@/components/Watchlist';
import { ApiRequestError } from '@/lib/api';
import { apiCookieHeader } from '@/lib/server-api';
import { summary } from './fixtures';

function me(o: Partial<MeDTO> = {}): MeDTO {
  return {
    credits: 4,
    max: 5,
    resetsAt: new Date().toISOString(),
    tier: 'free',
    tokenLive: false,
    proMinHold: null,
    maxMinHold: null,
    user: null,
    proChecksPerDay: 30,
    maxChecksPerDay: 200,
    token: null,
    xLinkAvailable: false,
    notificationsUnread: 0,
    ...o,
  };
}
const user = (o: Partial<NonNullable<MeDTO['user']>> = {}) => ({ id: 'u1', evmAddress: '0xabc', solAddress: null, xHandle: null, tier: 'free' as const, holding: null, holder: false, ...o });

/** The cards as [requirement, first list line, button text, pressed?, disabled?]. */
function cards(html: string) {
  const out: [string, string, string, boolean, boolean][] = [];
  for (const m of html.matchAll(/<div class="tier[^"]*">([\s\S]*?)<\/button><\/div>/g)) {
    const body = m[1];
    const req = /<p class="req">([\s\S]*?)<\/p>/.exec(body)![1].replace(/<[^>]+>/g, '');
    const first = /<li>([\s\S]*?)<\/li>/.exec(body)![1];
    const btn = /<button([^>]*)>([^<]*)$/.exec(body)!;
    out.push([req, first, btn[2], /aria-pressed="true"/.test(btn[1]), /disabled/.test(btn[1])]);
  }
  return out;
}

describe('tier cards', () => {
  it('signed out, before launch: holding hidden, real Connect wallet buttons, limits from /v1/me', () => {
    const html = renderToStaticMarkup(<Tiers me={me()} onWallet={() => {}} />);
    expect(cards(html)).toEqual([
      ['No wallet needed', '5 checks a day on the site', 'Keep using free', false, false],
      ['Opens at token launch', '30 checks a day, ahead of the queue', 'Connect wallet', false, false],
      ['Opens at token launch', '200 checks a day', 'Connect wallet', false, false],
    ]);
    expect(renderToStaticMarkup(<TiersNote me={me()} />)).toContain('Pro and Max open at token launch.');
  });

  it('signed in as Pro before launch: Pro marked, Free included, Max at launch', () => {
    const html = renderToStaticMarkup(<Tiers me={me({ tier: 'pro', max: 30, credits: 30, user: user({ tier: 'pro', holder: true }), proChecksPerDay: 40 })} onWallet={() => {}} />);
    expect(cards(html)).toEqual([
      ['No wallet needed', 'Free checks every day on the site', 'Included', false, true],
      ['Opens at token launch', '40 checks a day, ahead of the queue', 'Your tier', true, false],
      ['Opens at token launch', '200 checks a day', 'At token launch', false, true],
    ]);
  });

  it('signed in as Free once the token is live: holding amounts, and a way to re-read the holding', () => {
    const live = me({ tokenLive: true, proMinHold: 250000, maxMinHold: 2500000, user: user() });
    expect(cards(renderToStaticMarkup(<Tiers me={live} onWallet={() => {}} />))).toEqual([
      ['No wallet needed', '5 checks a day on the site', 'Your tier', true, false],
      ['Hold 250,000 $APECHECK', '30 checks a day, ahead of the queue', 'Check my holding', false, false],
      ['Hold 2,500,000 $APECHECK', '200 checks a day', 'Check my holding', false, false],
    ]);
    expect(renderToStaticMarkup(<TiersNote me={live} />)).toContain('paid monthly in USDC');
  });

  it('credits copy by tier', () => {
    expect(creditsLeftText(me())).toBe('4 of 5 free checks left today');
    expect(creditsLeftText(me({ tier: 'max', credits: 190, max: 200 }))).toBe('190 of 200 checks left today');
  });
});

describe('$APECHECK in the header', () => {
  const render = (m: MeDTO) => renderToStaticMarkup(
    <MeProvider initial={m}>
      <TokenPrice />
    </MeProvider>,
  );
  it("is the prototype's markup from MeDTO.token", () => {
    expect(render(me({ tokenLive: true, token: { usd: 0.00412, ch24: 6.1 } }))).toBe('<span class="tok">$APECHECK <b>$0.00412</b> <span class="up">+6.1%</span></span>');
    expect(render(me({ tokenLive: true, token: { usd: 0.0039, ch24: -2.25 } }))).toBe('<span class="tok">$APECHECK <b>$0.00390</b> <span class="dn">−2.3%</span></span>');
  });
  it('is hidden without a live token or a quote', () => {
    expect(render(me({ tokenLive: false, token: { usd: 0.004, ch24: 1 } }))).toBe('');
    expect(render(me({ tokenLive: true, token: null }))).toBe('');
  });
});

describe('account menu', () => {
  it('holding shows only while the token is live', () => {
    expect(holdingLine(me({ tokenLive: true, user: user({ holding: 3_140_000 }) }))).toBe('Holds 3.1M $APECHECK');
    expect(holdingLine(me({ tokenLive: true, user: user({ holding: 250_000 }) }))).toBe('Holds 250k $APECHECK');
    expect(holdingLine(me({ tokenLive: false, user: user({ holding: null }) }))).toBe('Pro and Max open at token launch');
    expect(holdingLine(me({ tokenLive: false, tier: 'pro', user: user({ tier: 'pro' }) }))).toBeNull();
    expect(fmtHolding(0)).toBe('0');
    expect(fmtHolding(1_250_000_000)).toBe('1.3B');
    expect(fmtHolding(512)).toBe('512');
  });
  it('?x= after the X OAuth callback', () => {
    const t = (q: string) => xLinkToast(new URLSearchParams(q));
    expect(t('x=linked')).toBe('Your X account is linked');
    expect(t('x=error&reason=denied')).toBe('X linking was cancelled');
    expect(t('x=error&reason=taken')).toBe('That X account is linked to another ApeCheck account');
    expect(t('x=error')).toBe("Couldn't link your X account. Try again.");
    expect(t('q=foo')).toBeNull();
  });
});

describe('report copy', () => {
  it('Watch toasts promise only what the tier gets: Max re-checks, Pro alerts, Free and a browser list neither', () => {
    expect(watchToast(true, false, 'free')).toBe('Watching in this browser. Connect a wallet to keep it on your account; re-check alerts come with Pro.');
    expect(watchToast(true, true, 'free')).toBe('Added to your watchlist. Re-check alerts come with Pro.');
    expect(watchToast(true, true, 'pro')).toBe("Watching. You'll get an alert when the site or contract changes.");
    expect(watchToast(true, true, 'max')).toBe("Watching. You'll get a re-check when the site or contract changes.");
    expect(watchToast(false, true, 'max')).toBe('Removed from your watchlist');
  });
  it('the empty Watchlist tab follows the same rule', () => {
    const head = 'Nothing on your watchlist yet. Open any verdict and press Watch to keep it here';
    expect(watchEmptyText(null)).toBe(`${head}. Re-check alerts come with Pro, which opens at token launch.`);
    expect(watchEmptyText(me())).toBe(`${head}. Re-check alerts come with Pro, which opens at token launch.`);
    expect(watchEmptyText(me({ tokenLive: true, user: user() }))).toBe(`${head}. Re-check alerts come with Pro.`);
    expect(watchEmptyText(me({ tier: 'pro', user: user({ tier: 'pro' }) }))).toBe(`${head} and get an alert when the site or contract changes.`);
    expect(watchEmptyText(me({ tier: 'max', user: user({ tier: 'max' }) }))).toBe(`${head}; it's re-checked on its own when the site or contract changes.`);
    // a placeholder tier without a user (just signed out) is a browser list
    expect(watchEmptyText(me({ tier: 'max' }))).toBe(`${head}. Re-check alerts come with Pro, which opens at token launch.`);
  });
  it('notes are closed with the API words; asks show the API message', () => {
    expect(notesClosedText(null)).toBe('Notes are open to $APECHECK holders. Connect a wallet to add one.');
    expect(notesClosedText(me({ user: user() }))).toBe('Notes are open to $APECHECK holders once the token launches.');
    expect(notesClosedText(me({ tokenLive: true, user: user() }))).toBe('Notes are open to $APECHECK holders.');
    const e = new ApiRequestError(429, { code: 'rate_limited', error: "You've asked 20 follow-ups in the last hour. Try again later." });
    expect(askErrorText(e)).toBe("You've asked 20 follow-ups in the last hour. Try again later.");
    expect(askErrorText(new Error('boom'))).toBe("Couldn't reach ApeCheck. Try again in a moment.");
  });
});

describe('signed-in watchlist', () => {
  const rows = [
    summary({ id: 'a', kind: 'coin', name: '$ORBT', ticker: 'ORBT', chain: 'sol', narBand: 'partly', coinBand: 'sketchy', domain: null, ca: 'OrbtMint111', deployer: { address: 'DepWallet9', chain: 'sol' } }),
    summary({ id: 'b', kind: 'site', name: 'nebula.fi', domain: 'nebula.fi', narBand: 'real' }),
    summary({ id: 'c', kind: 'post', name: '@kairolabs', handle: 'kairolabs', domain: null, narBand: 'llarp' }),
  ];
  const ids = (f: Partial<typeof NO_FILTERS>) => filterRows(rows, { ...NO_FILTERS, ...f }).map(r => r.id);
  it('applies the feed filters in the browser', () => {
    expect(ids({})).toEqual(['a', 'b', 'c']);
    expect(ids({ type: 'site' })).toEqual(['b']);
    expect(ids({ nar: 'real' })).toEqual(['b']);
    expect(ids({ coin: 'sketchy' })).toEqual(['a']);
    expect(ids({ chain: 'sol' })).toEqual(['a']);
    expect(ids({ q: '$orbt' })).toEqual(['a']);
    expect(ids({ q: '@KAIRO' })).toEqual(['c']);
    expect(ids({ q: 'depwallet' })).toEqual(['a']);
    expect(ids({ q: 'nothing' })).toEqual([]);
  });

  it("moves this browser's ids to the account: targets resolved, deduped, gone ones skipped", async () => {
    const watched: string[] = [];
    const resolve = vi.fn(async (_ids: string[]) => [
      { id: 'x1', targetId: 'T1' },
      { id: 'x2', targetId: 'T1' },
      { id: 'x3', targetId: 'T2' },
      { id: 'x4', targetId: 'T3' },
    ]);
    const watch = vi.fn(async (t: string) => {
      if (t === 'T2') throw new ApiRequestError(404, { code: 'not_found', error: 'gone' });
      watched.push(t);
    });
    expect(await migrateLocalWatchlist(['x1', 'x2', 'x3', 'x4', 'x5'], { resolve, watch })).toEqual({ moved: 2, done: ['x1', 'x2', 'x3', 'x4', 'x5'], more: false });
    expect(watched).toEqual(['T1', 'T3']);
    expect(await migrateLocalWatchlist([], { resolve, watch })).toEqual({ moved: 0, done: [], more: false });
  });

  it('stops at a full watchlist; keeps the browser list when the API is unreachable', async () => {
    const resolve = async () => [
      { id: 'x1', targetId: 'T1' },
      { id: 'x2', targetId: 'T2' },
    ];
    const full = vi.fn(async () => {
      throw new ApiRequestError(409, { code: 'watchlist_full', error: 'full' });
    });
    expect(await migrateLocalWatchlist(['x1', 'x2'], { resolve, watch: full })).toEqual({ moved: 0, done: ['x1', 'x2'], more: false });
    expect(full).toHaveBeenCalledTimes(1);
    const down = async () => {
      throw new ApiRequestError(0, { code: 'network', error: 'down' });
    };
    await expect(migrateLocalWatchlist(['x1'], { resolve, watch: down })).rejects.toThrow('down');
  });

  /**
   * The browser list against an API like the real one: POST /v1/watch allows 60 a minute, and each "visit" runs passes
   * the way WatchlistProvider does (drop `done` from the browser list, wait a minute when `more`).
   */
  function fakeAccount(perMinute = 60) {
    const account = new Set<string>();
    let minute = 0;
    const hits = new Map<number, number>();
    const posts: string[] = [];
    const deps = {
      // every id is its own target's latest check, except "oldN", an older check of idN's target (the feed follows it)
      resolve: async (ids: string[]) => ids.map(id => (id.startsWith('old') ? `id${id.slice(3)}` : id)).map(id => ({ id, targetId: `T-${id}` })),
      watch: async (t: string) => {
        posts.push(t);
        const n = (hits.get(minute) ?? 0) + 1;
        hits.set(minute, n);
        if (n > perMinute) throw new ApiRequestError(429, { code: 'rate_limited', error: 'Too many requests. Wait a minute and try again.' });
        account.add(t);
        return { watching: true };
      },
      watched: async () => [...account],
    };
    return { account, posts, deps, nextMinute: () => minute++ };
  }

  it('a list longer than the 60-a-minute limit moves in passes and never starts over (no endless 429 loop)', async () => {
    const api = fakeAccount();
    let local = Array.from({ length: 80 }, (_, i) => `id${i}`);
    const passes: [number, number, boolean][] = [];
    for (let visit = 0; visit < 5 && local.length; visit++) {
      const res = await migrateLocalWatchlist(local, api.deps);
      const done = new Set(res.done);
      local = local.filter(id => !done.has(id));
      passes.push([res.moved, local.length, res.more]);
      api.nextMinute();
    }
    // at most MIGRATE_PER_PASS POSTs a pass, so the visitor's own Watch clicks keep room under the limit
    expect(passes).toEqual([
      [MIGRATE_PER_PASS, 80 - MIGRATE_PER_PASS, true],
      [80 - MIGRATE_PER_PASS, 0, false],
    ]);
    expect(api.account.size).toBe(80);
    expect(api.posts.length).toBe(80); // nothing was sent twice
  });

  it('a 429 part-way keeps the ids it could not settle; the next pass skips what already moved', async () => {
    const api = fakeAccount();
    const local0 = [...Array.from({ length: 70 }, (_, i) => `id${i}`), 'old1', 'old2'];
    // no per-pass cap: the API's own limit stops the pass after 60
    const first = await migrateLocalWatchlist(local0, api.deps, 1000);
    expect(first.moved).toBe(60);
    expect(first.more).toBe(true);
    expect(first.done).toEqual(Array.from({ length: 60 }, (_, i) => `id${i}`));
    const done = new Set(first.done);
    const local1 = local0.filter(id => !done.has(id));
    // "old1" follows to id1's target, which moved: it isn't known to be done yet, but costs no POST next time
    expect(local1).toEqual([...Array.from({ length: 10 }, (_, i) => `id${60 + i}`), 'old1', 'old2']);
    api.nextMinute();
    const second = await migrateLocalWatchlist(local1, api.deps, 1000);
    expect(second).toEqual({ moved: 10, done: local1, more: false });
    expect(api.account.size).toBe(70);
    expect(api.posts.length).toBe(61 + 10);
  });

  it('a 429 before anything moved keeps the whole list for later, without throwing', async () => {
    const limited = async () => {
      throw new ApiRequestError(429, { code: 'rate_limited', error: 'Too many requests. Wait a minute and try again.' });
    };
    const resolve = async (ids: string[]) => ids.map(id => ({ id, targetId: `T-${id}` }));
    expect(await migrateLocalWatchlist(['a', 'b'], { resolve, watch: limited })).toEqual({ moved: 0, done: [], more: true });
  });

  it(`ids past the first ${WATCH_MAX_IDS} stay in the browser for the next pass`, async () => {
    const api = fakeAccount(1000);
    const local = Array.from({ length: WATCH_MAX_IDS + 30 }, (_, i) => `id${i}`);
    const res = await migrateLocalWatchlist(local, api.deps, 1000);
    expect(res.done).toEqual(local.slice(0, WATCH_MAX_IDS));
    expect(res.more).toBe(true);
  });
});

describe('server renders', () => {
  it("forward only the API's own cookies", () => {
    expect(apiCookieHeader('ac_sid=s%3Aabc.sig; _ga=GA1.2; ac_session=s%3Axyz.sig; theme=dark')).toBe('ac_sid=s%3Aabc.sig; ac_session=s%3Axyz.sig');
    expect(apiCookieHeader('ac_session=first; ac_session=second')).toBe('ac_session=first');
    expect(apiCookieHeader('_ga=1; other=2')).toBeNull();
    expect(apiCookieHeader('ac_sid=')).toBeNull();
    expect(apiCookieHeader(null)).toBeNull();
  });
});
