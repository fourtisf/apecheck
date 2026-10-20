/**
 * Webhooks (M4, HANDOFF §9, §11): which events make deliveries, and the delivery itself through the real queue and the
 * real SSRF-guarded client to a local receiver (allow-listed with SSRF_ALLOW_HOSTS, as tests only may):
 *  - check.completed for the requester's own checks only (a private check reaches only its owner), Max only, once;
 *  - payload shape (WebhookPayload), headers, a signature that verifies (core verifyWebhook and an HMAC computed here);
 *  - retries on 500 with backoff, the same delivery id every time; no retry storm (exactly 6 spaced attempts);
 *  - 20 failed deliveries in a row disable the webhook (no more events; pending ones fail without a request);
 *  - SSRF: private / loopback / metadata URLs, and a name that now resolves to a private address, are refused without
 *    a request and not retried; https only in production; redirects not followed;
 *  - pings: one attempt, never held against the webhook;
 *  - watch.changed from the change detector (Max watchers' webhooks only);
 *  - the sweep re-queues lost deliveries; Stage F and the failure path queue check.completed.
 */
import http from 'node:http';
import net from 'node:net';
import { createHmac } from 'node:crypto';
import { Redis } from 'ioredis';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { WEBHOOK_SIGNATURE_HEADER, type WebhookPayload } from '@apecheck/core';
import { verifyWebhook } from '@apecheck/core/node';
import { createHttp } from '@apecheck/sources';
import { memoryLogger } from '../src/log';
import { runCheck, type PipelineDeps } from '../src/pipeline';
import { fireCheckWebhooks } from '../src/pipeline/save';
import { processRecheck, type RecheckDeps } from '../src/watch/recheck';
import {
  WEBHOOK_DISABLE_AFTER,
  WEBHOOK_JOB_OPTIONS,
  WEBHOOK_MAX_ATTEMPTS,
  checkCompletedDeliveries,
  deliveryIdFor,
  enqueueDeliveries,
  processDelivery,
  startWebhooksWorker,
  webhookRetryDelayMs,
  type WebhooksWorkerHandle,
} from '../src/webhooks/index';
import { closedPort, serveHandler, type FixtureSite } from './fixture-server';
import { fakeSources } from './fakes';
import { createCheck, heuristicAi, prisma, resetDb, testEnv } from './helpers';

const SECRET = 'whsec_' + 'k'.repeat(32);
const HOUR = 3600_000;

/* ---------------- a local receiver ---------------- */

interface Received {
  path: string;
  method: string;
  headers: http.IncomingHttpHeaders;
  body: string;
  at: number;
}
type Responder = (r: Received, n: number) => { status: number; body?: string; headers?: Record<string, string> };

async function receiver() {
  const requests: Received[] = [];
  const routes = new Map<string, Responder>();
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => {
      const r: Received = { path: req.url ?? '/', method: req.method ?? '', headers: req.headers, body: Buffer.concat(chunks).toString('utf8'), at: Date.now() };
      requests.push(r);
      const n = requests.filter(x => x.path === r.path).length;
      const ok: Responder = () => ({ status: 200, body: 'ok' });
      const out = (routes.get(r.path) ?? ok)(r, n);
      res.writeHead(out.status, { 'content-type': 'text/plain', ...out.headers });
      res.end(out.body ?? '');
    });
  });
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as net.AddressInfo).port;
  return {
    port,
    requests,
    routes,
    url: (path: string) => `http://127.0.0.1:${port}${path}`,
    on: (path: string) => requests.filter(r => r.path === path),
    close: () => new Promise<void>(r => { server.closeAllConnections(); server.close(() => r()); }),
  };
}

/* ---------------- rows ---------------- */

let seq = 0;
async function user(tier: 'FREE' | 'PRO' | 'MAX') {
  seq++;
  return prisma.user.create({ data: { evmAddress: '0x' + seq.toString(16).padStart(40, '0'), tier } });
}
function hook(userId: string, url: string, events: string[], extra: { disabledAt?: Date; failCount?: number; createdAt?: Date } = {}) {
  return prisma.webhook.create({ data: { userId, url, secret: SECRET, events, ...extra } });
}
/** a finished check (Partly real 48 · coin 44 · total 46) requested by `requesterId` */
async function finished(requesterId: string | null, o: { status?: 'DONE' | 'FAILED' | 'RUNNING'; isPrivate?: boolean; finishedAt?: Date; raw?: string } = {}) {
  seq++;
  const raw = o.raw ?? `orbit${seq}.xyz`;
  const target = await prisma.target.create({ data: { key: `site:${raw}`, kind: 'SITE', domain: raw, name: raw } });
  const status = o.status ?? 'DONE';
  const done = status === 'DONE';
  return prisma.check.create({
    data: {
      shortId: `w${String(seq).padStart(6, '0')}`,
      targetId: target.id,
      targetRaw: raw,
      status,
      requesterId,
      isPrivate: o.isPrivate ?? false,
      finishedAt: status === 'RUNNING' ? null : (o.finishedAt ?? new Date()),
      ...(done
        ? { narScore: 48, narBand: 'partly', coinScore: 44, coinBand: 'sketchy', totalScore: 46, summary: "The app loads but the main flow stops at 'Coming soon'." }
        : status === 'FAILED'
          ? { error: 'The check hit an error and could not finish' }
          : {}),
    },
  });
}

async function waitFor<T>(fn: () => Promise<T | null | undefined | false> | T | null | undefined | false, ms = 15_000, what = 'condition'): Promise<T> {
  const until = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v as T;
    if (Date.now() > until) throw new Error(`timed out waiting for ${what}`);
    await new Promise(r => setTimeout(r, 25));
  }
}
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
const delivery = (id: string) => prisma.webhookDelivery.findUniqueOrThrow({ where: { id } });
const settled = (id: string) => waitFor(async () => { const d = await delivery(id); return d.status !== 'pending' ? d : null; }, 20_000, `delivery ${id}`);

let redis: Redis;
beforeAll(async () => {
  redis = new Redis(process.env.REDIS_URL!, { maxRetriesPerRequest: 2 });
});
afterAll(async () => {
  await redis.quit();
  await prisma.$disconnect();
});

/* ---------------- unit ---------------- */

describe('retry schedule', () => {
  it('1 min, then ×4: the sixth and last attempt is ~5.7 h after the first; jitter at most 10 %', () => {
    const plain = [1, 2, 3, 4, 5].map(n => webhookRetryDelayMs(n, () => 0));
    expect(plain).toEqual([60_000, 240_000, 960_000, 3_840_000, 15_360_000]);
    const total = plain.reduce((a, b) => a + b, 0);
    expect(total / HOUR).toBeGreaterThan(5.5);
    expect(total / HOUR).toBeLessThan(6.5);
    expect(webhookRetryDelayMs(1, () => 0.999)).toBeLessThanOrEqual(66_000);
    // never beyond the last retry, whatever BullMQ passes
    expect(webhookRetryDelayMs(40, () => 0)).toBe(15_360_000);
    expect(WEBHOOK_JOB_OPTIONS).toMatchObject({ attempts: 6, backoff: { type: 'webhook' } });
    expect(WEBHOOK_MAX_ATTEMPTS).toBe(6);
    expect(WEBHOOK_DISABLE_AFTER).toBe(20);
  });

  it('delivery ids are derived from webhook, event and check', () => {
    expect(deliveryIdFor('w1', 'check.completed', 'c1')).toBe(deliveryIdFor('w1', 'check.completed', 'c1'));
    expect(deliveryIdFor('w1', 'check.completed', 'c1')).not.toBe(deliveryIdFor('w2', 'check.completed', 'c1'));
    expect(deliveryIdFor('w1', 'check.completed', 'c1')).toMatch(/^wd_[0-9a-f]{24}$/);
  });
});

/* ---------------- which deliveries an event makes ---------------- */

describe('check.completed: who gets it', () => {
  beforeEach(async () => {
    await resetDb();
  });

  it("only the requester's enabled webhooks subscribed to it, Max only, once per check", async () => {
    const a = await user('MAX');
    const b = await user('MAX');
    const a1 = await hook(a.id, 'https://a.example/1', ['check.completed']);
    await hook(a.id, 'https://a.example/2', ['watch.changed']);
    await hook(a.id, 'https://a.example/3', ['check.completed'], { disabledAt: new Date(), failCount: 20 });
    const a4 = await hook(a.id, 'https://a.example/4', ['check.completed', 'watch.changed']);
    await hook(b.id, 'https://b.example/1', ['check.completed']);

    const c = await finished(a.id);
    const ids = await checkCompletedDeliveries(prisma, c.id);
    expect(ids.sort()).toEqual([deliveryIdFor(a1.id, 'check.completed', c.id), deliveryIdFor(a4.id, 'check.completed', c.id)].sort());
    const rows = await prisma.webhookDelivery.findMany();
    expect(rows).toHaveLength(2);
    for (const r of rows) expect(r).toMatchObject({ event: 'check.completed', checkId: c.id, targetId: null, status: 'pending', attempts: 0 });

    // finishing the same check again (a job re-run, the stuck-check recovery) makes no second delivery
    expect((await checkCompletedDeliveries(prisma, c.id)).sort()).toEqual(ids.sort());
    expect(await prisma.webhookDelivery.count()).toBe(2);
    await prisma.webhookDelivery.update({ where: { id: ids[0] }, data: { status: 'ok' } });
    expect(await checkCompletedDeliveries(prisma, c.id)).toEqual([ids[1]]);

    // a failed check is completed too
    const failed = await finished(a.id, { status: 'FAILED' });
    expect(await checkCompletedDeliveries(prisma, failed.id)).toHaveLength(2);
    // not finished, no requester, a requester below Max, a webhook added after the check finished: nothing
    expect(await checkCompletedDeliveries(prisma, (await finished(a.id, { status: 'RUNNING' })).id)).toEqual([]);
    expect(await checkCompletedDeliveries(prisma, (await finished(null)).id)).toEqual([]);
    const pro = await user('PRO');
    await hook(pro.id, 'https://p.example/1', ['check.completed']);
    expect(await checkCompletedDeliveries(prisma, (await finished(pro.id)).id)).toEqual([]);
    const late = await user('MAX');
    const old = await finished(late.id, { finishedAt: new Date(Date.now() - HOUR) });
    await hook(late.id, 'https://l.example/1', ['check.completed']);
    expect(await checkCompletedDeliveries(prisma, old.id)).toEqual([]);
  });

  it("a private check only ever reaches its owner's webhooks", async () => {
    const owner = await user('MAX');
    const other = await user('MAX');
    const mine = await hook(owner.id, 'https://owner.example/hook', ['check.completed']);
    await hook(other.id, 'https://other.example/hook', ['check.completed', 'watch.changed']);
    const c = await finished(owner.id, { isPrivate: true });
    // the other Max user even watches the same target
    await prisma.watch.create({ data: { userId: other.id, targetId: c.targetId } });
    expect(await checkCompletedDeliveries(prisma, c.id)).toEqual([deliveryIdFor(mine.id, 'check.completed', c.id)]);
    expect(await prisma.webhookDelivery.findMany({ select: { webhookId: true } })).toEqual([{ webhookId: mine.id }]);
  });
});

/* ---------------- delivery through the real queue ---------------- */

describe('delivery', () => {
  let rx: Awaited<ReturnType<typeof receiver>>;
  let env: ReturnType<typeof testEnv>;
  let wk: WebhooksWorkerHandle;
  const log = memoryLogger();
  const RETRY_MS = 120;

  beforeAll(async () => {
    rx = await receiver();
    env = testEnv({ SSRF_ALLOW_HOSTS: `127.0.0.1:${rx.port}`, APP_URL: 'https://apecheck.io' });
  });
  afterAll(async () => {
    await rx.close();
  });
  beforeEach(async () => {
    await resetDb();
    await redis.flushdb();
    rx.requests.length = 0;
    rx.routes.clear();
    log.lines.length = 0;
    wk = await startWebhooksWorker({ env, prisma, log, retryDelayMs: () => RETRY_MS, sweepEveryMs: 0 });
  });
  afterEach(async () => {
    await wk.close();
  });

  /** Stage F's hook: the check.completed rows, queued */
  const complete = (checkId: string) =>
    fireCheckWebhooks({ prisma, log, hooks: { enqueueWebhooks: ids => enqueueDeliveries(wk.queue, ids) } }, checkId);

  it('check.completed: the WebhookPayload, the headers and a signature that verifies', async () => {
    const u = await user('MAX');
    const w = await hook(u.id, rx.url('/apecheck?token=abc'), ['check.completed']);
    const c = await finished(u.id, { raw: 'https://orbitswap.xyz/app' });
    await complete(c.id);
    const id = deliveryIdFor(w.id, 'check.completed', c.id);
    const d = await settled(id);
    expect(d).toMatchObject({ status: 'ok', attempts: 1, responseCode: 200, error: null });
    expect(d.deliveredAt).not.toBeNull();

    expect(rx.requests).toHaveLength(1);
    const r = rx.requests[0];
    expect(r.method).toBe('POST');
    expect(r.path).toBe('/apecheck?token=abc');
    expect(r.headers['content-type']).toBe('application/json');
    expect(r.headers['user-agent']).toBe('ApeCheck-Webhooks/1.0');
    const sig = r.headers[WEBHOOK_SIGNATURE_HEADER.toLowerCase()] as string;
    expect(sig).toMatch(/^t=\d{10},v1=[0-9a-f]{64}$/);
    // verifies with the shared helper and with an HMAC computed here, over the raw body
    expect(verifyWebhook(SECRET, r.body, sig)).toBe(true);
    const [, t, v1] = /^t=(\d+),v1=([0-9a-f]+)$/.exec(sig)!;
    expect(createHmac('sha256', SECRET).update(`${t}.${r.body}`).digest('hex')).toBe(v1);
    expect(Math.abs(Number(t) - Date.now() / 1000)).toBeLessThan(30);
    expect(verifyWebhook('whsec_wrong', r.body, sig)).toBe(false);
    expect(verifyWebhook(SECRET, r.body.replace('48', '98'), sig)).toBe(false);

    const body = JSON.parse(r.body) as WebhookPayload;
    expect(body).toEqual({
      id,
      event: 'check.completed',
      created: d.createdAt.toISOString(),
      check: {
        id: c.shortId,
        target: 'https://orbitswap.xyz/app',
        narrative: 48,
        coin: 44,
        total: 46,
        verdict: 'PARTLY_REAL',
        summary: "The app loads but the main flow stops at 'Coming soon'.",
        report_url: `https://apecheck.io/c/${c.shortId}`,
      },
    } satisfies WebhookPayload);

    const after = await prisma.webhook.findUniqueOrThrow({ where: { id: w.id } });
    expect(after).toMatchObject({ lastStatus: 200, failCount: 0, disabledAt: null });
    expect(after.lastDeliveryAt).not.toBeNull();
    // the URL's path and query (a token) never reach the log; the secret never does
    expect(log.lines.join('\n')).not.toMatch(/token=abc|whsec_/);

    // finishing it again sends nothing new
    await complete(c.id);
    await sleep(300);
    expect(rx.requests).toHaveLength(1);
  });

  it('a check that could not finish: no scores, no verdict, the plain reason as summary', async () => {
    const u = await user('MAX');
    const w = await hook(u.id, rx.url('/failed'), ['check.completed']);
    const c = await finished(u.id, { status: 'FAILED' });
    await complete(c.id);
    await settled(deliveryIdFor(w.id, 'check.completed', c.id));
    const body = JSON.parse(rx.on('/failed')[0].body) as WebhookPayload;
    expect(body.check).toEqual({
      id: c.shortId, target: c.targetRaw, narrative: null, coin: null, total: null, verdict: null,
      summary: 'The check hit an error and could not finish', report_url: `https://apecheck.io/c/${c.shortId}`,
    });
  });

  it('a 500 is retried with backoff until it is delivered; the same delivery id every time; success resets failCount', async () => {
    const u = await user('MAX');
    const w = await hook(u.id, rx.url('/flaky'), ['check.completed'], { failCount: 3 });
    rx.routes.set('/flaky', (_r, n) => (n === 1 ? { status: 500 } : n === 2 ? { status: 503 } : { status: 204 }));
    const c = await finished(u.id);
    await complete(c.id);
    const d = await settled(deliveryIdFor(w.id, 'check.completed', c.id));
    expect(d).toMatchObject({ status: 'ok', attempts: 3, responseCode: 204, error: null });
    const got = rx.on('/flaky');
    expect(got).toHaveLength(3);
    // spaced by the backoff, never back to back
    expect(got[1].at - got[0].at).toBeGreaterThanOrEqual(RETRY_MS - 20);
    expect(got[2].at - got[1].at).toBeGreaterThanOrEqual(RETRY_MS - 20);
    const ids = got.map(r => (JSON.parse(r.body) as WebhookPayload).id);
    expect(new Set(ids)).toEqual(new Set([d.id]));
    for (const r of got) expect(verifyWebhook(SECRET, r.body, r.headers['apecheck-signature'] as string)).toBe(true);
    expect(await prisma.webhook.findUniqueOrThrow({ where: { id: w.id } })).toMatchObject({ failCount: 0, lastStatus: 204 });
  });

  it('no retry storm: a receiver that always fails gets exactly 6 spaced attempts, then nothing more', async () => {
    const u = await user('MAX');
    const w = await hook(u.id, rx.url('/down'), ['check.completed']);
    rx.routes.set('/down', () => ({ status: 500, body: 'x'.repeat(200_000) }));
    const c = await finished(u.id);
    await complete(c.id);
    const d = await settled(deliveryIdFor(w.id, 'check.completed', c.id));
    expect(d).toMatchObject({ status: 'failed', attempts: 6, responseCode: 500, error: 'HTTP 500', deliveredAt: null });
    await sleep(RETRY_MS * 5);
    const got = rx.on('/down');
    expect(got).toHaveLength(6);
    for (let i = 1; i < got.length; i++) expect(got[i].at - got[i - 1].at).toBeGreaterThanOrEqual(RETRY_MS - 20);
    // one failed delivery counts once (not once per attempt)
    expect(await prisma.webhook.findUniqueOrThrow({ where: { id: w.id } })).toMatchObject({ failCount: 1, lastStatus: 500, disabledAt: null });
    // nothing re-queues it
    expect(await wk.sweep()).toBe(0);
    await sleep(RETRY_MS * 2);
    expect(rx.on('/down')).toHaveLength(6);
  });

  it('redirects are not followed', async () => {
    const u = await user('MAX');
    const w = await hook(u.id, rx.url('/moved'), ['check.completed']);
    rx.routes.set('/moved', () => ({ status: 302, headers: { location: rx.url('/elsewhere') } }));
    const c = await finished(u.id);
    await complete(c.id);
    const d = await settled(deliveryIdFor(w.id, 'check.completed', c.id));
    expect(d).toMatchObject({ status: 'failed', attempts: 6, responseCode: 302, error: 'HTTP 302 (redirects are not followed)' });
    expect(rx.on('/elsewhere')).toHaveLength(0);
  });

  it('20 failed deliveries in a row disable the webhook: no new events, pending ones fail without a request', async () => {
    const u = await user('MAX');
    const w = await hook(u.id, rx.url('/dead'), ['check.completed'], { failCount: WEBHOOK_DISABLE_AFTER - 2 });
    rx.routes.set('/dead', () => ({ status: 410 }));
    // a delivery already waiting when the webhook gets disabled
    const waiting = await finished(u.id);
    const [waitingId] = await checkCompletedDeliveries(prisma, waiting.id);

    const c1 = await finished(u.id);
    await complete(c1.id);
    await settled(deliveryIdFor(w.id, 'check.completed', c1.id));
    expect(await prisma.webhook.findUniqueOrThrow({ where: { id: w.id } })).toMatchObject({ failCount: WEBHOOK_DISABLE_AFTER - 1, disabledAt: null });

    const c2 = await finished(u.id);
    await complete(c2.id);
    await settled(deliveryIdFor(w.id, 'check.completed', c2.id));
    const off = await prisma.webhook.findUniqueOrThrow({ where: { id: w.id } });
    expect(off.failCount).toBe(WEBHOOK_DISABLE_AFTER);
    expect(off.disabledAt).not.toBeNull();
    expect(log.lines.some(l => /disabled after 20 failed deliveries in a row/.test(l))).toBe(true);
    const sent = rx.on('/dead').length;
    expect(sent).toBe(2 * WEBHOOK_MAX_ATTEMPTS);

    // no more events
    const c3 = await finished(u.id);
    expect(await checkCompletedDeliveries(prisma, c3.id)).toEqual([]);
    // the one that was waiting fails without a request
    await enqueueDeliveries(wk.queue, [waitingId]);
    expect(await settled(waitingId)).toMatchObject({ status: 'failed', attempts: 0, error: 'Not sent: the webhook was disabled after repeated failures' });
    expect(rx.on('/dead')).toHaveLength(sent);
    expect((await prisma.webhook.findUniqueOrThrow({ where: { id: w.id } })).failCount).toBe(WEBHOOK_DISABLE_AFTER);
  });

  it('SSRF: loopback, private and metadata URLs are refused without a request and never retried', async () => {
    const other = await receiver(); // listening, but not allow-listed
    try {
      const u = await user('MAX');
      const urls = [other.url('/hook'), 'http://10.0.0.1/hook', 'http://169.254.169.254/latest/meta-data/', 'http://metadata.google.internal/computeMetadata/v1/', 'http://localhost:8080/x'];
      const hooks = [];
      for (const url of urls) hooks.push(await hook(u.id, url, ['check.completed']));
      const c = await finished(u.id);
      await complete(c.id);
      for (const h of hooks) {
        const d = await settled(deliveryIdFor(h.id, 'check.completed', c.id));
        expect(d, h.url).toMatchObject({ status: 'failed', attempts: 1, responseCode: null });
        expect(d.error, h.url).toBe('Not sent: the URL points to a private, local or internal address');
        // a refused URL counts as a failed delivery for the webhook
        expect(await prisma.webhook.findUniqueOrThrow({ where: { id: h.id } })).toMatchObject({ failCount: 1, lastStatus: null });
      }
      expect(other.requests).toHaveLength(0);
      expect(rx.requests).toHaveLength(0);
    } finally {
      await other.close();
    }
  });

  it('a name that now resolves to a private address is refused (the guard runs on every delivery); https only in production', async () => {
    const u = await user('MAX');
    const w = await hook(u.id, 'https://hooks.example.com/apecheck', ['check.completed']);
    const c = await finished(u.id);
    const [id] = await checkCompletedDeliveries(prisma, c.id);
    // DNS rebinding after the API vetted the URL: hooks.example.com → 10.1.2.3
    const rebound = createHttp(env, { lookup: async () => ['10.1.2.3'] });
    const out = await processDelivery({ env, prisma, http: rebound, log }, id, { attemptsMade: 0, maxAttempts: 6 });
    expect(out).toMatchObject({ status: 'failed', requested: false });
    // the user sees that it was refused; what the name resolved to (our network's view) stays in the log
    expect(await delivery(id)).toMatchObject({ status: 'failed', attempts: 1, error: 'Not sent: the URL points to a private, local or internal address' });
    expect(log.lines.some(l => /hooks\.example\.com refused by the SSRF guard: .*10\.1\.2\.3/.test(l))).toBe(true);

    // production: a plain http URL is never sent (the API refuses it at creation; checked again here)
    const plain = await hook(u.id, rx.url('/plain'), ['check.completed']);
    const c2 = await finished(u.id);
    const id2 = (await checkCompletedDeliveries(prisma, c2.id)).find(x => x === deliveryIdFor(plain.id, 'check.completed', c2.id))!;
    const prod = { ...env, NODE_ENV: 'production' as const };
    const out2 = await processDelivery({ env: prod, prisma, http: createHttp(env), log }, id2, { attemptsMade: 0, maxAttempts: 6 });
    expect(out2).toMatchObject({ status: 'failed', requested: false, error: 'The webhook URL must use https' });
    expect(rx.on('/plain')).toHaveLength(0);
    expect(w.id).toBeTruthy();
  });

  it('a connection that is refused is retried like any failed attempt', async () => {
    const port = await closedPort();
    const local = testEnv({ SSRF_ALLOW_HOSTS: `127.0.0.1:${port}` });
    const u = await user('MAX');
    const w = await hook(u.id, `http://127.0.0.1:${port}/x`, ['check.completed']);
    const c = await finished(u.id);
    const [id] = await checkCompletedDeliveries(prisma, c.id);
    const out = await processDelivery({ env: local, prisma, http: createHttp(local), log }, id, { attemptsMade: 0, maxAttempts: 6 });
    expect(out).toMatchObject({ status: 'retry', code: null, error: 'Connection failed (ECONNREFUSED)' });
    expect(await delivery(id)).toMatchObject({ status: 'pending', attempts: 1, error: 'Connection failed (ECONNREFUSED)' });
    expect((await prisma.webhook.findUniqueOrThrow({ where: { id: w.id } })).failCount).toBe(0);
  });

  it('ping ("Send test"): one attempt, never held against the webhook, sent to a disabled webhook too', async () => {
    const u = await user('MAX');
    const w = await hook(u.id, rx.url('/ping'), ['check.completed'], { disabledAt: new Date(), failCount: WEBHOOK_DISABLE_AFTER });
    // what the API does (apps/api webhooks.ts queuePing): a row and a single-attempt job
    const okPing = await prisma.webhookDelivery.create({ data: { webhookId: w.id, event: 'ping' } });
    await wk.queue.add('deliver', { deliveryId: okPing.id }, { jobId: okPing.id, attempts: 1 });
    const d = await settled(okPing.id);
    expect(d).toMatchObject({ status: 'ok', attempts: 1, responseCode: 200 });
    const body = JSON.parse(rx.on('/ping')[0].body) as WebhookPayload;
    expect(body).toEqual({ id: okPing.id, event: 'ping', created: d.createdAt.toISOString() });
    expect(verifyWebhook(SECRET, rx.on('/ping')[0].body, rx.on('/ping')[0].headers['apecheck-signature'] as string)).toBe(true);
    // still disabled: only "enable" turns it back on
    expect((await prisma.webhook.findUniqueOrThrow({ where: { id: w.id } })).disabledAt).not.toBeNull();

    // a failing ping: tried once, even with retries in the job options, and not counted
    rx.routes.set('/ping', () => ({ status: 500 }));
    await prisma.webhook.update({ where: { id: w.id }, data: { disabledAt: null, failCount: 4 } });
    const badPing = await prisma.webhookDelivery.create({ data: { webhookId: w.id, event: 'ping' } });
    await enqueueDeliveries(wk.queue, [badPing.id]);
    expect(await settled(badPing.id)).toMatchObject({ status: 'failed', attempts: 1, responseCode: 500, error: 'HTTP 500' });
    await sleep(RETRY_MS * 3);
    expect(rx.on('/ping')).toHaveLength(2);
    expect(await prisma.webhook.findUniqueOrThrow({ where: { id: w.id } })).toMatchObject({ failCount: 4, lastStatus: 500, disabledAt: null });
  });

  it('the sweep queues lost deliveries again, gives up stale ones and leaves live jobs alone', async () => {
    const u = await user('MAX');
    const w = await hook(u.id, rx.url('/swept'), ['check.completed']);
    const lostCheck = await finished(u.id);
    const [lost] = await checkCompletedDeliveries(prisma, lostCheck.id);
    const staleCheck = await finished(u.id);
    const [stale] = await checkCompletedDeliveries(prisma, staleCheck.id);
    const liveCheck = await finished(u.id);
    const [live] = await checkCompletedDeliveries(prisma, liveCheck.id);
    await prisma.webhookDelivery.update({ where: { id: lost }, data: { createdAt: new Date(Date.now() - 10 * 60_000) } });
    await prisma.webhookDelivery.update({ where: { id: stale }, data: { createdAt: new Date(Date.now() - 2 * 24 * HOUR) } });
    await prisma.webhookDelivery.update({ where: { id: live }, data: { createdAt: new Date(Date.now() - 10 * 60_000), attempts: 2 } });
    // the live one waits for its retry
    await wk.queue.add('deliver', { deliveryId: live }, { jobId: live, ...WEBHOOK_JOB_OPTIONS, delay: 60_000 });

    expect(await wk.sweep()).toBe(1);
    expect(await settled(lost)).toMatchObject({ status: 'ok', attempts: 1 });
    expect(await delivery(stale)).toMatchObject({ status: 'failed', error: 'Not delivered in time' });
    expect(await delivery(live)).toMatchObject({ status: 'pending', attempts: 2 });
    expect(await (await wk.queue.getJob(live))!.getState()).toBe('delayed');
    expect(rx.on('/swept')).toHaveLength(1);
    expect(w.id).toBeTruthy();
  });
});

/* ---------------- watch.changed from the change detector ---------------- */

describe('watch.changed', () => {
  let rx: Awaited<ReturnType<typeof receiver>>;
  let site: FixtureSite;
  let html = '<html><head><title>Orbit</title></head><body><h1>Orbit v2 is live</h1><a href="/app">Launch app</a></body></html>';
  let env: ReturnType<typeof testEnv>;
  let wk: WebhooksWorkerHandle;
  const log = memoryLogger();

  beforeAll(async () => {
    rx = await receiver();
    site = await serveHandler('watched', (_req, res) => {
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end(html);
    });
    env = testEnv({ SSRF_ALLOW_HOSTS: `127.0.0.1:${rx.port},${site.host}`, APP_URL: 'https://apecheck.io', WATCH_RECHECK_HOURS: '6' });
  });
  afterAll(async () => {
    await rx.close();
    await site.close();
  });
  beforeEach(async () => {
    await resetDb();
    await redis.flushdb();
    wk = await startWebhooksWorker({ env, prisma, log, retryDelayMs: () => 50, sweepEveryMs: 0 });
  });
  afterEach(async () => {
    await wk.close();
  });

  it("a confirmed change makes a delivery for each Max watcher's watch.changed webhook, written with the alert", async () => {
    const target = await prisma.target.create({ data: { key: 'site:watched.test', kind: 'SITE', domain: 'watched.test', name: 'watched.test' } });
    await prisma.check.create({
      data: { shortId: 'wch0001', targetId: target.id, targetRaw: site.url, status: 'DONE', finishedAt: new Date(Date.now() - 24 * HOUR), narScore: 48, narBand: 'partly', isLatest: true },
    });
    const max = await user('MAX');
    const max2 = await user('MAX');
    const pro = await user('PRO');
    const free = await user('FREE');
    for (const u of [max, max2, pro, free]) await prisma.watch.create({ data: { userId: u.id, targetId: target.id } });
    const mine = await hook(max.id, rx.url('/changed'), ['watch.changed']);
    await hook(max2.id, rx.url('/completed-only'), ['check.completed']);
    await hook(pro.id, rx.url('/pro'), ['watch.changed']);
    await hook(free.id, rx.url('/free'), ['watch.changed']);

    const queued: string[] = [];
    const deps: RecheckDeps = {
      env,
      prisma,
      redis,
      sources: fakeSources(env, { allowHosts: [site.host] }),
      log,
      enqueueCheck: async () => undefined,
      enqueueWebhooks: async ids => {
        queued.push(...ids);
        await enqueueDeliveries(wk.queue, ids);
      },
      confirmDelayMs: 0,
    };
    expect(await processRecheck(deps, target.id)).toEqual({ status: 'first' });
    expect(await prisma.webhookDelivery.count()).toBe(0);
    await prisma.target.update({ where: { id: target.id }, data: { fingerprintAt: new Date(Date.now() - 7 * HOUR) } });
    html = html.replace('Orbit v2 is live', 'Orbit v2: join the waitlist');
    expect(await processRecheck(deps, target.id)).toMatchObject({ status: 'changed', alerted: 3 });

    const rows = await prisma.webhookDelivery.findMany();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ webhookId: mine.id, event: 'watch.changed', targetId: target.id, checkId: null });
    const note = await prisma.notification.findFirstOrThrow({ where: { userId: max.id, kind: 'changed' } });
    expect(rows[0].id).toBe(deliveryIdFor(mine.id, 'watch.changed', note.id));
    expect(queued).toEqual([rows[0].id]);

    const d = await settled(rows[0].id);
    expect(d).toMatchObject({ status: 'ok', attempts: 1 });
    const got = rx.on('/changed');
    expect(got).toHaveLength(1);
    expect(verifyWebhook(SECRET, got[0].body, got[0].headers['apecheck-signature'] as string)).toBe(true);
    expect(JSON.parse(got[0].body)).toEqual({
      id: rows[0].id,
      event: 'watch.changed',
      created: d.createdAt.toISOString(),
      target: { id: target.id, name: 'watched.test', change: 'site' },
    } satisfies WebhookPayload);
    expect(rx.requests.map(r => r.path)).toEqual(['/changed']);
  });
});

/* ---------------- Stage F and the failure path ---------------- */

describe('the pipeline queues check.completed', () => {
  let env: ReturnType<typeof testEnv>;
  beforeAll(() => {
    env = testEnv();
  });
  beforeEach(async () => {
    await resetDb();
  });

  const deps = (queued: string[]): PipelineDeps => ({
    env,
    prisma,
    redis,
    sources: fakeSources(env, {
      evmChains: { ['0x3333333333333333333333333333333333333333']: 'base' },
      coinFacts: {
        ['0x3333333333333333333333333333333333333333']: {
          chain: 'base', address: '0x3333333333333333333333333333333333333333', token: { name: 'Orbit', symbol: 'ORBIT', decimals: 18, supply: '1' },
          deployer: null, bundle: null, holders: null, lp: null, authorities: null, market: null, stubbed: ['fourtis'], errors: [],
        },
      },
    }),
    ai: heuristicAi(),
    browser: async () => null,
    log: memoryLogger(),
    fetchCard: async () => null,
    hooks: { enqueueWebhooks: async ids => void queued.push(...ids) },
  });

  it("a finished check (Stage F) and an unrecoverable one both queue the requester's deliveries", async () => {
    const u = await user('MAX');
    const w = await hook(u.id, 'https://dev.example/hook', ['check.completed']);
    const queued: string[] = [];

    const check = await createCheck('0x3333333333333333333333333333333333333333');
    await prisma.check.update({ where: { id: check.id }, data: { requesterId: u.id, via: 'API' } });
    expect((await runCheck(check.id, deps(queued))).status).toBe('done');
    expect(queued).toEqual([deliveryIdFor(w.id, 'check.completed', check.id)]);

    const t = await prisma.target.create({ data: { key: 'site:broken.example', kind: 'SITE', name: 'broken', checkCount: 1 } });
    const bad = await prisma.check.create({ data: { shortId: 'bad0002', targetId: t.id, targetRaw: '¯\\_(ツ)_/¯', status: 'QUEUED', requesterId: u.id } });
    expect((await runCheck(bad.id, deps(queued))).status).toBe('failed');
    expect(queued).toEqual([deliveryIdFor(w.id, 'check.completed', check.id), deliveryIdFor(w.id, 'check.completed', bad.id)]);

    // a re-run of a finished check's job queues the same (still pending) delivery again: harmless, jobId = delivery id
    expect((await runCheck(check.id, deps(queued))).status).toBe('skipped');
    expect(queued.filter(x => x === deliveryIdFor(w.id, 'check.completed', check.id))).toHaveLength(2);
    expect(await prisma.webhookDelivery.count()).toBe(2);
  });
});
