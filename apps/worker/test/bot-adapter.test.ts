/**
 * The bot on the real X adapter (@apecheck/sources createX: OAuth 1.0a signing, mention mapping, media upload, error
 * messages) over a fake HTTP layer serving the adapter's own recorded API fixtures — the contract between the two
 * sides, without api.x.com.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Redis } from 'ioredis';
import { afterAll, beforeAll, beforeEach, expect, it } from 'vitest';
import { createX, type Http, type HttpRequest, type HttpResponse } from '@apecheck/sources';
import { memoryLogger } from '../src/log';
import { SINCE_KEY, pollOnce } from '../src/bot/index';
import type { BotDeps } from '../src/bot/handle';
import { RetryReplyError, processReply } from '../src/bot/reply';
import { createCheck, heuristicAi, prisma, resetDb, testEnv } from './helpers';

const FIXTURES = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../packages/sources/test/fixtures');
const fixture = (name: string) => fs.readFileSync(path.join(FIXTURES, name), 'utf8');
const NOW = Date.parse('2026-10-19T10:00:00.000Z');
const BOT_ID = '1800000000000000000';
const MEDIA_ID = '1880028106020515840';
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from('card')]);

interface Call {
  method: string;
  url: URL;
  body: string | Buffer | undefined;
  auth: string;
}

/** api.x.com as the fixtures recorded it, plus POST /2/tweets and the media upload. */
function fakeXHttp(o: { tweets429?: boolean } = {}) {
  const calls: Call[] = [];
  let seq = 0;
  const reply = (status: number, body: unknown, headers: Record<string, string> = {}): HttpResponse => ({
    status,
    ok: status >= 200 && status < 300,
    url: '',
    finalUrl: '',
    headers: { 'content-type': 'application/json', ...headers },
    text: body == null ? '' : JSON.stringify(body),
    truncated: false,
    ms: 1,
  });
  const http: Http = {
    async request(raw: string, req: HttpRequest = {}) {
      const url = new URL(raw);
      const method = req.method ?? 'GET';
      calls.push({ method, url, body: req.body, auth: req.headers?.authorization ?? '' });
      if (url.host !== 'api.x.com') throw new Error(`unexpected host ${url.host}`);
      const p = url.pathname;
      if (method === 'GET' && p === `/2/users/${BOT_ID}/mentions`) {
        const page = url.searchParams.get('pagination_token') ? 'x-mentions-page2.json' : 'x-mentions-page1.json';
        return { ...reply(200, null), text: fixture(page) };
      }
      if (method === 'POST' && p === '/2/media/upload/initialize') return reply(200, { data: { id: MEDIA_ID, media_key: `3_${MEDIA_ID}` } });
      if (method === 'POST' && p === `/2/media/upload/${MEDIA_ID}/append`) return reply(200, null);
      if (method === 'POST' && p === `/2/media/upload/${MEDIA_ID}/finalize`) return reply(200, { data: { id: MEDIA_ID } });
      if (method === 'POST' && p === '/2/tweets') {
        if (o.tweets429) return reply(429, { title: 'Too Many Requests' }, { 'x-rate-limit-remaining': '0', 'x-rate-limit-reset': String(NOW / 1000 + 300) });
        return reply(201, { data: { id: String(1900000000000000000n + BigInt(++seq)), text: 'x' } });
      }
      return reply(404, { title: 'Not Found' });
    },
    async json<T>(u: string, req?: HttpRequest) {
      return JSON.parse((await this.request(u, req)).text) as T;
    },
  };
  return { http, calls };
}

let redis: Redis;
beforeAll(() => {
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

function harness(o: { tweets429?: boolean } = {}) {
  const env = testEnv({
    X_API_KEY: 'ck-123',
    X_API_SECRET: 'cs-456',
    X_ACCESS_TOKEN: `${BOT_ID}-tok`,
    X_ACCESS_SECRET: 'ts-789',
    X_BOT_USER_ID: BOT_ID,
    X_BOT_HANDLE: 'ApeCheckBot',
  });
  const fake = fakeXHttp(o);
  const x = createX(env, fake.http, { now: () => NOW, sleep: async () => undefined });
  const replies: string[] = [];
  const checks: string[] = [];
  const deps: BotDeps = {
    env,
    prisma,
    redis,
    x,
    ai: heuristicAi(),
    log: memoryLogger(),
    now: () => NOW,
    enqueueCheck: async id => void checks.push(id),
    enqueueReply: async id => void replies.push(id),
    fetchCard: async () => PNG,
  };
  return { deps, x, calls: fake.calls, replies, checks };
}

it('reads the mentions X recorded and handles each one by the rules', async () => {
  const { deps, calls } = harness();
  // the bot's earlier verdict post that 1847000000000000100 replies to
  const kairo = await createCheck('https://app.kairo.xyz');
  await prisma.check.update({ where: { id: kairo.id }, data: { status: 'DONE', finishedAt: new Date(NOW - 3600_000), narScore: 37, narBand: 'llarp', summary: 'GitHub pushed in one burst at launch.' } });
  await prisma.botMention.create({
    data: { tweetId: '1846990000000000000', authorId: '1', authorHandle: 'first', text: '@ApeCheckBot real?', status: 'REPLIED', kind: 'check', checkId: kairo.id, replyTweetId: '1846999999999999999', repliedAt: new Date(NOW - 3000_000) },
  });
  await prisma.user.create({ data: { xUserId: '1610000000000000004', xHandle: 'someprouser', tier: 'PRO' } });
  await redis.set(SINCE_KEY, '1');

  const r = await pollOnce(deps);
  // signed with the bot's user keys, since_id passed, both pages read
  expect(calls.filter(c => c.url.pathname.endsWith('/mentions')).map(c => c.url.searchParams.get('since_id'))).toEqual(['1', '1']);
  expect(calls[0].auth).toMatch(/^OAuth oauth_consumer_key="ck-123"/);
  expect(Object.fromEntries(r.outcomes.map(o => [o.tweetId, o.outcome]))).toEqual({
    // a long post replying to a deleted post, with the project's link and its contract: the contract wins
    '1846900000000000050': { action: 'check', checkId: expect.any(String), reuse: null, replyNow: false, target: '7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU' },
    // a Pro holder's question under the bot's verdict (the bot only in X's prefix)
    '1847000000000000100': { action: 'followup', pro: true },
    // a contract in a standalone mention (the cashtag doesn't count)
    '1847000000000000200': { action: 'check', checkId: expect.any(String), reuse: null, replyNow: false, target: '0x1111111111111111111111111111111111111111' },
    // degenfren's account is 4 days old
    '1847000000000000300': { action: 'ignored', reason: 'young_account' },
  });
  expect(r.nextSinceId).toBe('1847000000000000300');
  expect(await redis.get(SINCE_KEY)).toBe('1847000000000000300');
  expect(await prisma.botMention.findUniqueOrThrow({ where: { tweetId: '1847000000000000100' } })).toMatchObject({
    text: 'why is the github score so low?',
    authorHandle: 'someprouser',
    conversationId: expect.any(String),
    inReplyToId: '1846999999999999999',
  });
  // stored as X displays it: without the "@kairolabs " reply prefix and the trailing photo link
  expect((await prisma.botMention.findUniqueOrThrow({ where: { tweetId: '1847000000000000300' } })).text).toBe('🚀 @ApeCheckBot check this');
});

it('posts the verdict with the card through the media upload, and the follow-up answer, to the mention ids only', async () => {
  const { deps, calls, replies } = harness();
  await redis.set(SINCE_KEY, '1');
  await prisma.user.create({ data: { xUserId: '1610000000000000004', xHandle: 'someprouser', tier: 'PRO' } });
  const kairo = await createCheck('https://app.kairo.xyz');
  await prisma.check.update({ where: { id: kairo.id }, data: { status: 'DONE', finishedAt: new Date(NOW - 3600_000), narScore: 37, narBand: 'llarp', summary: 'GitHub pushed in one burst at launch.' } });
  await prisma.botMention.create({
    data: { tweetId: '1846990000000000000', authorId: '1', authorHandle: 'first', text: '@ApeCheckBot real?', status: 'REPLIED', kind: 'check', checkId: kairo.id, replyTweetId: '1846999999999999999', repliedAt: new Date(NOW - 3000_000) },
  });
  await pollOnce(deps);

  // the $GHOST check finishes; Stage F would queue its reply
  const ghost = await prisma.botMention.findUniqueOrThrow({ where: { tweetId: '1846900000000000050' } });
  await prisma.check.update({ where: { id: ghost.checkId! }, data: { status: 'DONE', finishedAt: new Date(NOW), narScore: 22, narBand: 'llarp', summary: 'The partnership @tier1fund is not shown anywhere.' } });
  calls.length = 0;
  expect(await processReply(deps, ghost.id)).toBe('replied');
  expect(calls.map(c => `${c.method} ${c.url.pathname}`)).toEqual([
    'POST /2/media/upload/initialize',
    `POST /2/media/upload/${MEDIA_ID}/append`,
    `POST /2/media/upload/${MEDIA_ID}/finalize`,
    'POST /2/tweets',
  ]);
  const tweet = JSON.parse(String(calls.at(-1)!.body));
  expect(tweet).toEqual({
    text: 'LIKELY LARP (22/100)\nThe partnership tier1fund is not shown anywhere.\nChecks the claims, not the team. DYOR.',
    // X's "@ghostproj" reply prefix is left out: only the asker is notified (the follow-up below names only the bot)
    reply: { in_reply_to_tweet_id: '1846900000000000050', exclude_reply_user_ids: ['1650000000000000009'] },
    media: { media_ids: [MEDIA_ID] },
  });
  expect(await prisma.botMention.findUniqueOrThrow({ where: { id: ghost.id } })).toMatchObject({ status: 'REPLIED', replyTweetId: '1900000000000000001', replyText: tweet.text });

  // the Pro follow-up: answered from the stored check, saved as an Ask
  const follow = await prisma.botMention.findUniqueOrThrow({ where: { tweetId: '1847000000000000100' } });
  expect(replies).toContain(follow.id);
  calls.length = 0;
  expect(await processReply(deps, follow.id)).toBe('replied');
  expect(calls.map(c => `${c.method} ${c.url.pathname}`)).toEqual(['POST /2/tweets']);
  const answer = JSON.parse(String(calls[0].body));
  expect(answer.reply).toEqual({ in_reply_to_tweet_id: '1847000000000000100' });
  expect(answer.media).toBeUndefined();
  expect(answer.text).not.toContain('@');
  expect(await prisma.ask.findFirstOrThrow()).toMatchObject({ checkId: kairo.id, question: 'why is the github score so low?', askerHandle: 'someprouser', via: 'BOT' });
});

it("retries after X's 429 with the adapter's reset time", async () => {
  const { deps } = harness({ tweets429: true });
  await redis.set(SINCE_KEY, '1');
  await pollOnce(deps);
  const m = await prisma.botMention.findUniqueOrThrow({ where: { tweetId: '1847000000000000200' } });
  await prisma.check.update({ where: { id: m.checkId! }, data: { status: 'FAILED', finishedAt: new Date(NOW) } });
  const err = await processReply(deps, m.id, { attemptsMade: 0, attempts: 3 }).catch(e => e);
  expect(err).toBeInstanceOf(RetryReplyError);
  expect(err.message).toBe('x.reply: rate limited until 2026-10-19T10:05:00.000Z');
  expect(await processReply(deps, m.id, { attemptsMade: 2, attempts: 3 })).toBe('failed');
});
