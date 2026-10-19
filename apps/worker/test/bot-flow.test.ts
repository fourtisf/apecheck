/**
 * M2 acceptance, end to end: a FakeX delivers mentions; worker-bot (startBotWorker, real Redis lock, since_id and
 * "bot-replies" queue) stores them, starts the check on the real "checks" queue; worker-checks (startCheckWorker, real
 * pipeline, headless Chromium behind the SSRF guard) checks the local working-app fixture site linked from the
 * project's post; Stage F saves the share card and queues the replies; worker-bot posts them with the card PNG.
 *
 *  - tagging @ApeCheckBot under a project post gets ONE reply, with the verdict and the card, well within 4 minutes;
 *  - tagging it again in the same thread does not produce a second check: another account's tag gets its own reply
 *    with the same verdict, the same account's re-tag is linked to the check and not answered twice.
 */
import { Queue } from 'bullmq';
import { Redis } from 'ioredis';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { BOT_DISCLAIMER, QUEUES } from '@apecheck/core';
import { createSources } from '@apecheck/sources';
import { memoryLogger } from '../src/log';
import { startCheckWorker, type CheckWorkerHandle } from '../src/worker';
import { startBotWorker, type BotWorkerHandle } from '../src/bot/index';
import { serveFixture, testLookup, type FixtureSite } from './fixture-server';
import { fakeHttp } from './fakes';
import { FakeX, post, replyTo } from './fake-x';
import { heuristicAi, prisma, resetDb, testEnv } from './helpers';

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from('share card of the check')]);

let site: FixtureSite;
let checks: CheckWorkerHandle;
let bot: BotWorkerHandle;
let conn: Redis;
const x = new FakeX();
const cardsServed: string[] = [];

async function until<T>(what: string, fn: () => Promise<T | null | undefined | false>, ms = 240_000): Promise<T> {
  const deadline = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise(r => setTimeout(r, 300));
  }
}
const mention = (tweetId: string) => prisma.botMention.findUnique({ where: { tweetId } });

beforeAll(async () => {
  await resetDb();
  conn = new Redis(process.env.REDIS_URL!, { maxRetriesPerRequest: null });
  await conn.flushdb();
  for (const name of [QUEUES.checks, QUEUES.botReplies]) {
    const q = new Queue(name, { connection: conn });
    await q.obliterate({ force: true }).catch(() => undefined);
    await q.close();
  }
  site = await serveFixture('working-app');
  const env = testEnv({ SSRF_ALLOW_HOSTS: site.host, X_BOT_USER_ID: '1000', X_BOT_HANDLE: 'ApeCheckBot', APP_URL: 'https://apecheck.io' });
  const sources = createSources(env, { http: fakeHttp(env.SSRF_ALLOW_HOSTS) });
  checks = await startCheckWorker({
    env,
    sources,
    log: memoryLogger(),
    browser: { lookup: testLookup },
    recover: false,
    // the web app's /card/<id>.png (Stage F saves it under SCREENSHOT_DIR/cards)
    fetchCard: async shortId => (cardsServed.push(shortId), PNG),
  });
  bot = await startBotWorker({ env, x, ai: heuristicAi(), log: memoryLogger(), pollMs: 400 });
});

afterAll(async () => {
  await bot?.close();
  await checks?.close(1000);
  await site?.close();
  await conn?.quit();
  await prisma.$disconnect();
});

it('tagging the bot under a project post gets one reply with the verdict and the card; a second tag in the thread starts no second check', async () => {
  const project = post({ text: 'Orbit v2 is live, trade now https://t.co/AbC', urls: [site.url], authorHandle: 'orbitxyz', authorId: '700' });
  const tag = replyTo(project, '@ApeCheckBot real or larp?');
  const t0 = Date.now();
  x.inbox.push(tag);

  // stored, linked to a new bot check
  const queued = await until('the mention to be queued', async () => {
    const m = await mention(tag.id);
    return m?.status === 'QUEUED' && m.checkId ? m : null;
  }, 30_000);
  expect(bot.state).toBe('active');
  const check = await prisma.check.findUniqueOrThrow({ where: { id: queued.checkId! } });
  expect(check).toMatchObject({ via: 'BOT', requesterHandle: 'degen_rina', targetRaw: site.url });

  // while the check runs: another account tags the bot in the same thread → same check
  const other = replyTo(project, '@ApeCheckBot is this one legit?', { authorId: '601', authorHandle: 'other_user' });
  x.inbox.push(other);
  await until('the second mention to join the check', async () => (await mention(other.id))?.checkId === check.id);

  // the check finishes, Stage F saves the card and queues both replies, the bot posts them
  const replied = await until('the reply', async () => {
    const m = await mention(tag.id);
    return m?.status === 'REPLIED' ? m : null;
  });
  const done = await prisma.check.findUniqueOrThrow({ where: { id: check.id } });
  expect(done.status).toBe('DONE');
  expect(done.cardPath).toBe(`cards/${done.shortId}.png`);
  expect(Date.now() - t0).toBeLessThan(4 * 60_000);
  await until('the second reply', async () => (await mention(other.id))?.status === 'REPLIED');

  const toTag = x.replies.filter(r => r.inReplyToId === tag.id);
  expect(toTag).toHaveLength(1);
  const reply = toTag[0];
  expect(reply.media?.equals(PNG)).toBe(true);
  expect(reply.text).toMatch(/^(REAL|LIKELY REAL|PARTLY REAL|LIKELY LARP|LARP) \(\d{1,3}\/100\)\n/);
  expect(reply.text.endsWith(BOT_DISCLAIMER)).toBe(true);
  expect(reply.text).not.toContain('@');
  expect(replied).toMatchObject({ kind: 'check', replyTweetId: reply.id, replyText: reply.text });
  expect(x.replies.filter(r => r.inReplyToId === other.id)).toEqual([expect.objectContaining({ text: reply.text })]);

  // the first account tags again in the same thread: no second check, no second reply to them
  const again = replyTo(project, '@ApeCheckBot ???');
  x.inbox.push(again);
  const ignored = await until('the re-tag to be handled', async () => {
    const m = await mention(again.id);
    return m && m.status !== 'RECEIVED' ? m : null;
  });
  expect(ignored).toMatchObject({ status: 'IGNORED', ignoreReason: 'answered_in_thread', checkId: check.id });

  expect(await prisma.check.count()).toBe(1);
  expect(x.replies).toHaveLength(2);
  expect(x.replies.every(r => [tag.id, other.id].includes(r.inReplyToId))).toBe(true);
  expect(cardsServed).toEqual([done.shortId]);
});
