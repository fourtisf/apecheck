/**
 * resolveBotTarget() and the mention text rules (HANDOFF §7 "Resolve what to check, in order"). Pure: no DB, no network.
 */
import { describe, expect, it } from 'vitest';
import type { XPost } from '@apecheck/sources';
import { resolveBotTarget } from '../src/bot/resolve';
import { isFromBot, isRetweet, ownText, questionText, tagsBot, type BotIdentity } from '../src/bot/mention';
import { post, replyTo } from './fake-x';

const BOT: BotIdentity = { handle: 'ApeCheckBot', userId: '1000' };
const CA = '0x1111111111111111111111111111111111111111';
const SOL = 'So1anaMint1111111111111111111111111111pump';
const TRON = 'TQn9Y2khEsLJW1ChVWFMSMeRDow5KcbLSE';

const project = (text: string, p: Partial<XPost> = {}) => post({ text, authorHandle: 'orbitxyz', authorId: '700', ...p });
const resolve = (m: XPost, parent: XPost | null = m.repliedTo ?? null) => resolveBotTarget(m, parent, BOT);

describe('resolveBotTarget', () => {
  const cases: { name: string; mention: () => XPost; parent?: () => XPost | null; want: ReturnType<typeof resolve> | Partial<ReturnType<typeof resolve>> }[] = [
    {
      name: 'plain "real or larp?" under a project post: the link in that post (t.co expanded)',
      mention: () => replyTo(project('Orbit v2 is live https://t.co/AbC123', { urls: ['https://orbit.xyz/app'] }), '@ApeCheckBot real or larp?'),
      want: { kind: 'target', target: 'https://orbit.xyz/app', type: 'site', from: 'replied' },
    },
    {
      name: 'under a project post without links: the post author\'s profile',
      mention: () => replyTo(project('We ship tomorrow. Stay tuned 🚀 $ORBIT'), '@ApeCheckBot real or larp?'),
      want: { kind: 'target', target: 'https://x.com/orbitxyz', type: 'handle', from: 'author' },
    },
    {
      // HANDOFF §7 rule 2: the replied-to post's links / contract / author — its @handles are other accounts
      name: "under a post that names another account: the post's author, never the @handle in it",
      mention: () => replyTo(post({ text: 'Aping into @orbitxyz, 100x incoming', authorHandle: 'kol', authorId: '42' }), '@ApeCheckBot is this legit'),
      want: { kind: 'target', target: 'https://x.com/kol', type: 'handle', from: 'author' },
    },
    {
      name: 'a project post naming its auditor, exchange or chain: the project, not them',
      mention: () => replyTo(project('Orbit v2 ships next week. Audited by @CertiK, listed on @MEXC_Official, built on @base'), '@ApeCheckBot real or larp?'),
      want: { kind: 'target', target: 'https://x.com/orbitxyz', type: 'handle', from: 'author' },
    },
    {
      name: "a friend tagged next to the bot under a project post: the project's link, not the friend",
      mention: () => replyTo(project('Orbit v2 is live https://t.co/AbC', { urls: ['https://orbit.xyz/app'] }), '@ApeCheckBot what do you think @frend_ser'),
      want: { kind: 'target', target: 'https://orbit.xyz/app', type: 'site', from: 'replied' },
    },
    {
      name: 'a typed @handle under a post with no link or contract: the typed handle (before the post author)',
      mention: () => replyTo(project('gm, big news soon'), '@ApeCheckBot what about @kairolabs'),
      want: { kind: 'target', target: 'https://x.com/kairolabs', type: 'handle', from: 'mention' },
    },
    {
      name: 'under a post with a contract and a link: the contract',
      mention: () => replyTo(project(`CA: ${CA}\norbit.xyz https://t.co/x1`, { urls: ['https://orbit.xyz'] }), '@ApeCheckBot'),
      want: { kind: 'target', target: CA, type: 'contract', from: 'replied' },
    },
    {
      name: 'tag with an EVM contract in the mention: wins over the parent\'s link',
      mention: () => replyTo(project('https://t.co/q', { urls: ['https://orbit.xyz'] }), `@ApeCheckBot what about ${CA.toUpperCase().replace('0X', '0x')}?`),
      want: { kind: 'target', target: CA, type: 'contract', from: 'mention' },
    },
    {
      name: 'tag with a Solana mint',
      mention: () => post({ text: `@ApeCheckBot ${SOL} real?` }),
      want: { kind: 'target', target: SOL, type: 'contract', from: 'mention' },
    },
    {
      name: 'tag with a Tron address',
      mention: () => post({ text: `@ApeCheckBot check ${TRON}` }),
      want: { kind: 'target', target: TRON, type: 'contract', from: 'mention' },
    },
    {
      name: 'tag with a link: the expanded URL, never the t.co',
      mention: () => post({ text: '@ApeCheckBot thoughts? https://t.co/Zz9', urls: ['https://kairo.ai/launch?ref=x'] }),
      want: { kind: 'target', target: 'https://kairo.ai/launch?ref=x', type: 'site', from: 'mention' },
    },
    {
      name: 'tag with a chart link: the contract in it',
      mention: () => post({ text: '@ApeCheckBot https://t.co/c', urls: [`https://dexscreener.com/base/${CA}`] }),
      want: { kind: 'target', target: CA, type: 'contract', from: 'mention' },
    },
    {
      name: 'tag with an X post link',
      mention: () => post({ text: '@ApeCheckBot is this one real https://t.co/p', urls: ['https://twitter.com/kairolabs/status/1849002'] }),
      want: { kind: 'target', target: 'https://x.com/kairolabs/status/1849002', type: 'xpost', from: 'mention' },
    },
    {
      name: 'tag with @project',
      mention: () => post({ text: '@ApeCheckBot what about @kairolabs' }),
      want: { kind: 'target', target: 'https://x.com/kairolabs', type: 'handle', from: 'mention' },
    },
    {
      name: 'a bare domain typed in the mention',
      mention: () => post({ text: '@ApeCheckBot look at kairo.ai pls' }),
      want: { kind: 'target', target: 'https://kairo.ai', type: 'site', from: 'mention' },
    },
    {
      name: "X's reply prefix is not the author's: its @handles are no target",
      mention: () => replyTo(post({ text: 'gm frens', authorHandle: 'randomguy', authorId: '9' }), '@ApeCheckBot real?'),
      // the prefix "@randomguy" is X's; the parent has nothing, so its author is checked (rule 2), not via rule 1
      want: { kind: 'target', target: 'https://x.com/randomguy', type: 'handle', from: 'author' },
    },
    {
      name: 'quote tweet: the quoted post counts as a link written in the mention',
      mention: () => post({ text: '@ApeCheckBot real? https://t.co/qt', urls: ['https://twitter.com/orbitxyz/status/777'], quotedId: '777' }),
      want: { kind: 'target', target: 'https://x.com/orbitxyz/status/777', type: 'xpost', from: 'mention' },
    },
    {
      name: 'quote tweet without the quoted URL in the entities',
      mention: () => post({ text: '@ApeCheckBot real?', quotedId: '778' }),
      want: { kind: 'target', target: 'https://x.com/i/status/778', type: 'xpost', from: 'mention' },
    },
    {
      name: "the bot's own posts, profile and report links are no target",
      mention: () =>
        post({
          text: '@ApeCheckBot you said https://t.co/a https://t.co/b about @ApeCheckBot apecheck.io/c/abc1234',
          urls: ['https://x.com/ApeCheckBot/status/123', 'https://x.com/apecheckbot'],
        }),
      want: { kind: 'help' },
    },
    {
      name: "a reply under the bot's own post never checks the bot",
      mention: () => replyTo(post({ text: 'LIKELY LARP (37/100)', authorHandle: 'ApeCheckBot', authorId: '1000' }), '@ApeCheckBot ok'),
      want: { kind: 'help' },
    },
    {
      name: 'several candidates: contract > site > X post > @handle',
      mention: () =>
        post({ text: `@ApeCheckBot @kairolabs https://t.co/1 https://t.co/2 ${CA}`, urls: ['https://x.com/kairolabs/status/55', 'https://kairo.ai'] }),
      want: { kind: 'target', target: CA, type: 'contract', from: 'mention' },
    },
    {
      name: 'several candidates without a contract: the site',
      mention: () => post({ text: '@ApeCheckBot @kairolabs https://t.co/1 https://t.co/2', urls: ['https://x.com/kairolabs/status/55', 'https://kairo.ai'] }),
      want: { kind: 'target', target: 'https://kairo.ai', type: 'site', from: 'mention' },
    },
    {
      name: 'an X post beats an @handle',
      mention: () => post({ text: '@ApeCheckBot @kairolabs https://t.co/1', urls: ['https://x.com/kairolabs/status/55'] }),
      want: { kind: 'target', target: 'https://x.com/kairolabs/status/55', type: 'xpost', from: 'mention' },
    },
    {
      name: 'two sites: the first one written',
      mention: () => post({ text: '@ApeCheckBot https://t.co/1 vs https://t.co/2', urls: ['https://alpha.xyz', 'https://beta.xyz'] }),
      want: { kind: 'target', target: 'https://alpha.xyz', type: 'site', from: 'mention' },
    },
    {
      name: 'socials and explorers without a contract are not project sites',
      mention: () => post({ text: '@ApeCheckBot https://t.co/1 https://t.co/2', urls: ['https://t.me/orbit', 'https://github.com/orbit/core'] }),
      want: { kind: 'help' },
    },
    {
      name: 'a cashtag alone names no project',
      mention: () => post({ text: '@ApeCheckBot $ORBIT real?' }),
      want: { kind: 'help' },
    },
    {
      name: 'non-Latin text under a project post',
      mention: () => replyTo(project('Orbit v2 https://t.co/x', { urls: ['https://orbit.xyz'] }), '@ApeCheckBot 这个项目是真的吗？'),
      want: { kind: 'target', target: 'https://orbit.xyz', type: 'site', from: 'replied' },
    },
    {
      name: 'non-Latin text with a domain and a handle glued to CJK',
      mention: () => post({ text: '@ApeCheckBot看看 kairo.ai 和@kairolabs吧' }),
      want: { kind: 'target', target: 'https://kairo.ai', type: 'site', from: 'mention' },
    },
    {
      name: 'empty text, not a reply: help',
      mention: () => post({ text: '' }),
      want: { kind: 'help' },
    },
    {
      name: 'only the bot handle, not a reply: help',
      mention: () => post({ text: '@ApeCheckBot' }),
      want: { kind: 'help' },
    },
    {
      name: 'the parent is itself a reply: its prefix handles are not the target, its author is',
      mention: () =>
        replyTo(
          post({ text: '@someone_else thanks for the support!', authorHandle: 'orbitxyz', authorId: '700', replyToId: '1', displayTextRange: null }),
          '@ApeCheckBot real?',
        ),
      want: { kind: 'target', target: 'https://x.com/orbitxyz', type: 'handle', from: 'author' },
    },
    {
      name: "a quote of the bot's own verdict (its URL in the entities) is no target",
      mention: () => post({ text: '@ApeCheckBot called it lol https://t.co/q1', urls: ['https://twitter.com/ApeCheckBot/status/1950000000000000001'], quotedId: '1950000000000000001' }),
      want: { kind: 'help' },
    },
    {
      name: "a quote of the bot's verdict that also carries a link: the link",
      mention: () =>
        post({ text: '@ApeCheckBot and this one? https://t.co/q1 https://t.co/k', urls: ['https://x.com/ApeCheckBot/status/1950000000000000001', 'https://kairo.ai'], quotedId: '1950000000000000001' }),
      want: { kind: 'target', target: 'https://kairo.ai', type: 'site', from: 'mention' },
    },
    {
      name: 'a reply to a post that quotes the bot: that post\'s author, never the bot\'s post',
      mention: () =>
        replyTo(post({ text: 'lol https://t.co/q', urls: ['https://x.com/ApeCheckBot/status/1950000000000000002'], quotedId: '1950000000000000002', authorHandle: 'kol', authorId: '42' }), '@ApeCheckBot ?'),
      want: { kind: 'target', target: 'https://x.com/kol', type: 'handle', from: 'author' },
    },
    {
      name: 'the parent arrived without its author handle: the parent post itself',
      mention: () => replyTo(project('soon', { id: '424242', authorHandle: null, author: null }), '@ApeCheckBot real?'),
      want: { kind: 'target', target: 'https://x.com/i/status/424242', type: 'xpost', from: 'author' },
    },
  ];

  for (const c of cases) {
    it(c.name, () => {
      const m = c.mention();
      expect(resolve(m, c.parent ? c.parent() : undefined)).toMatchObject(c.want);
    });
  }

  it('says why it chose the target', () => {
    const m = replyTo(project('https://t.co/q', { urls: ['https://orbit.xyz'] }), '@ApeCheckBot real or larp?');
    expect(resolve(m)).toEqual({ kind: 'target', target: 'https://orbit.xyz', type: 'site', from: 'replied', reason: 'project link in the post it replies to' });
    expect(resolve(post({ text: '@ApeCheckBot' }))).toEqual({ kind: 'help', reason: 'nothing to check in the mention' });
  });

  it("a native quote of a known bot post (only quotedId) is no target", () => {
    const m = post({ text: '@ApeCheckBot you are wrong, this is legit', quotedId: '1950000000000000003' });
    expect(resolveBotTarget(m, null, BOT, { botPostIds: new Set(['1950000000000000003']) })).toMatchObject({ kind: 'help' });
    // the same id as an X link without the handle
    const l = post({ text: '@ApeCheckBot https://t.co/z', urls: ['https://x.com/i/status/1950000000000000003'] });
    expect(resolveBotTarget(l, null, BOT, { botPostIds: new Set(['1950000000000000003']) })).toMatchObject({ kind: 'help' });
  });

  describe('a reply to another tag of the bot (a second tag in a thread)', () => {
    const projectPost = () => project('Orbit v2 is live https://t.co/AbC', { urls: ['https://orbit.xyz/'] });
    const firstTag = (parent: XPost | null, text = '@ApeCheckBot real?') =>
      parent ? replyTo(parent, text, { repliedTo: null }) : post({ text });

    it('never checks the person who tagged first: it asks for the post above that tag', () => {
      const parent = projectPost();
      const tag = firstTag(parent);
      const m = replyTo(tag, '@ApeCheckBot ?', { authorHandle: 'other_user', authorId: '601' });
      expect(resolve(m)).toEqual({ kind: 'up', postId: parent.id, reason: expect.any(String) });
      // with the post above it: that post's link
      expect(resolveBotTarget(m, tag, BOT, { above: parent })).toMatchObject({ kind: 'target', target: 'https://orbit.xyz/', type: 'site', from: 'replied' });
      // the same from the parent's own repliedTo, when X included it
      expect(resolveBotTarget(m, { ...tag, repliedTo: parent }, BOT)).toMatchObject({ kind: 'target', target: 'https://orbit.xyz/' });
    });

    it("a link-less post above the tag: that post's author, never the tagger", () => {
      const parent = project('We ship tomorrow');
      const tag = firstTag(parent);
      const m = replyTo(tag, '@ApeCheckBot ??', { authorHandle: 'other_user', authorId: '601' });
      expect(resolveBotTarget(m, tag, BOT, { above: parent })).toMatchObject({ kind: 'target', target: 'https://x.com/orbitxyz', from: 'author' });
    });

    it('the post above could not be read: help, never the tagger', () => {
      const tag = firstTag(projectPost());
      const m = replyTo(tag, '@ApeCheckBot ??', { authorHandle: 'other_user', authorId: '601' });
      expect(resolveBotTarget(m, tag, BOT, { above: null })).toMatchObject({ kind: 'help' });
    });

    it('a top-level tag that names nothing: help, never its author', () => {
      const tag = firstTag(null, '@ApeCheckBot hello');
      expect(resolve(replyTo(tag, '@ApeCheckBot ?', { authorHandle: 'other_user', authorId: '601' }))).toMatchObject({ kind: 'help' });
    });

    it('what the earlier tag named: its link, else its @handle (after one typed in the mention)', () => {
      const withLink = firstTag(null, '@ApeCheckBot is orbit.xyz real?');
      expect(resolve(replyTo(withLink, '@ApeCheckBot +1', { authorHandle: 'other_user', authorId: '601' }))).toMatchObject({ target: 'https://orbit.xyz', from: 'replied' });
      const withHandle = firstTag(null, '@ApeCheckBot is @orbitxyz real?');
      expect(resolve(replyTo(withHandle, '@ApeCheckBot +1', { authorHandle: 'other_user', authorId: '601' }))).toMatchObject({ target: 'https://x.com/orbitxyz', from: 'replied' });
      expect(resolve(replyTo(withHandle, '@ApeCheckBot what about @kairolabs', { authorHandle: 'other_user', authorId: '601' }))).toMatchObject({
        target: 'https://x.com/kairolabs',
        from: 'mention',
      });
    });
  });

  it('without a parent post given, a reply resolves to help (the bot reads the parent then)', () => {
    const m = replyTo(project('https://t.co/q', { urls: ['https://orbit.xyz'] }), '@ApeCheckBot real?');
    expect(resolveBotTarget(m, null, BOT)).toMatchObject({ kind: 'help' });
  });
});

describe('mention text', () => {
  it("own text: X's display range, else the reply prefix X adds (author + handles of the parent)", () => {
    const parent = post({ text: 'gm @alice', authorHandle: 'orbitxyz', authorId: '700' });
    const m = replyTo(parent, '@ApeCheckBot real?');
    expect(m.text).toBe('@orbitxyz @alice @ApeCheckBot real?');
    expect(ownText(m, BOT, parent)).toBe('@ApeCheckBot real?');
    // no range from X: the prefix is the leading handles X carries over
    expect(ownText({ ...m, displayTextRange: null }, BOT, parent)).toBe('@ApeCheckBot real?');
    // no range and no parent: leading handles up to the bot's are X's
    expect(ownText({ ...m, displayTextRange: undefined }, BOT, null)).toBe('@ApeCheckBot real?');
    // not a reply: all of it
    expect(ownText(post({ text: '@kairolabs @ApeCheckBot hi', displayTextRange: null }), BOT)).toBe('@kairolabs @ApeCheckBot hi');
  });

  it('a bot handle only in the reply prefix is not a tag', () => {
    // someone answering further down a thread the bot is in: X prefixes "@degen_rina @ApeCheckBot"
    const botReply = post({ text: '@degen_rina LIKELY LARP (37/100)', authorHandle: 'ApeCheckBot', authorId: '1000', displayTextRange: [12, 32] });
    const userReply = replyTo(botReply, 'lol nice', { authorHandle: 'lurker', authorId: '77' });
    expect(userReply.text).toBe('@ApeCheckBot @degen_rina lol nice');
    expect(tagsBot(ownText(userReply, BOT, botReply), BOT)).toBe(false);
    expect(tagsBot(ownText({ ...userReply, displayTextRange: null }, BOT, botReply), BOT)).toBe(false);
    // typed: a tag, also with the full-width at sign and in any case
    expect(tagsBot(ownText(replyTo(botReply, '@ApeCheckBot and this?', { authorHandle: 'lurker' }), BOT, botReply), BOT)).toBe(true);
    expect(tagsBot('hey ＠apecheckbot', BOT)).toBe(true);
    expect(tagsBot('hey @ApeCheckBotFan', BOT)).toBe(false);
    expect(tagsBot('mail me a@ApeCheckBot', BOT)).toBe(false);
  });

  it('retweets, the bot itself, follow-up questions', () => {
    expect(isRetweet(post({ text: 'RT @orbitxyz: @ApeCheckBot real?' }))).toBe(true);
    expect(isRetweet(post({ text: 'RT this @ApeCheckBot' }))).toBe(false);
    expect(isFromBot(post({ text: 'x', authorId: '1000', authorHandle: 'renamed' }), BOT)).toBe(true);
    expect(isFromBot(post({ text: 'x', authorId: '5', authorHandle: 'apecheckbot' }), BOT)).toBe(true);
    expect(isFromBot(post({ text: 'x', authorId: '5', authorHandle: 'someone' }), BOT)).toBe(false);
    expect(questionText('@ApeCheckBot  who funded\nthe deployer? @ApeCheckBot', BOT)).toBe('who funded the deployer?');
  });
});
