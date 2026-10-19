import fs from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { SID_COOKIE } from '@apecheck/core';
import { APP_URL, Client, makeHarness, resetState, type Harness } from './helpers';

let h: Harness;
beforeAll(async () => {
  h = await makeHarness();
  fs.mkdirSync(path.join(h.shotsDir, 'chk1'), { recursive: true });
  fs.writeFileSync(path.join(h.shotsDir, 'chk1', '1.jpg'), Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]));
  fs.writeFileSync(path.join(h.shotsDir, 'chk1', '2.webp'), 'RIFFxxxxWEBP');
  fs.writeFileSync(path.join(h.shotsDir, 'chk1', 'notes.txt'), 'not an image');
  fs.writeFileSync(path.join(h.shotsDir, 'chk1', 'page.html'), '<script>alert(1)</script>');
  fs.writeFileSync(path.join(h.shotsDir, '.hidden.jpg'), 'dot');
  fs.writeFileSync(path.join(h.tmpRoot, 'secret.jpg'), 'TOP-SECRET');
});
afterAll(async () => {
  await h.close();
});
beforeEach(async () => {
  await resetState(h);
});

const setCookies = (res: { headers: Record<string, unknown> }) => {
  const v = res.headers['set-cookie'];
  return (Array.isArray(v) ? v : v ? [v] : []) as string[];
};

describe('basics', () => {
  it('GET /health', async () => {
    const res = await h.app.inject({ method: 'GET', url: '/health' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true });
    expect(setCookies(res)).toEqual([]);
  });

  it('answers unknown routes and bad bodies with ApiErrorBody', async () => {
    const nf = await h.app.inject({ method: 'GET', url: '/v2/whatever' });
    expect(nf.statusCode).toBe(404);
    expect(nf.json()).toEqual({ code: 'not_found', error: 'Not found' });

    const badJson = await h.app.inject({ method: 'POST', url: '/v1/checks', headers: { 'content-type': 'application/json' }, payload: '{"target":' });
    expect(badJson.statusCode).toBe(400);
    expect(badJson.json()).toMatchObject({ code: 'bad_request' });

    const big = await h.app.inject({ method: 'POST', url: '/v1/checks', payload: { target: 'x'.repeat(40_000) } });
    expect(big.statusCode).toBe(413);
    expect(big.json()).toMatchObject({ code: 'payload_too_large' });
  });

  it('rate limits each IP across the API', async () => {
    const c = new Client(h.app, '198.51.100.120');
    let last = 0;
    for (let i = 0; i < 121; i++) last = (await c.get('/v1/me')).statusCode;
    expect(last).toBe(429);
    const res = await c.get('/v1/feed');
    expect(res.json()).toEqual({ code: 'rate_limited', error: 'Too many requests. Wait a minute and try again.' });
    // someone else is fine
    expect((await new Client(h.app, '198.51.100.121').get('/v1/me')).statusCode).toBe(200);
  });
});

describe('anonymous session cookie', () => {
  it('issues a signed httpOnly cookie once and keeps the same id', async () => {
    const res = await h.app.inject({ method: 'GET', url: '/v1/me' });
    const [cookie] = setCookies(res);
    expect(cookie).toMatch(new RegExp(`^${SID_COOKIE}=[A-Za-z0-9_-]{32}\\.`));
    expect(cookie).toContain('HttpOnly');
    expect(cookie).toContain('SameSite=Lax');
    expect(cookie).toContain('Path=/');
    expect(cookie).toContain('Max-Age=31536000');
    expect(cookie).not.toContain('Secure');

    const c = new Client(h.app);
    await c.get('/v1/me');
    const sid = c.sid(h.app);
    expect(sid).toMatch(/^[A-Za-z0-9_-]{32}$/);
    const again = await c.get('/v1/me');
    expect(setCookies(again)).toEqual([]);
    expect(c.sid(h.app)).toBe(sid);
  });

  it('replaces a tampered or unsigned cookie', async () => {
    const forged = await h.app.inject({ method: 'GET', url: '/v1/me', headers: { cookie: `${SID_COOKIE}=AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA` } });
    expect(setCookies(forged)).toHaveLength(1);
    const c = new Client(h.app);
    await c.get('/v1/me');
    c.cookie = c.cookie!.replace(/\.[^.]*$/, '.bad-signature');
    const res = await c.get('/v1/me');
    expect(setCookies(res)).toHaveLength(1);
  });

  it('marks the cookie Secure in production', async () => {
    const prod = await makeHarness({ NODE_ENV: 'production' });
    try {
      const res = await prod.app.inject({ method: 'GET', url: '/v1/me' });
      expect(setCookies(res)[0]).toContain('Secure');
    } finally {
      await prod.close();
    }
  });
});

describe('CORS', () => {
  it('allows APP_URL and CORS_ORIGINS with credentials', async () => {
    for (const origin of [APP_URL, 'http://localhost:3000']) {
      const pre = await h.app.inject({
        method: 'OPTIONS',
        url: '/v1/checks',
        headers: { origin, 'access-control-request-method': 'POST', 'access-control-request-headers': 'content-type' },
      });
      expect(pre.statusCode).toBe(204);
      expect(pre.headers['access-control-allow-origin']).toBe(origin);
      expect(pre.headers['access-control-allow-credentials']).toBe('true');
      expect(String(pre.headers['access-control-allow-methods'])).toContain('POST');
      expect(setCookies(pre)).toEqual([]);
    }
    const get = await h.app.inject({ method: 'GET', url: '/v1/me', headers: { origin: APP_URL } });
    expect(get.headers['access-control-allow-origin']).toBe(APP_URL);
    expect(get.headers['access-control-allow-credentials']).toBe('true');
  });

  it('gives other origins no CORS grant', async () => {
    const res = await h.app.inject({ method: 'GET', url: '/v1/me', headers: { origin: 'https://evil.example' } });
    expect(res.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('outside production also accepts any local dev origin', async () => {
    for (const origin of ['http://localhost:3123', 'http://127.0.0.1:4555', 'http://localhost']) {
      const res = await h.app.inject({ method: 'GET', url: '/v1/me', headers: { origin } });
      expect(res.headers['access-control-allow-origin']).toBe(origin);
    }
    for (const origin of ['https://localhost:3123', 'http://localhost.evil.example', 'http://127.0.0.1.evil.example:80', 'http://10.0.0.1:3000']) {
      const res = await h.app.inject({ method: 'GET', url: '/v1/me', headers: { origin } });
      expect(res.headers['access-control-allow-origin']).toBeUndefined();
    }
  });

  it('in production only CORS_ORIGINS and APP_URL match, exactly', async () => {
    const prod = await makeHarness({ NODE_ENV: 'production' });
    try {
      for (const origin of ['http://localhost:3123', 'http://127.0.0.1:3000']) {
        const res = await prod.app.inject({ method: 'GET', url: '/v1/me', headers: { origin } });
        expect(res.headers['access-control-allow-origin']).toBeUndefined();
      }
      for (const origin of [APP_URL, 'http://localhost:3000']) {
        const res = await prod.app.inject({ method: 'GET', url: '/v1/me', headers: { origin } });
        expect(res.headers['access-control-allow-origin']).toBe(origin);
      }
    } finally {
      await prod.close();
    }
  });
});

describe('/shots', () => {
  it('serves screenshots with long cache and nosniff', async () => {
    const res = await h.app.inject({ method: 'GET', url: '/shots/chk1/1.jpg' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe('image/jpeg');
    expect(res.headers['cache-control']).toBe('public, max-age=2592000, immutable');
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(setCookies(res)).toEqual([]);
    expect(res.rawPayload.subarray(0, 3)).toEqual(Buffer.from([0xff, 0xd8, 0xff]));
    const webp = await h.app.inject({ method: 'GET', url: '/shots/chk1/2.webp' });
    expect(webp.statusCode).toBe(200);
    expect(webp.headers['content-type']).toBe('image/webp');
  });

  it('refuses anything but images, dotfiles, listings and path traversal', async () => {
    const urls = [
      '/shots/chk1/notes.txt',
      '/shots/chk1/page.html',
      '/shots/.hidden.jpg',
      '/shots/',
      '/shots/chk1/',
      '/shots/../secret.jpg',
      '/shots/..%2fsecret.jpg',
      '/shots/%2e%2e/secret.jpg',
      '/shots/%2e%2e%2fsecret.jpg',
      '/shots/chk1/../../secret.jpg',
      '/shots/chk1/..%2f..%2fsecret.jpg',
      '/shots/chk1/%2e%2e%5c%2e%2e%5csecret.jpg',
      '/shots//etc/passwd',
      `/shots/${encodeURIComponent(path.join(h.tmpRoot, 'secret.jpg'))}`,
      '/shots/chk1/1.jpg%00.txt',
    ];
    for (const url of urls) {
      const res = await h.app.inject({ method: 'GET', url });
      expect(res.statusCode, url).toBeGreaterThanOrEqual(400);
      expect(res.statusCode, url).toBeLessThan(500);
      expect(res.body, url).not.toContain('TOP-SECRET');
      expect(res.body, url).not.toContain('not an image');
      expect(res.body, url).not.toContain('<script>');
      expect(res.headers['content-type'], url).toMatch(/application\/json/);
    }
  });
});
