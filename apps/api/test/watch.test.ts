/** M3 watchlist, report.watching and re-check alerts (notifications). */
import { Queue } from 'bullmq';
import { Redis } from 'ioredis';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { QUEUES, type CheckReportDTO, type FeedResponse, type MeDTO, type NotificationsResponse, type RecheckJob, type WatchlistResponse } from '@apecheck/core';
import { TEST_REDIS_URL } from './global-setup';
import { USER_RATE, userLimitKey } from '../src/limits';
import { WATCH_MAX, latestVisibleChecks, recheckJobId } from '../src/routes/watch';
import { Client, EvmWallet, SolWallet, makeHarness, resetState, seedCheck, seedTarget, signedIn, type Harness } from './helpers';

let h: Harness;
beforeAll(async () => {
  h = await makeHarness();
});
afterAll(async () => h.close());
beforeEach(async () => resetState(h));

const minAgo = (m: number) => new Date(Date.now() - m * 60_000);

describe('signed-in only', () => {
  it('401 sign_in_required for every watch and alert route when signed out', async () => {
    const c = new Client(h.app);
    for (const [method, url] of [['POST', '/v1/watch/cm00000000000000000000000'], ['DELETE', '/v1/watch/cm00000000000000000000000'], ['GET', '/v1/watchlist']] as const) {
      const res = await c.req({ method, url });
      expect(res.statusCode, url).toBe(401);
      expect(res.json()).toEqual({ code: 'sign_in_required', error: 'Sign in with a wallet to keep a watchlist.' });
    }
    for (const [method, url] of [['GET', '/v1/notifications'], ['POST', '/v1/notifications/read']] as const) {
      const res = await c.req({ method, url });
      expect(res.statusCode, url).toBe(401);
      expect(res.json()).toEqual({ code: 'sign_in_required', error: 'Sign in with a wallet to see your alerts.' });
    }
  });
});

describe('watch / unwatch / watchlist', () => {
  it('watches a target, shows it on the report and in the watchlist; unwatching removes it', async () => {
    const c = new Client(h.app);
    await signedIn(c, new EvmWallet());
    const t = await seedTarget(h.prisma);
    const old = await seedCheck(h.prisma, { targetId: t.id, isLatest: false, finishedAt: minAgo(90) });
    const latest = await seedCheck(h.prisma, { targetId: t.id, finishedAt: minAgo(10) });
    const t2 = await seedTarget(h.prisma);
    const other = await seedCheck(h.prisma, { targetId: t2.id, finishedAt: minAgo(5) });

    expect((await c.get(`/v1/checks/${old.shortId}`)).json<CheckReportDTO>().watching).toBe(false);
    expect((await c.post(`/v1/watch/${t.id}`)).json()).toEqual({ watching: true });
    expect((await c.post(`/v1/watch/${t.id}`)).json()).toEqual({ watching: true }); // idempotent
    expect((await c.post(`/v1/watch/${t2.id}`)).json()).toEqual({ watching: true });
    expect(await h.prisma.watch.count()).toBe(2);

    expect((await c.get(`/v1/checks/${old.shortId}`)).json<CheckReportDTO>().watching).toBe(true);
    // anonymous viewers get no watching flag; other users see false
    expect((await new Client(h.app).get(`/v1/checks/${old.shortId}`)).json<CheckReportDTO>().watching).toBeUndefined();
    const someone = new Client(h.app);
    await signedIn(someone, new SolWallet());
    expect((await someone.get(`/v1/checks/${old.shortId}`)).json<CheckReportDTO>().watching).toBe(false);

    const wl = (await c.get('/v1/watchlist')).json<WatchlistResponse>();
    // the latest check of each watched target, newest first
    expect(wl.items.map(i => i.id)).toEqual([other.shortId, latest.shortId]);
    expect(wl.targetIds.sort()).toEqual([t.id, t2.id].sort());

    expect((await c.delete(`/v1/watch/${t.id}`)).json()).toEqual({ watching: false });
    expect((await c.delete(`/v1/watch/${t.id}`)).json()).toEqual({ watching: false });
    expect((await c.get('/v1/watchlist')).json<WatchlistResponse>()).toMatchObject({ items: [{ id: other.shortId }], targetIds: [t2.id] });
  });

  it('a watched target without a finished check is listed by id only; your own private check is shown, others’ never', async () => {
    const c = new Client(h.app);
    const me = await signedIn(c, new EvmWallet());
    const t = await seedTarget(h.prisma);
    await seedCheck(h.prisma, { targetId: t.id, status: 'RUNNING' });
    await c.post(`/v1/watch/${t.id}`);
    expect((await c.get('/v1/watchlist')).json<WatchlistResponse>()).toEqual({ items: [], targetIds: [t.id] });

    const mine = await seedTarget(h.prisma);
    const priv = await seedCheck(h.prisma, { targetId: mine.id, isPrivate: true, requesterId: me.user!.id });
    expect((await c.post(`/v1/watch/${mine.id}`)).statusCode).toBe(200);
    expect((await c.get('/v1/watchlist')).json<WatchlistResponse>().items.map(i => i.id)).toEqual([priv.shortId]);

    const theirs = await seedTarget(h.prisma);
    await seedCheck(h.prisma, { targetId: theirs.id, isPrivate: true, requesterSid: 'someone' });
    const res = await c.post(`/v1/watch/${theirs.id}`);
    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ code: 'not_found', error: "This project hasn't been checked yet." });
    expect((await c.post('/v1/watch/not-a-target')).statusCode).toBe(404);
  });

  it('GET /v1/feed?tab=watch without ids reads the signed-in account’s watchlist', async () => {
    const c = new Client(h.app);
    await signedIn(c, new EvmWallet());
    const t = await seedTarget(h.prisma);
    const row = await seedCheck(h.prisma, { targetId: t.id });
    const t2 = await seedTarget(h.prisma);
    await seedCheck(h.prisma, { targetId: t2.id });
    expect((await c.get('/v1/feed?tab=watch')).json<FeedResponse>()).toEqual({ items: [], total: 0, nextCursor: null });
    await c.post(`/v1/watch/${t.id}`);
    const feed = (await c.get('/v1/feed?tab=watch')).json<FeedResponse>();
    expect(feed.items.map(i => i.id)).toEqual([row.shortId]);
    // signed out: still the ids the browser sends
    expect((await new Client(h.app).get('/v1/feed?tab=watch')).json<FeedResponse>().total).toBe(0);
  });

  it(`at most ${WATCH_MAX} watched targets`, async () => {
    const c = new Client(h.app);
    const me = await signedIn(c, new EvmWallet());
    const targets = await Promise.all(Array.from({ length: WATCH_MAX }, () => seedTarget(h.prisma)));
    await h.prisma.watch.createMany({ data: targets.map(t => ({ userId: me.user!.id, targetId: t.id })) });
    const t = await seedTarget(h.prisma);
    await seedCheck(h.prisma, { targetId: t.id });
    const res = await c.post(`/v1/watch/${t.id}`);
    expect(res.statusCode).toBe(409);
    expect(res.json()).toEqual({ code: 'watchlist_full', error: 'Your watchlist is full. Remove a project to add another.' });
    // re-watching one already there is fine
    await seedCheck(h.prisma, { targetId: targets[0].id });
    expect((await c.post(`/v1/watch/${targets[0].id}`)).statusCode).toBe(200);
  });

  it('watching a target already on the list costs no per-user burst (a browser list moving over again)', async () => {
    const c = new Client(h.app);
    const me = await signedIn(c, new EvmWallet());
    const t = await seedTarget(h.prisma);
    await seedCheck(h.prisma, { targetId: t.id });
    expect((await c.post(`/v1/watch/${t.id}`)).statusCode).toBe(200);
    // the minute's watch burst is used up
    const key = userLimitKey('watch', me.user!.id);
    const now = Date.now();
    await h.redis.zadd(key, ...Array.from({ length: USER_RATE.watch }, (_, i) => [now, `fill-${i}`]).flat());
    const again = await c.post(`/v1/watch/${t.id}`);
    expect(again.statusCode).toBe(200);
    expect(again.json()).toEqual({ watching: true });
    const t2 = await seedTarget(h.prisma);
    await seedCheck(h.prisma, { targetId: t2.id });
    const fresh = await c.post(`/v1/watch/${t2.id}`);
    expect(fresh.statusCode).toBe(429);
    expect(fresh.json().code).toBe('rate_limited');
    expect(await h.prisma.watch.count({ where: { userId: me.user!.id } })).toBe(1);
  });
});

describe('notifications', () => {
  it('lists my alerts newest first with the check to open, counts unread, marks them read', async () => {
    const c = new Client(h.app);
    const me = await signedIn(c, new EvmWallet());
    const other = await h.prisma.user.create({ data: { evmAddress: '0x' + '9'.repeat(40) } });
    const t = await seedTarget(h.prisma);
    const before = await seedCheck(h.prisma, { targetId: t.id, isLatest: false, finishedAt: minAgo(120) });
    const recheck = await seedCheck(h.prisma, { targetId: t.id, finishedAt: minAgo(5) });
    const n1 = await h.prisma.notification.create({ data: { userId: me.user!.id, targetId: t.id, kind: 'changed', text: 'site1.xyz changed its site since the last check.', createdAt: minAgo(30) } });
    const n2 = await h.prisma.notification.create({ data: { userId: me.user!.id, targetId: t.id, checkId: before.id, kind: 'rechecked', text: 'Re-check done: still Likely real.', createdAt: minAgo(3) } });
    await h.prisma.notification.create({ data: { userId: other.id, targetId: t.id, kind: 'changed', text: 'not yours' } });

    expect((await c.get('/v1/me')).json<MeDTO>().notificationsUnread).toBe(2);
    const list = (await c.get('/v1/notifications')).json<NotificationsResponse>();
    expect(list).toEqual({
      unread: 2,
      items: [
        { id: n2.id, kind: 'rechecked', text: 'Re-check done: still Likely real.', targetId: t.id, checkId: before.shortId, createdAt: n2.createdAt.toISOString(), read: false },
        { id: n1.id, kind: 'changed', text: 'site1.xyz changed its site since the last check.', targetId: t.id, checkId: recheck.shortId, createdAt: n1.createdAt.toISOString(), read: false },
      ],
    });

    expect((await c.post('/v1/notifications/read', { ids: [n1.id] })).json()).toEqual({ unread: 1 });
    // someone else's ids are ignored
    const others = await h.prisma.notification.findFirstOrThrow({ where: { userId: other.id } });
    expect((await c.post('/v1/notifications/read', { ids: [others.id] })).json()).toEqual({ unread: 1 });
    expect((await h.prisma.notification.findUniqueOrThrow({ where: { id: others.id } })).readAt).toBeNull();
    expect((await c.post('/v1/notifications/read', {})).json()).toEqual({ unread: 0 });
    expect((await c.get('/v1/notifications?limit=1')).json<NotificationsResponse>()).toMatchObject({ unread: 0, items: [{ id: n2.id, read: true }] });
    expect((await c.get('/v1/me')).json<MeDTO>().notificationsUnread).toBe(0);
    expect((await c.post('/v1/notifications/read', { ids: 'nope' })).statusCode).toBe(400);
  });
});

describe('the latest check per watched target is picked in SQL', () => {
  let hq: Harness;
  beforeAll(async () => {
    hq = await makeHarness({}, { logQueries: true });
  });
  afterAll(async () => hq.close());

  it('one row per target (public, or my own private one, newest finished), never every check of every target', async () => {
    const c = new Client(hq.app);
    const me = await signedIn(c, new EvmWallet());
    const other = await hq.prisma.user.create({ data: { evmAddress: '0x' + '8'.repeat(40) } });
    // a popular target: many finished checks, then my private re-check, then someone else's private one and a running one
    const busy = await seedTarget(hq.prisma);
    await hq.prisma.check.createMany({
      data: Array.from({ length: 60 }, (_, i) => ({
        shortId: `bz${String(i).padStart(5, '0')}`, targetId: busy.id, targetRaw: 'raw', status: 'DONE' as const, via: 'WEB' as const,
        isLatest: false, startedAt: minAgo(500 - i), finishedAt: minAgo(400 - i),
      })),
    });
    const publicLatest = await seedCheck(hq.prisma, { targetId: busy.id, finishedAt: minAgo(30) });
    const mine = await seedCheck(hq.prisma, { targetId: busy.id, isPrivate: true, isLatest: false, requesterId: me.user!.id, finishedAt: minAgo(20) });
    await seedCheck(hq.prisma, { targetId: busy.id, isPrivate: true, isLatest: false, requesterId: other.id, finishedAt: minAgo(10) });
    await seedCheck(hq.prisma, { targetId: busy.id, status: 'RUNNING' });
    // a quiet target: two public checks with the same finish time (the id breaks the tie)
    const quiet = await seedTarget(hq.prisma);
    const same = minAgo(60);
    const q1 = await seedCheck(hq.prisma, { targetId: quiet.id, isLatest: false, finishedAt: same });
    const q2 = await seedCheck(hq.prisma, { targetId: quiet.id, finishedAt: same });
    const quietLatest = [q1, q2].sort((a, b) => (a.id < b.id ? 1 : -1))[0];
    // a target with nothing finished
    const empty = await seedTarget(hq.prisma);
    await seedCheck(hq.prisma, { targetId: empty.id, status: 'FAILED', isLatest: false });

    const picked = await latestVisibleChecks(hq.prisma, [busy.id, quiet.id, empty.id], me.user!.id);
    expect(picked.map(p => [p.targetId, p.shortId]).sort()).toEqual([[busy.id, mine.shortId], [quiet.id, quietLatest.shortId]].sort());
    // another viewer sees the public verdict
    expect((await latestVisibleChecks(hq.prisma, [busy.id], 'someone-else')).map(p => p.shortId)).toEqual([publicLatest.shortId]);
    // the other user sees their own private one
    expect((await latestVisibleChecks(hq.prisma, [busy.id], other.id)).map(p => p.shortId)).not.toEqual([publicLatest.shortId]);
    expect(await latestVisibleChecks(hq.prisma, [], me.user!.id)).toEqual([]);

    for (const t of [busy, quiet, empty]) await c.post(`/v1/watch/${t.id}`);
    await hq.prisma.notification.create({ data: { userId: me.user!.id, targetId: busy.id, kind: 'changed', text: 'busy changed.' } });
    hq.queries.length = 0;
    const wl = (await c.get('/v1/watchlist')).json<WatchlistResponse>();
    expect(wl.items.map(i => i.id)).toEqual([mine.shortId, quietLatest.shortId]);
    const alerts = (await c.get('/v1/notifications')).json<NotificationsResponse>();
    expect(alerts.items.map(n => n.checkId)).toEqual([mine.shortId]);
    // no query reads a target's checks without picking one per target in SQL
    const byTarget = hq.queries.filter(q => /"Check"/.test(q) && /"targetId"\s*IN/i.test(q));
    expect(byTarget.length).toBeGreaterThanOrEqual(2);
    for (const q of byTarget) expect(q).toMatch(/DISTINCT ON \("targetId"\)/);
  });
});

describe('first fingerprint', () => {
  it('a Pro/Max user who starts watching a target never fingerprinted queues its first fingerprint (worker-prices)', async () => {
    const conn = new Redis(TEST_REDIS_URL, { maxRetriesPerRequest: null });
    const rechecks = new Queue<RecheckJob>(QUEUES.rechecks, { connection: conn });
    try {
      const pro = new Client(h.app);
      const me = await signedIn(pro, new EvmWallet());
      // a fresh tier read: the route takes the stored tier as it is
      await h.prisma.user.update({ where: { id: me.user!.id }, data: { tier: 'PRO', tierCheckedAt: new Date() } });
      const free = new Client(h.app);
      await signedIn(free, new SolWallet());

      const fresh = await seedTarget(h.prisma);
      await seedCheck(h.prisma, { targetId: fresh.id });
      const seen = await seedTarget(h.prisma, { fingerprint: 'site:v1:abc', fingerprintAt: minAgo(30) });
      await seedCheck(h.prisma, { targetId: seen.id });
      const byFree = await seedTarget(h.prisma);
      await seedCheck(h.prisma, { targetId: byFree.id });

      expect((await pro.post(`/v1/watch/${fresh.id}`)).statusCode).toBe(200);
      expect((await pro.post(`/v1/watch/${seen.id}`)).statusCode).toBe(200);
      expect((await free.post(`/v1/watch/${byFree.id}`)).statusCode).toBe(200);

      const job = await rechecks.getJob(recheckJobId(fresh.id));
      expect(job?.name).toBe('target');
      expect(job?.data).toEqual({ targetId: fresh.id });
      // already fingerprinted (the scan keeps it current), or only Free watchers (no alerts): nothing queued
      expect(await rechecks.getJob(recheckJobId(seen.id))).toBeUndefined();
      expect(await rechecks.getJob(recheckJobId(byFree.id))).toBeUndefined();
      // watching again queues nothing new (one job per target)
      await pro.delete(`/v1/watch/${fresh.id}`);
      expect((await pro.post(`/v1/watch/${fresh.id}`)).statusCode).toBe(200);
      expect(await rechecks.getJobCounts('waiting', 'prioritized', 'delayed')).toMatchObject({ waiting: 1 });
    } finally {
      await rechecks.close();
      await conn.quit();
    }
  });
});
