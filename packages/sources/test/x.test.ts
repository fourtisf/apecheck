import { describe, expect, it } from 'vitest';
import { createX, X_USER_FIELDS } from '../src/adapters/x';
import type { XSource } from '../src/types';
import { fakeHttp, fixture, testEnv } from './helpers';

const KEYS = { X_BEARER_TOKEN: 'bearer-abc' };
const SYN = 'cdn.syndication.twimg.com';

describe('X adapter: stub', () => {
  it('without X_BEARER_TOKEN account reads are null and nothing is requested', async () => {
    const http = fakeHttp();
    const x = createX(testEnv(), http);
    expect(x.configured).toBe(false);
    expect(x.canPost).toBe(false);
    expect(await x.getPost('abc')).toBeNull();
    expect(await x.getUser('kairolabs')).toBeNull();
    expect(await x.getUserById('1500000000000000001')).toBeNull();
    expect(await x.renameCount('kairolabs')).toBeNull();
    expect(http.calls).toHaveLength(0);
    // the bot methods exist but are stubs too (see x-bot.test.ts)
    const source: XSource = x;
    expect(await source.mentions!(null)).toEqual({ posts: [], newestId: null });
    expect(await source.reply!('1846629381234567890', 'hi')).toBeNull();
    expect(http.calls).toHaveLength(0);
  });

  it('canPost needs all four OAuth 1.0a keys', () => {
    const three = { X_API_KEY: 'a', X_API_SECRET: 'b', X_ACCESS_TOKEN: 'c' };
    expect(createX(testEnv(three), fakeHttp()).canPost).toBe(false);
    expect(createX(testEnv({ ...three, X_ACCESS_SECRET: 'd' }), fakeHttp()).canPost).toBe(true);
  });
});

describe('X adapter: getPost is free (embed endpoints, never the paid X API)', () => {
  const allKeys = { ...KEYS, X_API_KEY: 'k', X_API_SECRET: 's', X_ACCESS_TOKEN: 't', X_ACCESS_SECRET: 'u' };

  it('with every X key set, the post is read from the syndication endpoint without credentials', async () => {
    const http = fakeHttp(url => (url.host === SYN ? { json: fixture('x-syndication.json') } : undefined));
    const post = await createX(testEnv(allKeys), http).getPost('1846629381234567890');
    expect(http.calls).toHaveLength(1);
    expect(http.calls.some(c => new URL(c.url).host === 'api.x.com')).toBe(false);
    const u = new URL(http.calls[0].url);
    expect(u.origin + u.pathname).toBe('https://cdn.syndication.twimg.com/tweet-result');
    expect(u.searchParams.get('id')).toBe('1846629381234567890');
    expect(u.searchParams.get('token')).toBe('4h5cv23f4ez');
    expect(http.calls[0].req).toMatchObject({ timeoutMs: 8000, redirect: false });
    expect(http.calls[0].req.guard).toBeFalsy();
    expect(http.calls[0].req.headers?.authorization).toBeUndefined();
    expect(post).toMatchObject({
      id: '1846629381234567890',
      authorHandle: 'kairolabs',
      urls: ['https://app.kairo.xyz/trade', 'https://docs.kairo.xyz'],
      cashtags: ['KAIRO'],
      quotedId: '1846000000000000000',
    });
    // an embed has no account data
    expect(post?.author).toMatchObject({ handle: 'kairolabs', createdAt: null, followers: null, description: null, bioUrls: [] });
  });

  it('syndication down → oEmbed (still no api.x.com); both down → null with both reasons', async () => {
    const http = fakeHttp(url => (url.host === SYN ? { status: 503, text: 'busy' } : url.host === 'publish.twitter.com' ? { json: fixture('x-oembed.json') } : undefined));
    const x = createX(testEnv(allKeys), http);
    const post = await x.getPost('1846629381234567890', 'kairolabs');
    expect(post?.urls).toEqual(['https://app.kairo.xyz/trade']);
    expect(http.calls.map(c => new URL(c.url).host)).toEqual([SYN, 'publish.twitter.com']);

    const down = fakeHttp(() => ({ status: 500, text: '' }));
    const y = createX(testEnv(allKeys), down);
    expect(await y.getPost('1846629381234567890')).toBeNull();
    expect(down.calls.map(c => new URL(c.url).host)).toEqual([SYN, 'publish.twitter.com']);
  });
});

describe('X adapter: users', () => {
  it('getUser maps bio URLs, profile URL and the pinned post text', async () => {
    const http = fakeHttp(url => (url.pathname === '/2/users/by/username/kairolabs' ? { json: fixture('x-user.json') } : undefined));
    const user = await createX(testEnv(KEYS), http).getUser('@kairolabs');
    expect(user).toEqual({
      id: '1500000000000000001',
      handle: 'kairolabs',
      name: 'Kairo Labs',
      createdAt: '2025-03-02T10:00:00.000Z',
      followers: 18234,
      following: 210,
      verified: true,
      description: 'Building Kairo. Docs: https://t.co/docs77 and https://t.co/gh88',
      url: 'https://kairo.xyz',
      bioUrls: ['https://docs.kairo.xyz', 'https://github.com/kairolabs'],
      pinnedTweetId: '1846629381234567890',
      pinnedText: 'Kairo v2 is live on mainnet.',
    });
    const u = new URL(http.calls[0].url);
    expect(u.searchParams.get('expansions')).toBe('pinned_tweet_id');
    expect(u.searchParams.get('user.fields')).toBe(X_USER_FIELDS);
  });

  it('getUserById uses /2/users/:id', async () => {
    const http = fakeHttp(url => (url.pathname === '/2/users/1500000000000000001' ? { json: fixture('x-user.json') } : undefined));
    expect((await createX(testEnv(KEYS), http).getUserById('1500000000000000001'))?.handle).toBe('kairolabs');
  });

  it('unknown handle → null with the API detail; invalid handle → no request', async () => {
    const x = createX(testEnv(KEYS), fakeHttp(() => ({ json: fixture('x-user-not-found.json') })));
    expect(await x.getUser('nonexistent_h')).toBeNull();
    expect(x.lastError).toBe('x.getUser: Could not find user with username: [nonexistent_h].');
    const http = fakeHttp();
    expect(await createX(testEnv(KEYS), http).getUser('not a handle!')).toBeNull();
    expect(http.calls).toHaveLength(0);
  });

  it('renameCount is a stub (third-party source needed)', async () => {
    expect(await createX(testEnv(KEYS), fakeHttp()).renameCount('kairolabs')).toBeNull();
  });
});
