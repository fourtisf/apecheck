/**
 * /bot example thread: a reply is shown as an X thread only when the bot really posted it; a check that ran on the
 * site is at most a captioned illustration, with no time, no X label and no real account quoted as tagging the bot.
 */
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { ago, type CheckReportDTO, type FeedResponse } from '@apecheck/core';
import { BotView } from '@/components/pages/BotView';
import { pickBotExample, type BotExampleDeps } from '@/components/pages/botExample';
import { feedOf, report, summary } from './fixtures';

const POST_AT = new Date(Date.now() - 2 * 86400_000).toISOString(); // "2d"
const MENTION_AT = new Date(Date.now() - 3 * 3600_000).toISOString(); // "3h"
const REPLIED_AT = new Date(Date.now() - 50 * 60_000).toISOString(); // "50m"
const CHECKED_AT = new Date(Date.now() - 7 * 3600_000).toISOString(); // "7h"

/** A post check the site ran, whose post text the check read: the M1 case the finding reproduced. */
const sitePost = report({
  id: 'web0001',
  kind: 'post',
  name: '@kairolabs',
  title: 'Kairo',
  handle: 'kairolabs',
  domain: null,
  via: 'web',
  checkedAt: CHECKED_AT,
  post: { author: 'kairolabs', text: 'Kairo v2 is live on mainnet today.', createdAt: POST_AT },
});
/** A bot check whose reply was posted on X; the fixture says nothing about what the mention replies to. */
const botReplied = report({
  id: 'bot0001',
  kind: 'post',
  name: '@kairolabs',
  title: 'Kairo',
  handle: 'kairolabs',
  domain: null,
  via: 'bot',
  by: 'degen_rina',
  checkedAt: CHECKED_AT,
  post: { author: 'kairolabs', text: 'Kairo v2 is live on mainnet today.', createdAt: POST_AT },
  botReply: { mention: { author: 'degen_rina', text: '@ApeCheckBot is this real? @kairolabs', createdAt: MENTION_AT }, repliedAt: REPLIED_AT },
});
/** A site check the bot answered on X from cache, with the words it posted. */
const cacheReplied = report({
  ...botReplied,
  id: 'web0002',
  via: 'web',
  by: null,
  botReply: {
    mention: { author: 'late_user', text: '@ApeCheckBot and this one?', createdAt: MENTION_AT },
    repliedAt: REPLIED_AT,
    replyText: "PARTLY REAL (50/100)\n'Launch app' opens a waitlist.\nChecks the claims, not the team. DYOR.",
  },
});
/** The mention was posted as a reply under the very post the check read (BotMention.inReplyToId is its id). */
const botUnderPost = report({
  ...botReplied,
  id: 'bot0003',
  post: { id: '1849002', author: 'kairolabs', text: 'Kairo v2 is live on mainnet today.', createdAt: POST_AT },
  botReply: { mention: { author: 'degen_rina', text: '@kairolabs @ApeCheckBot is this real?', createdAt: MENTION_AT, inReplyToId: '1849002' }, repliedAt: REPLIED_AT },
});
/** The finding's case: a quote tweet of the post (it replies to nothing), so the check read the quoted post. */
const botQuoted = report({
  ...botUnderPost,
  id: 'bot0004',
  botReply: { mention: { author: 'degen_rina', text: '@ApeCheckBot real?', createdAt: MENTION_AT, inReplyToId: null }, repliedAt: REPLIED_AT },
});
/** A mention under some other post (that links the checked post, or carries a link the mention pasted). */
const botElsewhere = report({
  ...botUnderPost,
  id: 'bot0005',
  botReply: { mention: { author: 'degen_rina', text: '@ApeCheckBot x.com/kairolabs/status/1849002 real?', createdAt: MENTION_AT, inReplyToId: '5550001' }, repliedAt: REPLIED_AT },
});
/** A bot check whose reply hasn't gone out (or failed to post). */
const botPending = report({ ...botReplied, id: 'bot0002', botReply: undefined });

function deps(reports: CheckReportDTO[], posts: FeedResponse | null = feedOf(reports.filter(r => r.kind === 'post'))): BotExampleDeps & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    async postChecks() {
      calls.push('postChecks');
      return posts;
    },
    async report(id) {
      calls.push(`report:${id}`);
      return reports.find(r => r.id === id) ?? null;
    },
  };
}

const render = (example: Awaited<ReturnType<typeof pickBotExample>>) =>
  renderToStaticMarkup(<BotView handle="ApeCheckBot" stats={null} recent={feedOf([])} example={example} />);

describe('pickBotExample', () => {
  it('never turns a check that ran on the site into a bot reply', async () => {
    const ex = await pickBotExample(feedOf([]), deps([sitePost]));
    expect(ex).toMatchObject({ mode: 'example', item: { id: 'web0001' }, post: { text: 'Kairo v2 is live on mainnet today.' } });
  });

  it('a bot check whose reply was not posted is neither a reply nor an illustration', async () => {
    const ex = await pickBotExample(feedOf([summary({ id: 'bot0002', kind: 'post', via: 'bot' })]), deps([botPending, sitePost]));
    expect(ex).toMatchObject({ mode: 'example', item: { id: 'web0001' } });
    expect(await pickBotExample(feedOf([summary({ id: 'bot0002', kind: 'post', via: 'bot' })]), deps([botPending]))).toBeNull();
  });

  it('says where an illustrated check ran', async () => {
    const api = report({ ...sitePost, id: 'api0001', via: 'api' });
    expect(render(await pickBotExample(feedOf([]), deps([api])))).toContain('The check ran through the API; nothing was posted on X.');
    expect(render(await pickBotExample(feedOf([]), deps([sitePost])))).toContain('The check ran on the site; nothing was posted on X.');
  });

  it('shows a real thread for a bot reply that was posted, with the mention as written', async () => {
    const ex = await pickBotExample(feedOf([summary({ id: 'bot0001', kind: 'post', via: 'bot' })]), deps([botReplied, sitePost]));
    expect(ex).toMatchObject({ mode: 'reply', item: { id: 'bot0001' }, reply: { mention: { author: 'degen_rina' } } });
  });

  it('no thread when no check read a post, or the API is down', async () => {
    expect(await pickBotExample(feedOf([]), deps([report({ ...sitePost, post: null })]))).toBeNull();
    expect(await pickBotExample(feedOf([]), deps([report({ ...sitePost, post: { author: 'kairolabs', text: '  ', createdAt: null } })]))).toBeNull();
    const d = deps([sitePost]);
    expect(await pickBotExample(null, d)).toBeNull();
    expect(d.calls).toEqual([]);
  });
});

describe('BotView thread', () => {
  it('an illustration is captioned, has no times, no X label and no real account tagging the bot', async () => {
    const html = render(await pickBotExample(feedOf([]), deps([sitePost])));
    expect(html).toContain('Example: how the bot would answer this post');
    expect(html).toContain('nothing was posted on X');
    // the project's real post, under its real handle
    expect(html).toContain('Kairo v2 is live on mainnet today.');
    expect(html).toContain('@kairolabs');
    // no time on any post: neither the post's nor the check's
    expect(html).not.toContain(`<span>${ago(POST_AT)}</span>`);
    expect(html).not.toContain(`<span>${ago(CHECKED_AT)}</span>`);
    expect(html).not.toContain('Automated account');
    // the tag is "You", not an account that never wrote it
    expect(html).toMatch(/<b>You<\/b><\/div><p class="p-text"><span class="tagx">@ApeCheckBot<\/span> real or larp\?<\/p>/);
    // the answer still sits under a tag, never directly under the project's post
    expect(html.indexOf('Kairo v2 is live')).toBeLessThan(html.indexOf('<b>You</b>'));
    expect(html.indexOf('<b>You</b>')).toBeLessThan(html.indexOf('<b>ApeCheck</b>'));
  });

  it('a posted reply shows the mention as written, its author and the real times', async () => {
    const html = render(await pickBotExample(feedOf([summary({ id: 'bot0001', kind: 'post', via: 'bot' })]), deps([botReplied])));
    expect(html).not.toContain('Example:');
    expect(html).toContain('<b>degen_rina</b><span>@degen_rina</span>');
    expect(html).toContain('<span class="tagx">@ApeCheckBot</span> is this real? <span class="tagx">@kairolabs</span>');
    expect(html).not.toContain('real or larp?');
    expect(html).toContain(`<span>${ago(MENTION_AT)}</span>`);
    expect(html).toContain(`<span>${ago(REPLIED_AT)}</span>`);
    expect(html).toContain('Automated account');
  });

  it('shows the words the bot posted, for a site check it answered from cache too', async () => {
    const ex = await pickBotExample(feedOf([summary({ id: 'web0002', kind: 'post', via: 'web' })]), deps([cacheReplied]));
    expect(ex).toMatchObject({ mode: 'reply', item: { id: 'web0002' } });
    const html = render(ex);
    expect(html).not.toContain('Example:');
    expect(html).toContain('<span>PARTLY REAL (50/100)</span><span><br/>&#x27;Launch app&#x27; opens a waitlist.</span><span><br/>Checks the claims, not the team. DYOR.</span>');
    expect(html).toContain('<b>late_user</b>');
    // never an illustration captioned "nothing was posted on X"
    expect(await pickBotExample(feedOf([]), deps([cacheReplied]))).toBeNull();
  });

  it('shows the post the check read above the mention only when the mention replies to that post', async () => {
    const pick = (r: CheckReportDTO) => pickBotExample(feedOf([summary({ id: r.id, kind: 'post', via: 'bot' })]), deps([r]));
    const under = await pick(botUnderPost);
    expect(under).toMatchObject({ mode: 'reply', parent: { id: '1849002', text: 'Kairo v2 is live on mainnet today.' } });
    const html = render(under);
    // the reply chain as it happened: the project's post with its real time, the mention under it, the bot's answer
    expect(html).toContain(`<span>${ago(POST_AT)}</span>`);
    expect(html.indexOf('Kairo v2 is live')).toBeGreaterThan(-1);
    expect(html.indexOf('Kairo v2 is live')).toBeLessThan(html.indexOf('<b>degen_rina</b>'));
    expect(html.indexOf('<b>degen_rina</b>')).toBeLessThan(html.indexOf('<b>ApeCheck</b>'));

    for (const r of [botQuoted, botElsewhere]) {
      const ex = await pick(r);
      expect(ex).toMatchObject({ mode: 'reply', item: { id: r.id }, parent: null });
      const quoted = render(ex);
      // never drawn as a reply under a post the mention didn't reply to: the thread starts at the mention
      expect(quoted).not.toContain('Kairo v2 is live');
      expect(quoted).not.toContain(`<span>${ago(POST_AT)}</span>`);
      expect(quoted).toMatch(/<div class="thread"><div class="post"><div class="pav"[^>]*>D<\/div><div><div class="p-meta"><b>degen_rina<\/b>/);
      expect(quoted).toContain('Automated account');
    }
  });

  it('no parent post when the post or the mention carries no id to match (rows stored before them)', async () => {
    const pick = (r: CheckReportDTO) => pickBotExample(feedOf([summary({ id: r.id, kind: 'post', via: 'bot' })]), deps([r]));
    // the botReplied fixture: a post without its id, a mention without its reply target
    expect(await pick(botReplied)).toMatchObject({ mode: 'reply', parent: null });
    const noPostId = report({ ...botUnderPost, post: { ...botUnderPost.post!, id: null } });
    expect(await pick(noPostId)).toMatchObject({ mode: 'reply', parent: null });
    const noTarget = report({ ...botUnderPost, botReply: { ...botUnderPost.botReply!, mention: { ...botUnderPost.botReply!.mention, inReplyToId: undefined } } });
    expect(await pick(noTarget)).toMatchObject({ mode: 'reply', parent: null });
  });

  it('no thread at all without an example', () => {
    expect(render(null)).not.toContain('class="thread');
  });
});
