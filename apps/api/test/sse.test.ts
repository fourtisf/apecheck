import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { checkChannel, progressKey, type CheckChannelMsg, type CheckReportDTO } from '@apecheck/core';
import { APP_URL, Client, makeHarness, parseSse, resetState, seedCheck, seedTarget, type Harness } from './helpers';

let h: Harness;
let base: string;
beforeAll(async () => {
  h = await makeHarness();
  await h.app.listen({ host: '127.0.0.1', port: 0 });
  base = `http://127.0.0.1:${(h.app.server.address() as AddressInfo).port}`;
});
afterAll(async () => {
  await h.close();
});
beforeEach(async () => {
  await resetState(h);
});

interface Stream {
  status: number;
  headers: http.IncomingHttpHeaders;
  body: () => string;
  events: () => { event: string; data: unknown }[];
  ended: Promise<void>;
  waitFor: (pred: (evs: { event: string; data: any }[]) => boolean, ms?: number) => Promise<void>;
  close: () => void;
}

function openStream(urlPath: string, headers: Record<string, string> = {}): Promise<Stream> {
  return new Promise((resolve, reject) => {
    const req = http.get(`${base}${urlPath}`, { headers: { accept: 'text/event-stream', ...headers } }, res => {
      let buf = '';
      let endResolve!: () => void;
      const ended = new Promise<void>(r => (endResolve = r));
      res.setEncoding('utf8');
      res.on('data', chunk => (buf += chunk));
      res.on('end', () => endResolve());
      res.on('close', () => endResolve());
      const events = () => parseSse(buf);
      resolve({
        status: res.statusCode ?? 0,
        headers: res.headers,
        body: () => buf,
        events,
        ended,
        close: () => req.destroy(),
        waitFor: (pred, ms = 5000) =>
          new Promise<void>((ok, fail) => {
            const started = Date.now();
            const tick = () => {
              if (pred(events())) return ok();
              if (Date.now() - started > ms) return fail(new Error(`timed out; got ${JSON.stringify(events().map(e => e.event))}`));
              setTimeout(tick, 15);
            };
            tick();
          }),
      });
    });
    req.on('error', reject);
  });
}

async function seedSiteCheck(status: 'DONE' | 'RUNNING' | 'QUEUED', steps: number, extra: Record<string, unknown> = {}) {
  const t = await seedTarget(h.prisma, { kind: 'SITE', domain: 'glint.trade', name: 'glint.trade', key: 'site:glint.trade' });
  const check = await seedCheck(h.prisma, {
    targetId: t.id,
    shortId: 'sse0001',
    status,
    isLatest: status === 'DONE',
    totalScore: status === 'DONE' ? 47 : null,
    narScore: status === 'DONE' ? 47 : null,
    narBand: status === 'DONE' ? 'partly' : null,
    summary: status === 'DONE' ? "'Launch app' opens a waitlist form." : null,
    ...extra,
  });
  for (let i = 0; i < steps; i++) {
    await h.prisma.checkStep.create({
      data: { checkId: check.id, idx: i, tMs: i * 1000, status: 'INFO', text: `Step ${i}`, screenshot: i === 1 ? `${check.id}/1.jpg` : null },
    });
  }
  return check;
}

const publish = (checkId: string, msg: CheckChannelMsg) => h.publisher.publish(checkChannel(checkId), JSON.stringify(msg));

describe('GET /v1/checks/:id/events', () => {
  it('replays a finished check: every step, then done with the report, then ends', async () => {
    const check = await seedSiteCheck('DONE', 3);
    const s = await openStream('/v1/checks/sse0001/events', { origin: APP_URL });
    await s.ended;
    expect(s.status).toBe(200);
    expect(s.headers['content-type']).toBe('text/event-stream; charset=utf-8');
    expect(s.headers['cache-control']).toBe('no-cache');
    expect(s.headers['connection']).toBe('keep-alive');
    expect(s.headers['x-accel-buffering']).toBe('no');
    expect(s.headers['access-control-allow-origin']).toBe(APP_URL);
    expect(s.headers['access-control-allow-credentials']).toBe('true');
    expect(s.body().startsWith('retry: 3000\n\n')).toBe(true);

    const evs = s.events();
    expect(evs.map(e => e.event)).toEqual(['step', 'step', 'step', 'done']);
    expect(evs[0].data).toEqual({ idx: 0, t: 0, status: 'info', text: 'Step 0', source: null, url: null, caption: null, screenshot: null, progress: 1 });
    expect(evs[1].data).toMatchObject({ idx: 1, screenshot: `/shots/${check.id}/1.jpg`, progress: 1 });
    const report = evs[3].data as CheckReportDTO;
    expect(report).toMatchObject({ id: 'sse0001', status: 'done', total: 47, narBand: 'partly', progress: 1, cardUrl: `${APP_URL}/card/sse0001.png` });
    expect(report.steps).toHaveLength(3);
    // subscription released once the stream ended
    await new Promise(r => setTimeout(r, 50));
    expect(h.hub.channelCount).toBe(0);
  });

  it('streams a live check: stored steps, then published steps (no duplicates), then done', async () => {
    const check = await seedSiteCheck('RUNNING', 2, { evidence: { stepsExpected: 10 } });
    await h.redis.set(progressKey(check.id), '0.2');
    const s = await openStream('/v1/checks/sse0001/events');
    expect(s.status).toBe(200);
    await s.waitFor(evs => evs.some(e => e.event === 'status'));
    expect(s.events().map(e => e.event)).toEqual(['step', 'step', 'status']);
    expect(s.events()[2].data).toEqual({ status: 'running', progress: 0.2 });
    expect(h.hub.channelCount).toBe(1);

    // a step the client already has (worker wrote the DB row, then published) is skipped
    await publish(check.id, { type: 'step', step: { idx: 1, t: 1000, status: 'info', text: 'Step 1' }, progress: 0.2 });
    await publish(check.id, {
      type: 'step',
      step: { idx: 2, t: 2500, status: 'ok', text: 'Page loaded in 1.2s', caption: 'Reading the page', url: 'https://glint.trade', screenshot: `/shots/${check.id}/2.jpg` },
      progress: 0.3,
    });
    await publish(check.id, { type: 'status', status: 'running', progress: 0.35 });
    await s.waitFor(evs => evs.length >= 5);

    await h.prisma.check.update({
      where: { id: check.id },
      data: { status: 'DONE', isLatest: true, finishedAt: new Date(), totalScore: 47, narScore: 47, narBand: 'partly' },
    });
    await h.prisma.checkStep.create({ data: { checkId: check.id, idx: 2, tMs: 2500, status: 'OK', text: 'Page loaded in 1.2s' } });
    await publish(check.id, { type: 'done', status: 'done' });
    await s.ended;

    const evs = s.events();
    expect(evs.map(e => e.event)).toEqual(['step', 'step', 'status', 'step', 'status', 'done']);
    expect(evs[3].data).toEqual({
      idx: 2, t: 2500, status: 'ok', text: 'Page loaded in 1.2s', source: null, caption: 'Reading the page', url: 'https://glint.trade',
      screenshot: `/shots/${check.id}/2.jpg`, progress: 0.3,
    });
    expect(evs[4].data).toEqual({ status: 'running', progress: 0.35 });
    expect(evs[5].data).toMatchObject({ id: 'sse0001', status: 'done', total: 47 });
    expect((evs[5].data as CheckReportDTO).steps.map(st => st.idx)).toEqual([0, 1, 2]);
    await new Promise(r => setTimeout(r, 50));
    expect(h.hub.channelCount).toBe(0);
  });

  it('delivers done for a check that fails while queued', async () => {
    const check = await seedSiteCheck('QUEUED', 0);
    const s = await openStream('/v1/checks/sse0001/events');
    await s.waitFor(evs => evs.some(e => e.event === 'status'));
    expect(s.events()[0].data).toEqual({ status: 'queued', progress: 0 });
    await h.prisma.check.update({ where: { id: check.id }, data: { status: 'FAILED', error: 'Site never loaded', finishedAt: new Date() } });
    await publish(check.id, { type: 'done', status: 'failed' });
    await s.ended;
    const done = s.events().find(e => e.event === 'done')!.data as CheckReportDTO;
    expect(done).toMatchObject({ status: 'failed', error: 'Site never loaded', cardUrl: null });
  });

  it('shares one Redis subscription between viewers and cleans up when they leave', async () => {
    await seedSiteCheck('RUNNING', 1);
    const a = await openStream('/v1/checks/sse0001/events');
    const b = await openStream('/v1/checks/sse0001/events');
    await a.waitFor(evs => evs.some(e => e.event === 'status'));
    await b.waitFor(evs => evs.some(e => e.event === 'status'));
    expect(h.hub.channelCount).toBe(1);
    const subs = (await h.publisher.pubsub('NUMSUB', checkChannel((await h.prisma.check.findFirstOrThrow()).id))) as [string, number];
    expect(subs[1]).toBe(1);
    a.close();
    await new Promise(r => setTimeout(r, 100));
    expect(h.hub.channelCount).toBe(1);
    b.close();
    await new Promise(r => setTimeout(r, 100));
    expect(h.hub.channelCount).toBe(0);
  });

  it('404s unknown checks and other people\'s private checks as JSON', async () => {
    const missing = await openStream('/v1/checks/nope999/events');
    await missing.ended;
    expect(missing.status).toBe(404);
    expect(JSON.parse(missing.body())).toEqual({ code: 'not_found', error: "This check doesn't exist or has expired." });

    const owner = new Client(h.app);
    await owner.get('/v1/me');
    await seedSiteCheck('DONE', 1, { isPrivate: true, isLatest: false, requesterSid: owner.sid(h.app) });
    const stranger = await openStream('/v1/checks/sse0001/events');
    await stranger.ended;
    expect(stranger.status).toBe(404);
    const mine = await openStream('/v1/checks/sse0001/events', { cookie: owner.cookie! });
    await mine.ended;
    expect(mine.status).toBe(200);
    expect(mine.events().map(e => e.event)).toEqual(['step', 'done']);
  });

  it('ends open streams on shutdown so the server can close', async () => {
    const other = await makeHarness();
    try {
      await other.app.listen({ host: '127.0.0.1', port: 0 });
      const t = await seedTarget(other.prisma, { kind: 'SITE', domain: 'shutdown.xyz', name: 'shutdown.xyz', key: 'site:shutdown.xyz' });
      await seedCheck(other.prisma, { targetId: t.id, shortId: 'down001', status: 'RUNNING' });
      const port = (other.app.server.address() as AddressInfo).port;
      const ended = new Promise<string>((resolve, reject) => {
        http
          .get(`http://127.0.0.1:${port}/v1/checks/down001/events`, res => {
            let buf = '';
            res.on('data', c => (buf += c));
            res.on('end', () => resolve(buf));
          })
          .on('error', reject);
      });
      await new Promise(r => setTimeout(r, 200));
      const started = Date.now();
      await other.app.close();
      expect(Date.now() - started).toBeLessThan(3000);
      expect(await ended).toContain('event: status');
    } finally {
      await other.close();
    }
  });

  it('sets the session cookie on a first visit even though the reply is hijacked', async () => {
    await seedSiteCheck('DONE', 1);
    const s = await openStream('/v1/checks/sse0001/events');
    await s.ended;
    const cookies = s.headers['set-cookie'] ?? [];
    expect(cookies.some(c => c.startsWith('ac_sid=') && c.includes('HttpOnly'))).toBe(true);
  });
});
