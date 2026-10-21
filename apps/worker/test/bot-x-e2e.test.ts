/**
 * M2 acceptance on the REAL X adapter. createSources() builds the X adapter (OAuth 1.0a signing, mention mapping,
 * chunked media upload) over an Http whose api.x.com is the stateful emulator in ./x-api.ts; the same `sources.x`
 * drives worker-bot (startBotWorker: Redis lock, since_id, "bot-replies" queue) and worker-checks (startCheckWorker:
 * real pipeline, headless Chromium behind the SSRF guard, on the local working-app fixture site linked from the
 * project's post). Stage F saves the share card; worker-bot uploads it to X and replies.
 *
 *  - tagging @ApeCheckBot under a project post gets ONE reply, with the verdict and the card, within 4 minutes;
 *  - a second tag in the same thread starts no second check (another account: its own reply with the same verdict;
 *    the same account again: linked to the check, not answered twice);
 *  - a mention of the same site elsewhere is answered from the cached verdict, with the card;
 *  - a batch read over two pages, the second answered 429 once, is handled once: since_id is kept until the whole
 *    batch was read, and re-read mentions are never answered twice;
 *  - every X call is signed correctly; only the stored mentions are ever replied to, and each reply notifies only
 *    its asker (X's auto-filled "Replying to" accounts, e.g. the project in the reply prefix, are excluded).
 */
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { Queue } from 'bullmq';
import { Redis } from 'ioredis';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { BOT_DISCLAIMER, QUEUES, type Env } from '@apecheck/core';
import { createSources } from '@apecheck/sources';
import { memoryLogger } from '../src/log';
import { startCheckWorker, type CheckWorkerHandle } from '../src/worker';
import { SINCE_KEY, startBotWorker, type BotWorkerHandle } from '../src/bot/index';
import { serveFixture, testLookup, type FixtureSite } from './fixture-server';
import { fakeHttp } from './fakes';
import { XApi, routeHttp, type XApiUser } from './x-api';
import { heuristicAi, prisma, resetDb, testEnv } from './helpers';

const BOT_ID = '1800000000000000000';
const CREDS = {
  consumerKey: 'e2eConsumerKey0000000000',
  consumerSecret: 'e2e consumer secret/with+odd=chars',
  token: `${BOT_ID}-e2eAccessToken`,
  tokenSecret: 'e2e token secret&more',
  bearer: 'AAAAe2eBearer%3D',
};
const DAY = 86_400_000;
/** the share card the web app renders: > 1 MB, so the upload takes two append chunks */
const CARD = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), randomBytes(1_300_000)]);
const VERDICT_RE = /^(REAL|LIKELY REAL|PARTLY REAL|LIKELY LARP|LARP) \(\d{1,3}\/100\)( · Coin: [A-Z ]+ \(\d{1,3}\))?\n/;

let env: Env;
let site: FixtureSite;
let checks: CheckWorkerHandle;
let bot: BotWorkerHandle;
let conn: Redis;
let api: XApi;
const cardsServed: string[] = [];
const users: Record<'bot' | 'orbit' | 'rina' | 'other' | 'sleuth' | 'newbie', XApiUser> = {} as never;

async function until<T>(what: string, fn: () => Promise<T | null | undefined | false>, ms = 240_000): Promise<T> {
  const deadline = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise(r => setTimeout(r, 250));
  }
}
const mention = (tweetId: string) => prisma.botMention.findUnique({ where: { tweetId } });
const user = (id: string, username: string, createdAt: number): XApiUser => ({
  id,
  username,
  name: username,
  created_at: new Date(createdAt).toISOString(),
  verified: false,
  description: '',
  public_metrics: { followers_count: 120, following_count: 300, tweet_count: 900, listed_count: 1 },
});

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
  env = testEnv({
    SSRF_ALLOW_HOSTS: site.host,
    X_API_KEY: CREDS.consumerKey,
    X_API_SECRET: CREDS.consumerSecret,
    X_ACCESS_TOKEN: CREDS.token,
    X_ACCESS_SECRET: CREDS.tokenSecret,
    X_BEARER_TOKEN: CREDS.bearer,
    X_BOT_USER_ID: BOT_ID,
    X_BOT_HANDLE: 'ApeCheckBot',
    APP_URL: 'https://apecheck.io',
  });

  api = new XApi({ botId: BOT_ID, creds: CREDS });
  const now = Date.now();
  Object.assign(users, {
    bot: api.addUser(user(BOT_ID, 'ApeCheckBot', now - 200 * DAY)),
    // the project: its site links x.com/orbitswap; checks only name the account, they never read it (paid X API)
    orbit: api.addUser({ ...user('1500000000000000700', 'orbitswap', now - 420 * DAY), name: 'Orbit', description: 'Orbit v2: swap across chains.' }),
    rina: api.addUser(user('1600000000000000501', 'degen_rina', now - 900 * DAY)),
    other: api.addUser(user('1600000000000000601', 'other_user', now - 1200 * DAY)),
    sleuth: api.addUser(user('1600000000000000801', 'chain_sleuth', now - 1500 * DAY)),
    newbie: api.addUser(user('1600000000000000901', 'fresh_ape', now - 2 * DAY)),
  });
  // small pages, so a batch of three mentions is read in two
  api.pageSize = 2;

  // one Http for every adapter: api.x.com is the emulator, *.test the fixture sites, nothing else
  const sources = createSources(env, { http: routeHttp(api.http, fakeHttp(env.SSRF_ALLOW_HOSTS)) });
  checks = await startCheckWorker({
    env,
    sources,
    log: memoryLogger(),
    browser: { lookup: testLookup },
    recover: false,
    // the web app's /card/<id>.png (Stage F saves it under SCREENSHOT_DIR/cards)
    fetchCard: async shortId => (cardsServed.push(shortId), CARD),
  });
  bot = await startBotWorker({ env, x: sources.x, ai: heuristicAi(), log: memoryLogger(), pollMs: 1000 });
});

afterAll(async () => {
  await bot?.close();
  await checks?.close(1000);
  await site?.close();
  await conn?.quit();
  await prisma.$disconnect();
});

it('real X adapter end to end: one reply with the card per mention, one check per thread, cached answers, a cut-short batch handled once', { timeout: 300_000 }, async () => {
  // the first poll takes the bot lock (and finds nothing yet)
  await until('worker-bot to take the lock', async () => bot.state === 'active', 10_000);
  const project = api.post(users.orbit, 'Orbit v2 is live, trade now https://t.co/0rb1tV2', { links: { 'https://t.co/0rb1tV2': site.url } });

  // 1. degen_rina tags the bot under the project's post
  const t0 = Date.now();
  const tag = api.reply(project, users.rina, '@ApeCheckBot real or larp?');
  expect(tag.text).toBe('@orbitswap @ApeCheckBot real or larp?');
  const queued = await until('the mention to be queued', async () => {
    const m = await mention(tag.id);
    return m?.status === 'QUEUED' && m.checkId ? m : null;
  }, 30_000);
  // stored as X shows it: what rina typed, without X's "@orbitswap " reply prefix
  expect(queued).toMatchObject({ text: '@ApeCheckBot real or larp?', authorHandle: 'degen_rina', authorId: users.rina.id, conversationId: project.id, inReplyToId: project.id });
  // the project X put in the reply prefix is not to be notified by the bot's reply
  expect(queued.replyExcludeIds).toEqual([users.orbit.id]);
  const check = await prisma.check.findUniqueOrThrow({ where: { id: queued.checkId! } });
  expect(check).toMatchObject({ via: 'BOT', requesterHandle: 'degen_rina', targetRaw: site.url });

  // 2. while it runs, another account tags the bot in the same thread: same check
  const other = api.reply(project, users.other, '@ApeCheckBot is this one legit?');
  await until('the second mention to join the check', async () => (await mention(other.id))?.checkId === check.id);

  // 3. the check finishes; Stage F saves the card and queues both replies; worker-bot uploads the card and posts
  const replied = await until('the reply to the first tag', async () => {
    const m = await mention(tag.id);
    return m?.status === 'REPLIED' ? m : null;
  });
  expect(Date.now() - t0).toBeLessThan(4 * 60_000);
  await until('the reply to the second tag', async () => (await mention(other.id))?.status === 'REPLIED');
  const done = await prisma.check.findUniqueOrThrow({ where: { id: check.id } });
  expect(done.status).toBe('DONE');
  expect(done.cardPath).toBe(`cards/${done.shortId}.png`);
  expect(fs.readFileSync(path.join(env.SCREENSHOT_DIR, done.cardPath!)).equals(CARD)).toBe(true);
  const first = api.posted.find(p => p.inReplyToId === tag.id)!;
  expect(replied).toMatchObject({ kind: 'check', replyTweetId: first.id, replyText: first.text });

  // 4. three mentions arrive together and are read over two pages; X answers the second page 429 once:
  //    rina again in the same thread, chain_sleuth about the same site in a post of its own, a 2-day-old account
  const sinceBefore = await conn.get(SINCE_KEY);
  expect(sinceBefore).toBe(other.id);
  // the reset is 4-5 s away: time to look at the state between the two reads
  api.rateLimitNextPage = 5;
  const retag = api.reply(project, users.rina, '@ApeCheckBot ???');
  const cached = api.post(users.sleuth, '@ApeCheckBot what about https://t.co/0rb1tAg', { links: { 'https://t.co/0rb1tAg': site.url } });
  const young = api.post(users.newbie, '@ApeCheckBot legit? https://t.co/0rb1tYg', { links: { 'https://t.co/0rb1tYg': site.url } });
  // the first page (the two newest) is handled at once; since_id stays put until the 429'd page was read too
  const handled = async (id: string) => {
    const m = await mention(id);
    return !!m && m.status !== 'RECEIVED';
  };
  await until('the first page to be handled', async () => (await handled(cached.id)) && (await handled(young.id)), 30_000);
  expect(await mention(retag.id)).toBeNull();
  expect(await conn.get(SINCE_KEY)).toBe(other.id);
  await until('the cached answer', async () => (await mention(cached.id))?.status === 'REPLIED', 30_000);
  const again = await until('the re-tag to be handled after the back-off', async () => {
    const m = await mention(retag.id);
    return m && m.status !== 'RECEIVED' ? m : null;
  }, 30_000);
  expect(again).toMatchObject({ status: 'IGNORED', ignoreReason: 'answered_in_thread', checkId: check.id });
  expect(await mention(young.id)).toMatchObject({ status: 'IGNORED', ignoreReason: 'young_account', checkId: null });
  expect(await mention(cached.id)).toMatchObject({ status: 'REPLIED', kind: 'check', checkId: check.id, text: '@ApeCheckBot what about https://t.co/0rb1tAg' });
  await until('since_id to move past the batch', async () => (await conn.get(SINCE_KEY)) === young.id, 10_000);

  // a few more polls: nothing is answered twice
  const pollsBefore = api.requests.filter(r => r.url.pathname.endsWith('/mentions')).length;
  await until('two more polls', async () => api.requests.filter(r => r.url.pathname.endsWith('/mentions')).length >= pollsBefore + 2, 10_000);

  // ---- one check, one reply per answered mention, each with the card ----
  expect(await prisma.check.count()).toBe(1);
  expect(api.posted.map(p => p.inReplyToId).sort()).toEqual([tag.id, other.id, cached.id].sort());
  for (const p of api.posted) {
    expect(p.text).toMatch(VERDICT_RE);
    expect(p.text.endsWith(BOT_DISCLAIMER)).toBe(true);
    expect(p.text).not.toContain('@');
    expect(p.mediaIds).toHaveLength(1);
    expect(p.media[0].equals(CARD)).toBe(true);
    const m = await prisma.botMention.findFirstOrThrow({ where: { replyTweetId: p.id } });
    expect(m).toMatchObject({ tweetId: p.inReplyToId, status: 'REPLIED', replyText: p.text });
    // "Replying to" the asker alone (HANDOFF §7: never mention anyone unprompted)
    expect(p.replyingTo).toEqual([m.authorId]);
  }
  expect(new Set(api.posted.map(p => p.text)).size).toBe(1);
  // the card went up in two chunks for each reply; the web was asked for it once (worker-bot read the saved file)
  expect([...api.uploads.values()].map(u => [u.segments.size, u.state, u.bytes?.length])).toEqual(Array(3).fill([2, 'succeeded', CARD.length]));
  expect(cardsServed).toEqual([done.shortId]);

  // ---- the X traffic ----
  expect(api.authErrors).toEqual([]);
  expect(api.badRequests).toEqual([]);
  const reads = api.requests.filter(r => r.url.pathname === `/2/users/${BOT_ID}/mentions`);
  expect(reads.every(r => r.auth === 'oauth1')).toBe(true);
  // the cold start reads without since_id; after that every read carries it
  const firstWithSince = reads.findIndex(r => r.url.searchParams.has('since_id'));
  expect(firstWithSince).toBeGreaterThan(0);
  expect(reads[firstWithSince].url.searchParams.get('since_id')).toBe(tag.id);
  expect(reads.slice(firstWithSince).every(r => r.url.searchParams.has('since_id'))).toBe(true);
  const q = reads[0].url.searchParams;
  expect(q.get('expansions')?.split(',')).toEqual(expect.arrayContaining(['author_id', 'referenced_tweets.id', 'referenced_tweets.id.author_id']));
  expect(q.get('tweet.fields')?.split(',')).toEqual(expect.arrayContaining(['display_text_range', 'in_reply_to_user_id', 'conversation_id', 'referenced_tweets', 'entities', 'created_at']));
  expect(q.get('user.fields')?.split(',')).toContain('created_at');
  // the second page: once 429, then read with the same since_id after the reset
  const paged = reads.filter(r => r.url.searchParams.has('pagination_token'));
  expect(paged.map(r => [r.status, r.url.searchParams.get('since_id')])).toEqual([[429, other.id], [200, other.id]]);
  // every write is user context; the posts are replies to the stored mentions and nothing else
  const writes = api.requests.filter(r => r.method === 'POST');
  expect(writes.every(r => r.auth === 'oauth1' && r.status < 300)).toBe(true);
  expect(writes.filter(r => r.url.pathname === '/2/tweets')).toHaveLength(3);
  const stored = new Set((await prisma.botMention.findMany({ select: { tweetId: true } })).map(m => m.tweetId));
  expect(api.posted.every(p => p.inReplyToId && stored.has(p.inReplyToId))).toBe(true);
  // the pipeline never used the paid X API (no Bearer read at all, not the project's account either): only the bot did
  expect(api.requests.filter(r => r.auth === 'bearer' || r.url.pathname.startsWith('/2/users/by/username/') || r.url.pathname.startsWith('/2/tweets/'))).toEqual([]);
});
