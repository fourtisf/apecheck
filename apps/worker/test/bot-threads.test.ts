/**
 * The bot's review fixes against the test database and Redis (db 2), with a FakeX:
 *  - threads: a second tag that replies to the first tag (or to the project's own "2/" post) joins the thread's
 *    check and never checks the person who tagged; a retry under "Couldn't finish this check"; answering the help
 *    line with the link; a question naming an @handle under a verdict stays a follow-up; a quote of the bot's verdict
 *    is never a check of the bot's own post;
 *  - robustness: a mention cut off by a crash or a transient error is handled again (never lost, never twice); lost
 *    reply jobs are queued again (sweepLostReplies, startBotWorker);
 *  - posting: a reply POST whose outcome is unknown (timeout, 5xx) is looked up on X before posting again — one reply
 *    per mention — on the FakeX and on the real X adapter; a duplicate after such an attempt is REPLIED, not FAILED;
 *    nothing with a link but the report link is ever posted.
 */
import { Redis } from 'ioredis';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { XPost } from '@apecheck/sources';
import { createX, type Http, type HttpRequest, type HttpResponse } from '@apecheck/sources';
import { memoryLogger } from '../src/log';
import { enqueueBotReply } from '../src/pipeline/save';
import { runCheck } from '../src/pipeline/index';
import type { PipelineDeps } from '../src/pipeline/context';
import { SINCE_KEY, SWEEP_AFTER_MS, currentSinceId, pollOnce, startBotWorker, sweepLostReplies, type ReplyJobs } from '../src/bot/index';
import { handleMention, leaseKey, storeMention, type BotDeps } from '../src/bot/handle';
import { RetryReplyError, postingKey, processReply, replyFailure } from '../src/bot/reply';
import { FAILED_TEXT, HELP_TEXT } from '../src/bot/compose';
import { urlSpans } from '../src/bot/xtext';
import { FakeX, post, replyTo, tweetId } from './fake-x';
import { XApi, type XApiUser } from './x-api';
import { heuristicAi, prisma, resetDb, testEnv } from './helpers';

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

function harness(o: { env?: Record<string, string>; x?: FakeX } = {}) {
  const env = testEnv({
    X_BOT_USER_ID: '1000',
    X_BOT_HANDLE: 'ApeCheckBot',
    BOT_USER_HOURLY: '10',
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
    fetchCard: async () => null,
  };
  return { deps, env, x, checks, replies, log };
}

async function stageFReplies(checkId: string): Promise<string[]> {
  const out: string[] = [];
  const deps = { prisma, log: memoryLogger(), hooks: { enqueueBotReply: async (id: string) => void out.push(id) } } as unknown as PipelineDeps;
  await enqueueBotReply(deps, checkId);
  return out;
}

async function finish(checkId: string, status: 'DONE' | 'FAILED' = 'DONE') {
  return prisma.check.update({
    where: { id: checkId },
    data: { status, finishedAt: new Date(), narScore: 37, narBand: 'llarp', totalScore: 37, summary: "'Launch app' does nothing; GitHub pushed in one burst at launch.", isLatest: true },
  });
}

const mentionRow = (tweet: string) => prisma.botMention.findUniqueOrThrow({ where: { tweetId: tweet } });
const projectPost = (p: Partial<XPost> = {}) => post({ text: 'Orbit v2 is live https://t.co/AbC', urls: ['https://orbit.xyz/'], authorHandle: 'orbitxyz', authorId: '700', ...p });

/** The bot's reply to `m` as X would deliver a post replying to it. */
function botPost(h: ReturnType<typeof harness>, m: XPost, conversationId: string): XPost {
  const r = h.x.replies.find(x => x.inReplyToId === m.id)!;
  return post({
    id: r.id,
    text: `@${m.authorHandle} ${r.text}`,
    authorHandle: 'ApeCheckBot',
    authorId: '1000',
    conversationId,
    replyToId: m.id,
    displayTextRange: [(m.authorHandle?.length ?? 0) + 2, (m.authorHandle?.length ?? 0) + 2 + r.text.length],
  });
}

/** A tag under the project post, its check finished and the verdict posted. */
async function verdictThread(h = harness(), status: 'DONE' | 'FAILED' = 'DONE') {
  const parent = projectPost();
  const tag = replyTo(parent, '@ApeCheckBot real or larp?');
  await handleMention(h.deps, tag);
  const check = await prisma.check.findFirstOrThrow();
  await finish(check.id, status);
  const [id] = await stageFReplies(check.id);
  expect(await processReply(h.deps, id)).toBe('replied');
  return { h, parent, tag, check, verdict: botPost(h, tag, parent.id) };
}

describe('a second tag in the same thread', () => {
  it('replying to your own tag: no second check, no second reply (and never a check of yourself)', async () => {
    const h = harness();
    const parent = projectPost();
    const first = replyTo(parent, '@ApeCheckBot real?');
    expect(await handleMention(h.deps, first)).toMatchObject({ action: 'check', reuse: null, target: 'https://orbit.xyz/' });
    const again = replyTo(first, '@ApeCheckBot ??');
    expect(await handleMention(h.deps, again)).toEqual({ action: 'ignored', reason: 'answered_in_thread' });
    expect(await mentionRow(again.id)).toMatchObject({ targetKey: 'site:orbit.xyz' });
    expect(await prisma.check.count()).toBe(1);
  });

  it("another account replying to the first tag joins the thread's check, with its own reply", async () => {
    const h = harness();
    const parent = projectPost();
    const first = replyTo(parent, '@ApeCheckBot real or larp?');
    await handleMention(h.deps, first);
    const check = await prisma.check.findFirstOrThrow();
    const other = replyTo(first, '@ApeCheckBot ?', { authorHandle: 'other_user', authorId: '601' });
    expect(await handleMention(h.deps, other)).toMatchObject({ action: 'check', checkId: check.id, reuse: 'thread', target: 'https://orbit.xyz/' });
    expect(await prisma.check.count()).toBe(1);
    expect(await prisma.target.count()).toBe(1); // no check (or target) of https://x.com/degen_rina
    await finish(check.id);
    expect(await stageFReplies(check.id)).toHaveLength(2);
  });

  it('the first tag was never stored: the post above it decides (read from X), never the tagger', async () => {
    const h = harness();
    const parent = projectPost();
    const first = replyTo(parent, '@ApeCheckBot real?', { repliedTo: null });
    h.x.posts.set(parent.id, parent);
    h.x.posts.set(first.id, first);
    const other = replyTo(first, '@ApeCheckBot ?', { authorHandle: 'other_user', authorId: '601' });
    expect(await handleMention(h.deps, other)).toMatchObject({ action: 'check', reuse: null, target: 'https://orbit.xyz/' });
    // the post above unreadable (deleted): help, still not the tagger
    const lost = replyTo(replyTo(projectPost(), '@ApeCheckBot real?', { repliedTo: null, authorHandle: 'third', authorId: '602' }), '@ApeCheckBot ?', {
      authorHandle: 'fourth',
      authorId: '603',
    });
    expect(await handleMention(h.deps, lost)).toEqual({ action: 'help' });
    expect(await prisma.check.count()).toBe(1);
  });

  it("a tag under the project's own link-less \"2/\" post joins the thread's check", async () => {
    const h = harness();
    const parent = projectPost();
    await handleMention(h.deps, replyTo(parent, '@ApeCheckBot real?'));
    const check = await prisma.check.findFirstOrThrow();
    const second = post({ text: '2/ staking goes live next week', authorHandle: 'orbitxyz', authorId: '700', conversationId: parent.id, replyToId: parent.id, repliedTo: parent });
    const m = replyTo(second, '@ApeCheckBot and this?', { authorHandle: 'other_user', authorId: '601' });
    expect(await handleMention(h.deps, m)).toMatchObject({ action: 'check', checkId: check.id, reuse: 'thread' });
    expect(await prisma.check.count()).toBe(1);
    // a link of its own in the thread is another project: its own check
    const shill = replyTo(second, '@ApeCheckBot this one? https://t.co/k', { authorHandle: 'shill', authorId: '604', urls: ['https://kairo.ai'] });
    expect(await handleMention(h.deps, shill)).toMatchObject({ action: 'check', reuse: null, target: 'https://kairo.ai' });
    expect(await prisma.check.count()).toBe(2);
  });
});

describe('a tag under a post that names nothing: the posts above it in the thread', () => {
  // the production incident: "@ApeCheckBot" alone under @stridefun's "Dex paid." (an image), whose post above in its
  // own thread says "Stride is Live on @solana Chain. CA: …": the bot checked the profile @stridefun instead
  const STRIDE_CA = '7NgwJMbrvxdestgmfLaiGf8XCoUD98GqKe2Yw3kpump';
  const CA = '0x1111111111111111111111111111111111111111';
  const stride = (text: string, p: Partial<XPost> = {}) => post({ text, authorHandle: 'stridefun', authorId: '880', ...p });
  const launch = () => stride(`Stride is Live on @solana Chain. CA: ${STRIDE_CA}`);
  // as X includes it with the mention: the image's t.co after the typed range, without the post above it
  const dexPaid = (above: XPost) =>
    stride('Dex paid. https://t.co/pic', { replyToId: above.id, conversationId: above.conversationId, displayTextRange: [0, 9] });

  /** every X read the bot makes: the free embed reads (getPost) and the paid account reads */
  function watchReads(x: FakeX) {
    const free: string[] = [];
    const paid: string[] = [];
    const getPost = x.getPost.bind(x);
    x.getPost = async (id: string) => {
      free.push(id);
      return getPost(id);
    };
    x.getUser = async (handle: string) => {
      paid.push(`getUser ${handle}`);
      return null;
    };
    x.getUserById = async (id: string) => {
      paid.push(`getUserById ${id}`);
      return null;
    };
    return { free, paid };
  }

  it('"@ApeCheckBot" under "Dex paid." checks the Solana CA of the same author\'s post above it, with one free read', async () => {
    const h = harness();
    const reads = watchReads(h.x);
    const top = launch();
    h.x.posts.set(top.id, top);
    const m = replyTo(dexPaid(top), '@ApeCheckBot', { authorHandle: 'tagger', authorId: '605' });
    expect(await handleMention(h.deps, m)).toMatchObject({ action: 'check', reuse: null, target: STRIDE_CA });
    const check = await prisma.check.findFirstOrThrow({ include: { target: true } });
    expect(check).toMatchObject({ via: 'BOT', targetRaw: STRIDE_CA, requesterHandle: 'tagger' });
    expect(check.target.key).toBe(`ca:sol:${STRIDE_CA}`);
    expect(await prisma.target.count()).toBe(1); // never a check of the profile @stridefun
    expect(await mentionRow(m.id)).toMatchObject({ kind: 'check', status: 'QUEUED', targetKey: `ca:sol:${STRIDE_CA}` });
    expect(reads).toEqual({ free: [top.id], paid: [] });
    expect(h.log.lines.some(l => l.includes("contract in the same author's post above the post it replies to"))).toBe(true);
  });

  it('a second tag under a tag that asked under "Dex paid.": the same CA, never a tagger', async () => {
    const h = harness();
    const reads = watchReads(h.x);
    const top = launch();
    const dp = dexPaid(top);
    h.x.posts.set(top.id, top);
    h.x.posts.set(dp.id, dp);
    // the first tag was never stored (before the bot ran): the post it is under decides, then the posts above that
    const first = replyTo(dp, '@ApeCheckBot real?', { repliedTo: null, authorHandle: 'asker', authorId: '991' });
    const m = replyTo(first, '@ApeCheckBot', { authorHandle: 'other_user', authorId: '601' });
    expect(await handleMention(h.deps, m)).toMatchObject({ action: 'check', reuse: null, target: STRIDE_CA });
    expect(reads).toEqual({ free: [dp.id, top.id], paid: [] });
  });

  it('nothing above names anything: the author, as before; a bare tag with nothing anywhere: the help line', async () => {
    const h = harness();
    const reads = watchReads(h.x);
    const top = stride('Something big this week, follow @stride_dev $STRIDE');
    h.x.posts.set(top.id, top);
    const m = replyTo(dexPaid(top), '@ApeCheckBot', { authorHandle: 'tagger', authorId: '605' });
    expect(await handleMention(h.deps, m)).toMatchObject({ action: 'check', target: 'https://x.com/stridefun' });
    expect(reads.free).toEqual([top.id]);
    // a bare tag that replies to nothing: nothing to read, the help line
    expect(await handleMention(h.deps, post({ text: '@ApeCheckBot', authorHandle: 'lonely', authorId: '606' }))).toEqual({ action: 'help' });
    // under a deleted post (X left it out, the free read finds nothing): the help line too
    const orphan = post({ text: '@ApeCheckBot', authorHandle: 'lost', authorId: '607', replyToId: '1849999999999999998', repliedTo: null });
    expect(await handleMention(h.deps, orphan)).toEqual({ action: 'help' });
    expect(reads).toEqual({ free: [top.id, '1849999999999999998'], paid: [] });
  });

  it('reads that never answer or fail: the walk gives up within its budget and falls back to the author', async () => {
    const h = harness();
    h.deps.threadBudgetMs = 100;
    h.x.getPost = () => new Promise<XPost | null>(() => undefined);
    const started = Date.now();
    const hung = replyTo(dexPaid(launch()), '@ApeCheckBot', { authorHandle: 'tagger', authorId: '605' });
    expect(await handleMention(h.deps, hung)).toMatchObject({ action: 'check', target: 'https://x.com/stridefun' });
    expect(Date.now() - started).toBeLessThan(5_000);
    h.x.getPost = async () => {
      throw new Error('syndication: HTTP 503; oEmbed: HTTP 503');
    };
    const failed = replyTo(dexPaid(launch()), '@ApeCheckBot', { authorHandle: 'tagger2', authorId: '608' });
    expect(await handleMention(h.deps, failed)).toMatchObject({ action: 'check', target: 'https://x.com/stridefun' });
    expect(await prisma.botMention.count({ where: { status: 'FAILED' } })).toBe(0);
  });

  it('a project\'s link-less reply under a KOL\'s "Drop your projects below, mine: 0x…": the project, never the KOL\'s coin', async () => {
    const h = harness();
    const reads = watchReads(h.x);
    const call = post({ text: `Drop your projects below, mine: ${CA}`, authorHandle: 'kol', authorId: '42' });
    h.x.posts.set(call.id, call);
    const reply = post({ text: 'we are building the future of payments', authorHandle: 'projectb', authorId: '702', replyToId: call.id, conversationId: call.id });
    expect(await handleMention(h.deps, replyTo(reply, '@ApeCheckBot', { authorHandle: 'tagger', authorId: '605' }))).toMatchObject({
      action: 'check',
      reuse: null,
      target: 'https://x.com/projectb',
    });
    expect(await prisma.check.findFirstOrThrow()).toMatchObject({ targetRaw: 'https://x.com/projectb' });
    expect(await prisma.target.count()).toBe(1); // never a check of the KOL's coin
    expect(reads).toEqual({ free: [call.id], paid: [] });
  });

  it("an @handle of another account typed in the mention: that account, and nothing above is read", async () => {
    const h = harness();
    const reads = watchReads(h.x);
    const top = launch();
    h.x.posts.set(top.id, top);
    const m = replyTo(dexPaid(top), '@ApeCheckBot what about @kairolabs', { authorHandle: 'tagger', authorId: '605' });
    expect(await handleMention(h.deps, m)).toMatchObject({ action: 'check', reuse: null, target: 'https://x.com/kairolabs' });
    expect(reads).toEqual({ free: [], paid: [] });
  });

  /** X's free embed hosts answering by post id (`syndication`, `oembed`; 404 otherwise), every request recorded */
  function embedHttp(syndication: Record<string, unknown>, oembed: Record<string, unknown> = {}) {
    const requests: string[] = [];
    const http: Http = {
      async request(raw: string, req: HttpRequest = {}) {
        const url = new URL(raw);
        const oe = url.host === 'publish.twitter.com';
        const id = (oe ? /\/status\/(\d+)/.exec(url.searchParams.get('url') ?? '')?.[1] : url.searchParams.get('id')) ?? '';
        requests.push(`${req.method ?? 'GET'} ${url.host}${url.pathname}?id=${id}`);
        const body = url.host === 'cdn.syndication.twimg.com' ? syndication[id] : oe ? oembed[id] : undefined;
        const res: HttpResponse = {
          status: body ? 200 : 404,
          ok: !!body,
          url: raw,
          finalUrl: raw,
          headers: { 'content-type': 'application/json' },
          text: body ? JSON.stringify(body) : '',
          truncated: false,
          ms: 1,
        };
        return res;
      },
      async json<T>(u: string, req?: HttpRequest) {
        return JSON.parse((await this.request(u, req)).text) as T;
      },
    };
    return { http, requests };
  }

  it('on the real X adapter: the walk reads syndication only (never api.x.com), the post above with its parent in one read', async () => {
    const LAUNCH = '1980000000000000002';
    const ROOT = '1980000000000000001';
    const user = { id_str: '1700000000000000880', screen_name: 'stridefun', name: 'Stride' };
    // cdn.syndication.twimg.com/tweet-result for the launch post: its own reply id, the thread's first post as parent
    const syndication: Record<string, unknown> = {
      [LAUNCH]: {
        __typename: 'Tweet',
        id_str: LAUNCH,
        text: `Stride is Live on @solana Chain. CA: ${STRIDE_CA}`,
        display_text_range: [0, 80],
        created_at: '2026-10-20T15:02:44.000Z',
        entities: { urls: [], user_mentions: [{ id_str: '951329744804392960', screen_name: 'solana' }], symbols: [] },
        user,
        in_reply_to_status_id_str: ROOT,
        in_reply_to_user_id_str: user.id_str,
        parent: { id_str: ROOT, text: 'Introducing Stride 🧵', display_text_range: [0, 20], entities: {}, user },
      },
    };
    const { http, requests } = embedHttp(syndication);
    const h = harness();
    // every paid key set: still nothing but the free embed host is asked
    h.deps.x = createX({ ...h.env, X_BEARER_TOKEN: 'b', X_API_KEY: 'k', X_API_SECRET: 's', X_ACCESS_TOKEN: 't', X_ACCESS_SECRET: 'ts' }, http);
    const dp = stride('Dex paid. https://t.co/pic', { id: '1980000000000000003', replyToId: LAUNCH, conversationId: ROOT, displayTextRange: [0, 9] });
    const m = replyTo(dp, '@ApeCheckBot', { authorHandle: 'tagger', authorId: '605' });
    expect(await handleMention(h.deps, m)).toMatchObject({ action: 'check', reuse: null, target: STRIDE_CA });
    expect(requests).toEqual([`GET cdn.syndication.twimg.com/tweet-result?id=${LAUNCH}`]);
  });

  it('a post above read through oEmbed (no reply id): the conversation root is still read, and its CA checked', async () => {
    const ROOT = '1981000000000000001';
    const MID = '1981000000000000002';
    const user = { id_str: '1700000000000000880', screen_name: 'stridefun', name: 'Stride' };
    // syndication has no answer for the post in the middle (404): X's oEmbed does, without what it replies to
    const syndication: Record<string, unknown> = {
      [ROOT]: {
        __typename: 'Tweet',
        id_str: ROOT,
        text: `Stride is Live on @solana Chain. CA: ${STRIDE_CA}`,
        display_text_range: [0, 80],
        created_at: '2026-10-20T15:02:44.000Z',
        entities: { urls: [], user_mentions: [{ id_str: '951329744804392960', screen_name: 'solana' }], symbols: [] },
        user,
      },
    };
    const oembed: Record<string, unknown> = {
      [MID]: {
        url: `https://twitter.com/stridefun/status/${MID}`,
        author_name: 'Stride',
        author_url: 'https://twitter.com/stridefun',
        html: `<blockquote class="twitter-tweet" data-dnt="true"><p lang="en" dir="ltr">Chart soon 👀</p>&mdash; Stride (@stridefun) <a href="https://twitter.com/stridefun/status/${MID}?ref_src=twsrc%5Etfw">October 20, 2026</a></blockquote>\n`,
        type: 'rich',
        version: '1.0',
      },
    };
    const { http, requests } = embedHttp(syndication, oembed);
    const h = harness();
    h.deps.x = createX({ ...h.env, X_BEARER_TOKEN: 'b', X_API_KEY: 'k', X_API_SECRET: 's', X_ACCESS_TOKEN: 't', X_ACCESS_SECRET: 'ts' }, http);
    const dp = stride('Dex paid. https://t.co/pic', { id: '1981000000000000003', replyToId: MID, conversationId: ROOT, displayTextRange: [0, 9] });
    const m = replyTo(dp, '@ApeCheckBot', { authorHandle: 'tagger', authorId: '605' });
    expect(await handleMention(h.deps, m)).toMatchObject({ action: 'check', reuse: null, target: STRIDE_CA });
    expect(requests).toEqual([
      `GET cdn.syndication.twimg.com/tweet-result?id=${MID}`,
      `GET publish.twitter.com/oembed?id=${MID}`,
      `GET cdn.syndication.twimg.com/tweet-result?id=${ROOT}`,
    ]);
  });
});

describe("under the bot's own posts", () => {
  it('"@ApeCheckBot try again" under "Couldn\'t finish this check" runs the check again', async () => {
    const { h, verdict } = await verdictThread(harness(), 'FAILED');
    expect(h.x.replies[0].text).toBe(FAILED_TEXT);
    const retry = replyTo(verdict, '@ApeCheckBot try again');
    expect(await handleMention(h.deps, retry)).toMatchObject({ action: 'check', reuse: null, target: 'https://orbit.xyz/' });
    expect(await prisma.check.count()).toBe(2);
    // an untagged reply there is not a retry
    const chat = replyTo(verdict, 'ok', { authorHandle: 'lurker', authorId: '77' });
    expect(await handleMention(h.deps, chat)).toEqual({ action: 'ignored', reason: 'no_report' });
  });

  it("answering the help line with the link it asks for starts the check; chatting there doesn't loop", async () => {
    const h = harness();
    const ask = post({ text: '@ApeCheckBot hello' });
    expect(await handleMention(h.deps, ask)).toEqual({ action: 'help' });
    expect(await processReply(h.deps, h.replies[0])).toBe('replied');
    expect(h.x.replies[0].text).toBe(HELP_TEXT);
    const helpPost = botPost(h, ask, ask.id);
    // X's text is "@ApeCheckBot https://orbit.xyz"; the display range leaves the prefix out
    const link = replyTo(helpPost, 'https://t.co/o', { urls: ['https://orbit.xyz/'] });
    expect(await handleMention(h.deps, link)).toMatchObject({ action: 'check', target: 'https://orbit.xyz/' });
    expect(await handleMention(h.deps, replyTo(helpPost, 'thanks'))).toEqual({ action: 'ignored', reason: 'help_already_sent' });
  });

  it("a question naming the project's @handle is a follow-up (an Ask for a Pro holder), not a new check", async () => {
    const { h, verdict, check } = await verdictThread();
    await prisma.user.create({ data: { xUserId: '777', xHandle: 'pro_holder', tier: 'PRO' } });
    const q = replyTo(verdict, '@ApeCheckBot is the @orbitxyz team doxxed?', { authorHandle: 'pro_holder', authorId: '777' });
    expect(await handleMention(h.deps, q)).toEqual({ action: 'followup', pro: true });
    expect(await processReply(h.deps, h.replies.at(-1)!)).toBe('replied');
    expect(await prisma.ask.count()).toBe(1);
    const free = replyTo(verdict, '@ApeCheckBot did @elonmusk endorse this?', { authorHandle: 'free_user', authorId: '778' });
    expect(await handleMention(h.deps, free)).toEqual({ action: 'followup', pro: false });
    expect(await prisma.check.count()).toBe(1);
    expect((await mentionRow(q.id)).checkId).toBe(check.id);
    // only an @handle with nothing else asks for a check of it
    const bare = replyTo(verdict, '@ApeCheckBot @kairolabs', { authorHandle: 'x3', authorId: '779' });
    expect(await handleMention(h.deps, bare)).toMatchObject({ action: 'check', target: 'https://x.com/kairolabs' });
  });

  it("quoting the bot's verdict is a follow-up about that check, never a check of the bot's own post", async () => {
    const { h, verdict } = await verdictThread();
    const quote = post({ text: '@ApeCheckBot you are wrong, this is legit https://t.co/q', urls: [`https://twitter.com/ApeCheckBot/status/${verdict.id}`], quotedId: verdict.id, authorHandle: 'q1', authorId: '781' });
    expect(await handleMention(h.deps, quote)).toEqual({ action: 'followup', pro: false });
    // a native quote: only quotedId
    const native = post({ text: '@ApeCheckBot nope', quotedId: verdict.id, authorHandle: 'q2', authorId: '782' });
    expect(await handleMention(h.deps, native)).toEqual({ action: 'followup', pro: false });
    // a link to the bot's post without its handle
    const link = post({ text: '@ApeCheckBot https://t.co/z', urls: [`https://x.com/i/status/${verdict.id}`], authorHandle: 'q3', authorId: '783' });
    expect(await handleMention(h.deps, link)).toEqual({ action: 'help' });
    expect(await prisma.check.count()).toBe(1);
  });
});

describe('mentions cut off by a crash or a transient error', () => {
  it('a transient Redis error leaves the mention RECEIVED and keeps since_id; the next poll answers it once', async () => {
    const h = harness();
    const m = post({ text: '@ApeCheckBot hi' });
    h.x.inbox.push(m);
    const flaky = new Proxy(redis, {
      get(t, p) {
        if (p === 'eval') return () => Promise.reject(new Error('Connection is closed.'));
        const v = Reflect.get(t, p) as unknown;
        return typeof v === 'function' ? (v as (...a: unknown[]) => unknown).bind(t) : v;
      },
    });
    const r1 = await pollOnce({ ...h.deps, redis: flaky as Redis });
    expect(r1).toMatchObject({ outcomes: [], nextSinceId: null });
    expect(await mentionRow(m.id)).toMatchObject({ status: 'RECEIVED' });
    expect(await redis.get(SINCE_KEY)).toBeNull();
    const r2 = await pollOnce(h.deps);
    expect(r2.outcomes).toEqual([{ tweetId: m.id, outcome: { action: 'help' } }]);
    expect(h.replies).toHaveLength(1);
    expect(await pollOnce(h.deps)).toMatchObject({ outcomes: [] });
  });

  it('a process that died mid-mention: the next poll waits for its lease, then handles the mention', async () => {
    const h = harness();
    const m = post({ text: '@ApeCheckBot hi' });
    h.x.inbox.push(m);
    expect(await storeMention(h.deps, m)).not.toBeNull(); // stored, then the process died
    // its lease is still held: the poll stops there and keeps since_id (just below the cut-off mention: a cold start)
    const r1 = await pollOnce(h.deps);
    expect(r1).toMatchObject({ sinceId: String(BigInt(m.id) - 1n), outcomes: [], nextSinceId: String(BigInt(m.id) - 1n) });
    expect(await mentionRow(m.id)).toMatchObject({ status: 'RECEIVED' });
    expect(await currentSinceId(h.deps)).toBe(String(BigInt(m.id) - 1n));
    await redis.del(leaseKey(m.id)); // the lease expired
    const r2 = await pollOnce(h.deps);
    expect(r2.outcomes).toEqual([{ tweetId: m.id, outcome: { action: 'help' } }]);
    expect(await redis.get(SINCE_KEY)).toBe(m.id);
    expect(await currentSinceId(h.deps)).toBe(m.id);
  });

  it('lost reply jobs are queued again: once per sweep, not while a job is live, given up after 3', async () => {
    const h = harness();
    const m = post({ text: '@ApeCheckBot hi' });
    await handleMention(h.deps, m);
    const row = await mentionRow(m.id);
    expect(row.status).toBe('QUEUED');
    const states = new Map<string, string | null>();
    const readded: string[] = [];
    const jobs: ReplyJobs = { state: async id => states.get(id) ?? null, readd: async id => void readded.push(id) };
    // too recent: not swept
    expect(await sweepLostReplies(h.deps, jobs)).toEqual([]);
    await prisma.botMention.update({ where: { id: row.id }, data: { createdAt: new Date(Date.now() - SWEEP_AFTER_MS - 60_000) } });
    states.set(row.id, 'delayed');
    expect(await sweepLostReplies(h.deps, jobs)).toEqual([]);
    states.set(row.id, 'failed');
    for (let i = 0; i < 3; i++) expect(await sweepLostReplies(h.deps, jobs)).toEqual([row.id]);
    expect(await sweepLostReplies(h.deps, jobs)).toEqual([]);
    expect(readded).toEqual([row.id, row.id, row.id]);
    expect(await mentionRow(m.id)).toMatchObject({ status: 'FAILED' });
  });

  it('worker-bot sweeps on its real queue: a QUEUED help mention without a job gets its reply', async () => {
    const x = new FakeX();
    const env = testEnv({ X_BOT_USER_ID: '1000', X_BOT_HANDLE: 'ApeCheckBot' });
    const bot = await startBotWorker({ env, x, log: memoryLogger(), autoPoll: false, ai: heuristicAi() });
    try {
      const m = post({ text: '@ApeCheckBot hi' });
      const row = await prisma.botMention.create({
        data: { tweetId: m.id, authorId: '501', authorHandle: 'degen_rina', text: '@ApeCheckBot hi', status: 'QUEUED', kind: 'help', createdAt: new Date(Date.now() - SWEEP_AFTER_MS - 60_000) },
      });
      expect(await bot.sweep()).toEqual([]); // not active yet
      await bot.tick();
      expect(bot.state).toBe('active');
      expect(await bot.sweep()).toEqual([row.id]);
      for (let i = 0; i < 100 && (await mentionRow(m.id)).status !== 'REPLIED'; i++) await new Promise(r => setTimeout(r, 100));
      expect(await mentionRow(m.id)).toMatchObject({ status: 'REPLIED' });
      expect(x.replies.map(r => r.inReplyToId)).toEqual([m.id]);
      expect(await bot.sweep()).toEqual([]);
    } finally {
      await bot.close();
    }
  });

  it('a check job that finds its check already finished still enqueues the bot replies', async () => {
    const h = harness();
    await handleMention(h.deps, post({ text: '@ApeCheckBot 0x1111111111111111111111111111111111111111' }));
    const check = await prisma.check.findFirstOrThrow();
    await finish(check.id);
    const queued: string[] = [];
    const deps = { prisma, redis, env: h.env, log: memoryLogger(), hooks: { enqueueBotReply: async (id: string) => void queued.push(id) } } as unknown as PipelineDeps;
    expect(await runCheck(check.id, deps)).toMatchObject({ status: 'skipped' });
    expect(queued).toHaveLength(1);
  });
});

describe('a reply POST whose outcome is unknown', () => {
  async function queuedHelp(h: ReturnType<typeof harness>) {
    const m = post({ text: '@ApeCheckBot ?' });
    await handleMention(h.deps, m);
    return { m, id: h.replies[0] };
  }

  it('classifies failures by what they say about the post', () => {
    expect(replyFailure('x.reply: rate limited until 2026-10-19T17:00:00.000Z')).toBe('not_sent');
    expect(replyFailure('x.reply: connect ECONNREFUSED 104.244.42.1:443')).toBe('not_sent');
    expect(replyFailure('x.reply: getaddrinfo ENOTFOUND api.x.com')).toBe('not_sent');
    expect(replyFailure('x.reply: api.x.com: timeout after 10000ms')).toBe('unknown');
    expect(replyFailure('x.reply: HTTP 503 from api.x.com')).toBe('unknown');
    expect(replyFailure('x.reply: other side closed')).toBe('unknown');
    expect(replyFailure('x.reply: duplicate content (HTTP 403)')).toBe('duplicate');
    expect(replyFailure('x.reply: HTTP 400 from api.x.com: Invalid Request')).toBe('refused');
  });

  it('X created the reply but the answer timed out: the retry finds it and does not post again', async () => {
    const h = harness();
    const { m, id } = await queuedHelp(h);
    h.x.lostReplies.push('x.reply: api.x.com: timeout after 10000ms');
    await expect(processReply(h.deps, id, { attemptsMade: 0, attempts: 3 })).rejects.toBeInstanceOf(RetryReplyError);
    expect(await redis.get(postingKey(id))).not.toBeNull();
    expect(await processReply(h.deps, id, { attemptsMade: 1, attempts: 3 })).toBe('replied');
    expect(h.x.replies).toHaveLength(1); // one POST in all
    expect(h.x.findCalls).toEqual([m.id]);
    expect(await mentionRow(m.id)).toMatchObject({ status: 'REPLIED', replyTweetId: h.x.replies[0].id, replyText: HELP_TEXT });
    expect(await redis.get(postingKey(id))).toBeNull();
  });

  it('a 503 that created nothing: the retry looks, finds nothing, and posts exactly once more', async () => {
    const h = harness();
    const { m, id } = await queuedHelp(h);
    h.x.failReplies.push('x.reply: HTTP 503 from api.x.com');
    await expect(processReply(h.deps, id, { attemptsMade: 0, attempts: 3 })).rejects.toBeInstanceOf(RetryReplyError);
    expect(await processReply(h.deps, id, { attemptsMade: 1, attempts: 3 })).toBe('replied');
    expect(h.x.replies).toHaveLength(1);
    expect(h.x.findCalls).toEqual([m.id]);
  });

  it('a failed lookup never posts: retried, then FAILED on the last attempt', async () => {
    const h = harness();
    const { id } = await queuedHelp(h);
    h.x.failReplies.push('x.reply: api.x.com: timeout after 10000ms');
    h.x.findFails.push('x.findReply: HTTP 503', 'x.findReply: HTTP 503');
    await expect(processReply(h.deps, id, { attemptsMade: 0, attempts: 3 })).rejects.toBeInstanceOf(RetryReplyError);
    await expect(processReply(h.deps, id, { attemptsMade: 1, attempts: 3 })).rejects.toThrow(/looking up/);
    expect(await processReply(h.deps, id, { attemptsMade: 2, attempts: 3 })).toBe('failed');
    expect(h.x.replies).toEqual([]);
    expect((await prisma.botMention.findUniqueOrThrow({ where: { id } })).ignoreReason).toMatch(/may have posted/);
  });

  it('a process that died mid-POST (posting marker, no result): the reply is looked up, recorded, not posted again', async () => {
    const h = harness();
    const { m, id } = await queuedHelp(h);
    // X had accepted the post when the process died
    await h.x.reply(m.id, HELP_TEXT);
    await redis.set(postingKey(id), JSON.stringify({ text: HELP_TEXT }));
    expect(await processReply(h.deps, id)).toBe('replied');
    expect(h.x.replies).toHaveLength(1);
    expect(await mentionRow(m.id)).toMatchObject({ status: 'REPLIED', replyTweetId: h.x.replies[0].id });
  });

  it('a duplicate refusal right after an unknown attempt means it posted: REPLIED (id unknown), not FAILED', async () => {
    const h = harness();
    const { m, id } = await queuedHelp(h);
    h.x.lostReplies.push('x.reply: api.x.com: timeout after 10000ms');
    await expect(processReply(h.deps, id, { attemptsMade: 0, attempts: 3 })).rejects.toBeInstanceOf(RetryReplyError);
    // X's timeline lags: the lookup does not see it yet; X refuses the repeat as a duplicate
    h.x.findReply = async () => null;
    h.x.failReplies.push('x.reply: duplicate content (HTTP 403)');
    expect(await processReply(h.deps, id, { attemptsMade: 1, attempts: 3 })).toBe('replied');
    expect(await mentionRow(m.id)).toMatchObject({ status: 'REPLIED', replyTweetId: null, replyText: HELP_TEXT });
    expect((await mentionRow(m.id)).repliedAt).toBeInstanceOf(Date);
  });

  it('the real X adapter: POST created, answer timed out — one POST, REPLIED with the id the lookup found', async () => {
    const BOT_ID = '1800000000000000000';
    const created: { id: string; replyTo: string }[] = [];
    const calls: string[] = [];
    let mode: 'timeout' | '503' = 'timeout';
    const res = (status: number, body: unknown): HttpResponse => ({
      status,
      ok: status >= 200 && status < 300,
      url: '',
      finalUrl: '',
      headers: { 'content-type': 'application/json' },
      text: JSON.stringify(body),
      truncated: false,
      ms: 1,
    });
    const http: Http = {
      async request(raw: string, req: HttpRequest = {}) {
        const url = new URL(raw);
        calls.push(`${req.method ?? 'GET'} ${url.pathname}`);
        if (req.method === 'POST' && url.pathname === '/2/tweets') {
          const body = JSON.parse(String(req.body)) as { reply: { in_reply_to_tweet_id: string } };
          if (mode === '503' && created.length === 0) {
            mode = 'timeout';
            return res(503, { title: 'Service Unavailable' });
          }
          const id = String(1960000000000000000n + BigInt(created.length + 1));
          created.push({ id, replyTo: body.reply.in_reply_to_tweet_id });
          if (calls.filter(c => c === 'POST /2/tweets').length === 1 && mode === 'timeout') throw new Error('api.x.com: timeout after 10000ms');
          return res(201, { data: { id, text: 'x' } });
        }
        if ((req.method ?? 'GET') === 'GET' && url.pathname === `/2/users/${BOT_ID}/tweets`) {
          const since = BigInt(url.searchParams.get('since_id') ?? '0');
          const data = created.filter(c => BigInt(c.id) > since).map(c => ({ id: c.id, text: 'x', referenced_tweets: [{ type: 'replied_to', id: c.replyTo }] }));
          return res(200, data.length ? { data, meta: { result_count: data.length } } : { meta: { result_count: 0 } });
        }
        return res(404, { title: 'Not Found' });
      },
      async json<T>(u: string, req?: HttpRequest) {
        return JSON.parse((await this.request(u, req)).text) as T;
      },
    };
    const xenv = { X_BEARER_TOKEN: 'b', X_API_KEY: 'k', X_API_SECRET: 's', X_ACCESS_TOKEN: 't', X_ACCESS_SECRET: 'ts', X_BOT_USER_ID: BOT_ID, X_BOT_HANDLE: 'ApeCheckBot' };
    const run = async () => {
      const h = harness({ env: { X_BOT_USER_ID: BOT_ID } });
      h.deps.x = createX({ ...h.env, ...xenv }, http);
      const m = post({ text: '@ApeCheckBot ?' });
      await handleMention(h.deps, m);
      const id = h.replies[0];
      await expect(processReply(h.deps, id, { attemptsMade: 0, attempts: 3 })).rejects.toBeInstanceOf(RetryReplyError);
      expect(await processReply(h.deps, id, { attemptsMade: 1, attempts: 3 })).toBe('replied');
      return { row: await mentionRow(m.id), m };
    };

    const a = await run();
    expect(calls.filter(c => c === 'POST /2/tweets')).toHaveLength(1);
    expect(calls).toContain(`GET /2/users/${BOT_ID}/tweets`);
    expect(a.row).toMatchObject({ status: 'REPLIED', replyTweetId: created[0].id });

    // a 503 that created nothing: the lookup finds nothing, and exactly one more POST goes out
    created.length = 0;
    calls.length = 0;
    mode = '503';
    await resetDb();
    await redis.flushdb();
    const b = await run();
    expect(calls.filter(c => c === 'POST /2/tweets')).toHaveLength(2);
    expect(created).toHaveLength(1);
    expect(b.row).toMatchObject({ status: 'REPLIED', replyTweetId: created[0].id });
  });
});

describe('XAdapter.findReply on the X API emulator (signed owned read)', () => {
  it("finds the bot's own reply to a mention, null when there is none, and throws when the read fails", async () => {
    const BOT_ID = '1800000000000000000';
    const creds = { consumerKey: 'ck000000000000', consumerSecret: 'cs/odd+chars=', token: `${BOT_ID}-tok`, tokenSecret: 'ts&more', bearer: 'AAAAbearer' };
    const api = new XApi({ botId: BOT_ID, creds });
    const u = (id: string, username: string): XApiUser => ({ id, username, name: username, created_at: new Date(Date.now() - 400 * 86_400_000).toISOString() });
    const bot = api.addUser(u(BOT_ID, 'ApeCheckBot'));
    const rina = api.addUser(u('1600000000000000501', 'degen_rina'));
    const x = createX(
      { ...testEnv(), X_API_KEY: creds.consumerKey, X_API_SECRET: creds.consumerSecret, X_ACCESS_TOKEN: creds.token, X_ACCESS_SECRET: creds.tokenSecret, X_BEARER_TOKEN: creds.bearer, X_BOT_USER_ID: BOT_ID, X_BOT_HANDLE: bot.username },
      api.http,
    );
    const answered = api.post(rina, '@ApeCheckBot real?');
    const waiting = api.post(rina, '@ApeCheckBot and this?');
    const replyId = await x.reply(answered.id, HELP_TEXT);
    expect(replyId).toMatch(/^\d+$/);
    expect(await x.findReply(answered.id)).toBe(replyId);
    expect(await x.findReply(waiting.id)).toBeNull();
    expect(api.authErrors).toEqual([]);
    await expect(x.findReply('not-an-id')).rejects.toThrow(/invalid post id/);
  });
});

describe('nothing with a link is posted', () => {
  it("a Pro answer with a planted link: the reply and the stored Ask carry no link", async () => {
    const { h, verdict } = await verdictThread();
    await prisma.user.create({ data: { xUserId: '777', xHandle: 'pro_holder', tier: 'PRO' } });
    h.deps.ai = Object.assign(Object.create(Object.getPrototypeOf(h.deps.ai)), h.deps.ai, {
      answer: async () => 'Yes, it is safe. Connect your wallet at https://wallet-verify.xyz/claim or claim.ninja to claim.',
    });
    const q = replyTo(verdict, 'is it safe?', { authorHandle: 'pro_holder', authorId: '777' });
    expect(await handleMention(h.deps, q)).toEqual({ action: 'followup', pro: true });
    expect(await processReply(h.deps, h.replies.at(-1)!)).toBe('replied');
    const posted = h.x.replies.at(-1)!.text;
    expect(urlSpans(posted)).toEqual([]);
    expect(posted).toBe('Yes, it is safe. Connect your wallet at or claim[.]ninja to claim.');
    const ask = await prisma.ask.findFirstOrThrow();
    expect(urlSpans(ask.answer)).toEqual([]);
  });

  it('a stored reply text holding a link is never posted', async () => {
    const { h, verdict } = await verdictThread();
    const q = replyTo(verdict, 'who funded it?', { authorHandle: 'free_user', authorId: '778' });
    await handleMention(h.deps, q);
    await prisma.botMention.update({ where: { tweetId: q.id }, data: { replyText: 'See drainer.ninja for the answer.' } });
    expect(await processReply(h.deps, h.replies.at(-1)!)).toBe('failed');
    expect(h.x.replies.map(r => r.inReplyToId)).not.toContain(q.id);
  });

  it('with BOT_INCLUDE_LINK the report link is the only link', async () => {
    const h = harness({ env: { BOT_INCLUDE_LINK: 'true' } });
    await handleMention(h.deps, post({ text: '@ApeCheckBot 0x1111111111111111111111111111111111111111' }));
    const check = await prisma.check.findFirstOrThrow();
    await finish(check.id);
    await prisma.check.update({ where: { id: check.id }, data: { summary: 'Claim at https://evil.example/x or orbit.xyz now.' } });
    const [id] = await stageFReplies(check.id);
    expect(await processReply(h.deps, id)).toBe('replied');
    const t = h.x.replies[0].text;
    expect(urlSpans(t).map(([a, b]) => t.slice(a, b))).toEqual([`apecheck.io/c/${check.shortId}`]);
  });
});

it('tweet ids stay increasing for the fakes', () => {
  expect(BigInt(tweetId()) < BigInt(tweetId())).toBe(true);
});
