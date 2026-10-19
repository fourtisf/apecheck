/** M3 "Link your X": OAuth 2.0 + PKCE against a fake X (the sandbox can't reach x.com). */
import { createHash } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { xOauthStateKey, type MeDTO } from '@apecheck/core';
import { Client, EvmWallet, FakeSources, SolWallet, makeHarness, resetState, signedIn, type Harness } from './helpers';

describe('X link not configured', () => {
  it('xLinkAvailable is false and /v1/auth/x/start is a 404', async () => {
    const h = await makeHarness();
    try {
      const c = new Client(h.app);
      expect((await c.get('/v1/me')).json<MeDTO>().xLinkAvailable).toBe(false);
      await signedIn(c, new EvmWallet());
      const res = await c.get('/v1/auth/x/start');
      expect(res.statusCode).toBe(404);
      expect(res.json()).toEqual({ code: 'x_link_unavailable', error: 'Linking an X account is not available right now.' });
    } finally {
      await h.close();
    }
  });
});

describe('X link (OAuth 2.0 PKCE)', () => {
  let h: Harness;
  const fake = new FakeSources();
  let xAccount = { id: '1849', username: 'Degen_Rina' };
  let tokenStatus = 200;

  beforeAll(async () => {
    fake.httpHandlers.push((url, req) => {
      if (url.href === 'https://api.x.com/2/oauth2/token' && req.method === 'POST') {
        return tokenStatus === 200 ? { json: { token_type: 'bearer', expires_in: 7200, access_token: 'AT-123', scope: 'users.read tweet.read' } } : { status: tokenStatus, json: { error: 'invalid_request' } };
      }
      if (url.href === 'https://api.x.com/2/users/me') {
        return req.headers?.authorization === 'Bearer AT-123' ? { json: { data: { ...xAccount, name: 'Rina' } } } : { status: 401, json: {} };
      }
      return undefined;
    });
    h = await makeHarness({ X_OAUTH2_CLIENT_ID: 'client-abc', X_OAUTH2_CLIENT_SECRET: 'secret-xyz', API_URL: 'http://api.test' }, { sources: fake });
  });
  afterAll(async () => h.close());
  beforeEach(async () => {
    await resetState(h);
    fake.httpCalls = [];
    xAccount = { id: '1849', username: 'Degen_Rina' };
    tokenStatus = 200;
  });

  /** start the flow; returns the state and the authorize URL */
  async function start(c: Client) {
    const res = await c.get('/v1/auth/x/start');
    expect(res.statusCode).toBe(302);
    const url = new URL(res.headers.location as string);
    return { url, state: url.searchParams.get('state')! };
  }

  it('start: 401 when signed out; signed in: 302 to X with PKCE (S256) and a stored state', async () => {
    expect((await new Client(h.app).get('/v1/me')).json<MeDTO>().xLinkAvailable).toBe(true);
    const anon = await new Client(h.app).get('/v1/auth/x/start');
    expect(anon.statusCode).toBe(401);
    expect(anon.json().code).toBe('sign_in_required');

    const c = new Client(h.app);
    const me = await signedIn(c, new EvmWallet());
    const { url, state } = await start(c);
    expect(url.origin + url.pathname).toBe('https://x.com/i/oauth2/authorize');
    expect(Object.fromEntries(url.searchParams)).toEqual({
      response_type: 'code',
      client_id: 'client-abc',
      redirect_uri: 'http://api.test/v1/auth/x/callback',
      scope: 'users.read tweet.read',
      state,
      code_challenge: expect.any(String),
      code_challenge_method: 'S256',
    });
    expect(url.search).toContain('scope=users.read%20tweet.read');
    const stored = JSON.parse((await h.redis.get(xOauthStateKey(state)))!);
    expect(stored.userId).toBe(me.user!.id);
    expect(createHash('sha256').update(stored.verifier).digest('base64url')).toBe(url.searchParams.get('code_challenge'));
    expect(stored.verifier.length).toBeGreaterThanOrEqual(43);
    expect(await h.redis.ttl(xOauthStateKey(state))).toBeGreaterThan(590);
  });

  it('callback: exchanges the code, links the X account and returns to the site', async () => {
    const c = new Client(h.app);
    const me = await signedIn(c, new EvmWallet());
    const { state } = await start(c);
    const verifier = JSON.parse((await h.redis.get(xOauthStateKey(state)))!).verifier;
    const res = await c.get(`/v1/auth/x/callback?state=${state}&code=CODE-1`);
    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toBe('http://app.test/?x=linked');

    const [tokenCall, meCall] = fake.httpCalls;
    expect(tokenCall.url).toBe('https://api.x.com/2/oauth2/token');
    expect(tokenCall.req.method).toBe('POST');
    expect(tokenCall.req.headers?.authorization).toBe('Basic ' + Buffer.from('client-abc:secret-xyz').toString('base64'));
    expect(tokenCall.req.headers?.['content-type']).toBe('application/x-www-form-urlencoded');
    expect(Object.fromEntries(new URLSearchParams(tokenCall.req.body as string))).toEqual({
      code: 'CODE-1', grant_type: 'authorization_code', redirect_uri: 'http://api.test/v1/auth/x/callback', code_verifier: verifier, client_id: 'client-abc',
    });
    expect(tokenCall.req.timeoutMs).toBe(10_000);
    expect(meCall.url).toBe('https://api.x.com/2/users/me');
    expect(await h.prisma.user.findUniqueOrThrow({ where: { id: me.user!.id } })).toMatchObject({ xHandle: 'Degen_Rina', xUserId: '1849' });
    expect((await c.get('/v1/me')).json<MeDTO>().user?.xHandle).toBe('Degen_Rina');
    // the state is gone: a replay fails
    expect((await c.get(`/v1/auth/x/callback?state=${state}&code=CODE-1`)).headers.location).toBe('http://app.test/?x=error');
  });

  it('the flow must finish in the account that started it (a link sent to someone else does nothing)', async () => {
    const attacker = new Client(h.app);
    await signedIn(attacker, new EvmWallet());
    const { state } = await start(attacker);
    const victim = new Client(h.app);
    const v = await signedIn(victim, new SolWallet());
    const res = await victim.get(`/v1/auth/x/callback?state=${state}&code=CODE-2`);
    expect(res.headers.location).toBe('http://app.test/?x=error');
    expect(fake.httpCalls).toHaveLength(0);
    expect((await h.prisma.user.findUniqueOrThrow({ where: { id: v.user!.id } })).xHandle).toBeNull();
    // and the state was used up
    expect(await h.redis.exists(xOauthStateKey(state))).toBe(0);
    // signed out at the callback: same
    const { state: s2 } = await start(attacker);
    expect((await new Client(h.app).get(`/v1/auth/x/callback?state=${s2}&code=C`)).headers.location).toBe('http://app.test/?x=error');
  });

  it('a denied authorization, a failed exchange and an unknown state come back as ?x=error', async () => {
    const c = new Client(h.app);
    await signedIn(c, new EvmWallet());
    const { state } = await start(c);
    expect((await c.get(`/v1/auth/x/callback?state=${state}&error=access_denied`)).headers.location).toBe('http://app.test/?x=error&reason=denied');
    tokenStatus = 400;
    const s2 = (await start(c)).state;
    expect((await c.get(`/v1/auth/x/callback?state=${s2}&code=bad`)).headers.location).toBe('http://app.test/?x=error');
    expect((await c.get('/v1/auth/x/callback?state=unknownstate0000000000&code=x')).headers.location).toBe('http://app.test/?x=error');
  });

  it('an X account linked to someone else is refused; a stale handle moves', async () => {
    const owner = await h.prisma.user.create({ data: { solAddress: new SolWallet().address, xHandle: 'old_name', xUserId: '1849' } });
    const c = new Client(h.app);
    const me = await signedIn(c, new EvmWallet());
    const { state } = await start(c);
    expect((await c.get(`/v1/auth/x/callback?state=${state}&code=C`)).headers.location).toBe('http://app.test/?x=error&reason=taken');
    expect((await h.prisma.user.findUniqueOrThrow({ where: { id: me.user!.id } })).xUserId).toBeNull();

    // the handle "Degen_Rina" sits on a user from before, with another X id: the new owner of the handle takes it
    await h.prisma.user.update({ where: { id: owner.id }, data: { xHandle: 'Degen_Rina', xUserId: '555' } });
    const s2 = (await start(c)).state;
    expect((await c.get(`/v1/auth/x/callback?state=${s2}&code=C`)).headers.location).toBe('http://app.test/?x=linked');
    expect((await h.prisma.user.findUniqueOrThrow({ where: { id: owner.id } })).xHandle).toBeNull();
    expect((await h.prisma.user.findUniqueOrThrow({ where: { id: me.user!.id } })).xHandle).toBe('Degen_Rina');
  });

  it('unlink clears the X account', async () => {
    const c = new Client(h.app);
    await signedIn(c, new EvmWallet());
    const { state } = await start(c);
    await c.get(`/v1/auth/x/callback?state=${state}&code=C`);
    const res = await c.post('/v1/auth/x/unlink');
    expect(res.statusCode).toBe(200);
    expect(res.json<MeDTO>().user).toMatchObject({ xHandle: null });
    expect((await h.prisma.user.findFirstOrThrow()).xUserId).toBeNull();
    expect((await new Client(h.app).post('/v1/auth/x/unlink')).statusCode).toBe(401);
  });
});
