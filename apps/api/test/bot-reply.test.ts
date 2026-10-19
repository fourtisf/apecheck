/**
 * CheckReportDTO.botReply: the /bot page shows a thread as a real X thread only for a check whose verdict reply the
 * bot actually posted, with the mention and the reply as they were written. Every other check carries no botReply.
 * Since M2 a check can answer several mentions (re-tags reuse it) and a site check can be answered from cache.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { CheckReportDTO } from '@apecheck/core';
import { Client, makeHarness, resetState, seedCheck, seedTarget, type Harness } from './helpers';

let h: Harness;
beforeAll(async () => {
  h = await makeHarness();
});
afterAll(async () => {
  await h.close();
});
beforeEach(async () => {
  await resetState(h);
});

const get = async (id: string) => (await new Client(h.app).get(`/v1/checks/${id}`)).json<CheckReportDTO>();

describe('report botReply', () => {
  it('carries the mention and the reply time once the bot replied on X', async () => {
    const t = await seedTarget(h.prisma, { kind: 'POST', handle: 'kairolabs', name: '@kairolabs', key: 'post:1849' });
    const c = await seedCheck(h.prisma, { targetId: t.id, shortId: 'bot0001', via: 'BOT', requesterHandle: 'degen_rina', narScore: 50, totalScore: 50, narBand: 'partly' });
    await h.prisma.botMention.create({
      data: {
        tweetId: '9001',
        authorId: '77',
        authorHandle: '@degen_rina',
        text: '@ApeCheckBot is this real? @kairolabs',
        inReplyToId: '1849',
        status: 'REPLIED',
        checkId: c.id,
        replyTweetId: '9002',
        replyText: 'PARTLY REAL (50/100)\nChecks the claims, not the team. DYOR.',
        kind: 'check',
        repliedAt: new Date('2026-10-18T10:05:00.000Z'),
        createdAt: new Date('2026-10-18T10:02:00.000Z'),
      },
    });
    // a second tag in the thread reused the check: the report keeps the first reply; follow-ups never count
    await h.prisma.botMention.create({
      data: {
        tweetId: '9003', authorId: '78', authorHandle: 'other', text: '@ApeCheckBot and this?', status: 'REPLIED', kind: 'check', checkId: c.id,
        replyTweetId: '9004', replyText: 'later', repliedAt: new Date('2026-10-18T11:00:00.000Z'), createdAt: new Date('2026-10-18T10:59:00.000Z'),
      },
    });
    await h.prisma.botMention.create({
      data: {
        tweetId: '9005', authorId: '79', authorHandle: 'pro', text: 'who funded it?', status: 'REPLIED', kind: 'followup', checkId: c.id,
        replyTweetId: '9006', replyText: 'answer', repliedAt: new Date('2026-10-18T09:00:00.000Z'), createdAt: new Date('2026-10-18T08:59:00.000Z'),
      },
    });
    expect((await get('bot0001')).botReply).toEqual({
      // inReplyToId: the post the mention replies to, so /bot draws the checked post as its parent only when it is
      mention: { author: 'degen_rina', text: '@ApeCheckBot is this real? @kairolabs', createdAt: '2026-10-18T10:02:00.000Z', inReplyToId: '1849' },
      repliedAt: '2026-10-18T10:05:00.000Z',
      replyText: 'PARTLY REAL (50/100)\nChecks the claims, not the team. DYOR.',
    });
  });

  it('a site check the bot answered from cache carries the reply and is listed under via=bot', async () => {
    const t = await seedTarget(h.prisma, { kind: 'SITE', domain: 'orbitswap.xyz', name: 'orbitswap.xyz', key: 'site:orbitswap.xyz' });
    const c = await seedCheck(h.prisma, { targetId: t.id, shortId: 'web0009', via: 'WEB', isLatest: true, narScore: 50, totalScore: 50, narBand: 'partly' });
    const client = new Client(h.app);
    expect((await client.get('/v1/feed?via=bot')).json<{ items: { id: string }[] }>().items.map(i => i.id)).toEqual([]);
    await h.prisma.botMention.create({
      data: {
        tweetId: '9301', authorId: '80', authorHandle: 'someone', text: '@ApeCheckBot orbitswap.xyz real?', status: 'REPLIED', kind: 'check', checkId: c.id,
        replyTweetId: '9302', replyText: 'PARTLY REAL (50/100)', repliedAt: new Date('2026-10-18T12:00:00.000Z'), createdAt: new Date('2026-10-18T11:59:00.000Z'),
      },
    });
    // a mention that replies to nothing (a quote tweet, a post of its own) says so
    expect((await get('web0009')).botReply).toMatchObject({ mention: { author: 'someone', inReplyToId: null }, replyText: 'PARTLY REAL (50/100)' });
    expect((await client.get('/v1/feed?via=bot')).json<{ items: { id: string; via: string }[] }>().items).toEqual([expect.objectContaining({ id: 'web0009', via: 'web' })]);
    expect((await client.get('/v1/feed?via=web')).json<{ items: { id: string }[] }>().items.map(i => i.id)).toEqual(['web0009']);
  });

  it('has no botReply before the reply is posted, for site checks, and for a reply that was not a verdict', async () => {
    const t = await seedTarget(h.prisma, { kind: 'POST', handle: 'kairolabs', name: '@kairolabs', key: 'post:1849' });
    const pending = await seedCheck(h.prisma, { targetId: t.id, shortId: 'bot0002', via: 'BOT', requesterHandle: 'degen_rina', narScore: 50, totalScore: 50, narBand: 'partly' });
    await h.prisma.botMention.create({
      data: { tweetId: '9101', authorId: '77', authorHandle: 'degen_rina', text: '@ApeCheckBot real or larp?', status: 'QUEUED', checkId: pending.id },
    });
    const site = await seedCheck(h.prisma, { targetId: t.id, shortId: 'web0001', via: 'WEB', isLatest: false, narScore: 50, totalScore: 50, narBand: 'partly' });
    // a follow-up answer and a reply that failed to post are not the bot's verdict reply
    await h.prisma.botMention.create({
      data: {
        tweetId: '9201', authorId: '78', authorHandle: 'someone', text: 'who funded it?', status: 'REPLIED', kind: 'followup', checkId: site.id,
        replyTweetId: '9202', repliedAt: new Date(),
      },
    });
    await h.prisma.botMention.create({
      data: { tweetId: '9203', authorId: '78', authorHandle: 'someone', text: '@ApeCheckBot real?', status: 'FAILED', kind: 'check', checkId: site.id },
    });
    const t2 = await seedTarget(h.prisma, { kind: 'SITE', domain: 'orbitswap.xyz', name: 'orbitswap.xyz', key: 'site:orbitswap.xyz' });
    await seedCheck(h.prisma, { targetId: t2.id, shortId: 'web0002', via: 'WEB', narScore: 50, totalScore: 50, narBand: 'partly' });

    for (const id of ['bot0002', 'web0001', 'web0002']) {
      const r = await get(id);
      expect(r.id).toBe(id);
      expect(r).not.toHaveProperty('botReply');
    }
  });
});
