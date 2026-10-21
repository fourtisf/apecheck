/**
 * Re-check alerts (M3): fingerprints of watched targets and what a change does.
 *  - a fixture site is fingerprinted, its text changed, fingerprinted again → "changed" for Pro/Max watchers;
 *  - a page whose only change is a timestamp or a price → no alert; a fetch error, a bot challenge or a page that
 *    differs on every load → no alert;
 *  - Max watchers get an automatic re-check (limits: per day, 12 h per watch, public verdicts only, a running check is
 *    joined), and its "rechecked" notification when it finishes;
 *  - only watchers the stored fingerprint was kept for hear about a change (one frozen while nobody paid watched it is
 *    replaced, not compared, for someone who just started watching);
 *  - contract (EVM, through the real adapter: a throttled RPC is a failed read, an upgraded proxy a change), Tron and
 *    mint (Solana, Token-2022 extensions) fingerprints; the per-day cap of automatic re-checks under concurrency;
 *    the scan's selection.
 */
import http from 'node:http';
import { Redis } from 'ioredis';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { PRIORITY } from '@apecheck/core';
import { HttpError, createEvm, createTron, type EvmTokenBasics, type Http } from '@apecheck/sources';
import { memoryLogger } from '../src/log';
import { siteFingerprintText, stripVolatile } from '../src/watch/normalise';
import { evmFingerprint, fingerprintKind, fingerprintScheme, siteUrl, tronFingerprint } from '../src/watch/fingerprint';
import { autoRechecksToday, processRecheck, reserveAutoRecheck, scanWatched, retryKey, RECHECK_CHECK_JOB, type RecheckDeps } from '../src/watch/recheck';
import { completeAutoRechecks, recheckedText } from '../src/watch/notify';
import { closedPort, serveHandler, type FixtureSite } from './fixture-server';
import { fakeSources, type FakeData, type FakeSources } from './fakes';
import { prisma, resetDb, testEnv } from './helpers';

const HOUR = 3600_000;
let redis: Redis;

beforeAll(async () => {
  redis = new Redis(process.env.REDIS_URL!, { maxRetriesPerRequest: 2 });
});
afterAll(async () => {
  await redis.quit();
  await prisma.$disconnect();
});
beforeEach(async () => {
  await resetDb();
  await redis.flushdb();
});

/* ---------------- the page ---------------- */

const page = (o: { headline?: string; price?: string; updated?: string; extra?: string } = {}) => `<!doctype html><html><head>
<title>Orbit — swap anything</title><meta name="description" content="Orbit swaps &amp; bridges">
<script>window.__BUILD = ${Math.random()}; window.t = Date.now();</script><style>.x{color:red}</style></head>
<body><h1>${o.headline ?? 'Orbit v2 is live'}</h1>
<p>ORBIT $${o.price ?? '0.01234'} (+4.2%) · MC $1.2M · TVL 12,345,678 USD · 1,204 holders</p>
<p>Updated ${o.updated ?? 'Oct 19, 2026, 12:30:05 PM UTC'} · 5 minutes ago</p>
<a href="/app">Launch app</a> <a href="/docs">Docs</a>${o.extra ?? ''}
<footer>© 2026 Orbit Labs · block #19283746</footer></body></html>`;

describe('site text normalising', () => {
  it('drops scripts, styles, tags and every value that changes on its own', () => {
    const a = siteFingerprintText(page());
    expect(a).toContain('Orbit v# is live');
    expect(a).toContain('Launch app');
    expect(a).toContain('description: Orbit swaps & bridges');
    expect(a).not.toMatch(/\d/);
    expect(a).not.toContain('__BUILD');
    // prices, market cap, counters, dates, clock times, relative times, block numbers
    const b = siteFingerprintText(page({ price: '0.00999', updated: 'Nov 2, 2026, 9:01 AM UTC' }).replace('5 minutes ago', 'an hour ago').replace('$1.2M', '$980K').replace('1,204', '1,377').replace('19283746', '19290001'));
    expect(b).toBe(a);
    // words are what counts
    expect(siteFingerprintText(page({ headline: 'Orbit v2: join the waitlist' }))).not.toBe(a);
  });

  it('a few volatile shapes', () => {
    expect(stripVolatile('Mint ends in 3d 4h 12m · 24h vol $1.2M (+12.5%) · Mon, Oct 20 at 14:00 UTC')).toBe(stripVolatile('Mint ends in 2d 23h 59m · 24h vol $980K (−3%) · Tue, Oct 21 at 09:30 UTC'));
    expect(stripVolatile('Launch app')).toBe('Launch app');
    // values that move on their own, in the shapes token pages render them
    const same: [string, string][] = [
      ['24h volume ▲ 3.2%', '24h volume ▼ 1.1%'],
      ['Price ↑ $0.012 · 🔺 4%', 'Price ↓ $0.011 · 🔻 2%'],
      ['Price $0.0₄12', 'Price $0.0₅98'],
      ['Supply 1e9', 'Supply 1,000,000,000'],
      ['Block 0x9f3ab2c1', 'Block 0x1d77e0aa'],
      ['Last tx 3Xk9fQ2mPq', 'Last tx 8hZr1bVw7c'],
      [`Tx 0x${'ab12'.repeat(16)} confirmed`, `Tx 0x${'9f0e'.repeat(16)} confirmed`],
      ['Join 1 holder', 'Join 2 holders'],
      ['Updated yesterday', 'Updated 2 days ago'],
      ['Launch: tomorrow', 'Launch: today'],
      ['Next epoch in 1d 2h', 'Next epoch in 23h 59m'],
    ];
    for (const [a, b] of same) expect(stripVolatile(a), `${a} / ${b}`).toBe(stripVolatile(b));
    // words still count
    expect(stripVolatile('Block explorer')).toBe('Block explorer');
    expect(stripVolatile('Status: Live')).not.toBe(stripVolatile('Status: Paused'));
  });

  it("a different contract address on the page is still a change (the site swapped its token)", () => {
    const evm = (ca: string) => siteFingerprintText(page({ extra: `<p>Contract: ${ca}</p>` }));
    expect(evm('0x4200000000000000000000000000000000000abc')).not.toBe(evm('0x4200000000000000000000000000000000000abd'));
    // addresses that differ only in their digits too
    expect(evm('0x1234567890123456789012345678901234567890')).not.toBe(evm('0x0987654321098765432109876543210987654321'));
    expect(evm('0xab12cd34ef56ab12cd34ef56ab12cd34ef56ab12')).not.toBe(evm('0xab99cd34ef56ab12cd34ef56ab12cd34ef56ab12'));
    const sol = (ca: string) => siteFingerprintText(page({ extra: `<p>CA: ${ca}</p>` }));
    expect(sol('DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263')).not.toBe(sol('DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB264'));
    expect(evm('0x4200000000000000000000000000000000000abc')).toBe(evm('0x4200000000000000000000000000000000000ABC'));
  });

  it('the fingerprinted page is the root of the checked address', () => {
    expect(siteUrl('orbitswap.xyz', 'https://orbitswap.xyz/app?ref=1')).toBe('https://orbitswap.xyz/');
    expect(siteUrl('watched.test', 'http://watched.test:4321/x')).toBe('http://watched.test:4321/');
    expect(siteUrl('orbitswap.xyz', 'orbitswap.xyz')).toBe('https://orbitswap.xyz/');
    expect(siteUrl('orbitswap.xyz', '0x' + '1'.repeat(40))).toBe('https://orbitswap.xyz/');
  });
});

/* ---------------- harness ---------------- */

interface Harness {
  deps: RecheckDeps;
  queued: string[];
  log: ReturnType<typeof memoryLogger>;
}

function harness(o: { allowHosts?: string[]; data?: FakeData; env?: Record<string, string>; enqueue?: (id: string) => Promise<void> } = {}): Harness {
  const env = testEnv({ SSRF_ALLOW_HOSTS: (o.allowHosts ?? []).join(','), WATCH_RECHECK_HOURS: '6', MAX_AUTO_RECHECKS_PER_DAY: '3', ...o.env });
  const queued: string[] = [];
  const log = memoryLogger();
  const deps: RecheckDeps = {
    env,
    prisma,
    redis,
    sources: fakeSources(env, { allowHosts: o.allowHosts, ...o.data }),
    log,
    enqueueCheck: o.enqueue ?? (async id => void queued.push(id)),
    confirmDelayMs: 0,
  };
  return { deps, queued, log };
}

let seq = 0;
async function user(tier: 'FREE' | 'PRO' | 'MAX') {
  seq++;
  return prisma.user.create({ data: { evmAddress: '0x' + seq.toString(16).padStart(40, '0'), tier } });
}
async function watchers(targetId: string) {
  const free = await user('FREE');
  const pro = await user('PRO');
  const max = await user('MAX');
  for (const u of [free, pro, max]) await prisma.watch.create({ data: { userId: u.id, targetId } });
  return { free, pro, max };
}

/** A SITE target with a public verdict (Partly real 48) whose input was the fixture's address. */
async function siteTarget(site: FixtureSite, name = `${site.name}.test`) {
  const target = await prisma.target.create({ data: { key: `site:${name}`, kind: 'SITE', domain: name, name } });
  const check = await prisma.check.create({
    data: { shortId: `v${String(++seq).padStart(6, '0')}`, targetId: target.id, targetRaw: site.url, status: 'DONE', finishedAt: new Date(Date.now() - 24 * HOUR), narScore: 48, narBand: 'partly', isLatest: true },
  });
  return { target, check };
}

/** the stored fingerprint is WATCH_RECHECK_HOURS + 1 h old: due again */
const age = (targetId: string, hours = 7) => prisma.target.update({ where: { id: targetId }, data: { fingerprintAt: new Date(Date.now() - hours * HOUR) } });
const notes = () => prisma.notification.findMany({ orderBy: [{ createdAt: 'asc' }, { userId: 'asc' }] });

describe('site change detection', () => {
  let site: FixtureSite;
  let html = page();
  let status = 200;
  let headers: Record<string, string> = {};
  let hits = 0;

  beforeAll(async () => {
    site = await serveHandler('watched', (_req: http.IncomingMessage, res: http.ServerResponse) => {
      hits++;
      res.writeHead(status, { 'content-type': 'text/html; charset=utf-8', ...headers });
      res.end(typeof html === 'function' ? (html as () => string)() : html);
    });
  });
  afterAll(() => site.close());
  beforeEach(() => {
    html = page();
    status = 200;
    headers = {};
    hits = 0;
  });

  it('first fingerprint just stores; the same page, or one whose only change is a price or a time, is no change', async () => {
    const h = harness({ allowHosts: [site.host] });
    const { target } = await siteTarget(site);
    await watchers(target.id);
    expect(await processRecheck(h.deps, target.id)).toEqual({ status: 'first' });
    const first = (await prisma.target.findUniqueOrThrow({ where: { id: target.id } })).fingerprint;
    expect(fingerprintScheme(first)).toBe('site:v3');
    // not due again until WATCH_RECHECK_HOURS have passed
    expect(await processRecheck(h.deps, target.id)).toEqual({ status: 'skipped', reason: 'fingerprinted recently' });

    await age(target.id);
    expect(await processRecheck(h.deps, target.id)).toEqual({ status: 'same' });
    await age(target.id);
    html = page({ price: '0.02001', updated: 'Oct 20, 2026, 08:00:00 AM UTC' }).replace('5 minutes ago', '2 hours ago');
    expect(await processRecheck(h.deps, target.id)).toEqual({ status: 'same' });
    const t = await prisma.target.findUniqueOrThrow({ where: { id: target.id } });
    expect(t.fingerprint).toBe(first);
    expect(Date.now() - t.fingerprintAt!.getTime()).toBeLessThan(60_000);
    expect(await notes()).toEqual([]);
  });

  it('a text change alerts every Pro and Max watcher (not Free) and starts one automatic re-check for Max', async () => {
    const h = harness({ allowHosts: [site.host] });
    const { target, check: verdict } = await siteTarget(site);
    const { free, pro, max } = await watchers(target.id);
    await processRecheck(h.deps, target.id);
    await age(target.id);
    html = page({ headline: 'Orbit v2: join the waitlist' });
    const before = hits;
    const out = await processRecheck(h.deps, target.id);
    expect(out).toMatchObject({ status: 'changed', alerted: 2 });
    // the change was read twice before it counted
    expect(hits - before).toBe(2);

    const recheck = await prisma.check.findFirstOrThrow({ where: { id: { not: verdict.id } } });
    expect(out).toMatchObject({ recheckId: recheck.id });
    expect(recheck).toMatchObject({ status: 'QUEUED', via: 'WEB', requesterId: max.id, targetRaw: site.url, targetId: target.id, isPrivate: false });
    expect(h.queued).toEqual([recheck.id]);
    expect(RECHECK_CHECK_JOB.priority).toBe(PRIORITY.recheck);

    const n = await notes();
    expect(n.map(x => [x.userId, x.kind, x.checkId, x.text])).toEqual(
      expect.arrayContaining([
        [pro.id, 'changed', null, 'watched.test changed since its last check'],
        [max.id, 'changed', recheck.id, 'watched.test changed since its last check; re-checking it now'],
      ]),
    );
    expect(n).toHaveLength(2);
    expect(n.some(x => x.userId === free.id)).toBe(false);
    const w = await prisma.watch.findMany({ where: { targetId: target.id } });
    expect(w.find(x => x.userId === free.id)!.lastAlertAt).toBeNull();
    expect(w.find(x => x.userId === pro.id)!.lastAlertAt).not.toBeNull();
    expect(w.find(x => x.userId === pro.id)!.lastRecheckAt).toBeNull();
    expect(w.find(x => x.userId === max.id)!.lastRecheckAt).not.toBeNull();

    // the re-check finishes: Max gets the new verdict next to the old one, once
    expect(await completeAutoRechecks(h.deps, recheck.id)).toBe(0); // still queued
    await prisma.check.update({ where: { id: recheck.id }, data: { status: 'DONE', finishedAt: new Date(), narScore: 72, narBand: 'likely' } });
    expect(await completeAutoRechecks(h.deps, recheck.id)).toBe(1);
    expect(await completeAutoRechecks(h.deps, recheck.id)).toBe(0);
    const done = (await notes()).filter(x => x.kind === 'rechecked');
    expect(done.map(x => [x.userId, x.checkId, x.text])).toEqual([[max.id, recheck.id, 'Re-checked watched.test: Likely real 72, was Partly real 48']]);

    // the same new page again: no second alert
    await age(target.id);
    expect(await processRecheck(h.deps, target.id)).toEqual({ status: 'same' });
    expect(await prisma.notification.count()).toBe(3);
  });

  it('two runs on the same change: one set of alerts, one re-check', async () => {
    const h = harness({ allowHosts: [site.host] });
    const { target } = await siteTarget(site);
    await watchers(target.id);
    await processRecheck(h.deps, target.id);
    await age(target.id);
    html = page({ headline: 'Orbit moved to a new chain' });
    const outs = await Promise.all([processRecheck(h.deps, target.id), processRecheck(h.deps, target.id)]);
    expect(outs.filter(o => o.status === 'changed')).toHaveLength(1);
    expect(await prisma.notification.count()).toBe(2);
    expect(await prisma.check.count()).toBe(2);
    expect(h.queued).toHaveLength(1);
  });

  it('a fetch error, an HTTP error or a bot challenge never alerts (and backs off an hour)', async () => {
    const h = harness({ allowHosts: [site.host] });
    const { target } = await siteTarget(site);
    await watchers(target.id);
    await processRecheck(h.deps, target.id);
    const first = (await prisma.target.findUniqueOrThrow({ where: { id: target.id } })).fingerprint;

    for (const breakIt of [
      () => { status = 500; html = '<h1>Internal error</h1>'; },
      () => { status = 200; html = '<!doctype html><title>Just a moment...</title><p>Checking your browser</p>'; },
      () => { status = 403; headers = { 'cf-mitigated': 'challenge' }; html = '<title>Attention Required! | Cloudflare</title>'; },
      () => { status = 200; html = '<html><body><script>render()</script></body></html>'; },
    ]) {
      breakIt();
      await age(target.id);
      await redis.del(retryKey(target.id));
      const out = await processRecheck(h.deps, target.id);
      expect(out.status).toBe('error');
      expect(await redis.ttl(retryKey(target.id))).toBeGreaterThan(3000);
      expect((await prisma.target.findUniqueOrThrow({ where: { id: target.id } })).fingerprint).toBe(first);
      headers = {};
    }
    // the backing-off target is left out of the scan
    expect(await scanWatched(h.deps)).toEqual([]);
    await redis.del(retryKey(target.id));
    expect(await scanWatched(h.deps)).toEqual([target.id]);
    expect(await notes()).toEqual([]);
  });

  it('a site that is down (connection refused) never alerts', async () => {
    const port = await closedPort();
    const down = { name: 'down', host: `down.test:${port}`, port, url: `http://down.test:${port}/`, close: async () => undefined };
    const h = harness({ allowHosts: [down.host] });
    const { target } = await siteTarget(down);
    await watchers(target.id);
    await prisma.target.update({ where: { id: target.id }, data: { fingerprint: `site:v3:${'a'.repeat(64)}`, fingerprintAt: new Date(Date.now() - 7 * HOUR) } });
    expect((await processRecheck(h.deps, target.id)).status).toBe('error');
    expect(await notes()).toEqual([]);
  });

  it('a page that differs on every load is not a change', async () => {
    const h = harness({ allowHosts: [site.host] });
    const { target } = await siteTarget(site);
    await watchers(target.id);
    await processRecheck(h.deps, target.id);
    await age(target.id);
    let n = 0;
    html = (() => page({ extra: `<p>Tip of the day: ${['stake', 'swap', 'bridge', 'farm'][n++ % 4]}</p>` })) as unknown as string;
    expect(await processRecheck(h.deps, target.id)).toEqual({ status: 'unstable' });
    expect(await notes()).toEqual([]);
  });

  it('a fingerprint frozen while nobody paid watched is replaced, not compared, for someone who just started watching', async () => {
    const h = harness({ allowHosts: [site.host] });
    const { target } = await siteTarget(site);
    // an earlier Pro watcher: the fingerprint is taken; they left 40 days ago and nobody kept it current since
    const old = await user('PRO');
    await prisma.watch.create({ data: { userId: old.id, targetId: target.id } });
    expect(await processRecheck(h.deps, target.id)).toEqual({ status: 'first' });
    await prisma.watch.delete({ where: { userId_targetId: { userId: old.id, targetId: target.id } } });
    await age(target.id, 40 * 24);
    // the site changed weeks ago; a Pro and a Max user open the report and start watching now
    html = page({ headline: 'Orbit v2: join the waitlist' });
    const pro = await user('PRO');
    const max = await user('MAX');
    for (const u of [pro, max]) await prisma.watch.create({ data: { userId: u.id, targetId: target.id } });
    const before = (await prisma.target.findUniqueOrThrow({ where: { id: target.id } })).fingerprint;
    expect(await processRecheck(h.deps, target.id)).toEqual({ status: 'rebaselined' });
    expect(await notes()).toEqual([]);
    expect(h.queued).toEqual([]);
    const t = await prisma.target.findUniqueOrThrow({ where: { id: target.id } });
    expect(t.fingerprint).not.toBe(before);
    expect(Date.now() - t.fingerprintAt!.getTime()).toBeLessThan(60_000);
    // from here on the fingerprint is theirs: the next change is news to both
    await age(target.id);
    html = page({ headline: 'Orbit is paused' });
    expect(await processRecheck(h.deps, target.id)).toMatchObject({ status: 'changed', alerted: 2 });
    expect((await notes()).map(n => n.userId).sort()).toEqual([pro.id, max.id].sort());
  });

  it('only watchers the fingerprint was kept for are alerted (a Max watcher who joined during a long outage is not)', async () => {
    const h = harness({ allowHosts: [site.host] });
    const { target } = await siteTarget(site);
    const pro = await user('PRO');
    await prisma.watch.create({ data: { userId: pro.id, targetId: target.id, createdAt: new Date(Date.now() - 30 * 24 * HOUR) } });
    expect(await processRecheck(h.deps, target.id)).toEqual({ status: 'first' });
    // the site could not be read for 3 days (the fingerprint stayed); a Max user started watching yesterday
    await age(target.id, 72);
    const max = await user('MAX');
    await prisma.watch.create({ data: { userId: max.id, targetId: target.id, createdAt: new Date(Date.now() - 24 * HOUR) } });
    html = page({ headline: 'Orbit has a new team' });
    expect(await processRecheck(h.deps, target.id)).toMatchObject({ status: 'changed', alerted: 1, recheckId: null });
    expect((await notes()).map(n => n.userId)).toEqual([pro.id]);
    expect(h.queued).toEqual([]);
    const w = await prisma.watch.findUniqueOrThrow({ where: { userId_targetId: { userId: max.id, targetId: target.id } } });
    expect(w).toMatchObject({ lastAlertAt: null, lastRecheckAt: null });
  });

  it('automatic re-checks: at most MAX_AUTO_RECHECKS_PER_DAY a day, one per watch per 12 h, a running check is joined', async () => {
    const h = harness({ allowHosts: [site.host] });
    const { target } = await siteTarget(site);
    const { max } = await watchers(target.id);
    const max2 = await user('MAX');
    await prisma.watch.create({ data: { userId: max2.id, targetId: target.id } });
    await processRecheck(h.deps, target.id);

    // max used up today's automatic re-checks (3); max2's watch was re-checked 2 h ago
    const other = await prisma.target.create({ data: { key: 'site:other.xyz', kind: 'SITE', domain: 'other.xyz', name: 'other.xyz' } });
    await prisma.notification.createMany({ data: [1, 2, 3].map(i => ({ userId: max.id, targetId: other.id, kind: 'changed', checkId: `c${i}`, text: 'x' })) });
    await prisma.watch.update({ where: { userId_targetId: { userId: max2.id, targetId: target.id } }, data: { lastRecheckAt: new Date(Date.now() - 2 * HOUR) } });
    await age(target.id);
    html = page({ headline: 'Orbit is paused' });
    expect(await processRecheck(h.deps, target.id)).toMatchObject({ status: 'changed', alerted: 3, recheckId: null });
    expect(h.queued).toEqual([]);
    const plain = (await notes()).filter(x => x.targetId === target.id);
    expect(plain.every(x => x.checkId === null && !x.text.includes('re-checking'))).toBe(true);

    // 13 h later max2 is due again; a check of the target is already running: it is joined, nothing new starts
    await prisma.watch.update({ where: { userId_targetId: { userId: max2.id, targetId: target.id } }, data: { lastRecheckAt: new Date(Date.now() - 13 * HOUR) } });
    const running = await prisma.check.create({ data: { shortId: 'running', targetId: target.id, targetRaw: site.url, status: 'RUNNING', startedAt: new Date() } });
    await age(target.id);
    html = page({ headline: 'Orbit is back' });
    expect(await processRecheck(h.deps, target.id)).toMatchObject({ status: 'changed', recheckId: running.id });
    expect(h.queued).toEqual([]);
    const joined = await prisma.notification.findMany({ where: { checkId: running.id } });
    expect(joined.map(x => x.userId)).toEqual([max2.id]);
  });

  it('a target with only private verdicts is never re-checked in public (the alert still goes out)', async () => {
    const h = harness({ allowHosts: [site.host] });
    const { target, check } = await siteTarget(site);
    await prisma.check.update({ where: { id: check.id }, data: { isPrivate: true } });
    const { max } = await watchers(target.id);
    await processRecheck(h.deps, target.id);
    await age(target.id);
    html = page({ headline: 'Orbit is private now' });
    expect(await processRecheck(h.deps, target.id)).toMatchObject({ status: 'changed', recheckId: null });
    expect(await prisma.check.count()).toBe(1);
    expect((await notes()).find(x => x.userId === max.id)).toMatchObject({ kind: 'changed', checkId: null });
  });

  it('a re-check that cannot be queued ends FAILED and the alert no longer promises it', async () => {
    const h = harness({ allowHosts: [site.host], enqueue: async () => { throw new Error('Redis down'); } });
    const { target } = await siteTarget(site);
    const { max } = await watchers(target.id);
    await processRecheck(h.deps, target.id);
    await age(target.id);
    html = page({ headline: 'Orbit has a new team' });
    expect(await processRecheck(h.deps, target.id)).toMatchObject({ status: 'changed', recheckId: null });
    const failed = await prisma.check.findFirstOrThrow({ where: { status: 'FAILED' } });
    expect(failed.requesterId).toBe(max.id);
    expect((await notes()).find(x => x.userId === max.id)).toMatchObject({ checkId: null, text: 'watched.test changed since its last check' });
    expect((await prisma.watch.findFirstOrThrow({ where: { userId: max.id } })).lastRecheckAt).toBeNull();
  });
});

describe('contract and mint fingerprints', () => {
  const CA = '0x' + 'c0'.repeat(20);
  const basics = (owner: string | null, mint: boolean): EvmTokenBasics => ({ name: 'Orbit', symbol: 'ORBIT', decimals: 18, totalSupply: '1', owner, ownerRenounced: owner == null ? null : false, hasMintFunction: mint });

  async function coin(chain: 'BASE' | 'SOL', ca: string) {
    const target = await prisma.target.create({ data: { key: `ca:${chain.toLowerCase()}:${ca}`, kind: 'COIN', chain, ca, name: '$ORBIT', ticker: 'ORBIT' } });
    await prisma.check.create({ data: { shortId: `k${String(++seq).padStart(6, '0')}`, targetId: target.id, targetRaw: ca, status: 'DONE', finishedAt: new Date(), narScore: 30, narBand: 'llarp', isLatest: true } });
    await watchers(target.id);
    return target;
  }

  it('a fingerprint from an older version (v2: before the ZeppelinOS slot and issue()) is re-baselined, never an alert', async () => {
    const h = harness({ data: { evmCode: { [CA]: '0x6080aa' }, evmBasics: { [CA]: basics('0x' + '11'.repeat(20), true) } } });
    const t = await coin('BASE', CA);
    await prisma.target.update({ where: { id: t.id }, data: { fingerprint: `contract:v2:${'b'.repeat(64)}`, fingerprintAt: new Date(Date.now() - 7 * HOUR) } });
    expect(await processRecheck(h.deps, t.id)).toEqual({ status: 'first' });
    expect(fingerprintScheme((await prisma.target.findUniqueOrThrow({ where: { id: t.id } })).fingerprint)).toBe('contract:v3');
    expect(await notes()).toEqual([]);
  });

  it('EVM: a new owner or a mint function is a change; a failed RPC read is not', async () => {
    const data: FakeData = { evmCode: { [CA]: '0x6080aa' }, evmBasics: { [CA]: basics('0x' + '11'.repeat(20), false) } };
    const h = harness({ data });
    const t = await coin('BASE', CA);
    expect(await processRecheck(h.deps, t.id)).toEqual({ status: 'first' });
    expect(fingerprintScheme((await prisma.target.findUniqueOrThrow({ where: { id: t.id } })).fingerprint)).toBe('contract:v3');

    // the RPC fails: not compared
    data.evmCode![CA] = null;
    await age(t.id);
    expect(await processRecheck(h.deps, t.id)).toMatchObject({ status: 'error' });
    await redis.del(retryKey(t.id));

    data.evmCode![CA] = '0x6080aa';
    data.evmBasics![CA] = basics('0x' + '22'.repeat(20), true);
    await age(t.id);
    expect(await processRecheck(h.deps, t.id)).toMatchObject({ status: 'changed', alerted: 2 });
    expect((await notes()).map(n => n.text)).toContain("$ORBIT's contract changed since its last check");
  });

  it('Solana: a freeze authority that appears is a change', async () => {
    const MINT = 'So1anaMint1111111111111111111111111111111111';
    const data: FakeData = { solMints: { [MINT]: { exists: true, decimals: 6, supply: '1', mintAuthority: null, freezeAuthority: null, token2022: false } } };
    const h = harness({ data });
    const t = await coin('SOL', MINT);
    expect(await processRecheck(h.deps, t.id)).toEqual({ status: 'first' });
    await age(t.id);
    expect(await processRecheck(h.deps, t.id)).toEqual({ status: 'same' });
    data.solMints![MINT] = { ...data.solMints![MINT]!, freezeAuthority: 'Fr33ze1111111111111111111111111111111111111' };
    await age(t.id);
    expect(await processRecheck(h.deps, t.id)).toMatchObject({ status: 'changed' });
    expect((await notes()).map(n => n.text)).toContain("$ORBIT's mint or freeze authority changed since its last check");
  });

  it('Solana Token-2022: a new transfer fee or transfer hook is a change; withheld fees piling up are not', async () => {
    const MINT = 'Tok22Mint111111111111111111111111111111111111';
    const ext = (bps: number, hook: string) => [
      `transferFeeConfig transferFeeConfigAuthority=FeeAuth1 withdrawWithheldAuthority=none newerTransferFee.transferFeeBasisPoints=${bps} newerTransferFee.maximumFee=5000`,
      `transferHook authority=none programId=${hook}`,
    ];
    const mint = (bps: number, hook: string) => ({ exists: true, decimals: 6, supply: '1', mintAuthority: null, freezeAuthority: null, token2022: true, extensions: ext(bps, hook) });
    const data: FakeData = { solMints: { [MINT]: mint(100, 'Hook1') } };
    const h = harness({ data });
    const t = await coin('SOL', MINT);
    expect(await processRecheck(h.deps, t.id)).toEqual({ status: 'first' });
    await age(t.id);
    expect(await processRecheck(h.deps, t.id)).toEqual({ status: 'same' });
    data.solMints![MINT] = mint(9900, 'Hook1');
    await age(t.id);
    expect(await processRecheck(h.deps, t.id)).toMatchObject({ status: 'changed' });
    data.solMints![MINT] = mint(9900, 'Hook2');
    await age(t.id);
    expect(await processRecheck(h.deps, t.id)).toMatchObject({ status: 'changed' });
  });

  describe('EVM through the real adapter', () => {
    const IMPL_SLOT = '0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc';
    const OWNER_SEL = '0x8da5cb5b';
    const IMPL_A = '0x' + 'a1'.repeat(20);
    const IMPL_B = '0x' + 'b2'.repeat(20);
    const word = (hex: string) => '0x' + hex.replace(/^0x/, '').padStart(64, '0');
    interface Node { code: Record<string, string>; impl: string | null; owner: string; throttle: Set<'owner' | 'storage'> }
    /** a JSON-RPC node behind the real EvmAdapter; a throttled method answers HTTP 429 with a -32005 body (Alchemy, public nodes) */
    function rpcHttp(node: Node): Http {
      return {
        async request() {
          throw new Error('not used');
        },
        async json<T>(_url: string, req: { body?: string } = {}): Promise<T> {
          const { id, method, params } = JSON.parse(req.body ?? '{}') as { id: number; method: string; params: [Record<string, string> | string, string] };
          const result = (r: unknown) => ({ jsonrpc: '2.0', id, result: r }) as T;
          const limited = () => {
            throw new HttpError(429, 'https://rpc.test/', JSON.stringify({ jsonrpc: '2.0', id, error: { code: -32005, message: 'rate limit exceeded' } }));
          };
          if (method === 'eth_getCode') return result(node.code[String(params[0]).toLowerCase()] ?? '0x');
          if (method === 'eth_getStorageAt') {
            if (node.throttle.has('storage')) limited();
            return result(params[1] === IMPL_SLOT && node.impl ? word(node.impl) : word('0'));
          }
          if (method === 'eth_call') {
            if ((params[0] as Record<string, string>).data === OWNER_SEL) {
              if (node.throttle.has('owner')) limited();
              return result(word(node.owner));
            }
            return { jsonrpc: '2.0', id, error: { code: 3, message: 'execution reverted' } } as T;
          }
          throw new Error(`unexpected ${method}`);
        },
      };
    }
    const proxyNode = (): Node => ({
      // an EIP-1967 proxy (its own code never changes), owner() 0x33…, logic at IMPL_A
      code: { [CA]: '0x363d3d37' + 'cd'.repeat(120), [IMPL_A]: '0x6080' + 'aa'.repeat(300), [IMPL_B]: '0x6080' + 'bb'.repeat(300) },
      impl: IMPL_A,
      owner: '0x' + '33'.repeat(20),
      throttle: new Set(),
    });

    it('a throttled owner() read (HTTP 429, -32005) is a failed read, never a confirmed "owner gone"', async () => {
      const node = proxyNode();
      const evm = createEvm(testEnv(), rpcHttp(node));
      const healthy = await evmFingerprint({ evm }, 'base', CA);
      expect(healthy).toMatchObject({ ok: true, kind: 'contract' });
      node.throttle.add('owner');
      for (let i = 0; i < 2; i++) expect(await evmFingerprint({ evm }, 'base', CA)).toMatchObject({ ok: false, reason: expect.stringMatching(/owner/) });
      node.throttle = new Set(['storage']);
      expect(await evmFingerprint({ evm }, 'base', CA)).toMatchObject({ ok: false, reason: expect.stringMatching(/implementation/) });
      node.throttle.clear();
      expect(await evmFingerprint({ evm }, 'base', CA)).toEqual(healthy);
    });

    it('watchers: throttling never alerts; an upgrade of the proxy to new logic (same owner, same mint selectors) does', async () => {
      const node = proxyNode();
      const h = harness();
      h.deps.sources.evm = createEvm(h.deps.env, rpcHttp(node));
      const t = await coin('BASE', CA);
      expect(await processRecheck(h.deps, t.id)).toEqual({ status: 'first' });
      const first = (await prisma.target.findUniqueOrThrow({ where: { id: t.id } })).fingerprint;
      for (const part of ['owner', 'storage'] as const) {
        node.throttle = new Set([part]);
        await age(t.id);
        expect(await processRecheck(h.deps, t.id)).toMatchObject({ status: 'error' });
        await redis.del(retryKey(t.id));
      }
      node.throttle.clear();
      await age(t.id);
      expect(await processRecheck(h.deps, t.id)).toEqual({ status: 'same' });
      expect((await prisma.target.findUniqueOrThrow({ where: { id: t.id } })).fingerprint).toBe(first);
      expect(await notes()).toEqual([]);

      node.impl = IMPL_B;
      await age(t.id);
      expect(await processRecheck(h.deps, t.id)).toMatchObject({ status: 'changed', alerted: 2 });
      expect((await notes()).map(n => n.text)).toContain("$ORBIT's contract changed since its last check");
    });

    it('the implementation redeployed with new code at the same address is a change too', async () => {
      const node = proxyNode();
      const evm = createEvm(testEnv(), rpcHttp(node));
      const before = await evmFingerprint({ evm }, 'base', CA);
      node.code[IMPL_A] = '0x6080' + 'ee'.repeat(300);
      const after = await evmFingerprint({ evm }, 'base', CA);
      expect(before.ok && after.ok && before.value !== after.value).toBe(true);
    });
  });

  it('Tron: an owner() TronGrid did not run (rate limit) is a failed read; a revert is a steady "no owner"; a failed name() is not', async () => {
    const TRC = 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t';
    let owner: 'limited' | 'revert' | 'value' = 'value';
    let nameLimited = false;
    const http: Http = {
      async request() {
        throw new Error('not used');
      },
      async json<T>(url: string, req: { body?: string } = {}): Promise<T> {
        const body = JSON.parse(req.body ?? '{}') as { function_selector?: string };
        if (url.endsWith('/wallet/getcontract')) return { contract_address: TRC, origin_address: 'TBckp5W67rgZ8kE5CArzqWgCpBHPqarGht', bytecode: '6080604052' + '638da5cb5b' + '00', name: 'K' } as T;
        if (body.function_selector === 'owner()') {
          if (owner === 'limited') throw new HttpError(429, url, '{"Error":"request rate exceeded the allowed_rps(15)"}');
          if (owner === 'revert') return { result: { code: 'CONTRACT_EXE_ERROR', message: '' } } as T;
          return { result: { result: true }, constant_result: ['ab'.repeat(32)] } as T;
        }
        if (body.function_selector === 'name()' && nameLimited) throw new HttpError(429, url, '{"Error":"request rate exceeded the allowed_rps(15)"}');
        return { result: { code: 'CONTRACT_EXE_ERROR', message: '' } } as T;
      },
    };
    const tron = createTron(testEnv(), http);
    const healthy = await tronFingerprint({ tron }, TRC);
    expect(healthy.ok).toBe(true);
    owner = 'limited';
    expect(await tronFingerprint({ tron }, TRC)).toMatchObject({ ok: false, reason: expect.stringMatching(/tron\.tokenInfo owner/) });
    owner = 'revert';
    const reverted = await tronFingerprint({ tron }, TRC);
    expect(reverted.ok).toBe(true);
    expect(await tronFingerprint({ tron }, TRC)).toEqual(reverted);
    owner = 'value';
    expect(await tronFingerprint({ tron }, TRC)).toEqual(healthy);
    // a rate-limited name() is reported, but the name is not part of the fingerprint: still a good read
    nameLimited = true;
    expect(await tronFingerprint({ tron }, TRC)).toEqual(healthy);
  });
});

describe('automatic re-checks under concurrency', () => {
  it('reserving a slot is atomic per user and day; a released slot can be taken again', async () => {
    const h = harness({ env: { MAX_AUTO_RECHECKS_PER_DAY: '3' } });
    const now = Date.now();
    // one already used today (the durable count), five targets changing at once
    const tries = await Promise.all(Array.from({ length: 5 }, () => reserveAutoRecheck(h.deps, 'user-1', 1, now)));
    expect(tries.filter(r => r.ok)).toHaveLength(2);
    expect((await reserveAutoRecheck(h.deps, 'user-1', 1, now)).ok).toBe(false);
    await tries.find(r => r.ok)!.release();
    expect((await reserveAutoRecheck(h.deps, 'user-1', 1, now)).ok).toBe(true);
    // another user, another day: their own counters
    expect((await reserveAutoRecheck(h.deps, 'user-2', 0, now)).ok).toBe(true);
    expect((await reserveAutoRecheck(h.deps, 'user-1', 0, now + 24 * HOUR)).ok).toBe(true);
  });

  it('targets changing at the same time never give a Max user more automatic re-checks than are left today', async () => {
    const cas = ['c1', 'c2', 'c3', 'c4'].map(x => '0x' + x.repeat(20));
    const basics = (owner: string): EvmTokenBasics => ({ name: 'X', symbol: 'X', decimals: 18, totalSupply: '1', owner, ownerRenounced: false, hasMintFunction: false });
    const data: FakeData = { evmCode: {}, evmBasics: {} };
    for (const ca of cas) {
      data.evmCode![ca] = '0x6080aa';
      data.evmBasics![ca] = basics('0x' + '11'.repeat(20));
    }
    const h = harness({ data, env: { MAX_AUTO_RECHECKS_PER_DAY: '3' } });
    const max = await user('MAX');
    const targets = [];
    for (const ca of cas) {
      const t = await prisma.target.create({ data: { key: `ca:base:${ca}`, kind: 'COIN', chain: 'BASE', ca, name: `$${ca.slice(2, 6)}` } });
      await prisma.check.create({ data: { shortId: `r${String(++seq).padStart(6, '0')}`, targetId: t.id, targetRaw: ca, status: 'DONE', finishedAt: new Date(), narScore: 30, narBand: 'llarp', isLatest: true } });
      await prisma.watch.create({ data: { userId: max.id, targetId: t.id } });
      targets.push(t);
      expect(await processRecheck(h.deps, t.id)).toEqual({ status: 'first' });
    }
    // 2 of today's 3 automatic re-checks already used on another target
    const other = await prisma.target.create({ data: { key: 'site:other.xyz', kind: 'SITE', domain: 'other.xyz', name: 'other.xyz' } });
    await prisma.notification.createMany({ data: [1, 2].map(i => ({ userId: max.id, targetId: other.id, kind: 'changed', checkId: `c${i}`, text: 'x' })) });
    // every contract changes owner; the scan fingerprints them in parallel
    for (const ca of cas) data.evmBasics![ca] = basics('0x' + '22'.repeat(20));
    for (const t of targets) await age(t.id);
    const outs = await Promise.all(targets.map(t => processRecheck(h.deps, t.id)));
    expect(outs.map(o => o.status)).toEqual(['changed', 'changed', 'changed', 'changed']);
    expect(outs.filter(o => o.status === 'changed' && o.recheckId)).toHaveLength(1);
    expect(h.queued).toHaveLength(1);
    expect(await autoRechecksToday(prisma, max.id, Date.now())).toBe(3);
  });
});

describe('the scan', () => {
  it('picks due targets with a Pro or Max watcher, oldest fingerprint first; never X posts / profiles (no paid X reads)', async () => {
    const h = harness();
    const mk = (key: string, data: object) => prisma.target.create({ data: { key, name: key, ...data } as never });
    const due = await mk('site:due.xyz', { kind: 'SITE', domain: 'due.xyz', fingerprintAt: new Date(Date.now() - 7 * HOUR) });
    const never = await mk('site:never.xyz', { kind: 'SITE', domain: 'never.xyz' });
    const fresh = await mk('site:fresh.xyz', { kind: 'SITE', domain: 'fresh.xyz', fingerprintAt: new Date(Date.now() - HOUR) });
    const freeOnly = await mk('site:free.xyz', { kind: 'SITE', domain: 'free.xyz' });
    const unknownChain = await mk('ca:evm:0xabc', { kind: 'COIN', ca: '0xabc' });
    const profile = await mk('x:kairolabs', { kind: 'POST', handle: 'kairolabs' });
    const pro = await user('PRO');
    const free = await user('FREE');
    for (const t of [due, never, fresh, unknownChain, profile]) await prisma.watch.create({ data: { userId: pro.id, targetId: t.id } });
    await prisma.watch.create({ data: { userId: free.id, targetId: freeOnly.id } });
    expect(await scanWatched(h.deps)).toEqual([never.id, due.id]);
    // not even with X_BEARER_TOKEN set: a profile would need the paid X API, which only the bot uses
    const withX = harness({ data: { xConfigured: true } });
    expect(await scanWatched(withX.deps)).toEqual([never.id, due.id]);
    expect(fingerprintKind({ kind: 'POST', chain: null, ca: null, domain: 'kairo.xyz', handle: 'kairolabs' })).toBeNull();
    expect((withX.deps.sources as FakeSources).calls.filter(c => c.startsWith('x.'))).toEqual([]);
  });
});

describe('texts', () => {
  it('rechecked', () => {
    expect(recheckedText('orbitswap.xyz', { status: 'DONE', narScore: 72, narBand: 'likely' }, { narScore: 48, narBand: 'partly' })).toBe('Re-checked orbitswap.xyz: Likely real 72, was Partly real 48');
    expect(recheckedText('$ORBIT', { status: 'DONE', narScore: 12, narBand: 'larp' }, null)).toBe('Re-checked $ORBIT: LARP 12');
    expect(recheckedText('$ORBIT', { status: 'FAILED', narScore: null, narBand: null }, null)).toBe("The re-check of $ORBIT couldn't finish; the last verdict stands");
    // a re-check that could test nothing about the project finished its work: not "couldn't finish"
    const none = { status: 'FAILED', narScore: null, narBand: null, error: "Not enough to check: orbitswap.xyz didn't load, and no GitHub repo or contract on a supported chain was found for it." };
    expect(recheckedText('orbitswap.xyz', none, { narScore: 72, narBand: 'likely' })).toBe('The re-check of orbitswap.xyz found nothing to test; the last verdict stands');
  });
});
