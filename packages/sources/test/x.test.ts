import { describe, expect, it } from 'vitest';
import { createX, X_TWEET_FIELDS, X_USER_FIELDS } from '../src/adapters/x';
import type { XSource } from '../src/types';
import { fakeHttp, fixture, testEnv } from './helpers';

const KEYS = { X_BEARER_TOKEN: 'bearer-abc' };

describe('X adapter: stub', () => {
  it('without X_BEARER_TOKEN every read is null and nothing is requested', async () => {
    const http = fakeHttp();
    const x = createX(testEnv(), http);
    expect(x.configured).toBe(false);
    expect(x.canPost).toBe(false);
    expect(await x.getPost('1846629381234567890')).toBeNull();
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

describe('X adapter: getPost', () => {
  it('requests the post with author + referenced expansions and maps entities', async () => {
    const http = fakeHttp(url => (url.pathname === '/2/tweets/1846629381234567890' ? { json: fixture('x-post.json') } : undefined));
    const post = await createX(testEnv(KEYS), http).getPost('1846629381234567890');
    const u = new URL(http.calls[0].url);
    expect(u.origin).toBe('https://api.x.com');
    expect(u.searchParams.get('expansions')).toBe('author_id,referenced_tweets.id');
    expect(u.searchParams.get('tweet.fields')).toBe(X_TWEET_FIELDS);
    expect(X_TWEET_FIELDS).toContain('created_at,entities,conversation_id,referenced_tweets,author_id');
    expect(u.searchParams.get('user.fields')).toBe(X_USER_FIELDS);
    expect(http.calls[0].req.headers?.authorization).toBe('Bearer bearer-abc');
    expect(post).toEqual({
      id: '1846629381234567890',
      text: 'Kairo v2 is live on mainnet. Trade now https://t.co/abc123 $kairo cc @solana https://t.co/pic999',
      authorId: '1500000000000000001',
      authorHandle: 'kairolabs',
      authorName: 'Kairo Labs',
      createdAt: '2026-10-18T14:02:11.000Z',
      conversationId: '1846629381234567890',
      urls: ['https://app.kairo.xyz/trade', 'https://docs.kairo.xyz'],
      mentions: ['solana'],
      cashtags: ['KAIRO'],
      replyToId: null,
      quotedId: '1846000000000000000',
      author: {
        id: '1500000000000000001',
        handle: 'kairolabs',
        name: 'Kairo Labs',
        createdAt: '2025-03-02T10:00:00.000Z',
        followers: 18234,
        following: 210,
        verified: false,
        description: 'Building Kairo. Docs: https://t.co/docs77',
        url: 'https://kairo.xyz',
        bioUrls: ['https://docs.kairo.xyz'],
        pinnedTweetId: '1846629381234567890',
        pinnedText: null,
      },
    });
  });

  it('long posts use note_tweet text and entities; replies set replyToId', async () => {
    const http = fakeHttp(() => ({ json: fixture('x-post-long-reply.json') }));
    const post = await createX(testEnv(KEYS), http).getPost('1846700000000000001');
    expect(post?.text).toMatch(/The rest names the contract and docs/);
    expect(post?.urls).toEqual(['https://x.com/i/web/status/1846700000000000001', 'https://kairo.xyz/roadmap']);
    expect(post?.cashtags).toEqual(['KAI']);
    expect(post?.mentions).toEqual(['kairolabs']);
    expect(post?.replyToId).toBe('1846629381234567890');
    expect(post?.quotedId).toBeNull();
  });

  it('invalid ids are not requested; 404 → null; rate limit → null with lastError', async () => {
    const http = fakeHttp();
    const x = createX(testEnv(KEYS), http);
    expect(await x.getPost('abc')).toBeNull();
    expect(http.calls).toHaveLength(0);

    const notFound = createX(testEnv(KEYS), fakeHttp(() => ({ status: 404, json: { title: 'Not Found' } })));
    expect(await notFound.getPost('1')).toBeNull();
    expect(notFound.lastError).toBeNull();

    const limited = createX(testEnv(KEYS), fakeHttp(() => ({ status: 429, text: '', headers: { 'x-rate-limit-reset': '1760054400' } })));
    expect(await limited.getPost('1')).toBeNull();
    expect(limited.lastError).toBe('x.getPost: rate limited until 2025-10-10T00:00:00.000Z');

    const unauthorized = createX(testEnv(KEYS), fakeHttp(() => ({ status: 401, json: { title: 'Unauthorized' } })));
    expect(await unauthorized.getPost('1')).toBeNull();
    expect(unauthorized.lastError).toBe('x.getPost: HTTP 401 from api.x.com');
  });

  it('errors-only answers (deleted/protected posts) → null with the detail', async () => {
    const x = createX(testEnv(KEYS), fakeHttp(() => ({ json: { errors: [{ title: 'Authorization Error', detail: 'Sorry, you are not authorized to see the Tweet with id: [1].' }] } })));
    expect(await x.getPost('1')).toBeNull();
    expect(x.lastError).toBe('x.getPost: Sorry, you are not authorized to see the Tweet with id: [1].');
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
