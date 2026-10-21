import { describe, expect, it } from 'vitest';
import {
  X_EMBED_TIMEOUT_MS, createXEmbed, decodeEntities, oembedUrl, parseOEmbed, parseSyndication, syndicationToken, syndicationUrl,
} from '../src/adapters/x-embed';
import { fakeHttp, fixture } from './helpers';

const ID = '1846629381234567890';
const SYN = 'cdn.syndication.twimg.com';
const OEMBED = 'publish.twitter.com';

describe('syndication token and URLs', () => {
  it('computes the token like react-tweet: ((id / 1e15) * π) in base 36 without zeros and the dot', () => {
    expect(syndicationToken('20')).toBe('6dq1a2xwd93');
    expect(syndicationToken(ID)).toBe('4h5cv23f4ez');
    for (const id of ['20', ID, '1629307668568633344', '999999999999999999']) {
      expect(syndicationToken(id)).toBe(((Number(id) / 1e15) * Math.PI).toString(36).replace(/(0+|\.)/g, ''));
      expect(syndicationToken(id)).toMatch(/^[1-9a-z]+$/);
    }
  });

  it('builds fixed-host URLs from the numeric id only', () => {
    expect(syndicationUrl(ID)).toBe(`https://${SYN}/tweet-result?id=${ID}&lang=en&token=4h5cv23f4ez`);
    const o = new URL(oembedUrl(ID, 'kairolabs'));
    expect(o.host).toBe(OEMBED);
    expect(o.searchParams.get('url')).toBe(`https://twitter.com/kairolabs/status/${ID}`);
    expect(o.searchParams.get('omit_script')).toBe('1');
    expect(o.searchParams.get('dnt')).toBe('true');
    // a handle that isn't one never reaches the URL
    expect(new URL(oembedUrl(ID, 'evil.com/x?')).searchParams.get('url')).toBe(`https://twitter.com/i/status/${ID}`);
  });
});

describe('parseSyndication', () => {
  it('maps text, author, expanded links (own media dropped), mentions, cashtags, quote', () => {
    const post = parseSyndication(fixture('x-syndication.json'));
    expect(post).toEqual({
      id: ID,
      text: 'Kairo v2 is live on mainnet. Trade now https://t.co/abc123 $kairo cc @solana https://t.co/pic999',
      authorId: '1500000000000000001',
      authorHandle: 'kairolabs',
      authorName: 'Kairo Labs',
      createdAt: '2026-10-18T14:02:11.000Z',
      conversationId: null,
      urls: ['https://app.kairo.xyz/trade', 'https://docs.kairo.xyz'],
      mentions: ['solana'],
      mentionUserIds: ['951329744804392960'],
      cashtags: ['KAIRO'],
      replyToId: null,
      quotedId: '1846000000000000000',
      author: {
        id: '1500000000000000001',
        handle: 'kairolabs',
        name: 'Kairo Labs',
        createdAt: null,
        followers: null,
        following: null,
        verified: true,
        description: null,
        url: null,
        bioUrls: [],
        pinnedTweetId: null,
        pinnedText: null,
      },
      displayTextRange: [0, 76],
      inReplyToUserId: null,
      repliedTo: null,
    });
  });

  it('a reply: replyToId, the typed range after the reply prefix (code points), the parent as repliedTo', () => {
    const post = parseSyndication(fixture('x-syndication-reply.json'))!;
    expect(post.replyToId).toBe(ID);
    expect(post.inReplyToUserId).toBe('1500000000000000001');
    expect(post.text.slice(...post.displayTextRange!)).toBe('@ApeCheckBot real or larp?');
    expect(post.mentions).toEqual(['kairolabs', 'ApeCheckBot']);
    expect(post.mentionUserIds).toEqual(['1500000000000000001', '1800000000000000000']);
    expect(post.repliedTo).toMatchObject({ id: ID, authorHandle: 'kairolabs', urls: ['https://kairo.xyz'], cashtags: ['KAI'] });
    expect(post.repliedTo?.repliedTo).toBeUndefined();
  });

  it("a reply in its author's own thread: the parent keeps its own reply id, so the bot can walk further up", () => {
    // @stridefun's "Dex paid." (an image) under its "Stride is Live … CA: …" post, itself the thread's second post
    const post = parseSyndication(fixture('x-syndication-thread.json'))!;
    expect(post).toMatchObject({ id: '1980000000000000003', authorHandle: 'stridefun', replyToId: '1980000000000000002', urls: [] });
    expect(post.text.slice(...post.displayTextRange!)).toBe('Dex paid.');
    expect(post.repliedTo).toMatchObject({
      id: '1980000000000000002',
      authorId: '1700000000000000880',
      authorHandle: 'stridefun',
      replyToId: '1980000000000000001',
      inReplyToUserId: '1700000000000000880',
      mentions: ['solana'],
      displayTextRange: [0, 80],
    });
    expect(post.repliedTo!.text).toContain('CA: 7NgwJMbrvxdestgmfLaiGf8XCoUD98GqKe2Yw3kpump');
  });

  it('a long post carries its full text when the payload has it', () => {
    const raw = { ...fixture<Record<string, unknown>>('x-syndication.json'), note_tweet: { note_tweet_results: { result: { text: 'Kairo v2 is live on mainnet. The rest of a long post' } } } };
    expect(parseSyndication(raw)?.text).toBe('Kairo v2 is live on mainnet. The rest of a long post');
  });

  it('deleted / protected / withheld → null; an odd entity is skipped, not the post; a wrong shape throws', () => {
    expect(parseSyndication(fixture('x-syndication-tombstone.json'))).toBeNull();
    expect(parseSyndication({})).toBeNull();
    expect(parseSyndication(null)).toBeNull();
    const odd = fixture<Record<string, any>>('x-syndication.json');
    odd.entities.urls.push({ expanded_url: 42 }, 'nonsense', { expanded_url: 'javascript:alert(1)' });
    odd.entities.user_mentions.push({ id_str: 7 });
    odd.display_text_range = 'x';
    odd.parent = { broken: true };
    const post = parseSyndication(odd)!;
    expect(post.urls).toEqual(['https://app.kairo.xyz/trade', 'https://docs.kairo.xyz']);
    expect(post.mentions).toEqual(['solana']);
    expect(post.displayTextRange).toBeNull();
    expect(() => parseSyndication({ __typename: 'Tweet', id_str: ID })).toThrow(/unexpected tweet-result shape/);
  });
});

describe('parseOEmbed', () => {
  it('text from the <p>, author from author_url, links from the visible t.co text, mentions and cashtags', () => {
    const post = parseOEmbed(fixture('x-oembed.json'), ID);
    expect(post).toMatchObject({
      id: ID,
      text: 'Kairo v2 is live on mainnet.\nTrade now app.kairo.xyz/trade… $kairo cc @solana & friends #DeFi pic.twitter.com/pic999',
      authorHandle: 'kairolabs',
      authorName: 'Kairo Labs',
      createdAt: '2026-10-18T00:00:00.000Z',
      urls: ['https://app.kairo.xyz/trade'],
      mentions: ['solana'],
      cashtags: ['KAIRO'],
      replyToId: null,
    });
    expect(post?.author).toMatchObject({ handle: 'kairolabs', createdAt: null, followers: null });
  });

  it('no <p> → null; a wrong shape throws', () => {
    expect(parseOEmbed({ html: '<blockquote></blockquote>' }, ID)).toBeNull();
    expect(() => parseOEmbed({ author_name: 'x' }, ID)).toThrow(/unexpected oEmbed shape/);
  });

  it('decodes HTML entities', () => {
    expect(decodeEntities('a &amp; b &lt;c&gt; &#39;d&#x27; &mdash; &hellip; &bogus;')).toBe("a & b <c> 'd' — … &bogus;");
  });
});

describe('XEmbedReader.getPost', () => {
  it('syndication first; 8 s timeout, no redirects, no SSRF guard (fixed hosts), no credentials', async () => {
    const http = fakeHttp(url => (url.host === SYN ? { json: fixture('x-syndication.json') } : undefined));
    const reader = createXEmbed(http);
    expect((await reader.getPost(ID))?.authorHandle).toBe('kairolabs');
    expect(http.calls).toHaveLength(1);
    expect(http.calls[0].req).toMatchObject({ timeoutMs: X_EMBED_TIMEOUT_MS, redirect: false });
    expect(X_EMBED_TIMEOUT_MS).toBe(8000);
    expect(http.calls[0].req.guard).toBeFalsy();
    expect(http.calls[0].req.headers?.authorization).toBeUndefined();
  });

  it('falls back to oEmbed when syndication fails, is empty or 404s', async () => {
    for (const syn of [{ status: 500, text: 'x' }, { status: 200, text: '' }, { status: 404, text: '' }, { status: 200, text: 'not json' }, { json: fixture('x-syndication-tombstone.json') }]) {
      const http = fakeHttp(url => (url.host === SYN ? syn : url.host === OEMBED ? { json: fixture('x-oembed.json') } : undefined));
      const post = await createXEmbed(http).getPost(ID, 'kairolabs');
      expect(post?.authorHandle).toBe('kairolabs');
      expect(http.calls.map(c => new URL(c.url).host)).toEqual([SYN, OEMBED]);
    }
  });

  it('both fail → null and lastError names both; an invalid id is never requested', async () => {
    const http = fakeHttp(url => (url.host === SYN ? { status: 429, text: '' } : { status: 503, text: '' }));
    const reader = createXEmbed(http);
    expect(await reader.getPost(ID)).toBeNull();
    expect(reader.lastError).toBe(`x-embed.getPost: syndication: HTTP 429 from ${SYN}; oEmbed: HTTP 503 from ${OEMBED}`);
    const none = fakeHttp();
    expect(await createXEmbed(none).getPost('12; DROP')).toBeNull();
    expect(await createXEmbed(none).getPost('https://evil.test/')).toBeNull();
    expect(none.calls).toHaveLength(0);
  });

  it('a deleted post (both 404) is null without an error', async () => {
    const reader = createXEmbed(fakeHttp(() => ({ status: 404, text: '' })));
    expect(await reader.getPost(ID)).toBeNull();
    expect(reader.lastError).toBeNull();
  });
});
