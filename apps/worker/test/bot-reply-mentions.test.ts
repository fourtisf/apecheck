/**
 * HANDOFF §7 "never mention anyone unprompted": X fills a v2 reply's "Replying to" list by itself (the mention's
 * author plus every account the mention names, X's own reply prefix included). The bot stores those accounts with
 * the mention (BotMention.replyExcludeIds, from XPost.mentionUserIds) and every reply it posts — verdict, help,
 * follow-up pointer — leaves them out, so only the asker is notified. Test database + Redis like bot.test.ts.
 */
import { Redis } from 'ioredis';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { XPost } from '@apecheck/sources';
import { memoryLogger } from '../src/log';
import { enqueueBotReply } from '../src/pipeline/save';
import type { PipelineDeps } from '../src/pipeline/context';
import { handleMention, type BotDeps } from '../src/bot/handle';
import { processReply } from '../src/bot/reply';
import { HELP_TEXT, PRO_POINTER_TEXT } from '../src/bot/compose';
import { replyExcludeIds } from '../src/bot/mention';
import { FakeX, post, replyTo } from './fake-x';
import { heuristicAi, prisma, resetDb, testEnv } from './helpers';

const BOT_ID = '1000';
const ASKER = '501';
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

function harness() {
  const env = testEnv({ X_BOT_USER_ID: BOT_ID, X_BOT_HANDLE: 'ApeCheckBot', BOT_USER_HOURLY: '3', BOT_HOURLY_CAP: '200', APP_URL: 'https://apecheck.io' });
  const x = new FakeX();
  const replies: string[] = [];
  const deps: BotDeps = {
    env,
    prisma,
    redis,
    x,
    ai: heuristicAi(),
    log: memoryLogger(),
    enqueueCheck: async () => undefined,
    enqueueReply: async id => void replies.push(id),
    fetchCard: async () => null,
  };
  return { deps, x, replies };
}

/** user ids X knows for the handles in the tests */
const IDS: Record<string, string> = { apecheckbot: BOT_ID, degen_rina: ASKER, orbitxyz: '700', friend: '3001', free_user: '778' };
for (let i = 1; i <= 25; i++) IDS[`acct${i}`] = String(2000 + i);

/** The post as the adapter maps it: mentionUserIds from the entity ids of every handle it @mentions. */
function withIds(p: XPost): XPost {
  return { ...p, mentionUserIds: p.mentions.map(h => IDS[h.toLowerCase()]).filter((id): id is string => !!id) };
}
const projectPost = () => withIds(post({ text: 'Orbit v2 is live https://t.co/AbC', urls: ['https://orbit.xyz/'], authorHandle: 'orbitxyz', authorId: '700' }));
const mentionRow = (tweet: string) => prisma.botMention.findUniqueOrThrow({ where: { tweetId: tweet } });

async function stageF(checkId: string, status: 'DONE' | 'FAILED' = 'DONE'): Promise<string[]> {
  await prisma.check.update({
    where: { id: checkId },
    data: { status, finishedAt: new Date(), narScore: 37, narBand: 'llarp', totalScore: 37, summary: "'Launch app' does nothing.", isLatest: true },
  });
  const out: string[] = [];
  const deps = { prisma, log: memoryLogger(), hooks: { enqueueBotReply: async (id: string) => void out.push(id) } } as unknown as PipelineDeps;
  await enqueueBotReply(deps, checkId);
  return out;
}

describe('replyExcludeIds', () => {
  it('everyone the mention names and the replied-to author, never the asker or the bot, numeric ids once each', () => {
    const bot = { handle: 'ApeCheckBot', userId: BOT_ID };
    expect(replyExcludeIds({ authorId: ASKER, mentionUserIds: ['700', BOT_ID, ASKER, '3001', '700', 'x1', ''], inReplyToUserId: '700' }, bot)).toEqual(['700', '3001']);
    // the parent's author is added even when X sent no entity for it
    expect(replyExcludeIds({ authorId: ASKER, mentionUserIds: [], inReplyToUserId: '900' }, bot)).toEqual(['900']);
    // a self-reply, a reply to the bot, a post without the field
    expect(replyExcludeIds({ authorId: ASKER, mentionUserIds: undefined, inReplyToUserId: ASKER }, bot)).toEqual([]);
    expect(replyExcludeIds({ authorId: ASKER, inReplyToUserId: BOT_ID }, bot)).toEqual([]);
    // without X_BOT_USER_ID the adapter drops the bot's id itself
    expect(replyExcludeIds({ authorId: ASKER, mentionUserIds: [BOT_ID, '3001'] }, { handle: 'ApeCheckBot', userId: null })).toEqual([BOT_ID, '3001']);
  });
});

describe('bot replies notify only the asker', () => {
  it('a tag naming 25 other accounts under a project post: the verdict reply leaves out all of them and the project', async () => {
    const { deps, x } = harness();
    const tagged = Array.from({ length: 25 }, (_, i) => `@acct${i + 1}`).join(' ');
    const m = withIds(replyTo(projectPost(), `@ApeCheckBot https://t.co/0rb ${tagged} real or larp?`, { urls: ['https://orbit.xyz/'] }));
    expect(m.text.startsWith('@orbitxyz @ApeCheckBot https://t.co/0rb @acct1 ')).toBe(true);
    expect(await handleMention(deps, m)).toMatchObject({ action: 'check', target: 'https://orbit.xyz/' });
    const expected = ['700', ...Array.from({ length: 25 }, (_, i) => String(2001 + i))];
    expect((await mentionRow(m.id)).replyExcludeIds).toEqual(expected);

    const row = await mentionRow(m.id);
    const [job] = await stageF(row.checkId!);
    expect(await processReply(deps, job)).toBe('replied');
    expect(x.replies).toHaveLength(1);
    expect(x.replies[0]).toMatchObject({ inReplyToId: m.id, excludeUserIds: expected });
    expect(x.replies[0].excludeUserIds).not.toContain(ASKER);
    expect(x.replies[0].excludeUserIds).not.toContain(BOT_ID);
  });

  it('the "Couldn\'t finish" reply to a failed check leaves them out too', async () => {
    const { deps, x } = harness();
    const m = withIds(post({ text: '@ApeCheckBot @friend https://t.co/0rb real?', urls: ['https://orbit.xyz/'] }));
    await handleMention(deps, m);
    const [job] = await stageF((await mentionRow(m.id)).checkId!, 'FAILED');
    expect(await processReply(deps, job)).toBe('replied');
    expect(x.replies[0]).toMatchObject({ inReplyToId: m.id, excludeUserIds: ['3001'] });
  });

  it('the help line leaves out the accounts in X\'s reply prefix (a tag under a deleted post)', async () => {
    const { deps, x, replies } = harness();
    const text = '@friend @ApeCheckBot ?';
    const m = withIds(post({ text, replyToId: '1849999999999999999', inReplyToUserId: '3001', repliedTo: null, displayTextRange: [8, text.length] }));
    expect(await handleMention(deps, m)).toEqual({ action: 'help' });
    expect(await processReply(deps, replies[0])).toBe('replied');
    expect(x.replies).toEqual([{ id: expect.any(String), inReplyToId: m.id, text: HELP_TEXT, media: null, excludeUserIds: ['3001'] }]);
  });

  it('a pointer under the bot\'s verdict does not notify the original asker again', async () => {
    const { deps, x, replies } = harness();
    const tag = withIds(replyTo(projectPost(), '@ApeCheckBot real or larp?'));
    await handleMention(deps, tag);
    const [job] = await stageF((await mentionRow(tag.id)).checkId!);
    await processReply(deps, job);
    expect(x.replies[0].excludeUserIds).toEqual(['700']);
    const verdict = withIds(post({
      id: x.replies[0].id,
      text: `@degen_rina ${x.replies[0].text}`,
      authorHandle: 'ApeCheckBot',
      authorId: BOT_ID,
      conversationId: tag.conversationId,
      replyToId: tag.id,
      displayTextRange: [12, 12 + x.replies[0].text.length],
    }));
    // X prefixes "@ApeCheckBot @degen_rina"
    const q = withIds(replyTo(verdict, 'who funded the deployer?', { authorId: '778', authorHandle: 'free_user' }));
    expect(q.text.startsWith('@ApeCheckBot @degen_rina ')).toBe(true);
    expect(await handleMention(deps, q)).toEqual({ action: 'followup', pro: false });
    expect(await processReply(deps, replies.at(-1)!)).toBe('replied');
    expect(x.replies.at(-1)).toMatchObject({ inReplyToId: q.id, text: PRO_POINTER_TEXT, excludeUserIds: [ASKER] });
  });
});
