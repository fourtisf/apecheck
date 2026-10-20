/** M4 webhooks: CRUD (session + Max), URL checks (https in production, SSRF guard), the test ping, deliveries. */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Queue } from 'bullmq';
import { Redis } from 'ioredis';
import { QUEUES, type CreateWebhookResponse, type WebhookDTO, type WebhookDeliveryDTO, type WebhookJob } from '@apecheck/core';
import { TEST_REDIS_URL } from './global-setup';
import { Client, EvmWallet, SolWallet, makeHarness, resetState, seedCheck, seedTarget, signedIn, type Harness } from './helpers';

const maxW = new EvmWallet();
const max2W = new SolWallet();
const PUBLIC_IP = '93.184.215.14';

async function maxClient(h: Harness, w: EvmWallet | SolWallet = maxW) {
  const c = new Client(h.app);
  const me = await signedIn(c, w);
  return { c, userId: me.user!.id };
}

async function addHook(c: Client, body: unknown = { url: `https://${PUBLIC_IP}/apecheck`, events: ['check.completed'] }) {
  const res = await c.post('/v1/webhooks', body);
  if (res.statusCode !== 201) throw new Error(`create webhook ${res.statusCode}: ${res.body}`);
  return res.json<CreateWebhookResponse>();
}

describe('webhooks (dev)', () => {
  let h: Harness;
  let queueConn: Redis;
  let webhooks: Queue<WebhookJob>;
  beforeAll(async () => {
    h = await makeHarness({ TIER_OVERRIDES: `${maxW.address}:max,${max2W.address}:max`, WEBHOOKS_PER_USER: '3', SSRF_ALLOW_HOSTS: '127.0.0.1:9999' });
    queueConn = new Redis(TEST_REDIS_URL, { maxRetriesPerRequest: null });
    webhooks = new Queue<WebhookJob>(QUEUES.webhooks, { connection: queueConn });
  });
  afterAll(async () => {
    await webhooks.close();
    await queueConn.quit();
    await h.close();
  });
  beforeEach(async () => {
    await resetState(h);
    h.sources.dns.clear();
  });

  it('needs a signed-in Max user', async () => {
    const anon = new Client(h.app);
    expect((await anon.get('/v1/webhooks')).json().code).toBe('sign_in_required');
    expect((await anon.post('/v1/webhooks', { url: `https://${PUBLIC_IP}/x` })).statusCode).toBe(401);
    const free = new Client(h.app);
    await signedIn(free, new EvmWallet());
    for (const res of [await free.get('/v1/webhooks'), await free.post('/v1/webhooks', { url: `https://${PUBLIC_IP}/x` })]) {
      expect(res.statusCode).toBe(403);
      expect(res.json().code).toBe('max_required');
    }
    expect(await h.prisma.webhook.count()).toBe(0);
  });

  it('creates a webhook with its signing secret shown once', async () => {
    const { c, userId } = await maxClient(h);
    const res = await c.post('/v1/webhooks', { url: `https://${PUBLIC_IP}/apecheck#frag`, events: ['watch.changed', 'check.completed', 'watch.changed'] });
    expect(res.statusCode).toBe(201);
    expect(res.headers['cache-control']).toBe('no-store');
    const created = res.json<CreateWebhookResponse>();
    expect(created).toEqual({
      id: expect.any(String),
      url: `https://${PUBLIC_IP}/apecheck`,
      events: ['check.completed', 'watch.changed'],
      createdAt: expect.any(String),
      lastDeliveryAt: null,
      lastStatus: null,
      failCount: 0,
      disabled: false,
      secret: expect.stringMatching(/^whsec_[A-Za-z0-9]{32}$/),
    });
    const row = await h.prisma.webhook.findUniqueOrThrow({ where: { id: created.id } });
    expect(row).toMatchObject({ userId, secret: created.secret, url: created.url, events: ['check.completed', 'watch.changed'] });

    // no events given: the check verdicts
    const second = await addHook(c, { url: `https://${PUBLIC_IP}/second` });
    expect(second.events).toEqual(['check.completed']);

    const list = await c.get('/v1/webhooks');
    expect(list.headers['cache-control']).toBe('no-store');
    const items = list.json<{ items: WebhookDTO[] }>().items;
    expect(items.map(w => w.id)).toEqual([second.id, created.id]);
    expect(list.body).not.toContain(created.secret);
    expect(items[1]).not.toHaveProperty('secret');
  });

  it('400 for no events or unknown ones', async () => {
    const { c } = await maxClient(h);
    for (const events of [[], ['check.started'], 'check.completed']) {
      const res = await c.post('/v1/webhooks', { url: `https://${PUBLIC_IP}/x`, events });
      expect(res.statusCode).toBe(400);
      expect(res.json()).toEqual({ code: 'bad_request', error: 'Pick at least one event: check.completed or watch.changed.' });
    }
  });

  it('refuses URLs that are not public http(s) endpoints (400 bad_url)', async () => {
    const { c } = await maxClient(h);
    h.sources.dns.set('hooks.internal-looking.com', ['10.0.0.5']);
    h.sources.dns.set('rebind.example.com', ['93.184.215.14', '127.0.0.1']);
    const cases: [string, string][] = [
      ['not a url', 'Enter the full URL of your endpoint, starting with https://.'],
      ['/relative/path', 'Enter the full URL of your endpoint, starting with https://.'],
      ['ftp://93.184.215.14/x', 'Enter the full URL of your endpoint, starting with https://.'],
      ['javascript:alert(1)', 'Enter the full URL of your endpoint, starting with https://.'],
      [`https://${PUBLIC_IP}/` + 'a'.repeat(2100), 'Enter the full URL of your endpoint, starting with https://.'],
      [`https://user:pass@${PUBLIC_IP}/x`, "Webhook URLs can't contain a username or password. Check the signature header instead."],
      ['http://10.0.0.1/hook', 'Webhook URLs must point to a public server.'],
      ['http://192.168.1.10/hook', 'Webhook URLs must point to a public server.'],
      ['http://127.0.0.1:3000/hook', 'Webhook URLs must point to a public server.'],
      ['http://2130706433/hook', 'Webhook URLs must point to a public server.'],
      ['http://[::1]/hook', 'Webhook URLs must point to a public server.'],
      ['http://[::ffff:10.0.0.1]/hook', 'Webhook URLs must point to a public server.'],
      ['http://169.254.169.254/latest/meta-data', 'Webhook URLs must point to a public server.'],
      ['http://metadata.google.internal/computeMetadata/v1', 'Webhook URLs must point to a public server.'],
      ['http://localhost:4000/v1/feed', 'Webhook URLs must point to a public server.'],
      ['https://intranet/hook', 'Webhook URLs must point to a public server.'],
      ['https://hooks.internal-looking.com/x', 'Webhook URLs must point to a public server.'],
      ['https://rebind.example.com/x', 'Webhook URLs must point to a public server.'],
      ['https://does-not-resolve.example.com/x', "We couldn't find that host name. Check the URL."],
      // the dev allow-list names one host:port only
      ['http://127.0.0.1:9998/hook', 'Webhook URLs must point to a public server.'],
    ];
    for (const [i, [url, error]] of cases.entries()) {
      // the same session from several IPs: creates are limited to 10 a minute per IP
      const from = new Client(h.app, `198.51.100.${i + 1}`);
      from.cookie = c.cookie;
      const res = await from.post('/v1/webhooks', { url, events: ['check.completed'] });
      expect(res.statusCode, url).toBe(400);
      expect(res.json(), url).toEqual({ code: 'bad_url', error });
    }
    expect((await c.post('/v1/webhooks', { events: ['check.completed'] })).json().code).toBe('bad_url');
    expect(await h.prisma.webhook.count()).toBe(0);
  });

  it('accepts public names and IPs, http outside production, and SSRF_ALLOW_HOSTS in dev', async () => {
    const { c } = await maxClient(h);
    h.sources.dns.set('hooks.example.com', ['93.184.215.14', '2606:2800:21f:cb07:6820:80da:af6b:8b2c']);
    expect((await addHook(c, { url: 'https://hooks.example.com:8443/apecheck?x=1', events: ['check.completed'] })).url).toBe('https://hooks.example.com:8443/apecheck?x=1');
    expect((await addHook(c, { url: `http://${PUBLIC_IP}/plain-http`, events: ['check.completed'] })).url).toBe(`http://${PUBLIC_IP}/plain-http`);
    expect((await addHook(c, { url: 'http://127.0.0.1:9999/local-fixture', events: ['check.completed'] })).url).toBe('http://127.0.0.1:9999/local-fixture');
  });

  it('WEBHOOKS_PER_USER at most (409 too_many_webhooks), also for creates at the same moment', async () => {
    const { c } = await maxClient(h);
    await addHook(c);
    const [a, b, d] = await Promise.all([
      c.post('/v1/webhooks', { url: `https://${PUBLIC_IP}/a` }),
      c.post('/v1/webhooks', { url: `https://${PUBLIC_IP}/b` }),
      c.post('/v1/webhooks', { url: `https://${PUBLIC_IP}/c` }),
    ]);
    expect([a, b, d].map(r => r.statusCode).sort()).toEqual([201, 201, 409]);
    const over = [a, b, d].find(r => r.statusCode === 409)!;
    expect(over.json()).toEqual({ code: 'too_many_webhooks', error: 'You have 3 webhooks, the most allowed. Delete one to add another.' });
    expect(await h.prisma.webhook.count()).toBe(3);
  });

  it('deletes (with its deliveries), 404 for anyone else', async () => {
    const { c } = await maxClient(h);
    const hook = await addHook(c);
    await h.prisma.webhookDelivery.create({ data: { webhookId: hook.id, event: 'ping' } });
    const other = await maxClient(h, max2W);
    expect((await other.c.delete(`/v1/webhooks/${hook.id}`)).statusCode).toBe(404);
    expect((await c.delete(`/v1/webhooks/${hook.id}`)).json()).toEqual({ ok: true });
    expect((await c.delete(`/v1/webhooks/${hook.id}`)).statusCode).toBe(404);
    expect(await h.prisma.webhookDelivery.count()).toBe(0);
  });

  it('enable clears disabledAt and failCount', async () => {
    const { c } = await maxClient(h);
    const hook = await addHook(c);
    await h.prisma.webhook.update({ where: { id: hook.id }, data: { disabledAt: new Date(), failCount: 20, lastStatus: 500 } });
    expect((await c.get('/v1/webhooks')).json<{ items: WebhookDTO[] }>().items[0]).toMatchObject({ disabled: true, failCount: 20, lastStatus: 500 });
    const res = await c.post(`/v1/webhooks/${hook.id}/enable`);
    expect(res.statusCode).toBe(200);
    expect(res.json<WebhookDTO>()).toMatchObject({ id: hook.id, disabled: false, failCount: 0, lastStatus: 500 });
    expect(await h.prisma.webhook.findUniqueOrThrow({ where: { id: hook.id } })).toMatchObject({ disabledAt: null, failCount: 0 });
    const other = await maxClient(h, max2W);
    expect((await other.c.post(`/v1/webhooks/${hook.id}/enable`)).statusCode).toBe(404);
  });

  it('the test button queues a ping delivery (row + job on "webhooks", jobId = deliveryId, one attempt)', async () => {
    const { c } = await maxClient(h);
    const hook = await addHook(c);
    const res = await c.post(`/v1/webhooks/${hook.id}/test`);
    expect(res.statusCode).toBe(201);
    const d = res.json<WebhookDeliveryDTO>();
    expect(d).toEqual({
      id: expect.any(String),
      event: 'ping',
      status: 'pending',
      attempts: 0,
      responseCode: null,
      error: null,
      createdAt: expect.any(String),
      deliveredAt: null,
      checkId: null,
    });
    expect(await h.prisma.webhookDelivery.findUniqueOrThrow({ where: { id: d.id } })).toMatchObject({ webhookId: hook.id, event: 'ping', status: 'pending', checkId: null });
    const job = await webhooks.getJob(d.id);
    expect(job?.data).toEqual({ deliveryId: d.id });
    expect(job?.opts.attempts).toBe(1);

    // turned off after failures: turn it back on first
    await h.prisma.webhook.update({ where: { id: hook.id }, data: { disabledAt: new Date() } });
    const off = await c.post(`/v1/webhooks/${hook.id}/test`);
    expect(off.statusCode).toBe(409);
    expect(off.json()).toEqual({ code: 'webhook_disabled', error: 'This webhook is turned off after failed deliveries. Turn it back on first.' });
    const other = await maxClient(h, max2W);
    expect((await other.c.post(`/v1/webhooks/${hook.id}/test`)).statusCode).toBe(404);
    expect(await h.prisma.webhookDelivery.count()).toBe(1);
  });

  it('lists the last 50 deliveries, newest first, with the check short id', async () => {
    const { c } = await maxClient(h);
    const hook = await addHook(c);
    const t = await seedTarget(h.prisma);
    const check = await seedCheck(h.prisma, { targetId: t.id, shortId: 'dlv0001' });
    const base = Date.now() - 3600_000;
    await h.prisma.webhookDelivery.createMany({
      data: Array.from({ length: 55 }, (_, i) => ({
        webhookId: hook.id,
        event: i % 2 ? 'check.completed' : 'watch.changed',
        checkId: i === 54 ? check.id : null,
        targetId: t.id,
        status: i === 53 ? 'failed' : 'ok',
        attempts: 1,
        responseCode: i === 53 ? 500 : 200,
        error: i === 53 ? 'HTTP 500' : null,
        createdAt: new Date(base + i * 1000),
        deliveredAt: i === 53 ? null : new Date(base + i * 1000 + 50),
      })),
    });
    const res = await c.get(`/v1/webhooks/${hook.id}/deliveries`);
    expect(res.statusCode).toBe(200);
    const items = res.json<{ items: WebhookDeliveryDTO[] }>().items;
    expect(items).toHaveLength(50);
    expect(items[0]).toMatchObject({ event: 'watch.changed', status: 'ok', checkId: 'dlv0001', responseCode: 200 });
    expect(items[1]).toMatchObject({ status: 'failed', responseCode: 500, error: 'HTTP 500', deliveredAt: null, checkId: null });
    const times = items.map(i => Date.parse(i.createdAt));
    expect([...times].sort((a, b) => b - a)).toEqual(times);
    const other = await maxClient(h, max2W);
    expect((await other.c.get(`/v1/webhooks/${hook.id}/deliveries`)).statusCode).toBe(404);
  });
});

describe('webhooks in production', () => {
  let h: Harness;
  beforeAll(async () => {
    h = await makeHarness({ NODE_ENV: 'production', TIER_OVERRIDES: `${maxW.address}:max`, SSRF_ALLOW_HOSTS: '127.0.0.1:9999' });
  });
  afterAll(async () => h.close());
  beforeEach(async () => resetState(h));

  it('https only, and the dev allow-list is ignored', async () => {
    const { c } = await maxClient(h);
    const http = await c.post('/v1/webhooks', { url: `http://${PUBLIC_IP}/hook`, events: ['check.completed'] });
    expect(http.statusCode).toBe(400);
    expect(http.json()).toEqual({ code: 'bad_url', error: 'Webhook URLs must start with https://.' });
    const local = await c.post('/v1/webhooks', { url: 'https://127.0.0.1:9999/hook', events: ['check.completed'] });
    expect(local.statusCode).toBe(400);
    expect(local.json().error).toBe('Webhook URLs must point to a public server.');
    expect((await c.post('/v1/webhooks', { url: `https://${PUBLIC_IP}/hook`, events: ['check.completed'] })).statusCode).toBe(201);
  });
});
