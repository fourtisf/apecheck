/**
 * The bot against the test database and Redis (db 2), with a FakeX: storing, ignore rules, limits, idempotency,
 * one check per thread, cache hits, follow-ups, replies (card, retries, failures), since_id and the lock.
 * Queues are replaced by recorders here; test/bot-flow.test.ts runs the real queues and pipeline.
 */
import fs from 'node:fs';
import path from 'node:path';
import { Redis } from 'ioredis';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { BOT_DISCLAIMER } from '@apecheck/core';
import type { XPost } from '@apecheck/sources';
import { memoryLogger } from '../src/log';
import { enqueueBotReply } from '../src/pipeline/save';
import type { PipelineDeps } from '../src/pipeline/context';
import { LOCK_KEY, SINCE_KEY, currentSinceId, pollOnce, startBotWorker } from '../src/bot/index';
import { handleMention, type BotDeps } from '../src/bot/handle';
import { RetryReplyError, isRetryable, processReply, replyBackoff } from '../src/bot/reply';
import { FAILED_TEXT, HELP_TEXT, PRO_POINTER_TEXT, fitsX } from '../src/bot/compose';
import { FakeX, post, replyTo, tweetId } from './fake-x';
import { createCheck, heuristicAi, prisma, resetDb, testEnv } from './helpers';
import { fakeSources, xUser } from './fakes';
import { balanceReader, refreshTiers } from '../src/maintenance/index';

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from('fake card image')]);
const CA = '0x1111111111111111111111111111111111111111';
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

function harness(o: { env?: Record<string, string>; x?: FakeX; fetchCard?: BotDeps['fetchCard'] } = {}) {
  const env = testEnv({
    X_BOT_USER_ID: '1000',
    X_BOT_HANDLE: 'ApeCheckBot',
    BOT_USER_HOURLY: '3',
    BOT_PRO_USER_HOURLY: '20',
    BOT_HOURLY_CAP: '200',
    CACHE_HOURS: '6',
    APP_URL: 'https://apecheck.io',
    ...o.env,
  });
  const x = o.x ?? new FakeX();
  const checks: string[] = [];
  const replies: string[] = [];
  const log = memoryLogger();
  const deps: BotDeps = {
    env,
    prisma,
    redis,
    x,
    ai: heuristicAi(),
    log,
    enqueueCheck: async id => void checks.push(id),
    enqueueReply: async id => void replies.push(id),
    fetchCard: o.fetchCard ?? (async () => null),
  };
  return { deps, env, x, checks, replies, log };
}

/** Stage F's hook (save.ts enqueueBotReply) with a recorder. */
async function stageFReplies(checkId: string): Promise<string[]> {
  const out: string[] = [];
  const deps = { prisma, log: memoryLogger(), hooks: { enqueueBotReply: async (id: string) => void out.push(id) } } as unknown as PipelineDeps;
  await enqueueBotReply(deps, checkId);
  return out;
}

async function finish(checkId: string, p: { narScore?: number; narBand?: string; coinScore?: number | null; coinBand?: string | null; summary?: string; status?: 'DONE' | 'FAILED' } = {}) {
  return prisma.check.update({
    where: { id: checkId },
    data: {
      status: p.status ?? 'DONE',
      finishedAt: new Date(),
      narScore: p.narScore ?? 37,
      narBand: p.narBand ?? 'llarp',
      coinScore: p.coinScore ?? null,
      coinBand: p.coinBand ?? null,
      totalScore: p.narScore ?? 37,
      summary: p.summary ?? "'Launch app' does nothing; GitHub pushed in one burst at launch.",
      isLatest: true,
    },
  });
}

const mentionRow = (tweet: string) => prisma.botMention.findUniqueOrThrow({ where: { tweetId: tweet } });
const projectPost = (p: Partial<XPost> = {}) => post({ text: 'Orbit v2 is live https://t.co/AbC', urls: ['https://orbit.xyz/'], authorHandle: 'orbitxyz', authorId: '700', ...p });

describe('storing and idempotency', () => {
  it('stores every mention once; the same mention delivered twice gets one row and one reply', async () => {
    const { deps, x, replies } = harness();
    const m = post({ text: '@ApeCheckBot hello' });
    x.inbox.push(m);
    const first = await pollOnce(deps);
    expect(first.outcomes).toEqual([{ tweetId: m.id, outcome: { action: 'help' } }]);
    // delivered again (since_id lost, or a second poll racing): already stored → never handled again
    await redis.set(SINCE_KEY, String(BigInt(m.id) - 1n));
    const again = await pollOnce(deps);
    expect(again.outcomes).toEqual([{ tweetId: m.id, outcome: { action: 'duplicate' } }]);
    expect(await handleMention(deps, m)).toEqual({ action: 'duplicate' });
    expect(await prisma.botMention.count()).toBe(1);
    expect(replies).toHaveLength(1);

    expect(await processReply(deps, replies[0])).toBe('replied');
    expect(await processReply(deps, replies[0])).toBe('already');
    expect(x.replies).toEqual([{ id: expect.any(String), inReplyToId: m.id, text: HELP_TEXT, media: null }]);
    const row = await mentionRow(m.id);
    expect(row).toMatchObject({ status: 'REPLIED', kind: 'help', replyTweetId: x.replies[0].id, replyText: HELP_TEXT, text: '@ApeCheckBot hello' });
    expect(row.repliedAt).toBeInstanceOf(Date);
  });

  it('never posts without a stored mention, and never for a mention that is not waiting for a reply', async () => {
    const { deps, x } = harness();
    expect(await processReply(deps, 'nope')).toBe('missing');
    const m = post({ text: 'RT @orbitxyz: @ApeCheckBot real?' });
    await handleMention(deps, m);
    expect(await processReply(deps, (await mentionRow(m.id)).id)).toBe('skipped');
    expect(x.replies).toEqual([]);
  });

  it('stores what the author typed, without X\'s reply prefix', async () => {
    const { deps } = harness();
    const m = replyTo(projectPost(), '@ApeCheckBot real or larp?');
    expect(m.text).toBe('@orbitxyz @ApeCheckBot real or larp?');
    await handleMention(deps, m);
    expect((await mentionRow(m.id)).text).toBe('@ApeCheckBot real or larp?');
  });

  it('records whether the author typed the handle (the accounts /v1/bot/stats counts), whatever is done with it', async () => {
    const { deps } = harness();
    const tag = post({ text: '@ApeCheckBot is this real?', authorHandle: 'degen_rina', authorId: '501' });
    const cases: [XPost, boolean][] = [
      [tag, true],
      // the full-width at sign, any case, and a tag that is then ignored (stale) still tagged it
      [post({ text: 'real? ＠apecheckbot', authorId: '502' }), true],
      [post({ text: '@ApeCheckBot real?', authorId: '503', createdAt: new Date(Date.now() - 13 * 3600_000).toISOString() }), true],
      // the bot only in X's reply prefix, a longer handle, a retweet of someone's tag, the bot's own post
      [replyTo(tag, 'lol same question', { authorHandle: 'lurker', authorId: '77' }), false],
      [post({ text: '@ApeCheckBotFan gm', authorId: '504' }), false],
      [post({ text: 'RT @degen_rina: @ApeCheckBot is this real?', authorId: '505' }), false],
      [post({ text: '@ApeCheckBot test', authorId: '1000', authorHandle: 'ApeCheckBot' }), false],
    ];
    for (const [m, tagged] of cases) {
      await handleMention(deps, m);
      expect({ text: m.text, tagged: (await mentionRow(m.id)).tagged }).toEqual({ text: m.text, tagged });
    }
  });
});

describe('ignore rules', () => {
  const cases: { name: string; reason: string; make: () => XPost; x?: (x: FakeX) => void }[] = [
    { name: 'the bot itself', reason: 'self', make: () => post({ text: '@ApeCheckBot test', authorId: '1000', authorHandle: 'ApeCheckBot' }) },
    { name: 'a retweet', reason: 'retweet', make: () => post({ text: 'RT @orbitxyz: @ApeCheckBot real?' }) },
    { name: 'an old mention (backlog)', reason: 'stale', make: () => post({ text: '@ApeCheckBot real?', createdAt: new Date(Date.now() - 13 * 3600_000).toISOString() }) },
    {
      name: 'an account younger than 7 days',
      reason: 'young_account',
      make: () => post({ text: `@ApeCheckBot ${CA}`, author: xUser({ handle: 'fresh', id: '501', createdAt: new Date(Date.now() - 2 * 86400_000).toISOString() }) }),
    },
    {
      name: 'a young account whose age comes from a user lookup',
      reason: 'young_account',
      make: () => post({ text: `@ApeCheckBot ${CA}`, authorId: '502', author: null }),
      x: x => x.users.set('502', xUser({ handle: 'fresh2', id: '502', createdAt: new Date(Date.now() - 3 * 86400_000).toISOString() })),
    },
    {
      name: "the bot only in X's reply prefix (someone chatting further down the thread)",
      reason: 'not_tagged',
      make: () => replyTo(post({ text: '@ApeCheckBot is this real?', authorHandle: 'degen_rina', authorId: '501' }), 'lol same question', { authorHandle: 'lurker', authorId: '77' }),
    },
  ];
  for (const c of cases) {
    it(c.name, async () => {
      const { deps, x, checks, replies } = harness();
      c.x?.(x);
      const m = c.make();
      expect(await handleMention(deps, m)).toEqual({ action: 'ignored', reason: c.reason });
      expect(await mentionRow(m.id)).toMatchObject({ status: 'IGNORED', kind: 'ignored', ignoreReason: c.reason, checkId: null });
      expect(checks).toEqual([]);
      expect(replies).toEqual([]);
      expect(await prisma.check.count()).toBe(0);
    });
  }

  it('an account whose age is unknown is not held against it', async () => {
    const { deps } = harness();
    expect(await handleMention(deps, post({ text: '@ApeCheckBot hi', authorId: '503', author: null }))).toEqual({ action: 'help' });
  });
});

describe('limits', () => {
  it('BOT_USER_HOURLY per free account; ignored mentions are not counted', async () => {
    const { deps } = harness({ env: { BOT_USER_HOURLY: '2' } });
    expect(await handleMention(deps, post({ text: 'RT @x: @ApeCheckBot' }))).toMatchObject({ action: 'ignored', reason: 'retweet' });
    expect(await handleMention(deps, post({ text: '@ApeCheckBot one' }))).toEqual({ action: 'help' });
    expect(await handleMention(deps, post({ text: '@ApeCheckBot two' }))).toEqual({ action: 'help' });
    const third = post({ text: `@ApeCheckBot ${CA}` });
    expect(await handleMention(deps, third)).toEqual({ action: 'ignored', reason: 'user_limit' });
    expect(await prisma.check.count()).toBe(0); // a limited user never starts a check
    // another account still gets answers
    expect(await handleMention(deps, post({ text: '@ApeCheckBot hi', authorId: '601', authorHandle: 'other' }))).toEqual({ action: 'help' });
  });

  it('BOT_PRO_USER_HOURLY for an account linked to a Pro/Max user', async () => {
    const { deps } = harness({ env: { BOT_USER_HOURLY: '1', BOT_PRO_USER_HOURLY: '3' } });
    await prisma.user.create({ data: { xUserId: '501', xHandle: 'degen_rina', tier: 'PRO' } });
    for (let i = 0; i < 3; i++) expect(await handleMention(deps, post({ text: `@ApeCheckBot q${i}` }))).toEqual({ action: 'help' });
    expect(await handleMention(deps, post({ text: '@ApeCheckBot q4' }))).toEqual({ action: 'ignored', reason: 'user_limit' });
  });

  it('BOT_HOURLY_CAP for the whole bot', async () => {
    const { deps } = harness({ env: { BOT_HOURLY_CAP: '2' } });
    expect(await handleMention(deps, post({ text: '@ApeCheckBot a', authorId: '11', authorHandle: 'a1' }))).toEqual({ action: 'help' });
    expect(await handleMention(deps, post({ text: '@ApeCheckBot b', authorId: '12', authorHandle: 'b1' }))).toEqual({ action: 'help' });
    expect(await handleMention(deps, post({ text: '@ApeCheckBot c', authorId: '13', authorHandle: 'c1' }))).toEqual({ action: 'ignored', reason: 'global_limit' });
  });
});

describe('help', () => {
  it('replies the help line at most once per thread', async () => {
    const { deps, x, replies } = harness();
    const root = post({ text: 'gm', authorHandle: 'someone', authorId: '900' });
    x.posts.set(root.id, root);
    const a = post({ text: '@ApeCheckBot ?', conversationId: root.id });
    const b = post({ text: '@ApeCheckBot ??', conversationId: root.id, authorId: '502', authorHandle: 'b2' });
    expect(await handleMention(deps, a)).toEqual({ action: 'help' });
    expect(await handleMention(deps, b)).toEqual({ action: 'ignored', reason: 'help_already_sent' });
    expect(replies).toEqual([(await mentionRow(a.id)).id]);
    await processReply(deps, replies[0]);
    expect(x.replies.map(r => r.text)).toEqual(["Tag me under a project's post, or include its link or contract."]);
  });

  it("reads the parent post when X didn't include it", async () => {
    const { deps, x } = harness();
    const parent = projectPost();
    x.posts.set(parent.id, parent);
    const m = replyTo(parent, '@ApeCheckBot real?', { repliedTo: null });
    expect(await handleMention(deps, m)).toMatchObject({ action: 'check', target: 'https://orbit.xyz/' });
  });
});

describe('checks', () => {
  it('tagging under a project post starts one check (via BOT) and replies when Stage F finishes it', async () => {
    const { deps, x, checks, replies } = harness();
    const m = replyTo(projectPost(), '@ApeCheckBot real or larp?');
    const out = await handleMention(deps, m);
    expect(out).toMatchObject({ action: 'check', reuse: null, replyNow: false, target: 'https://orbit.xyz/' });
    const check = await prisma.check.findFirstOrThrow({ include: { target: true } });
    expect(check).toMatchObject({ via: 'BOT', requesterHandle: 'degen_rina', targetRaw: 'https://orbit.xyz/', status: 'QUEUED', postId: null });
    expect(check.target).toMatchObject({ key: 'site:orbit.xyz', checkCount: 1 });
    expect(checks).toEqual([check.id]);
    expect(replies).toEqual([]);
    expect(await mentionRow(m.id)).toMatchObject({ status: 'QUEUED', kind: 'check', checkId: check.id, targetKey: 'site:orbit.xyz' });

    // Stage F
    await finish(check.id, { coinScore: 37, coinBand: 'sketchy' });
    fs.mkdirSync(path.join(deps.env.SCREENSHOT_DIR, 'cards'), { recursive: true });
    fs.writeFileSync(path.join(deps.env.SCREENSHOT_DIR, 'cards', `${check.shortId}.png`), PNG);
    const queued = await stageFReplies(check.id);
    expect(queued).toEqual([(await mentionRow(m.id)).id]);
    expect(await processReply(deps, queued[0])).toBe('replied');
    expect(x.replies).toEqual([
      {
        id: expect.any(String),
        inReplyToId: m.id,
        text: `LIKELY LARP (37/100) · Coin: SKETCHY (37)\n'Launch app' does nothing; GitHub pushed in one burst at launch.\n${BOT_DISCLAIMER}`,
        media: PNG,
        // the project account X would put in "Replying to" is left out: only the asker is notified
        excludeUserIds: ['700'],
      },
    ]);
    // the reply never mentions anyone the bot wasn't asked by
    expect(x.replies[0].text).not.toContain('@');
  });

  it('an X post link becomes a post check with its post id', async () => {
    const { deps } = harness();
    await handleMention(deps, post({ text: '@ApeCheckBot this? https://t.co/p', urls: ['https://x.com/kairolabs/status/1849002'] }));
    expect(await prisma.check.findFirstOrThrow()).toMatchObject({ postId: '1849002', targetRaw: 'https://x.com/kairolabs/status/1849002', via: 'BOT' });
  });

  it('tagging twice in the same thread does not produce a second check', async () => {
    const { deps, x } = harness();
    const parent = projectPost();
    const first = replyTo(parent, '@ApeCheckBot real or larp?');
    const second = replyTo(parent, '@ApeCheckBot is this one real?', { authorId: '601', authorHandle: 'other_user' });
    const again = replyTo(parent, '@ApeCheckBot ???'); // the first author again, same thread
    expect(await handleMention(deps, first)).toMatchObject({ action: 'check', reuse: null });
    const check = await prisma.check.findFirstOrThrow();
    // while it runs: another account's tag joins the same check (the thread already has it)
    expect(await handleMention(deps, second)).toMatchObject({ action: 'check', checkId: check.id, reuse: 'thread', replyNow: false });
    // the same account re-tagging: linked, no second reply to them
    expect(await handleMention(deps, again)).toEqual({ action: 'ignored', reason: 'answered_in_thread' });
    expect(await mentionRow(again.id)).toMatchObject({ checkId: check.id, targetKey: 'site:orbit.xyz' });
    expect(await prisma.check.count()).toBe(1);
    expect((await prisma.target.findFirstOrThrow()).checkCount).toBe(1);

    await finish(check.id);
    const queued = await stageFReplies(check.id);
    expect(queued).toHaveLength(2);
    for (const id of queued) expect(await processReply(deps, id)).toBe('replied');
    expect(x.replies.map(r => r.inReplyToId).sort()).toEqual([first.id, second.id].sort());
    expect(new Set(x.replies.map(r => r.text)).size).toBe(1);

    // a later tag in the thread (verdict done, even past CACHE_HOURS): same check, answered at once
    await prisma.check.update({ where: { id: check.id }, data: { finishedAt: new Date(Date.now() - 30 * 3600_000) } });
    const late = replyTo(parent, '@ApeCheckBot and now?', { authorId: '602', authorHandle: 'late_user' });
    expect(await handleMention(deps, late)).toMatchObject({ action: 'check', checkId: check.id, reuse: 'thread', replyNow: true });
    expect(await prisma.check.count()).toBe(1);
  });

  it('a cached verdict (< CACHE_HOURS) is answered immediately with its card, without a new check', async () => {
    const fetched: string[] = [];
    const { deps, x, checks, replies } = harness({ fetchCard: async id => (fetched.push(id), PNG) });
    const web = await createCheck('https://orbit.xyz');
    await finish(web.id, { narScore: 82, narBand: 'real', summary: 'The app works end to end.' });
    const m = post({ text: '@ApeCheckBot orbit.xyz legit?' });
    expect(await handleMention(deps, m)).toMatchObject({ action: 'check', checkId: web.id, reuse: 'cached', replyNow: true });
    expect(checks).toEqual([]);
    expect(replies).toEqual([(await mentionRow(m.id)).id]);
    expect(await processReply(deps, replies[0])).toBe('replied');
    // no card saved under SCREENSHOT_DIR: fetched from the web's /card route
    expect(fetched).toEqual([web.shortId]);
    expect(x.replies[0]).toMatchObject({ text: `REAL (82/100)\nThe app works end to end.\n${BOT_DISCLAIMER}`, media: PNG });
  });

  it("a Sonic contract tagged again after its check moved to the site in its token info: cached, and the reply says what the verdict is for", async () => {
    const SONIC = '0x17c63a297a76bed7e96a96bcf5f566de1efdd1fc';
    const { deps, x, checks, replies } = harness();
    const first = await createCheck(SONIC);
    // the worker: no reads on Sonic, so the check is of esco.example (the Target re-keyed to the site)
    await prisma.target.update({ where: { id: first.targetId }, data: { key: 'site:esco.example', kind: 'SITE', domain: 'esco.example', name: 'esco.example' } });
    await finish(first.id, { narScore: 64, narBand: 'likely', summary: 'The app loads and the swap reaches a transaction.' });
    await prisma.check.update({ where: { id: first.id }, data: { evidence: { otherChain: { chain: 'Sonic', address: SONIC, site: 'esco.example' } } } });

    const m = post({ text: `@ApeCheckBot CA: ${SONIC} legit?` });
    expect(await handleMention(deps, m)).toMatchObject({ action: 'check', checkId: first.id, reuse: 'cached', replyNow: true });
    expect(checks).toEqual([]);
    expect(await processReply(deps, replies[0])).toBe('replied');
    const text = x.replies[0].text;
    expect(text).toBe(
      "LIKELY REAL (64/100)\nThis verdict is for esco[.]example, the website in the token's info; the coin on Sonic wasn't checked.\n" +
        `The app loads and the swap reaches a transaction.\n${BOT_DISCLAIMER}`,
    );
    expect(fitsX(text)).toBe(true);
  });

  it('an old verdict starts a new check; a running one is joined and answered by Stage F', async () => {
    const { deps, checks, replies } = harness();
    const old = await createCheck('https://orbit.xyz');
    await finish(old.id);
    await prisma.check.update({ where: { id: old.id }, data: { finishedAt: new Date(Date.now() - 7 * 3600_000) } });
    const a = post({ text: '@ApeCheckBot orbit.xyz?' });
    expect(await handleMention(deps, a)).toMatchObject({ action: 'check', reuse: null });
    expect(checks).toHaveLength(1);
    const running = await createCheck('https://kairo.ai');
    await prisma.check.update({ where: { id: running.id }, data: { status: 'RUNNING', startedAt: new Date() } });
    const b = post({ text: '@ApeCheckBot kairo.ai?', authorId: '601', authorHandle: 'b1' });
    expect(await handleMention(deps, b)).toMatchObject({ action: 'check', checkId: running.id, reuse: 'running', replyNow: false });
    expect(checks).toHaveLength(1);
    expect(replies).toEqual([]);
    await finish(running.id, { status: 'FAILED' });
    expect(await stageFReplies(running.id)).toEqual([(await mentionRow(b.id)).id]);
  });

  it('a failed check gets the "try again" line, without a card', async () => {
    const { deps, x } = harness({ fetchCard: async () => PNG });
    const m = post({ text: `@ApeCheckBot ${CA}` });
    await handleMention(deps, m);
    const check = await prisma.check.findFirstOrThrow();
    await prisma.check.update({ where: { id: check.id }, data: { status: 'FAILED', finishedAt: new Date(), error: 'The check hit an error and could not finish' } });
    const [id] = await stageFReplies(check.id);
    expect(await processReply(deps, id)).toBe('replied');
    expect(x.replies[0]).toMatchObject({ text: FAILED_TEXT, media: null });
  });

  it('re-tagging in the thread after "Couldn\'t finish this check" runs it again', async () => {
    const { deps, x } = harness();
    const parent = projectPost();
    const first = replyTo(parent, '@ApeCheckBot real?');
    await handleMention(deps, first);
    const failed = await prisma.check.findFirstOrThrow();
    await finish(failed.id, { status: 'FAILED' });
    const [id] = await stageFReplies(failed.id);
    await processReply(deps, id);
    expect(x.replies[0].text).toBe(FAILED_TEXT);
    const retry = replyTo(parent, '@ApeCheckBot try again');
    expect(await handleMention(deps, retry)).toMatchObject({ action: 'check', reuse: null });
    expect(await prisma.check.count()).toBe(2);
  });

  describe('a check that could test nothing about the project ("Not enough to check")', () => {
    const STRIDE = 'Not enough to check: no website, GitHub repo or contract on a supported chain was found for @stridefun.';
    const ESCO = '0x17c63a297a76bed7e96a96bcf5f566de1efdd1fc';
    const notEnough = (checkId: string, error = STRIDE, finishedAt = new Date()) =>
      prisma.check.update({ where: { id: checkId }, data: { status: 'FAILED', finishedAt, error } });
    // the incident: "@ApeCheckBot" alone under @stridefun's "Dex paid." (an image, no link or contract)
    const stridePost = () => post({ text: 'Dex paid.', authorHandle: 'stridefun', authorId: '880' });

    it('is answered with its reason, never "try again" or a score: no card, no mention, no link but the report link', async () => {
      for (const links of ['false', 'true']) {
        await resetDb();
        const { deps, x } = harness({ fetchCard: async () => PNG, env: { BOT_INCLUDE_LINK: links } });
        const m = replyTo(stridePost(), '@ApeCheckBot');
        expect(await handleMention(deps, m)).toMatchObject({ action: 'check', target: 'https://x.com/stridefun' });
        const check = await prisma.check.findFirstOrThrow();
        await notEnough(check.id);
        const [id] = await stageFReplies(check.id);
        expect(await processReply(deps, id)).toBe('replied');
        const reason = 'Not enough to check: no website, GitHub repo or contract on a supported chain was found for stridefun.';
        expect(x.replies[0]).toMatchObject({ text: links === 'true' ? `${reason}\napecheck.io/c/${check.shortId}` : reason, media: null });
        expect(x.replies[0].text).not.toMatch(/try again|PARTLY REAL|\/100|@/i);
      }
    });

    it('the same person re-tagging in the thread is not a retry; another person gets the same answer; a tag under the reply is no retry either', async () => {
      const { deps, x } = harness();
      const parent = stridePost();
      const first = replyTo(parent, '@ApeCheckBot');
      await handleMention(deps, first);
      const check = await prisma.check.findFirstOrThrow();
      await notEnough(check.id);
      await processReply(deps, (await stageFReplies(check.id))[0]);

      expect(await handleMention(deps, replyTo(parent, '@ApeCheckBot try again'))).toEqual({ action: 'ignored', reason: 'answered_in_thread' });
      const other = replyTo(parent, '@ApeCheckBot', { authorId: '602', authorHandle: 'other_user' });
      expect(await handleMention(deps, other)).toMatchObject({ action: 'check', checkId: check.id, reuse: 'thread', replyNow: true });
      expect(await processReply(deps, (await mentionRow(other.id)).id)).toBe('replied');
      expect(x.replies[1]).toMatchObject({ inReplyToId: other.id, text: x.replies[0].text });

      // under the bot's own "Not enough to check" reply: an answer to ask about, not a check to run again
      const reply = post({
        id: x.replies[0].id,
        text: `@degen_rina ${x.replies[0].text}`,
        authorHandle: 'ApeCheckBot',
        authorId: '1000',
        conversationId: parent.id,
        replyToId: first.id,
        displayTextRange: [12, 12 + x.replies[0].text.length],
      });
      expect(await handleMention(deps, replyTo(reply, '@ApeCheckBot', { authorId: '603', authorHandle: 'third' }))).toEqual({ action: 'ignored', reason: 'empty_question' });
      expect(await handleMention(deps, replyTo(reply, '@ApeCheckBot why?', { authorId: '604', authorHandle: 'fourth' }))).toEqual({ action: 'ignored', reason: 'no_report' });
      expect(await prisma.check.count()).toBe(1);
      expect(x.replies).toHaveLength(2);
    });

    it('a recent one is reused like a cached verdict (no new check); an old one, or an outage, runs again', async () => {
      const { deps, checks, replies } = harness();
      const recent = await createCheck(ESCO);
      await notEnough(recent.id, `Not enough to check: 0x17c…d1fc is not on Base, Ethereum, BNB Chain or Arbitrum, and no website or GitHub repo was found for it.`);
      const m = post({ text: `@ApeCheckBot ${ESCO}` });
      expect(await handleMention(deps, m)).toMatchObject({ action: 'check', checkId: recent.id, reuse: 'cached', replyNow: true });
      expect(checks).toEqual([]);
      expect(await processReply(deps, replies[0])).toBe('replied');

      await prisma.check.update({ where: { id: recent.id }, data: { finishedAt: new Date(Date.now() - 7 * 3600_000) } });
      expect(await handleMention(deps, post({ text: `@ApeCheckBot ${ESCO}`, authorId: '610', authorHandle: 'b2' }))).toMatchObject({ action: 'check', reuse: null });
      const outage = await prisma.check.findFirstOrThrow({ where: { id: { not: recent.id } } });
      await notEnough(outage.id, "Nothing about 0x17c…d1fc could be checked: the Base RPC didn't answer");
      expect(await handleMention(deps, post({ text: `@ApeCheckBot ${ESCO}`, authorId: '611', authorHandle: 'b3' }))).toMatchObject({ action: 'check', reuse: null });
      expect(checks).toHaveLength(2);
    });

    it('an outage is not "Not enough to check": the "try again" line, and a re-tag in the thread is the retry', async () => {
      const { deps, x } = harness();
      const parent = stridePost();
      await handleMention(deps, replyTo(parent, '@ApeCheckBot'));
      const check = await prisma.check.findFirstOrThrow();
      await notEnough(check.id, "Nothing about @stridefun could be checked: GitHub didn't answer");
      await processReply(deps, (await stageFReplies(check.id))[0]);
      expect(x.replies[0].text).toBe(FAILED_TEXT);
      expect(await handleMention(deps, replyTo(parent, '@ApeCheckBot try again'))).toMatchObject({ action: 'check', reuse: null });
      expect(await prisma.check.count()).toBe(2);
    });
  });

  it('a check whose job could not be queued ends FAILED and is answered at once', async () => {
    const { deps, replies } = harness();
    deps.enqueueCheck = async () => {
      throw new Error('Redis down');
    };
    const out = await handleMention(deps, post({ text: `@ApeCheckBot ${CA}` }));
    expect(out).toMatchObject({ action: 'check', replyNow: true });
    expect(await prisma.check.findFirstOrThrow()).toMatchObject({ status: 'FAILED', error: 'Could not queue the check' });
    expect(replies).toHaveLength(1);
  });
});

describe('follow-ups', () => {
  async function verdictThread() {
    const h = harness();
    const parent = projectPost();
    const tag = replyTo(parent, '@ApeCheckBot real or larp?');
    await handleMention(h.deps, tag);
    const check = await prisma.check.findFirstOrThrow();
    await finish(check.id);
    const [id] = await stageFReplies(check.id);
    await processReply(h.deps, id);
    const verdict = post({
      id: h.x.replies[0].id,
      text: `@degen_rina ${h.x.replies[0].text}`,
      authorHandle: 'ApeCheckBot',
      authorId: '1000',
      conversationId: parent.id,
      replyToId: tag.id,
      displayTextRange: [12, 12 + h.x.replies[0].text.length],
    });
    return { ...h, check, verdict, parent };
  }

  it('a Pro holder replying to the verdict gets an answer from the stored check, saved as an Ask (once, even across retries)', async () => {
    const { deps, x, check, verdict, replies } = await verdictThread();
    await prisma.user.create({ data: { xUserId: '777', xHandle: 'pro_holder', tier: 'PRO' } });
    // X prefixes "@ApeCheckBot @degen_rina": the bot was not typed, but this is a reply to its verdict
    const q = replyTo(verdict, 'who funded the deployer?', { authorId: '777', authorHandle: 'pro_holder' });
    expect(await handleMention(deps, q)).toEqual({ action: 'followup', pro: true });
    const id = replies.at(-1)!;
    expect(await mentionRow(q.id)).toMatchObject({ kind: 'followup', isFollowUp: true, checkId: check.id, status: 'QUEUED', replyText: null, text: 'who funded the deployer?' });

    x.failReplies.push('HTTP 503 Service Unavailable');
    await expect(processReply(deps, id, { attemptsMade: 0, attempts: 3 })).rejects.toBeInstanceOf(RetryReplyError);
    expect(await processReply(deps, id, { attemptsMade: 1, attempts: 3 })).toBe('replied');
    const asks = await prisma.ask.findMany();
    expect(asks).toEqual([expect.objectContaining({ checkId: check.id, question: 'who funded the deployer?', askerHandle: 'pro_holder', via: 'BOT' })]);
    expect(asks[0].answer.length).toBeGreaterThan(0);
    expect((await prisma.check.findUniqueOrThrow({ where: { id: check.id } })).asksCount).toBe(1);
    const posted = x.replies.at(-1)!;
    expect(posted.inReplyToId).toBe(q.id);
    expect(posted.media).toBeNull();
    expect(posted.text).not.toContain('@');
    expect((await mentionRow(q.id)).replyText).toBe(posted.text);
  });

  it('anyone else gets one line pointing to the site, once per thread', async () => {
    const { deps, x, verdict, replies } = await verdictThread();
    const q1 = replyTo(verdict, 'who funded the deployer?', { authorId: '778', authorHandle: 'free_user' });
    const q2 = replyTo(verdict, 'and the LP?', { authorId: '778', authorHandle: 'free_user' });
    expect(await handleMention(deps, q1)).toEqual({ action: 'followup', pro: false });
    expect(await handleMention(deps, q2)).toEqual({ action: 'ignored', reason: 'pointer_already_sent' });
    expect(await processReply(deps, replies.at(-1)!)).toBe('replied');
    expect(x.replies.at(-1)).toMatchObject({ inReplyToId: q1.id, text: PRO_POINTER_TEXT, media: null });
    expect(await prisma.ask.count()).toBe(0);
  });

  it('tagging the bot with a new link under its verdict asks for a check of that link, not a follow-up', async () => {
    const { deps, verdict } = await verdictThread();
    const m = replyTo(verdict, '@ApeCheckBot and this one? https://t.co/k', { authorId: '780', authorHandle: 'x2', urls: ['https://kairo.ai'] });
    expect(await handleMention(deps, m)).toMatchObject({ action: 'check', target: 'https://kairo.ai', reuse: null });
    expect(await prisma.check.count()).toBe(2);
  });

  it('a reply to the verdict is a tag only when the author typed the handle', async () => {
    const { deps, verdict } = await verdictThread();
    const untagged = replyTo(verdict, 'who funded the deployer?', { authorId: '781', authorHandle: 'x3' });
    const typed = replyTo(verdict, '@ApeCheckBot who funded the deployer?', { authorId: '782', authorHandle: 'x4' });
    expect(await handleMention(deps, untagged)).toEqual({ action: 'followup', pro: false });
    await handleMention(deps, typed);
    expect((await mentionRow(untagged.id)).tagged).toBe(false);
    expect((await mentionRow(typed.id)).tagged).toBe(true);
  });

  it('an empty follow-up is ignored', async () => {
    const { deps, verdict } = await verdictThread();
    expect(await handleMention(deps, replyTo(verdict, '', { authorId: '779', authorHandle: 'x1' }))).toEqual({ action: 'ignored', reason: 'empty_question' });
  });
});

describe('tiers of X-linked users (M3)', () => {
  const TOKEN = 'ApeCheckMint11111111111111111111111111111111';
  const SOL = 'So1Linked1111111111111111111111111111111111';

  it('the bot marks the linked user seen; the hourly refresh then gives the bot the new tier (limits and follow-ups)', async () => {
    const env = { BOT_USER_HOURLY: '1', BOT_PRO_USER_HOURLY: '3' };
    const user = await prisma.user.create({
      data: { xUserId: '777', xHandle: 'pro_holder', solAddress: SOL, tier: 'FREE', holding: 0, tierCheckedAt: new Date(Date.now() - 2 * 3600_000) },
    });
    // Free: BOT_USER_HOURLY
    const { deps } = harness({ env });
    const from777 = (text: string) => post({ text, authorId: '777', authorHandle: 'pro_holder' });
    expect(await handleMention(deps, from777('@ApeCheckBot one'))).toEqual({ action: 'help' });
    expect(await handleMention(deps, from777('@ApeCheckBot two'))).toEqual({ action: 'ignored', reason: 'user_limit' });
    // using the bot counts as being seen (that is what puts bot-only users in the hourly tier refresh)
    expect((await prisma.user.findUniqueOrThrow({ where: { id: user.id } })).lastSeenAt).toBeInstanceOf(Date);

    // they bought $APECHECK: worker-prices' hourly refresh reads the balance of their linked wallet
    const live = testEnv({ TOKEN_CHAIN: 'sol', TOKEN_ADDRESS: TOKEN, PRO_MIN_HOLD: '250000', MAX_MIN_HOLD: '2500000' });
    const res = await refreshTiers({ env: live, prisma, readBalance: balanceReader(fakeSources(live, { balances: { [SOL]: 400_000 } })), log: memoryLogger() });
    expect(res).toMatchObject({ users: 1, read: 1, changed: 1 });
    expect(await prisma.user.findUniqueOrThrow({ where: { id: user.id } })).toMatchObject({ tier: 'PRO' });

    // the bot reads that tier: BOT_PRO_USER_HOURLY (the ignored mention was not counted) ...
    expect(await handleMention(deps, from777('@ApeCheckBot three'))).toEqual({ action: 'help' });
    expect(await handleMention(deps, from777('@ApeCheckBot four'))).toEqual({ action: 'help' });
    expect(await handleMention(deps, from777('@ApeCheckBot five'))).toEqual({ action: 'ignored', reason: 'user_limit' });
  });

  it('a follow-up under the verdict is answered for a user the refresh made Pro (TIER_OVERRIDES before launch), not before', async () => {
    const h = harness();
    const parent = projectPost();
    await handleMention(h.deps, replyTo(parent, '@ApeCheckBot real or larp?'));
    const check = await prisma.check.findFirstOrThrow();
    await finish(check.id);
    const [id] = await stageFReplies(check.id);
    await processReply(h.deps, id);
    const verdict = post({
      id: h.x.replies[0].id,
      text: `@degen_rina ${h.x.replies[0].text}`,
      authorHandle: 'ApeCheckBot',
      authorId: '1000',
      conversationId: parent.id,
      displayTextRange: [12, 12 + h.x.replies[0].text.length],
    });
    const evm = '0x' + 'ab'.repeat(20);
    const user = await prisma.user.create({ data: { xUserId: '888', xHandle: 'team_wallet', evmAddress: evm, tier: 'FREE', lastSeenAt: new Date() } });
    const ask = (text: string) => replyTo(verdict, text, { authorId: '888', authorHandle: 'team_wallet' });
    expect(await handleMention(h.deps, ask('who funded the deployer?'))).toEqual({ action: 'followup', pro: false });

    const notLive = testEnv({ TIER_OVERRIDES: `${evm.toUpperCase().replace('0X', '0x')}:pro` });
    await refreshTiers({ env: notLive, prisma, readBalance: balanceReader(fakeSources(notLive)), log: memoryLogger() });
    expect(await prisma.user.findUniqueOrThrow({ where: { id: user.id } })).toMatchObject({ tier: 'PRO' });
    expect(await handleMention(h.deps, ask('and who holds the LP?'))).toEqual({ action: 'followup', pro: true });
  });
});

describe('posting', () => {
  async function queuedHelp(h: ReturnType<typeof harness>) {
    await handleMention(h.deps, post({ text: '@ApeCheckBot ?' }));
    return h.replies[0];
  }

  it('retries 429 / 5xx (the job throws for BullMQ) and fails for good on the last attempt', async () => {
    const h = harness();
    const id = await queuedHelp(h);
    h.x.failReplies.push('rate limited until 2026-10-19T17:00:00.000Z (429)', 'HTTP 502 Bad Gateway', 'HTTP 503');
    await expect(processReply(h.deps, id, { attemptsMade: 0, attempts: 3 })).rejects.toThrow(/429/);
    await expect(processReply(h.deps, id, { attemptsMade: 1, attempts: 3 })).rejects.toThrow(/502/);
    expect(await processReply(h.deps, id, { attemptsMade: 2, attempts: 3 })).toBe('failed');
    // a 5xx may hide a created post: before posting again after the 502, the bot looked for its reply (none)
    expect(h.x.findCalls.length).toBeGreaterThanOrEqual(1);
    expect(await prisma.botMention.findUniqueOrThrow({ where: { id } })).toMatchObject({
      status: 'FAILED',
      ignoreReason: 'X did not confirm the reply (it may have been posted): HTTP 503',
      replyTweetId: null,
    });
  });

  it('does not retry a refusal (duplicate content, forbidden)', async () => {
    const h = harness();
    const id = await queuedHelp(h);
    h.x.failReplies.push('HTTP 403: You are not allowed to create a Tweet with duplicate content.');
    expect(await processReply(h.deps, id, { attemptsMade: 0, attempts: 3 })).toBe('failed');
    expect(h.x.replies).toEqual([]);
  });

  it('tells retryable trouble from refusals, and waits for X\'s rate-limit reset', () => {
    expect(isRetryable('x.reply: rate limited until 2026-10-19T17:00:00.000Z')).toBe(true);
    expect(isRetryable('x.reply: HTTP 503 from api.x.com: Service Unavailable')).toBe(true);
    expect(isRetryable('x.reply: http.request: timeout after 10000ms')).toBe(true);
    expect(isRetryable('x.reply: duplicate content (HTTP 403)')).toBe(false);
    expect(isRetryable('x.reply: HTTP 400 from api.x.com: Invalid Request')).toBe(false);
    expect(isRetryable('x.reply: HTTP 401 from api.x.com: Unauthorized')).toBe(false);
    // an unreadable answer to the POST: X may have created the post; retried, looking for it first
    expect(isRetryable('x.reply: bad JSON from api.x.com')).toBe(true);
    const now = Date.parse('2026-10-19T16:50:00.000Z');
    expect(replyBackoff(1, 'x-reply', new Error('x.reply: HTTP 503'), now)).toBe(30_000);
    expect(replyBackoff(2, 'x-reply', new Error('x.reply: HTTP 503'), now)).toBe(60_000);
    expect(replyBackoff(1, 'x-reply', new Error('x.reply: rate limited until 2026-10-19T17:00:00.000Z'), now)).toBe(602_000);
    expect(replyBackoff(1, 'x-reply', new Error('x.reply: rate limited until 2026-10-20T16:50:00.000Z'), now)).toBe(30 * 60_000);
  });

  it('a reply X accepted but the database did not record is recorded on retry, not posted again', async () => {
    const h = harness();
    const id = await queuedHelp(h);
    await redis.set(`bot:posted:${id}`, JSON.stringify({ id: '424242', text: HELP_TEXT }));
    expect(await processReply(h.deps, id)).toBe('replied');
    expect(h.x.replies).toEqual([]);
    expect(await prisma.botMention.findUniqueOrThrow({ where: { id } })).toMatchObject({ status: 'REPLIED', replyTweetId: '424242' });
  });

  it('posts text only when there is no card anywhere', async () => {
    const h = harness({ fetchCard: async () => null });
    await handleMention(h.deps, post({ text: `@ApeCheckBot ${CA}` }));
    const check = await prisma.check.findFirstOrThrow();
    await finish(check.id);
    const [id] = await stageFReplies(check.id);
    expect(await processReply(h.deps, id)).toBe('replied');
    expect(h.x.replies[0].media).toBeNull();
    expect(h.x.replies[0].text).toMatch(/^LIKELY LARP \(37\/100\)\n/);
  });
});

describe('polling, since_id and the lock', () => {
  it('starts from the newest stored mention on a cold start and stores since_id after a poll', async () => {
    const h = harness();
    const old = post({ text: '@ApeCheckBot old' });
    await handleMention(h.deps, old);
    await redis.del(SINCE_KEY);
    expect(await currentSinceId(h.deps)).toBe(old.id);
    const fresh = post({ text: '@ApeCheckBot new' });
    h.x.inbox.push(old, fresh);
    const r = await pollOnce(h.deps);
    expect(h.x.mentionCalls).toEqual([old.id]);
    expect(r.outcomes.map(o => o.tweetId)).toEqual([fresh.id]);
    expect(await redis.get(SINCE_KEY)).toBe(fresh.id);
    await pollOnce(h.deps);
    expect(h.x.mentionCalls.at(-1)).toBe(fresh.id);
  });

  it('idles without the X keys, and only one worker-bot is active at a time', async () => {
    const env = testEnv({ X_BOT_USER_ID: '1000' });
    const noKeys = new FakeX();
    noKeys.canPost = false;
    const idle = await startBotWorker({ env, x: noKeys, log: memoryLogger(), autoPoll: false, ai: heuristicAi() });
    expect(idle.state).toBe('idle');
    expect(await idle.tick()).toBeNull();
    await idle.close();
    // an adapter from before M2 (no mentions()/reply())
    const m1 = Object.assign(new FakeX(), { mentions: undefined, reply: undefined });
    const old = await startBotWorker({ env, x: m1, log: memoryLogger(), autoPoll: false, ai: heuristicAi() });
    expect(old.state).toBe('idle');
    await old.close();

    const xa = new FakeX();
    const xb = new FakeX();
    xa.inbox.push(post({ id: tweetId(), text: '@ApeCheckBot hi' }));
    xb.inbox.push(...xa.inbox);
    const a = await startBotWorker({ env, x: xa, log: memoryLogger(), autoPoll: false, ai: heuristicAi() });
    const b = await startBotWorker({ env, x: xb, log: memoryLogger(), autoPoll: false, ai: heuristicAi() });
    try {
      expect(await a.tick()).toMatchObject({ outcomes: [{ outcome: { action: 'help' } }] });
      expect(a.state).toBe('active');
      expect(await b.tick()).toBeNull();
      expect(b.state).toBe('standby');
      expect(xb.mentionCalls).toEqual([]);
      await a.close();
      // the lock is free again: the standby takes over (and the mention, already stored, is not handled twice)
      await redis.del(SINCE_KEY);
      expect(await b.tick()).toMatchObject({ outcomes: [] });
      expect(b.state).toBe('active');
      expect(await prisma.botMention.count()).toBe(1);
    } finally {
      await a.close();
      await b.close();
    }
  });

  it('polls every BOT_POLL_SECONDS, 60 s by default (one owned mentions read a minute), with links off by default', async () => {
    const env = testEnv({ X_BOT_USER_ID: '1000' });
    expect(env.BOT_POLL_SECONDS).toBe(60);
    expect(env.BOT_INCLUDE_LINK).toBe(false);
    await redis.del(LOCK_KEY);
    const log = memoryLogger();
    const x = new FakeX();
    const w = await startBotWorker({ env, x, log, autoPoll: false, ai: heuristicAi() });
    try {
      await w.tick();
      expect(w.state).toBe('active');
      expect(log.lines).toContain("info active: polling @ApeCheckBot's mentions every 60s (AI: heuristic, links off)");
      // one mentions read per poll
      expect(x.mentionCalls).toHaveLength(1);
    } finally {
      await w.close();
    }
  });
});
