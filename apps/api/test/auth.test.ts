/** M3 wallet sign-in over HTTP: nonce, verify (EVM + Solana), sessions, linking, logout. */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { SESSION_COOKIE, SESSION_DAYS, SID_COOKIE, authNonceKey, sessionKey, type AuthNonceResponse, type MeDTO } from '@apecheck/core';
import { Client, EvmWallet, SolWallet, makeHarness, resetState, signIn, signedIn, type Harness } from './helpers';

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

async function nonceFor(c: Client, chain: 'evm' | 'sol', address: string, extra = '') {
  const res = await c.get(`/v1/auth/nonce?chain=${chain}&address=${encodeURIComponent(address)}${extra}`);
  expect(res.statusCode).toBe(200);
  return res.json<AuthNonceResponse>();
}

describe('GET /v1/auth/nonce', () => {
  it('returns the EIP-4361 message for this site, a single-use nonce stored for 10 minutes', async () => {
    const w = new EvmWallet();
    const c = new Client(h.app);
    const res = await c.get(`/v1/auth/nonce?chain=evm&address=${w.address}&chainId=8453`);
    expect(res.headers['cache-control']).toBe('no-store');
    const n = res.json<AuthNonceResponse>();
    expect(n.nonce).toMatch(/^[A-Za-z0-9]{20}$/);
    const lines = n.message.split('\n');
    expect(lines[0]).toBe('app.test wants you to sign in with your Ethereum account:');
    expect(lines[1].toLowerCase()).toBe(w.address);
    expect(lines[1]).not.toBe(w.address); // EIP-55 mixed case
    expect(lines.slice(2, 8)).toEqual(['', "Sign in to ApeCheck. This doesn't send a transaction or cost anything.", '', 'URI: http://app.test', 'Version: 1', 'Chain ID: 8453']);
    expect(lines[8]).toBe(`Nonce: ${n.nonce}`);
    const issued = Date.parse(lines[9].replace('Issued At: ', ''));
    expect(Date.parse(lines[10].replace('Expiration Time: ', '')) - issued).toBe(600_000);
    expect(n.expiresAt).toBe(lines[10].replace('Expiration Time: ', ''));
    const ttl = await h.redis.pttl(authNonceKey(n.nonce));
    expect(ttl).toBeGreaterThan(590_000);
    expect(JSON.parse((await h.redis.get(authNonceKey(n.nonce)))!)).toEqual({ chain: 'evm', address: w.address, message: n.message });
  });

  it('EVM without the wallet’s chain id: the Chain ID is the one chain smart wallets are checked on (Base unless TOKEN_CHAIN is EVM)', async () => {
    const w = new EvmWallet();
    const n = await nonceFor(new Client(h.app), 'evm', w.address);
    expect(n.message.split('\n')[7]).toBe('Chain ID: 8453');
  });

  it('Solana: the SIWS message, no Chain ID', async () => {
    const w = new SolWallet();
    const n = await nonceFor(new Client(h.app), 'sol', w.address);
    expect(n.message).toMatch(new RegExp(`^app\\.test wants you to sign in with your Solana account:\\n${w.address}\\n\\n`));
    expect(n.message).not.toContain('Chain ID');
  });

  it('refuses bad chains and addresses', async () => {
    const c = new Client(h.app);
    for (const q of ['chain=btc&address=x', 'chain=evm&address=0x123', 'chain=sol&address=0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed', 'chain=evm', 'chain=evm&address=0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed&chainId=-1']) {
      const res = await c.get(`/v1/auth/nonce?${q}`);
      expect(res.statusCode, q).toBe(400);
      expect(res.json().code).toBe('bad_request');
    }
  });
});

describe('POST /v1/auth/verify', () => {
  it('EVM: signs in, sets a signed httpOnly session cookie for SESSION_DAYS and returns MeDTO', async () => {
    const w = new EvmWallet();
    const c = new Client(h.app);
    const res = await signIn(c, w);
    expect(res.statusCode).toBe(200);
    const me = res.json<MeDTO>();
    expect(me.user).toMatchObject({ evmAddress: w.address, solAddress: null, xHandle: null, tier: 'free', holding: null, holder: false });
    expect(me).toMatchObject({ tier: 'free', credits: 5, max: 5, xLinkAvailable: false, notificationsUnread: 0, token: null, proChecksPerDay: 30, maxChecksPerDay: 200 });

    const cookie = c.lastSetCookie.find(x => x.startsWith(`${SESSION_COOKIE}=`))!;
    expect(cookie).toMatch(/HttpOnly/);
    expect(cookie).toMatch(/SameSite=Lax/);
    expect(cookie).toMatch(new RegExp(`Max-Age=${SESSION_DAYS * 86400}`));
    expect(cookie).not.toMatch(/Secure/);
    expect(cookie).not.toMatch(/Domain=/);

    const sid = c.session(h.app)!;
    expect(sid).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const user = await h.prisma.user.findUniqueOrThrow({ where: { evmAddress: w.address } });
    expect(JSON.parse((await h.redis.get(sessionKey(sid)))!)).toMatchObject({ userId: user.id });
    expect(await h.redis.ttl(sessionKey(sid))).toBeGreaterThan(SESSION_DAYS * 86400 - 10);

    // the session carries over to /v1/me
    expect((await c.get('/v1/me')).json<MeDTO>().user?.id).toBe(user.id);
    // and a client without it is signed out
    expect((await new Client(h.app).get('/v1/me')).json<MeDTO>().user).toBeNull();
  });

  it('EVM: a checksummed address and a v=0/1 signature work too; the same wallet signs into the same user', async () => {
    const w = new EvmWallet();
    const c = new Client(h.app);
    const n = await nonceFor(c, 'evm', w.address.toUpperCase().replace('0X', '0x'));
    const res = await c.post('/v1/auth/verify', { chain: 'evm', address: w.address.toUpperCase().replace('0X', '0x'), message: n.message, signature: w.sign(n.message, { v01: true }) });
    expect(res.statusCode).toBe(200);
    const first = res.json<MeDTO>().user!.id;
    const again = await signedIn(new Client(h.app), w);
    expect(again.user!.id).toBe(first);
    expect(await h.prisma.user.count()).toBe(1);
  });

  it('Solana: signs in with a base58 or base64 signature', async () => {
    const w = new SolWallet();
    const c = new Client(h.app);
    const n = await nonceFor(c, 'sol', w.address);
    const res = await c.post('/v1/auth/verify', { chain: 'sol', address: w.address, message: n.message, signature: w.sign(n.message, 'base64') });
    expect(res.statusCode).toBe(200);
    expect(res.json<MeDTO>().user).toMatchObject({ solAddress: w.address, evmAddress: null });
    expect((await signIn(new Client(h.app), w)).statusCode).toBe(200);
  });

  it('a nonce works once: a replay is refused', async () => {
    const w = new EvmWallet();
    const c = new Client(h.app);
    const n = await nonceFor(c, 'evm', w.address);
    const body = { chain: 'evm', address: w.address, message: n.message, signature: w.sign(n.message) };
    expect((await c.post('/v1/auth/verify', body)).statusCode).toBe(200);
    const replay = await new Client(h.app).post('/v1/auth/verify', body);
    expect(replay.statusCode).toBe(401);
    expect(replay.json()).toEqual({ code: 'nonce_expired', error: 'This sign-in request expired or was already used. Try signing in again.' });
  });

  it('refuses a nonce we never issued, and burns the nonce on a failed attempt', async () => {
    const w = new EvmWallet();
    const c = new Client(h.app);
    const n = await nonceFor(c, 'evm', w.address);
    const forged = n.message.replace(`Nonce: ${n.nonce}`, 'Nonce: madeUpNonce1234567890');
    const res = await c.post('/v1/auth/verify', { chain: 'evm', address: w.address, message: forged, signature: w.sign(forged) });
    expect(res.statusCode).toBe(401);
    expect(res.json().code).toBe('nonce_expired');

    // a wrong signature uses the nonce up: the right one afterwards is too late
    const bad = await c.post('/v1/auth/verify', { chain: 'evm', address: w.address, message: n.message, signature: new EvmWallet().sign(n.message) });
    expect(bad.statusCode).toBe(401);
    expect(bad.json()).toEqual({ code: 'bad_signature', error: "The signature doesn't match this wallet. Try signing in again." });
    expect((await c.post('/v1/auth/verify', { chain: 'evm', address: w.address, message: n.message, signature: w.sign(n.message) })).json().code).toBe('nonce_expired');
  });

  it('refuses a message for another domain, a tampered message and a message for another wallet', async () => {
    const w = new EvmWallet();
    const c = new Client(h.app);
    const cases = [
      (m: string) => m.replace('app.test wants', 'evil.example wants'),
      (m: string) => m.replace('URI: http://app.test', 'URI: http://evil.example'),
      (m: string) => m.replace("doesn't send a transaction", 'sends a transaction'),
      (m: string) => m.replace(/Chain ID: \d+/, 'Chain ID: 2'),
    ];
    for (const tamper of cases) {
      const n = await nonceFor(c, 'evm', w.address);
      const m = tamper(n.message);
      expect(m).not.toBe(n.message);
      const res = await c.post('/v1/auth/verify', { chain: 'evm', address: w.address, message: m, signature: w.sign(m) });
      expect(res.statusCode, m).toBe(400);
      expect(res.json()).toEqual({ code: 'bad_message', error: "The sign-in message doesn't match the one we sent. Try signing in again." });
    }
    // the nonce was issued for another wallet
    const other = new EvmWallet();
    const n = await nonceFor(c, 'evm', other.address);
    const res = await c.post('/v1/auth/verify', { chain: 'evm', address: w.address, message: n.message, signature: w.sign(n.message) });
    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe('bad_message');
    // the right message for that wallet, signed by someone else
    const n2 = await nonceFor(c, 'evm', other.address);
    const res2 = await c.post('/v1/auth/verify', { chain: 'evm', address: other.address, message: n2.message, signature: w.sign(n2.message) });
    expect(res2.json().code).toBe('bad_signature');
    // a Solana message presented as EVM
    const sol = new SolWallet();
    const n3 = await nonceFor(c, 'sol', sol.address);
    expect((await c.post('/v1/auth/verify', { chain: 'evm', address: w.address, message: n3.message, signature: w.sign(n3.message) })).json().code).toBe('bad_message');
    expect(await h.prisma.user.count()).toBe(0);
  });

  it('refuses an expired message', async () => {
    const w = new SolWallet();
    const c = new Client(h.app);
    const n = await nonceFor(c, 'sol', w.address);
    // the stored record outlives the clock: rewrite the expiry inside both the stored and the signed message
    const past = new Date(Date.now() - 1000).toISOString();
    const issued = new Date(Date.now() - 601_000).toISOString();
    const m = n.message.replace(/Issued At: .*/, `Issued At: ${issued}`).replace(/Expiration Time: .*/, `Expiration Time: ${past}`);
    await h.redis.set(authNonceKey(n.nonce), JSON.stringify({ chain: 'sol', address: w.address, message: m }), 'EX', 60);
    const res = await c.post('/v1/auth/verify', { chain: 'sol', address: w.address, message: m, signature: w.sign(m) });
    expect(res.statusCode).toBe(401);
    expect(res.json().code).toBe('nonce_expired');
  });

  it('refuses malformed signatures and bodies', async () => {
    const e = new EvmWallet();
    const s = new SolWallet();
    const c = new Client(h.app);
    for (const sig of ['0x', '0x1234', 'zz', '0x' + '00'.repeat(65), e.sign('something else')]) {
      const n = await nonceFor(c, 'evm', e.address);
      const res = await c.post('/v1/auth/verify', { chain: 'evm', address: e.address, message: n.message, signature: sig });
      expect(res.statusCode, sig).toBe(401);
      expect(res.json().code).toBe('bad_signature');
    }
    for (const sig of ['abc', Buffer.alloc(64).toString('base64'), s.sign('other')]) {
      const n = await nonceFor(c, 'sol', s.address);
      const res = await c.post('/v1/auth/verify', { chain: 'sol', address: s.address, message: n.message, signature: sig });
      expect(res.statusCode, sig).toBe(401);
    }
    for (const body of [{}, { chain: 'evm' }, { chain: 'evm', address: e.address, message: 'hi', signature: '' }, { chain: 'xrp', address: 'a', message: 'b', signature: 'c' }]) {
      expect((await c.post('/v1/auth/verify', body)).statusCode).toBe(400);
    }
    expect((await c.post('/v1/auth/verify', { chain: 'evm', address: e.address, message: 'hello', signature: '0x00' })).json().code).toBe('bad_message');
  });

  it('a smart wallet signs in through EIP-1271 on Base only (TOKEN_CHAIN is not EVM)', async () => {
    const owner = new EvmWallet();
    const safe = '0x' + '5a'.repeat(20);
    h.sources.erc1271Calls = [];
    try {
      const c = new Client(h.app);
      // controlling the address on Ethereum proves nothing: only Base is asked
      h.sources.erc1271.set(`eth:${safe}`, true);
      let n = await nonceFor(c, 'evm', safe);
      let res = await c.post('/v1/auth/verify', { chain: 'evm', address: safe, message: n.message, signature: owner.sign(n.message) });
      expect(res.statusCode).toBe(401);
      expect(res.json().code).toBe('bad_signature');
      expect(h.sources.erc1271Calls.map(x => x.chain)).toEqual(['base']);

      // a message naming another chain is refused without asking any chain
      h.sources.erc1271Calls = [];
      n = await nonceFor(c, 'evm', safe, '&chainId=1');
      res = await c.post('/v1/auth/verify', { chain: 'evm', address: safe, message: n.message, signature: owner.sign(n.message) });
      expect(res.statusCode).toBe(401);
      expect(res.json()).toEqual({
        code: 'bad_signature',
        error: "The signature doesn't match this wallet. If it's a smart wallet, switch it to Base and sign in again.",
      });
      expect(h.sources.erc1271Calls).toEqual([]);

      // Base's RPC is down: 503, try again (no other chain is tried)
      h.sources.erc1271.set(`base:${safe}`, null);
      n = await nonceFor(c, 'evm', safe, '&chainId=8453');
      res = await c.post('/v1/auth/verify', { chain: 'evm', address: safe, message: n.message, signature: owner.sign(n.message) });
      expect(res.statusCode).toBe(503);
      expect(res.json()).toEqual({ code: 'wallet_check_unavailable', error: "Couldn't check your smart wallet on Base right now. Try again in a moment." });
      expect(h.sources.erc1271Calls.map(x => x.chain)).toEqual(['base']);
      expect(await h.prisma.user.count()).toBe(0);

      h.sources.erc1271.set(`base:${safe}`, true);
      n = await nonceFor(c, 'evm', safe, '&chainId=8453');
      res = await c.post('/v1/auth/verify', { chain: 'evm', address: safe, message: n.message, signature: owner.sign(n.message) });
      expect(res.statusCode).toBe(200);
      expect(res.json<MeDTO>().user?.evmAddress).toBe(safe);
    } finally {
      h.sources.erc1271.clear();
      h.sources.erc1271Calls = [];
    }
  });

  it('a key wallet signs in whatever chain its wallet is on', async () => {
    const w = new EvmWallet();
    const c = new Client(h.app);
    h.sources.erc1271Calls = [];
    const n = await nonceFor(c, 'evm', w.address, '&chainId=56');
    expect(n.message).toContain('\nChain ID: 56\n');
    const res = await c.post('/v1/auth/verify', { chain: 'evm', address: w.address, message: n.message, signature: w.sign(n.message) });
    expect(res.statusCode).toBe(200);
    expect(h.sources.erc1271Calls).toEqual([]);
  });
});

describe('smart wallets when the token is live on an EVM chain', () => {
  const TOKEN = '0x' + '7e'.repeat(20);
  let he: Harness;
  beforeAll(async () => {
    he = await makeHarness({ TOKEN_CHAIN: 'eth', TOKEN_ADDRESS: TOKEN, PRO_MIN_HOLD: '1000', MAX_MIN_HOLD: '10000' });
  });
  afterAll(async () => {
    await he.close();
  });

  it('only whoever controls the contract on TOKEN_CHAIN can sign in as it (and get the tier it holds there)', async () => {
    // a treasury Safe holding Max on Ethereum; on Base the same address answers for someone else (old owners, a replay)
    const safe = '0x' + '5b'.repeat(20);
    const attacker = new EvmWallet();
    he.sources.balances.set(safe, 50_000);
    he.sources.erc1271.set(`base:${safe}`, true);
    he.sources.erc1271.set(`eth:${safe}`, false);
    const c = new Client(he.app);

    // without a chain id the message names Ethereum
    let n = await nonceFor(c, 'evm', safe);
    expect(n.message).toContain('\nChain ID: 1\n');
    let res = await c.post('/v1/auth/verify', { chain: 'evm', address: safe, message: n.message, signature: attacker.sign(n.message) });
    expect(res.statusCode).toBe(401);
    // a message for Base is refused outright: Base is never asked
    n = await nonceFor(c, 'evm', safe, '&chainId=8453');
    res = await c.post('/v1/auth/verify', { chain: 'evm', address: safe, message: n.message, signature: attacker.sign(n.message) });
    expect(res.statusCode).toBe(401);
    expect(res.json().error).toContain('switch it to Ethereum');
    expect(he.sources.erc1271Calls.map(x => x.chain)).toEqual(['eth']);
    expect(await he.prisma.user.count()).toBe(0);
    expect(c.session(he.app)).toBeNull();

    // the Safe's real owners sign on Ethereum: Max from the Ethereum balance
    he.sources.erc1271.set(`eth:${safe}`, true);
    const owner = new EvmWallet();
    n = await nonceFor(c, 'evm', safe, '&chainId=1');
    res = await c.post('/v1/auth/verify', { chain: 'evm', address: safe, message: n.message, signature: owner.sign(n.message) });
    expect(res.statusCode).toBe(200);
    expect(res.json<MeDTO>()).toMatchObject({ tier: 'max', user: { evmAddress: safe, holding: 50_000, holder: true } });
  });
});

describe('linking and switching wallets', () => {
  it('signed in with EVM, a Solana sign-in links that wallet to the same user (the session rotates)', async () => {
    const e = new EvmWallet();
    const s = new SolWallet();
    const c = new Client(h.app);
    const me1 = await signedIn(c, e);
    const firstSession = c.session(h.app)!;
    const me2 = await signedIn(c, s);
    expect(me2.user).toMatchObject({ id: me1.user!.id, evmAddress: e.address, solAddress: s.address });
    expect(c.session(h.app)).not.toBe(firstSession);
    expect(await h.redis.exists(sessionKey(firstSession))).toBe(0);
    expect(await h.prisma.user.count()).toBe(1);
    // either wallet now signs into that user
    expect((await signedIn(new Client(h.app), s)).user!.id).toBe(me1.user!.id);
  });

  it("409 wallet_taken when the other chain's wallet belongs to someone else", async () => {
    const e = new EvmWallet();
    const s = new SolWallet();
    await signedIn(new Client(h.app), s); // s is its own user
    const c = new Client(h.app);
    const me = await signedIn(c, e);
    const res = await signIn(c, s);
    expect(res.statusCode).toBe(409);
    expect(res.json()).toEqual({ code: 'wallet_taken', error: 'This wallet is linked to another ApeCheck account.' });
    // still signed in as e
    expect((await c.get('/v1/me')).json<MeDTO>().user!.id).toBe(me.user!.id);
  });

  it('another wallet of the same chain switches accounts instead of linking', async () => {
    const a = new EvmWallet();
    const b = new EvmWallet();
    const c = new Client(h.app);
    const meA = await signedIn(c, a);
    const meB = await signedIn(c, b);
    expect(meB.user!.id).not.toBe(meA.user!.id);
    expect(meB.user).toMatchObject({ evmAddress: b.address });
    expect((await h.prisma.user.findUniqueOrThrow({ where: { id: meA.user!.id } })).evmAddress).toBe(a.address);
  });
});

describe('POST /v1/auth/logout', () => {
  it('deletes the session and clears the cookie; the anonymous sid stays', async () => {
    const c = new Client(h.app);
    await signedIn(c, new EvmWallet());
    const id = c.session(h.app)!;
    const sid = c.sid(h.app);
    const res = await c.post('/v1/auth/logout');
    expect(res.json()).toEqual({ ok: true });
    expect(c.lastSetCookie.find(x => x.startsWith(`${SESSION_COOKIE}=;`))).toBeTruthy();
    expect(await h.redis.exists(sessionKey(id))).toBe(0);
    expect(c.session(h.app)).toBeNull();
    expect(c.sid(h.app)).toBe(sid);
    expect((await c.get('/v1/me')).json<MeDTO>().user).toBeNull();
  });

  it('a stolen copy of the cookie stops working after logout', async () => {
    const c = new Client(h.app);
    await signedIn(c, new EvmWallet());
    const copy = new Client(h.app);
    copy.cookie = c.cookie;
    await c.post('/v1/auth/logout');
    expect((await copy.get('/v1/me')).json<MeDTO>().user).toBeNull();
  });

  it('a forged or unsigned session cookie is ignored', async () => {
    const c = new Client(h.app);
    await signedIn(c, new EvmWallet());
    const raw = c.session(h.app)!;
    const forged = new Client(h.app);
    forged.cookie = `${SESSION_COOKIE}=${raw}`;
    expect((await forged.get('/v1/me')).json<MeDTO>().user).toBeNull();
  });
});

describe('cookies and origins', () => {
  it('COOKIE_DOMAIN and production: both cookies get Domain and Secure', async () => {
    const p = await makeHarness({ COOKIE_DOMAIN: '.app.test', NODE_ENV: 'production', APP_URL: 'https://app.test' });
    try {
      const c = new Client(p.app);
      const w = new EvmWallet();
      const n = (await c.get(`/v1/auth/nonce?chain=evm&address=${w.address}`)).json<AuthNonceResponse>();
      const sidCookie = c.lastSetCookie.find(x => x.startsWith(`${SID_COOKIE}=`))!;
      expect(sidCookie).toMatch(/Domain=\.app\.test/);
      expect(sidCookie).toMatch(/Secure/);
      expect(n.message.startsWith('app.test wants you')).toBe(true);
      const res = await c.post('/v1/auth/verify', { chain: 'evm', address: w.address, message: n.message, signature: w.sign(n.message) }, { origin: 'https://app.test' });
      expect(res.statusCode).toBe(200);
      const session = c.lastSetCookie.find(x => x.startsWith(`${SESSION_COOKIE}=`))!;
      expect(session).toMatch(/Domain=\.app\.test/);
      expect(session).toMatch(/Secure/);
      expect(session).toMatch(/HttpOnly/);
      // logout clears it on the same domain
      await c.post('/v1/auth/logout', undefined, { origin: 'https://app.test' });
      expect(c.lastSetCookie.find(x => x.startsWith(`${SESSION_COOKIE}=;`))).toMatch(/Domain=\.app\.test/);
    } finally {
      await p.close();
    }
  });

  it('a state-changing request with the session from a foreign origin is refused', async () => {
    const c = new Client(h.app);
    await signedIn(c, new EvmWallet());
    const res = await c.post('/v1/auth/logout', undefined, { origin: 'https://evil.example' });
    expect(res.statusCode).toBe(403);
    expect(res.json().code).toBe('forbidden');
    expect((await c.get('/v1/me')).json<MeDTO>().user).not.toBeNull();
    // our own origin (and no origin: server-side callers) are fine
    expect((await c.post('/v1/auth/logout', undefined, { origin: 'http://app.test' })).statusCode).toBe(200);
  });

  it('limits nonce requests per IP', async () => {
    const c = new Client(h.app, '198.51.100.200');
    const w = new EvmWallet();
    const codes: number[] = [];
    for (let i = 0; i < 31; i++) codes.push((await c.get(`/v1/auth/nonce?chain=evm&address=${w.address}`)).statusCode);
    expect(codes.slice(0, 30).every(x => x === 200)).toBe(true);
    expect(codes[30]).toBe(429);
  });

  it('limits verify attempts per IP', async () => {
    const c = new Client(h.app, '198.51.100.201');
    const w = new EvmWallet();
    const codes: number[] = [];
    for (let i = 0; i < 21; i++) codes.push((await c.post('/v1/auth/verify', { chain: 'evm', address: w.address, message: 'x', signature: '0x00' })).statusCode);
    expect(codes.slice(0, 20).every(x => x === 400)).toBe(true);
    expect(codes[20]).toBe(429);
    // the wallet itself is not locked out: another IP signs it in
    expect((await signIn(new Client(h.app, '198.51.100.202'), w)).statusCode).toBe(200);
  });
});
