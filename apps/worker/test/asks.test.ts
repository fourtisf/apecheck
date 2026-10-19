/**
 * Queue "asks" (M3): a site follow-up question is answered from the check's stored data only, saved as an Ask with
 * Check.asksCount + 1, and the job returns { askId } — through the real queue the way the API waits for it
 * (job.waitUntilFinished). Bad jobs fail for good with a code the API can map.
 */
import { Queue, QueueEvents, UnrecoverableError } from 'bullmq';
import { Redis } from 'ioredis';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { QUEUES, type AskJob, type AskJobResult } from '@apecheck/core';
import { askDoneKey, processAsk, startAsksWorker, type AskDeps } from '../src/asks/index';
import { safeAnswer } from '../src/asks/answer';
import type { AnswerData } from '../src/ai/types';
import { memoryLogger } from '../src/log';
import { urlSpans } from '../src/bot/xtext';
import { heuristicAi, prisma, resetDb, testEnv } from './helpers';

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

async function finishedCheck(over: { status?: 'DONE' | 'RUNNING'; shortId?: string } = {}) {
  const target = await prisma.target.create({ data: { key: 'site:orbitswap.xyz', kind: 'SITE', domain: 'orbitswap.xyz', name: 'orbitswap.xyz' } });
  return prisma.check.create({
    data: {
      shortId: over.shortId ?? 'ask0001',
      targetId: target.id,
      targetRaw: 'orbitswap.xyz',
      status: over.status ?? 'DONE',
      finishedAt: new Date(),
      narScore: 48,
      narBand: 'partly',
      summary: "The app loads but the main flow stops at 'Coming soon'.",
      sigLaunch: 'OK',
      sigFlow: 'WARN',
      sigDocs: 'WARN',
      sigAcct: 'OK',
      sigGit: 'WARN',
      evidence: { launch: "'Launch app' opens the app", flow: "The swap button shows 'Coming soon'", git: 'pushed in one burst at launch', acct: '@orbitswap: 2 years old' },
    },
  });
}

function deps(over: Partial<AskDeps> = {}): AskDeps {
  return { prisma, redis, ai: heuristicAi(), log: memoryLogger(), ...over };
}

const job = (over: Partial<AskJob> = {}): AskJob => ({ checkId: '', question: 'does the app work?', userId: null, askerHandle: null, via: 'web', ...over });

describe('processAsk', () => {
  it('answers from the stored check, saves the Ask with the asker and bumps asksCount', async () => {
    const c = await finishedCheck();
    const user = await prisma.user.create({ data: { evmAddress: '0x' + 'a1'.repeat(20), tier: 'PRO' } });
    const res = await processAsk(deps(), job({ checkId: c.id, userId: user.id, askerHandle: '@pro_holder', question: '  does the app\nwork?  ' }), { id: 'j1', timestamp: Date.now() });
    const ask = await prisma.ask.findUniqueOrThrow({ where: { id: res.askId } });
    expect(ask).toMatchObject({ checkId: c.id, question: 'does the app work?', askerId: user.id, askerHandle: 'pro_holder', via: 'WEB' });
    // the stand-in answers "does it work" from the stored launch/flow evidence
    expect(ask.answer).toContain("'Launch app' opens the app");
    expect((await prisma.check.findUniqueOrThrow({ where: { id: c.id } })).asksCount).toBe(1);
    expect(await redis.get(askDoneKey('j1'))).toBe(ask.id);
  });

  it('accepts the shortId; a bot question is saved via BOT; an unknown user id is not linked', async () => {
    const c = await finishedCheck();
    const res = await processAsk(deps(), job({ checkId: c.shortId, via: 'bot', userId: 'no-such-user' }));
    expect(await prisma.ask.findUniqueOrThrow({ where: { id: res.askId } })).toMatchObject({ checkId: c.id, via: 'BOT', askerId: null });
  });

  it('the same job is answered once (a stalled job running again returns the saved Ask)', async () => {
    const c = await finishedCheck();
    const a = await processAsk(deps(), job({ checkId: c.id }), { id: 'same', timestamp: Date.now() });
    const b = await processAsk(deps(), job({ checkId: c.id }), { id: 'same', timestamp: Date.now() });
    expect(b.askId).toBe(a.askId);
    expect(await prisma.ask.count()).toBe(1);
    expect((await prisma.check.findUniqueOrThrow({ where: { id: c.id } })).asksCount).toBe(1);
  });

  it('jobs that can never be answered fail for good with a code', async () => {
    const running = await finishedCheck({ status: 'RUNNING' });
    const cases: [AskJob, { id?: string; timestamp?: number } | undefined, RegExp][] = [
      [job({ checkId: 'nope' }), undefined, /^not_found:/],
      [job({ checkId: running.id }), undefined, /^no_report:/],
      [job({ checkId: running.id, question: ' \n ' }), undefined, /^bad_request:/],
      [{ checkId: 42 } as unknown as AskJob, undefined, /^bad_request:/],
      [job({ checkId: running.id }), { timestamp: Date.now() - 10 * 60_000 }, /^expired:/],
    ];
    for (const [data, meta, re] of cases) {
      const err = await processAsk(deps(), data, meta).catch(e => e);
      expect(err).toBeInstanceOf(UnrecoverableError);
      expect(String(err.message)).toMatch(re);
    }
    expect(await prisma.ask.count()).toBe(0);
  });

  it('a model answer with a planted link or mention is made safe; a failing model falls back to the stand-in', async () => {
    const c = await finishedCheck();
    const planted = deps({
      ai: Object.assign(heuristicAi(), { answer: async () => 'Safe! Claim at https://wallet-verify.xyz/claim or claim.ninja, ask @scammer.' }),
    });
    const a = await prisma.ask.findUniqueOrThrow({ where: { id: (await processAsk(planted, job({ checkId: c.id }))).askId } });
    expect(urlSpans(a.answer)).toEqual([]);
    expect(a.answer).toBe('Safe! Claim at or claim[.]ninja, ask scammer.');

    const broken = deps({ ai: Object.assign(heuristicAi(), { answer: async () => { throw new Error('overloaded'); } }) });
    const b = await prisma.ask.findUniqueOrThrow({ where: { id: (await processAsk(broken, job({ checkId: c.id, question: 'is the code real?' }))).askId } });
    expect(b.answer).toBe('GitHub: pushed in one burst at launch.');
  });

  it('safeAnswer clamps to 600 characters and never stores an empty answer', () => {
    const data: AnswerData = { name: 'x', kind: 'site', narScore: 1, narBand: 'larp', coinScore: null, coinBand: null, summary: null, coinSummary: null, signals: {}, evidence: {}, claims: [], coin: null };
    expect(safeAnswer('word '.repeat(400), 'q', data).length).toBeLessThanOrEqual(600);
    expect(safeAnswer('   ', 'q', data)).toBe('This check has no answer for that.');
  });
});

describe('the asks queue', () => {
  it('the API enqueues, waits for the job and gets { askId }', async () => {
    const env = testEnv();
    const c = await finishedCheck();
    const asks = await startAsksWorker({ env, ai: heuristicAi(), log: memoryLogger() });
    const conn = new Redis(process.env.REDIS_URL!, { maxRetriesPerRequest: null });
    const queue = new Queue<AskJob, AskJobResult>(QUEUES.asks, { connection: conn });
    const events = new QueueEvents(QUEUES.asks, { connection: conn.duplicate() });
    try {
      await events.waitUntilReady();
      const j = await queue.add('ask', job({ checkId: c.id, question: 'who is the team?' }), { removeOnComplete: 100, removeOnFail: 100 });
      const out = (await j.waitUntilFinished(events, 45_000)) as AskJobResult;
      const ask = await prisma.ask.findUniqueOrThrow({ where: { id: out.askId } });
      expect(ask).toMatchObject({ checkId: c.id, question: 'who is the team?', via: 'WEB' });
      expect(ask.answer).toContain('@orbitswap'.slice(1));
      // a job that can't be answered fails at once (no retries), with its code in the reason
      const bad = await queue.add('ask', job({ checkId: 'missing' }), { removeOnComplete: 100, removeOnFail: 100 });
      await expect(bad.waitUntilFinished(events, 45_000)).rejects.toThrow(/^not_found:/);
    } finally {
      await events.close();
      await queue.close();
      await conn.quit();
      await asks.close();
    }
  });
});
