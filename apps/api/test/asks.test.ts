/** M3 follow-ups: POST /v1/checks/:id/asks through queue "asks", answered by a tiny in-test worker. */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Worker, type Job } from 'bullmq';
import { Redis } from 'ioredis';
import { QUEUES, type AskDTO, type AskJob, type AskJobResult, type CheckReportDTO } from '@apecheck/core';
import { TEST_REDIS_URL } from './global-setup';
import { Client, EvmWallet, SolWallet, makeHarness, resetState, seedCheck, seedTarget, signedIn, type Harness } from './helpers';

const pro = new EvmWallet();
const proX = new SolWallet();
let h: Harness;
let worker: Worker<AskJob, AskJobResult> | null = null;
let workerConn: Redis | null = null;
/** what the in-test worker does with the next jobs */
let mode: 'answer' | 'fail' | 'slow' = 'answer';
let jobs: AskJob[] = [];

beforeAll(async () => {
  h = await makeHarness({ TIER_OVERRIDES: `${pro.address}:pro,${proX.address}:max`, ASKS_PER_HOUR: '3' }, { askWaitMs: 1500 });
});
afterAll(async () => h.close());

async function startWorker() {
  workerConn = new Redis(TEST_REDIS_URL, { maxRetriesPerRequest: null });
  worker = new Worker<AskJob, AskJobResult>(
    QUEUES.asks,
    async (job: Job<AskJob, AskJobResult>) => {
      jobs.push(job.data);
      if (mode === 'fail') throw new Error('model unavailable');
      if (mode === 'slow') await new Promise(r => setTimeout(r, 2500));
      const ask = await h.prisma.$transaction(async tx => {
        const a = await tx.ask.create({
          data: { checkId: job.data.checkId, question: job.data.question, answer: `Answer to: ${job.data.question}`, askerHandle: job.data.askerHandle, askerId: job.data.userId, via: 'WEB' },
        });
        await tx.check.update({ where: { id: job.data.checkId }, data: { asksCount: { increment: 1 } } });
        return a;
      });
      return { askId: ask.id };
    },
    { connection: workerConn, concurrency: 4 },
  );
  await worker.waitUntilReady();
}

beforeEach(async () => {
  await resetState(h);
  mode = 'answer';
  jobs = [];
  await startWorker();
});
afterEach(async () => {
  await worker?.close();
  await workerConn?.quit();
  worker = null;
});

async function doneCheck(over: Parameters<typeof seedCheck>[1] extends infer T ? Partial<T> : never = {}) {
  const t = await seedTarget(h.prisma);
  return seedCheck(h.prisma, { targetId: t.id, ...over });
}

describe('POST /v1/checks/:id/asks gates', () => {
  it('anonymous and Free users get 403 pro_required with the existing copy', async () => {
    const c = await doneCheck();
    const anon = await new Client(h.app).post(`/v1/checks/${c.shortId}/asks`, { question: 'who funded the deployer?' });
    expect(anon.statusCode).toBe(403);
    expect(anon.json()).toEqual({ code: 'pro_required', error: 'Follow-ups need Pro. Pro and Max open at token launch.' });
    const free = new Client(h.app);
    await signedIn(free, new EvmWallet());
    expect((await free.post(`/v1/checks/${c.shortId}/asks`, { question: 'who funded the deployer?' })).json().code).toBe('pro_required');
    expect(jobs).toHaveLength(0);
  });

  it('400 for a question that is too short or long, 404 for a missing or private check, 409 while it runs', async () => {
    const c = new Client(h.app);
    await signedIn(c, pro);
    const done = await doneCheck();
    for (const question of ['hi', 'x'.repeat(281), 42, undefined]) {
      const res = await c.post(`/v1/checks/${done.shortId}/asks`, { question });
      expect(res.statusCode).toBe(400);
      expect(res.json()).toEqual({ code: 'bad_request', error: 'Ask a question of 3 to 280 characters.' });
    }
    expect((await c.post('/v1/checks/nope123/asks', { question: 'who funded it?' })).statusCode).toBe(404);
    const priv = await doneCheck({ isPrivate: true, requesterSid: 'someone-else' });
    expect((await c.post(`/v1/checks/${priv.shortId}/asks`, { question: 'who funded it?' })).statusCode).toBe(404);
    const running = await doneCheck({ status: 'RUNNING' });
    const res = await c.post(`/v1/checks/${running.shortId}/asks`, { question: 'who funded it?' });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toEqual({ code: 'not_ready', error: 'Wait for the check to finish, then ask.' });
    expect(jobs).toHaveLength(0);
  });
});

describe('POST /v1/checks/:id/asks answers', () => {
  it('queues an AskJob, waits for the worker and returns the AskDTO', async () => {
    const c = new Client(h.app);
    const me = await signedIn(c, pro);
    const check = await doneCheck();
    const res = await c.post(`/v1/checks/${check.shortId}/asks`, { question: '  Who   funded the deployer?  ' });
    expect(res.statusCode).toBe(201);
    const ask = res.json<AskDTO>();
    expect(ask).toEqual({
      id: expect.any(String),
      question: 'Who funded the deployer?',
      answer: 'Answer to: Who funded the deployer?',
      by: `${pro.address.slice(0, 5)}…${pro.address.slice(-4)}`,
      via: 'site',
      createdAt: expect.any(String),
    });
    expect(jobs).toEqual([{ checkId: check.id, question: 'Who funded the deployer?', userId: me.user!.id, askerHandle: null, via: 'web' }]);
    expect(await h.prisma.ask.findUniqueOrThrow({ where: { id: ask.id } })).toMatchObject({ askerId: me.user!.id, via: 'WEB' });
    // it is on the report
    const report = (await c.get(`/v1/checks/${check.shortId}`)).json<CheckReportDTO>();
    expect(report.asksList.map(a => a.id)).toEqual([ask.id]);
    expect(report.asks).toBe(1);
  });

  it('an X-linked asker is shown by handle', async () => {
    const c = new Client(h.app);
    const me = await signedIn(c, proX);
    await h.prisma.user.update({ where: { id: me.user!.id }, data: { xHandle: 'solsleuth', xUserId: '42' } });
    const check = await doneCheck();
    const ask = (await c.post(`/v1/checks/${check.shortId}/asks`, { question: 'is the LP locked?' })).json<AskDTO>();
    expect(ask.by).toBe('solsleuth');
    expect(jobs[0].askerHandle).toBe('solsleuth');
  });

  it('a double submit of the same question within 60 s returns the same answer, asked once', async () => {
    const c = new Client(h.app);
    await signedIn(c, pro);
    const check = await doneCheck();
    const [a, b] = await Promise.all([
      c.post(`/v1/checks/${check.shortId}/asks`, { question: 'Who funded the deployer?' }),
      c.post(`/v1/checks/${check.shortId}/asks`, { question: 'who funded  the deployer?' }),
    ]);
    expect([a.statusCode, b.statusCode].sort()).toEqual([200, 201]);
    expect(a.json<AskDTO>().id).toBe(b.json<AskDTO>().id);
    const later = await c.post(`/v1/checks/${check.shortId}/asks`, { question: 'WHO funded the deployer?' });
    expect(later.statusCode).toBe(200);
    expect(later.json<AskDTO>().id).toBe(a.json<AskDTO>().id);
    expect(jobs).toHaveLength(1);
    expect(await h.prisma.ask.count()).toBe(1);
    // another question is another ask
    expect((await c.post(`/v1/checks/${check.shortId}/asks`, { question: 'is the LP locked?' })).statusCode).toBe(201);
    expect(jobs).toHaveLength(2);
  });

  it('ASKS_PER_HOUR per user: 429 past it; replays of the same question are free', async () => {
    const c = new Client(h.app);
    await signedIn(c, pro);
    const check = await doneCheck();
    for (const q of ['first question?', 'second question?', 'third question?']) expect((await c.post(`/v1/checks/${check.shortId}/asks`, { question: q })).statusCode).toBe(201);
    expect((await c.post(`/v1/checks/${check.shortId}/asks`, { question: 'third question?' })).statusCode).toBe(200);
    const res = await c.post(`/v1/checks/${check.shortId}/asks`, { question: 'fourth question?' });
    expect(res.statusCode).toBe(429);
    expect(res.json()).toEqual({ code: 'rate_limited', error: "You've asked 3 follow-ups in the last hour. Try again later." });
    expect(jobs).toHaveLength(3);
  });

  it('a failing worker answers 502 ask_failed and gives the hourly slot back', async () => {
    const c = new Client(h.app);
    await signedIn(c, pro);
    const check = await doneCheck();
    mode = 'fail';
    for (let i = 0; i < 4; i++) {
      const res = await c.post(`/v1/checks/${check.shortId}/asks`, { question: `failing question ${i}?` });
      expect(res.statusCode).toBe(502);
      expect(res.json()).toEqual({ code: 'ask_failed', error: "Couldn't answer that right now. Try again in a moment." });
    }
    mode = 'answer';
    expect((await c.post(`/v1/checks/${check.shortId}/asks`, { question: 'failing question 0?' })).statusCode).toBe(201);
  });

  it('no answer in time: 504 ask_timeout; a job nobody started is dropped and not counted', async () => {
    const c = new Client(h.app);
    await signedIn(c, pro);
    const check = await doneCheck();
    await worker!.close();
    worker = null;
    const res = await c.post(`/v1/checks/${check.shortId}/asks`, { question: 'anyone there?' });
    expect(res.statusCode).toBe(504);
    expect(res.json()).toEqual({ code: 'ask_timeout', error: 'The answer is taking longer than usual. Try again in a moment.' });
    expect(await h.asks.queue().getJobCounts('waiting', 'prioritized')).toMatchObject({ waiting: 0, prioritized: 0 });
    // the worker is back: asking again works and the hourly budget wasn't spent
    await startWorker();
    for (const q of ['anyone there?', 'q2?', 'q3?']) expect((await c.post(`/v1/checks/${check.shortId}/asks`, { question: q })).statusCode).toBe(201);
  });

  it('a slow answer that started keeps going: asking again within a minute picks it up', async () => {
    const c = new Client(h.app);
    await signedIn(c, pro);
    const check = await doneCheck();
    mode = 'slow';
    const first = await c.post(`/v1/checks/${check.shortId}/asks`, { question: 'slow question?' });
    expect(first.statusCode).toBe(504);
    const again = await c.post(`/v1/checks/${check.shortId}/asks`, { question: 'slow question?' });
    expect(again.statusCode).toBe(200);
    expect(again.json<AskDTO>().answer).toBe('Answer to: slow question?');
    expect(jobs).toHaveLength(1);
  });
});
