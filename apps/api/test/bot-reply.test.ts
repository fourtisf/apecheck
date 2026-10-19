/**
 * CheckReportDTO.botReply: the /bot page shows a thread as a real X thread only for a bot check whose reply was
 * actually posted, with the mention as it was written. Every other check carries no botReply at all.
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
        repliedAt: new Date('2026-10-18T10:05:00.000Z'),
        createdAt: new Date('2026-10-18T10:02:00.000Z'),
      },
    });
    expect((await get('bot0001')).botReply).toEqual({
      mention: { author: 'degen_rina', text: '@ApeCheckBot is this real? @kairolabs', createdAt: '2026-10-18T10:02:00.000Z' },
      repliedAt: '2026-10-18T10:05:00.000Z',
    });
  });

  it('has no botReply before the reply is posted, for site checks, and for a mention tied to a non-bot check', async () => {
    const t = await seedTarget(h.prisma, { kind: 'POST', handle: 'kairolabs', name: '@kairolabs', key: 'post:1849' });
    const pending = await seedCheck(h.prisma, { targetId: t.id, shortId: 'bot0002', via: 'BOT', requesterHandle: 'degen_rina', narScore: 50, totalScore: 50, narBand: 'partly' });
    await h.prisma.botMention.create({
      data: { tweetId: '9101', authorId: '77', authorHandle: 'degen_rina', text: '@ApeCheckBot real or larp?', status: 'QUEUED', checkId: pending.id },
    });
    const site = await seedCheck(h.prisma, { targetId: t.id, shortId: 'web0001', via: 'WEB', isLatest: false, narScore: 50, totalScore: 50, narBand: 'partly' });
    await h.prisma.botMention.create({
      data: {
        tweetId: '9201', authorId: '78', authorHandle: 'someone', text: '@ApeCheckBot real or larp?', status: 'REPLIED', checkId: site.id,
        replyTweetId: '9202', repliedAt: new Date(),
      },
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
