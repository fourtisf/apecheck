/**
 * M3 in Chromium, against `next start`, the real API and worker-bot's asks consumer (see global-setup.ts), with fake
 * wallets injected into the page (wallets.ts): an EIP-6963 EVM wallet signing with secp256k1 in Node and a Wallet
 * Standard Solana wallet signing with ed25519 in Node. The EVM wallet is Pro through TIER_OVERRIDES.
 * - wallet sign-in (SIWE), the account menu, linking a Solana wallet (SIWS), sign-out; the server render knows the viewer;
 * - a declined signature, a browser without wallets;
 * - Watch: this browser's list moves to the account on sign-in, then POST/DELETE /v1/watch; the feed's Watchlist tab;
 * - a follow-up question answered by the worker; a community note with Helpful votes;
 * - re-check alerts in the account menu; ?x=linked; the Max "Private" toggle; the signed-in header at every width.
 */
import type { Browser, BrowserContext, Page } from 'playwright';
import { afterAll, beforeAll, beforeEach, describe, expect, inject, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { REDIS_URL, WEB_URL, flushRedis, openDb, playwright } from './env';
import { EVM_MAX_KEY, EVM_PRO_KEY, SOL_SEED, evmAddressOf, installFakeWallets, solanaKey, type FakeWalletOpts } from './wallets';

let browser: Browser;
let db: Awaited<ReturnType<typeof openDb>>;
const contexts: BrowserContext[] = [];

const PRO = evmAddressOf(EVM_PRO_KEY);
const MAX = evmAddressOf(EVM_MAX_KEY);
const SOL = solanaKey(SOL_SEED).address;
const short = (a: string) => `${a.slice(0, 5)}…${a.slice(-4)}`;

async function cleanAccounts() {
  await db.notification.deleteMany({});
  await db.noteVote.deleteMany({});
  await db.note.deleteMany({});
  await db.ask.deleteMany({});
  await db.check.updateMany({ data: { asksCount: 0 } });
  await db.watch.deleteMany({});
  await db.user.deleteMany({});
}

beforeAll(async () => {
  browser = await playwright.chromium.launch({ headless: true });
  db = await openDb();
  await cleanAccounts();
});
afterAll(async () => {
  for (const c of contexts) await c.close().catch(() => {});
  await browser?.close();
  if (db) {
    await cleanAccounts();
    await db.$disconnect();
  }
});
// sessions, credits and rate limits live in Redis: every test starts signed out with fresh limits
beforeEach(async () => {
  flushRedis();
  await cleanAccounts();
});

const logs = () => `server logs: ${inject('e2eLogDir')}`;

async function newPage(opts: FakeWalletOpts & { width?: number; height?: number; wallets?: boolean } = {}): Promise<Page> {
  const ctx = await browser.newContext({ viewport: { width: opts.width ?? 1440, height: opts.height ?? 900 } });
  contexts.push(ctx);
  const page = await ctx.newPage();
  if (opts.wallets !== false) await installFakeWallets(page, opts);
  return page;
}

async function ready(page: Page, selector: string) {
  await page.waitForFunction(
    (sel: string) => {
      const el = document.querySelector(sel);
      return !!el && Object.keys(el).some(k => k.startsWith('__reactProps$'));
    },
    selector,
    { timeout: 30_000 },
  );
}

async function until<T>(fn: () => T | Promise<T>, ok: (v: T) => boolean, what: string, ms = 15_000): Promise<T> {
  const end = Date.now() + ms;
  let v: T = await fn();
  while (!ok(v) && Date.now() < end) {
    await new Promise(r => setTimeout(r, 100));
    v = await fn();
  }
  if (!ok(v)) throw new Error(`${what}: got ${JSON.stringify(v)} (${logs()})`);
  return v;
}

async function toastSays(page: Page, text: string) {
  await page.waitForFunction((t: string) => (document.querySelector('#toast.on')?.textContent ?? '').includes(t), text, { timeout: 15_000 }).catch(async () => {
    throw new Error(`toast never said "${text}"; last: "${await page.textContent('#toast')}" (${logs()})`);
  });
}

async function go(page: Page, path: string) {
  await page.goto(WEB_URL + path);
  await ready(page, '.top-r > :last-child');
}

/** Header "Connect wallet" (or a menu's link button) → the wallet modal → pick a wallet → signed in. */
async function signIn(page: Page, wallet: 'Test EVM Wallet' | 'Test Solana Wallet' = 'Test EVM Wallet') {
  await page.click('.top-r .btn-primary:has-text("Connect wallet")');
  await page.click(`.wopt:has-text("${wallet}")`);
  await page.waitForSelector('.acct-btn', { timeout: 20_000 });
}

const targetOf = async (shortId: string) => (await db.check.findUniqueOrThrow({ where: { shortId }, select: { targetId: true } })).targetId;

describe('wallet sign-in', () => {
  it('signs in with an EVM wallet, shows the account menu, links a Solana wallet and signs out', async () => {
    const page = await newPage();
    await go(page, '/c/site001');
    await page.click('.top-r .btn-primary:has-text("Connect wallet")');
    await page.waitForSelector('.wopt');
    const listed = await page.$$eval('.wopt', els => els.map(e => ({ text: e.textContent, icon: e.querySelector('img')?.getAttribute('src')?.slice(0, 15) ?? null })));
    expect(listed).toEqual([
      { text: 'Test EVM WalletEVM', icon: 'data:image/svg+' },
      { text: 'Test Solana WalletSolana', icon: 'data:image/svg+' },
    ]);
    await page.click('.wopt:has-text("Test EVM Wallet")');
    await page.waitForSelector('.acct-btn');
    await toastSays(page, `Signed in as ${short(PRO.toLowerCase())}`);
    // the toast's font would draw the "x" of "0x…" as "×" with its contextual alternates on
    expect(await page.$eval('#toast', el => getComputedStyle(el).fontFeatureSettings)).toBe('"calt" 0');
    expect(await page.textContent('.acct-btn')).toBe(`${short(PRO.toLowerCase())}Pro`);
    // the credits ring follows the tier's daily limit
    expect(await page.textContent('#credBtn')).toBe('30/30');

    const user = await db.user.findUniqueOrThrow({ where: { evmAddress: PRO.toLowerCase() } });
    expect(user.solAddress).toBeNull();

    // the server render sees the session cookie: the signed-in header is in the HTML itself
    const html = await (await page.request.get(`${WEB_URL}/c/site001`)).text();
    expect(html).toContain('acct-btn');
    expect(html).not.toContain('Connect wallet</span>');

    await page.click('.acct-btn');
    const menu = await page.textContent('.acct-menu');
    expect(menu).toContain('Pro');
    expect(menu).toContain(short(PRO.toLowerCase()));
    expect(menu).toContain('Link a Solana wallet');
    expect(menu).toContain('Link your X');
    expect(menu).not.toContain('Holds'); // the token isn't live

    await page.click('.acct-menu button:has-text("Link a Solana wallet")');
    await page.waitForSelector('.wopt');
    expect(await page.textContent('#modal-title')).toBe('Link a Solana wallet');
    expect(await page.$$eval('.wopt', els => els.map(e => e.textContent))).toEqual(['Test Solana WalletSolana']);
    await page.click('.wopt');
    await toastSays(page, 'Solana wallet linked');
    expect((await db.user.findUniqueOrThrow({ where: { id: user.id } })).solAddress).toBe(SOL);

    await page.click('.acct-btn');
    expect(await page.textContent('.acct-menu .acct-rows')).toContain(short(SOL));
    await page.click('.acct-menu button:has-text("Sign out")');
    await toastSays(page, 'Signed out');
    await page.waitForSelector('.top-r .btn-primary:has-text("Connect wallet")');
    await until(() => page.textContent('#credBtn'), t => t === '5/5', 'free credits again');
    expect((await page.request.get(`${WEB_URL}/`).then(r => r.text())).includes('acct-btn')).toBe(false);
  });

  it('signs in with a Solana wallet (Sign-In With Solana)', async () => {
    const page = await newPage();
    await go(page, '/');
    await signIn(page, 'Test Solana Wallet');
    expect(await page.textContent('.acct-btn')).toBe(short(SOL));
    expect(await db.user.count({ where: { solAddress: SOL } })).toBe(1);
  });

  it('a declined signature says so and leaves the visitor signed out', async () => {
    const page = await newPage();
    await go(page, '/');
    await page.evaluate(() => {
      (window as unknown as { __acWallets: { rejectNext: boolean } }).__acWallets.rejectNext = true;
    });
    await page.click('.top-r .btn-primary:has-text("Connect wallet")');
    await page.click('.wopt:has-text("Test EVM Wallet")');
    await toastSays(page, 'Signature request was declined');
    expect(await page.$('.acct-btn')).toBeNull();
    // the modal stays open to try again
    expect(await page.isVisible('.wopt:has-text("Test EVM Wallet")')).toBe(true);
    expect(await db.user.count()).toBe(0);
  });

  it('a browser without a wallet says so', async () => {
    const page = await newPage({ wallets: false });
    await go(page, '/');
    await page.click('.top-r .btn-primary:has-text("Connect wallet")');
    await page.waitForSelector('.wallet-none');
    expect(await page.textContent('.wallet-none')).toContain('No wallet found in this browser.');
  });

  it('the access modal: Connect wallet opens the wallet picker; signed in, the tier is marked', async () => {
    const page = await newPage();
    await go(page, '/');
    await page.click('#credBtn');
    const tiers = () => page.$$eval('.tier', els => els.map(e => ({ req: e.querySelector('.req')?.textContent, btn: e.querySelector('button')?.textContent })));
    expect(await tiers()).toEqual([
      { req: 'No wallet needed', btn: 'Keep using free' },
      { req: 'Opens at token launch', btn: 'Connect wallet' },
      { req: 'Opens at token launch', btn: 'Connect wallet' },
    ]);
    expect(await page.textContent('.tier.pro ul')).toContain('30 checks a day, ahead of the queue');
    expect(await page.textContent('.pay-note')).toBe('Pro and Max open at token launch.');
    await page.click('.tier.pro button');
    await page.click('.wopt:has-text("Test EVM Wallet")');
    await page.waitForSelector('.acct-btn');
    await page.click('#credBtn');
    expect(await tiers()).toEqual([
      { req: 'No wallet needed', btn: 'Included' },
      { req: 'Opens at token launch', btn: 'Your tier' },
      { req: 'Opens at token launch', btn: 'At token launch' },
    ]);
    expect(await page.getAttribute('.tier.pro button', 'aria-pressed')).toBe('true');
    expect(await page.textContent('.modal-h p')).toBe('30 of 30 checks left today. Checks reset at 00:00 UTC.');
  });

  it('?x=linked is announced once and removed from the address bar', async () => {
    const page = await newPage();
    await page.goto(`${WEB_URL}/?x=linked`);
    await toastSays(page, 'Your X account is linked');
    await until(() => page.url(), u => u === `${WEB_URL}/`, 'clean URL');
  });
});

describe('watchlist', () => {
  it("moves this browser's list to the account on sign-in, then watches on the server", async () => {
    const page = await newPage();
    await go(page, '/c/site002');
    await ready(page, '.rh-act button');
    await page.click('.rh-act button:has-text("Watch")');
    await toastSays(page, 'Watching in this browser. Connect a wallet to keep it on your account; re-check alerts come with Pro.');
    expect(await page.evaluate(() => localStorage.getItem('apecheck-watch'))).toBe('["site002"]');

    await signIn(page);
    const user = await db.user.findUniqueOrThrow({ where: { evmAddress: PRO.toLowerCase() } });
    const t2 = await targetOf('site002');
    await until(() => db.watch.findMany({ where: { userId: user.id }, select: { targetId: true } }), w => w.length === 1 && w[0].targetId === t2, 'migrated watch');
    await until(() => page.evaluate(() => localStorage.getItem('apecheck-watch')), v => v === null, 'browser list cleared');
    expect(await page.getAttribute('.rh-act button:has-text("Watching")', 'aria-pressed')).toBe('true');

    await go(page, '/c/site003');
    await page.click('.rh-act button:has-text("Watch")');
    // Pro gets an alert when it changes (only Max watchlists are re-checked on their own)
    await toastSays(page, "Watching. You'll get an alert when the site or contract changes.");
    const t3 = await targetOf('site003');
    await until(() => db.watch.count({ where: { userId: user.id, targetId: t3 } }), n => n === 1, 'server watch');

    // first paint knows: the server render forwards the session cookie (CheckReportDTO.watching)
    const html = await (await page.request.get(`${WEB_URL}/c/site003`)).text();
    expect(html).toMatch(/aria-pressed="true"[^>]*>Watching</);

    // the feed's Watchlist tab is the account's list (GET /v1/watchlist)
    await go(page, '/');
    await ready(page, '#ftabs [role="tab"]');
    await page.click('#ftabs [role="tab"]:has-text("Watchlist")');
    const rows = await until(
      () => page.$$eval('#rows a.tr', els => els.map(a => a.getAttribute('href'))),
      r => r.length === 2,
      'watchlist rows',
    );
    expect(new Set(rows)).toEqual(new Set(['/c/site002', '/c/site003']));
    expect(await page.textContent('#ftabs [role="tab"]:has-text("Watchlist") small')).toBe('2');
    // the filters still apply
    await page.fill('#fq', 'nebula');
    await until(() => page.$$eval('#rows a.tr', els => els.map(a => a.getAttribute('href'))), r => r.length === 1 && r[0] === '/c/site003', 'filtered watchlist');

    await go(page, '/c/site003');
    await page.click('.rh-act button:has-text("Watching")');
    await toastSays(page, 'Removed from your watchlist');
    await until(() => db.watch.count({ where: { userId: user.id, targetId: t3 } }), n => n === 0, 'unwatched');
  });
});

describe('asks and notes', () => {
  it('a Pro viewer asks a follow-up and gets the answer from the worker; others see the API message', async () => {
    const anon = await newPage({ wallets: false });
    await go(anon, '/c/site001');
    await anon.click('#rt-asks');
    await anon.fill('.ask input', 'Is the app live?');
    await anon.click('.ask button[type="submit"]');
    await anon.waitForSelector('.ask-msg');
    expect(await anon.textContent('.ask-msg')).toBe('Follow-ups need Pro. Pro and Max open at token launch.');

    const page = await newPage();
    await go(page, '/c/site001');
    await signIn(page);
    await page.click('#rt-asks');
    await page.fill('.ask input', 'Is the app live?');
    await page.click('.ask button[type="submit"]');
    // the question shows at once with the plain pending line
    await page.waitForSelector('.qa li[aria-busy="true"] .ask-thinking');
    expect(await page.textContent('.qa li[aria-busy="true"] .ask-thinking')).toBe('Thinking…');
    await page.waitForSelector('.qa li:not([aria-busy]) .a p', { timeout: 50_000 });
    const answer = await page.textContent('.qa li .a p');
    expect(answer?.length).toBeGreaterThan(10);
    expect(await page.textContent('.qa li .q p')).toBe('Is the app live?');
    expect(await page.textContent('#rt-asks small')).toBe('1');
    const ask = await db.ask.findFirstOrThrow({ where: { question: 'Is the app live?' }, include: { asker: true } });
    expect(ask.asker?.evmAddress).toBe(PRO.toLowerCase());
    expect(ask.answer).toBe(answer);
  });

  it('a holder posts a note (10–500 characters, with a counter) and marks another note helpful', async () => {
    const coin = await db.check.findUniqueOrThrow({ where: { shortId: 'coin001' } });
    const other = await db.user.create({ data: { evmAddress: '0x' + 'ab'.repeat(20), xHandle: 'solsleuth' } });
    await db.note.create({ data: { checkId: coin.id, authorId: other.id, text: 'Same site template as two rugs from last week.' } });

    const anon = await newPage({ wallets: false });
    await go(anon, '/c/coin001');
    await anon.click('#rt-notes');
    expect(await anon.$('.note-form')).toBeNull();
    await anon.click('#tp button:has-text("Add a note")');
    await toastSays(anon, 'Notes are open to $APECHECK holders. Connect a wallet to add one.');

    const page = await newPage();
    await go(page, '/c/coin001');
    await signIn(page);
    await page.click('#rt-notes');
    await page.waitForSelector('.note-form');
    await page.fill('#noteText', 'Too short');
    expect(await page.textContent('#noteCount')).toBe('9/500');
    expect(await page.isDisabled('.note-form button[type="submit"]')).toBe(true);
    const text = 'The deployer ran a Space yesterday and showed the app working end to end.';
    await page.fill('#noteText', text);
    expect(await page.textContent('#noteCount')).toBe(`${text.length}/500`);
    await page.click('.note-form button[type="submit"]');
    await toastSays(page, 'Note added');
    await until(() => page.$$eval('.notes li p', els => els.map(e => e.textContent)), t => t.includes(text), 'note in the list');
    expect(await page.inputValue('#noteText')).toBe('');
    const mine = await db.note.findFirstOrThrow({ where: { text }, include: { author: true } });
    expect(mine.author.evmAddress).toBe(PRO.toLowerCase());

    const theirs = page.locator('.notes li', { hasText: 'Same site template' }).locator('button');
    await theirs.click();
    await until(() => theirs.getAttribute('aria-pressed'), v => v === 'true', 'helpful pressed');
    expect(await theirs.textContent()).toBe('Helpful 1');
    await theirs.click();
    await until(() => theirs.getAttribute('aria-pressed'), v => v === 'false', 'helpful unpressed');
  });
});

describe('alerts, private checks, layout', () => {
  it('shows re-check alerts with an unread dot; opening one marks it read and opens the report', async () => {
    const page = await newPage();
    await go(page, '/');
    await signIn(page);
    const user = await db.user.findUniqueOrThrow({ where: { evmAddress: PRO.toLowerCase() } });
    const check = await db.check.findUniqueOrThrow({ where: { shortId: 'site001' } });
    await db.watch.create({ data: { userId: user.id, targetId: check.targetId } });
    const n = await db.notification.create({
      data: { userId: user.id, targetId: check.targetId, checkId: check.id, kind: 'changed', text: 'orbitswap.xyz changed since its last check' },
    });
    await page.reload();
    await page.waitForSelector('.acct-btn .acct-dot');
    expect(await page.getAttribute('.acct-btn', 'aria-label')).toContain('1 new alert');
    await ready(page, '.acct-btn');
    await page.click('.acct-btn');
    await page.waitForSelector('.acct-alerts button.unread');
    expect(await page.textContent('.acct-alerts button.unread')).toContain('orbitswap.xyz changed since its last check');
    await page.click('.acct-alerts button.unread');
    await page.waitForURL(`${WEB_URL}/c/site001`);
    await until(async () => (await db.notification.findUniqueOrThrow({ where: { id: n.id } })).readAt, v => v != null, 'read');
    await until(() => page.$('.acct-btn .acct-dot'), v => v === null, 'dot gone');
  });

  it('Max viewers get the Private toggle, which sends private: true', async () => {
    const pro = await newPage();
    await go(pro, '/');
    await signIn(pro);
    expect(await pro.$('#privToggle')).toBeNull();

    const page = await newPage({ evmKey: EVM_MAX_KEY });
    await go(page, '/');
    await signIn(page);
    expect(await page.textContent('.acct-btn')).toBe(`${short(MAX.toLowerCase())}Max`);
    await page.waitForSelector('#privToggle');
    await page.click('#privToggle');
    expect(await page.getAttribute('#privToggle', 'aria-pressed')).toBe('true');
    // look at what the form sends without starting a real check
    let body: unknown = null;
    await page.route('**/v1/checks', async route => {
      body = route.request().postDataJSON();
      await route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ code: 'queue_unavailable', error: 'Not in this test.' }) });
    });
    await page.fill('#target', 'example.org');
    await page.click('.btn-run');
    await toastSays(page, 'Not in this test.');
    expect(body).toEqual({ target: 'example.org', private: true });
  });

  it('the signed-in header fits from 1001 to 1240px, and the account menu fits a phone', async () => {
    const page = await newPage({ width: 1024, height: 768 });
    await go(page, '/');
    await signIn(page);
    for (const width of [1001, 1024, 1100, 1180, 1240, 1280]) {
      await page.setViewportSize({ width, height: 768 });
      const m = await page.evaluate(() => {
        const r = (s: string) => document.querySelector(s)!.getBoundingClientRect();
        return { cw: document.documentElement.clientWidth, right: r('.acct-btn').right, search: r('.hsearch').width };
      });
      expect(m.right, `account button at ${width}px`).toBeLessThanOrEqual(m.cw);
      expect(m.search, `search at ${width}px`).toBeGreaterThan(90);
    }
    // phones (the prototype's header itself needs ~350px): the round wallet button keeps the bar inside the page
    for (const width of [390, 375]) {
      await page.setViewportSize({ width, height: 800 });
      await page.click('.acct-btn');
      const m = await page.evaluate(() => {
        const menu = document.querySelector('.acct-menu')!.getBoundingClientRect();
        return {
          cw: document.documentElement.clientWidth,
          sw: document.documentElement.scrollWidth,
          btn: document.querySelector('.acct-btn')!.getBoundingClientRect().right,
          left: menu.left,
          right: menu.right,
        };
      });
      expect(m.btn, `account button at ${width}px`).toBeLessThanOrEqual(m.cw - 16);
      expect(m.left, `menu at ${width}px`).toBeGreaterThanOrEqual(0);
      expect(m.right, `menu at ${width}px`).toBeLessThanOrEqual(m.cw);
      expect(m.sw, `page width at ${width}px`).toBeLessThanOrEqual(m.cw);
      await page.keyboard.press('Escape');
    }
  });
});

/* ---------- review fixes ---------- */

const minutesAgo = (m: number) => new Date(Date.now() - m * 60_000);
type Wallets = { __acWallets: { hangNext: boolean; requests: string[]; release(): void } };

/** "A minute later": the rate limits go, the session (also in Redis) stays. */
function clearRateLimits() {
  const keys = execFileSync('redis-cli', ['-u', REDIS_URL, '--scan', '--pattern', 'rl:*'], { encoding: 'utf8' }).split('\n').filter(Boolean);
  if (keys.length) execFileSync('redis-cli', ['-u', REDIS_URL, 'DEL', ...keys], { stdio: 'pipe' });
}

/** A finished public site check (or a private one of `requesterId`), for tests that need more than the seed. */
async function siteCheck(shortId: string, o: { isPrivate?: boolean; requesterId?: string; ago?: number } = {}) {
  const domain = `${shortId}.example`;
  const t = await db.target.create({ data: { kind: 'SITE', domain, name: domain, key: `site:${domain}`, checkCount: 1 } });
  const ago = o.ago ?? 2000;
  await db.check.create({
    data: {
      shortId, targetId: t.id, targetRaw: domain, status: 'DONE', via: 'WEB', isLatest: true, isPrivate: !!o.isPrivate, requesterId: o.requesterId ?? null,
      narScore: 55, totalScore: 55, narBand: 'partly', summary: `What the agent found on ${domain}.`,
      createdAt: minutesAgo(ago + 2), startedAt: minutesAgo(ago + 2), finishedAt: minutesAgo(ago), durationMs: 90_000,
    },
  });
  return t.id;
}
async function dropChecks(prefix: string) {
  const targets = await db.target.findMany({ where: { checks: { some: { shortId: { startsWith: prefix } } } }, select: { id: true } });
  const ids = targets.map(t => t.id);
  await db.watch.deleteMany({ where: { targetId: { in: ids } } });
  await db.notification.deleteMany({ where: { targetId: { in: ids } } });
  await db.check.deleteMany({ where: { targetId: { in: ids } } });
  await db.target.deleteMany({ where: { id: { in: ids } } });
}

describe('review fixes: watchlist', () => {
  it('a browser list longer than the watch limit moves in passes and carries on where it stopped (no endless 429s)', async () => {
    const ids = Array.from({ length: 80 }, (_, i) => `bulk${String(i).padStart(3, '0')}`);
    try {
      for (const [i, id] of ids.entries()) await siteCheck(id, { ago: 3000 + i });
      const page = await newPage();
      const posts: number[] = [];
      page.on('response', r => {
        if (r.request().method() === 'POST' && /\/v1\/watch\//.test(r.url())) posts.push(r.status());
      });
      await go(page, '/');
      await page.evaluate(list => localStorage.setItem('apecheck-watch', JSON.stringify(list)), ids);
      await signIn(page);
      const user = await db.user.findUniqueOrThrow({ where: { evmAddress: PRO.toLowerCase() } });
      const onAccount = () => db.watch.count({ where: { userId: user.id } });
      const inBrowser = () => page.evaluate(() => (JSON.parse(localStorage.getItem('apecheck-watch') || '[]') as string[]).length);

      // first visit: one pass of 40, which leave the browser; the rest wait (the visitor's own clicks keep room)
      await until(onAccount, n => n === 40, 'first pass');
      await until(inBrowser, n => n === 40, 'moved ids left the browser');
      expect(posts.filter(s => s === 429)).toEqual([]);

      // the next page load within the same minute: POST /v1/watch allows 60 a minute, so this pass stops at the first
      // 429 after 20 more, and keeps what it moved
      await go(page, '/');
      await until(onAccount, n => n === 60, 'second pass');
      await until(inBrowser, n => n === 20, 'second pass kept its progress');
      expect(posts.filter(s => s === 429).length).toBe(1);

      // a minute later the last 20 move, without sending the first 60 again
      clearRateLimits();
      await go(page, '/');
      await until(onAccount, n => n === 80, 'third pass');
      await until(() => page.evaluate(() => localStorage.getItem('apecheck-watch')), v => v === null, 'browser list empty');
      expect(posts.filter(s => s === 200).length).toBe(80);
    } finally {
      await dropChecks('bulk');
    }
  });
});

describe('review fixes: wallet sign-in', () => {
  it("a wallet that never answers doesn't hold the wallet modal, and its late answer signs nobody in or closes anything", async () => {
    const page = await newPage();
    await go(page, '/');
    await page.evaluate(() => {
      (window as unknown as Wallets).__acWallets.hangNext = true;
    });
    await page.click('.top-r .btn-primary:has-text("Connect wallet")');
    await page.click('.wopt:has-text("Test EVM Wallet")');
    await page.waitForSelector('.wopt:has-text("Check your wallet")');
    // closed with Escape, then opened again: nothing is pending, every wallet can be picked
    await page.keyboard.press('Escape');
    await page.click('.top-r .btn-primary:has-text("Connect wallet")');
    await page.waitForSelector('.wopt');
    expect(await page.$$eval('.wopt', els => els.map(e => [e.textContent, (e as HTMLButtonElement).disabled]))).toEqual([
      ['Test EVM WalletEVM', false],
      ['Test Solana WalletSolana', false],
    ]);
    // the wallet answers late, while the access modal is open: it stays open, nobody is signed in
    await page.keyboard.press('Escape');
    await page.click('#credBtn');
    await page.waitForSelector('.tier');
    await page.evaluate(() => (window as unknown as Wallets).__acWallets.release());
    await page.waitForTimeout(1500);
    expect(await page.isVisible('.tier')).toBe(true);
    expect(await page.$('.acct-btn')).toBeNull();
    expect(await page.evaluate(() => (window as unknown as Wallets).__acWallets.requests)).not.toContain('personal_sign');
    expect(await db.user.count()).toBe(0);
    // signing in works as usual afterwards
    await page.keyboard.press('Escape');
    await signIn(page);
  });

  it('picking the waiting wallet again starts over', async () => {
    const page = await newPage();
    await go(page, '/');
    await page.evaluate(() => {
      (window as unknown as Wallets).__acWallets.hangNext = true;
    });
    await page.click('.top-r .btn-primary:has-text("Connect wallet")');
    await page.click('.wopt:has-text("Test EVM Wallet")');
    await page.waitForSelector('.wopt:has-text("Check your wallet")');
    await page.click('.wopt:has-text("Test EVM Wallet")');
    await page.waitForSelector('.acct-btn', { timeout: 20_000 });
    await toastSays(page, `Signed in as ${short(PRO.toLowerCase())}`);
    // the first, unanswered request is dropped even if the wallet answers it now
    await page.evaluate(() => (window as unknown as Wallets).__acWallets.release());
    await page.waitForTimeout(500);
    expect((await page.evaluate(() => (window as unknown as Wallets).__acWallets.requests)).filter(r => r === 'personal_sign').length).toBe(1);
  });

  it("sign-out never shows the paid tier's credits on the signed-out header", async () => {
    const page = await newPage();
    await go(page, '/');
    await signIn(page);
    expect(await page.textContent('#credBtn')).toBe('30/30');
    // a slow /v1/me after sign-out
    await page.route('**/v1/me', async route => {
      await new Promise(r => setTimeout(r, 1000));
      await route.continue();
    });
    await page.evaluate(() => {
      const seen: [string, string][] = [];
      (window as unknown as { __cred: typeof seen }).__cred = seen;
      const look = () => seen.push([document.querySelector('.acct-btn') ? 'in' : 'out', document.querySelector('#credBtn')?.textContent ?? '']);
      new MutationObserver(look).observe(document.querySelector('.top-r')!, { subtree: true, childList: true, characterData: true });
    });
    await page.click('.acct-btn');
    await page.click('.acct-menu button:has-text("Sign out")');
    await page.waitForSelector('.top-r .btn-primary:has-text("Connect wallet")');
    await until(() => page.textContent('#credBtn'), t => t === '5/5', 'free credits from /v1/me');
    const seen = await page.evaluate(() => (window as unknown as { __cred: [string, string][] }).__cred);
    const signedOut = seen.filter(([who]) => who === 'out').map(([, c]) => c);
    expect(signedOut).not.toContain('30/30');
    expect(signedOut).toContain('–/–');
  });
});

describe('review fixes: report', () => {
  it('two Helpful votes in flight together both stick', async () => {
    const coin = await db.check.findUniqueOrThrow({ where: { shortId: 'coin002' } });
    const a = await db.user.create({ data: { evmAddress: '0x' + 'cd'.repeat(20), xHandle: 'alpha' } });
    const b = await db.user.create({ data: { evmAddress: '0x' + 'ef'.repeat(20), xHandle: 'beta' } });
    await db.note.create({ data: { checkId: coin.id, authorId: a.id, text: 'Note A: the team showed the app in a Space.' } });
    await db.note.create({ data: { checkId: coin.id, authorId: b.id, text: 'Note B: same template as a rug last month.' } });
    const page = await newPage();
    await go(page, '/c/coin002');
    await signIn(page);
    await page.click('#rt-notes');
    await page.waitForSelector('.notes li');
    await page.route('**/v1/notes/*/helpful', async route => {
      await new Promise(r => setTimeout(r, 600));
      await route.continue();
    });
    const btnA = page.locator('.notes li', { hasText: 'Note A' }).locator('button');
    const btnB = page.locator('.notes li', { hasText: 'Note B' }).locator('button');
    await btnA.click();
    await btnB.click();
    await until(() => db.noteVote.count(), n => n === 2, 'both votes saved');
    await until(async () => [await btnA.getAttribute('aria-pressed'), await btnB.getAttribute('aria-pressed')], v => v[0] === 'true' && v[1] === 'true', 'both pressed');
    expect([await btnA.textContent(), await btnB.textContent()]).toEqual(['Helpful 1', 'Helpful 1']);
  });

  it('a question waiting for its answer, and a note draft, survive a look at another tab', async () => {
    const page = await newPage();
    await go(page, '/c/coin003');
    await signIn(page);
    let release!: () => void;
    const gate = new Promise<void>(r => (release = r));
    await page.route('**/v1/checks/*/asks', async route => {
      await gate;
      await route.continue();
    });
    await page.click('#rt-asks');
    await page.fill('.ask input', 'Is the liquidity locked?');
    await page.press('.ask input', 'Enter');
    await page.waitForSelector('.qa li[aria-busy="true"] .ask-thinking');
    await page.click('#rt-claims');
    await page.click('#rt-notes');
    await page.fill('#noteText', 'A draft that should still be here.');
    await page.click('#rt-claims');
    await page.click('#rt-asks');
    // still waiting: the pending row and the read-only box, so a second question can't start
    expect(await page.isVisible('.qa li[aria-busy="true"] .ask-thinking')).toBe(true);
    expect(await page.getAttribute('.ask input', 'readonly')).not.toBeNull();
    await page.click('#rt-notes');
    expect(await page.inputValue('#noteText')).toBe('A draft that should still be here.');
    release();
    await page.click('#rt-asks');
    await page.waitForSelector('.qa li:not([aria-busy]) .a p', { timeout: 50_000 });
    expect(await page.textContent('.qa li .q p')).toBe('Is the liquidity locked?');
    // a wallet-only asker: the short wallet in mono (as the pending row said), and no "0" avatar
    expect(await page.textContent('.qa li .q .meta b .mono')).toBe(short(PRO.toLowerCase()));
    expect(await page.$('.qa li .q .mini-av svg')).not.toBeNull();
  });

  it('keyboard focus lands on the next control after sign-in, asking, posting a note, linking a wallet and sign-out', async () => {
    const page = await newPage();
    await go(page, '/c/coin004');
    const active = () => page.evaluate(() => {
      const el = document.activeElement as HTMLElement | null;
      return el ? `${el.tagName}.${el.className}|${el.getAttribute('aria-label') ?? el.id ?? ''}|${(el.textContent ?? '').trim().slice(0, 30)}` : 'none';
    });
    await page.focus('.top-r .btn-primary:has-text("Connect wallet")');
    await page.keyboard.press('Enter');
    await page.waitForSelector('.wopt');
    await page.focus('.wopt:has-text("Test EVM Wallet")');
    await page.keyboard.press('Enter');
    await page.waitForSelector('.acct-btn');
    await until(active, a => a.includes('acct-btn'), 'focus on the account button after sign-in');

    // the account menu is a dialog popover; opening it moves focus inside
    expect(await page.getAttribute('.acct-btn', 'aria-haspopup')).toBe('dialog');
    await page.keyboard.press('Enter');
    await until(() => page.evaluate(() => !!document.activeElement?.closest('.acct-menu')), v => v, 'focus in the menu');
    await page.focus('.acct-menu button:has-text("Link a Solana wallet")');
    await page.keyboard.press('Enter');
    await page.waitForSelector('.wopt');
    await page.focus('.wopt:has-text("Test Solana Wallet")');
    await page.keyboard.press('Enter');
    await toastSays(page, 'Solana wallet linked');
    await until(active, a => a.includes('acct-btn'), 'focus on the account button after linking');

    await page.click('#rt-asks');
    await page.fill('.ask input', 'Who deployed it?');
    await page.press('.ask input', 'Enter');
    await page.waitForSelector('.qa li:not([aria-busy]) .a p', { timeout: 50_000 });
    await until(active, a => a.includes('Ask a follow-up'), 'focus stays in the ask box');

    await page.click('#rt-notes');
    await page.fill('#noteText', 'The team ran a Space and showed the contract source.');
    await page.focus('.note-form button[type="submit"]');
    await page.keyboard.press('Enter');
    await toastSays(page, 'Note added');
    await until(active, a => a.startsWith('TEXTAREA'), 'focus back in the note field');
    // the counter is read with the field, not announced on every keystroke
    expect(await page.getAttribute('#noteCount', 'aria-live')).toBeNull();

    await page.focus('.acct-btn');
    await page.keyboard.press('Enter');
    await page.focus('.acct-menu button:has-text("Sign out")');
    await page.keyboard.press('Enter');
    await toastSays(page, 'Signed out');
    await until(active, a => a.includes('Connect wallet'), 'focus on Connect wallet after sign-out');
  });

  it("a private report is marked Private, and its share card can't be posted to X", async () => {
    const page = await newPage({ evmKey: EVM_MAX_KEY });
    await go(page, '/');
    await signIn(page);
    const owner = await db.user.findUniqueOrThrow({ where: { evmAddress: MAX.toLowerCase() } });
    try {
      await siteCheck('privx01', { isPrivate: true, requesterId: owner.id });
      await go(page, '/c/privx01');
      await page.waitForSelector('.rh-meta');
      expect(await page.textContent('.rh-meta .lock')).toBe('Private');
      expect(await page.getAttribute('.rh-meta .lock', 'title')).toBe('Only you can see this check');
      await page.click('.rh-act button:has-text("Share card")');
      await page.waitForSelector('.modal-actions');
      expect(await page.$$eval('.modal-actions button', els => els.map(e => e.textContent))).toEqual(['Close', 'Download image']);
      // a public report keeps Post to X and has no marker
      await go(page, '/c/site001');
      expect(await page.$('.rh-meta .lock')).toBeNull();
      await page.click('.rh-act button:has-text("Share card")');
      await page.waitForSelector('.modal-actions');
      expect(await page.$$eval('.modal-actions button', els => els.map(e => e.textContent))).toContain('Post to X');
    } finally {
      await dropChecks('privx');
    }
  });
});

describe('review fixes: header and account menu', () => {
  it('the account menu scrolls on a short window, so alerts and Sign out stay reachable', async () => {
    for (const [width, height] of [[844, 390], [375, 500]] as const) {
      await cleanAccounts();
      flushRedis();
      const page = await newPage({ width, height });
      await go(page, '/');
      await signIn(page);
      const user = await db.user.findUniqueOrThrow({ where: { evmAddress: PRO.toLowerCase() } });
      const check = await db.check.findUniqueOrThrow({ where: { shortId: 'site001' } });
      for (let i = 0; i < 6; i++) {
        await db.notification.create({ data: { userId: user.id, targetId: check.targetId, checkId: check.id, kind: 'changed', text: `orbitswap.xyz changed since its last check (${i + 1})` } });
      }
      await page.click('.acct-btn');
      await page.waitForSelector('.acct-alerts li');
      const m = await page.evaluate(() => {
        const menu = document.querySelector('.acct-menu')!;
        const out = [...menu.querySelectorAll('button')].find(b => b.textContent === 'Sign out')!;
        return { vh: window.innerHeight, menu: menu.getBoundingClientRect().bottom, signOut: out.getBoundingClientRect().bottom, scrolls: menu.scrollHeight > menu.clientHeight };
      });
      expect(m.scrolls, `menu scrolls at ${width}x${height}`).toBe(true);
      expect(m.menu, `menu inside the window at ${width}x${height}`).toBeLessThanOrEqual(m.vh);
      expect(m.signOut, `Sign out inside the window at ${width}x${height}`).toBeLessThanOrEqual(m.vh);
      await page.click('.acct-menu button:has-text("Sign out")');
      await toastSays(page, 'Signed out');
    }
  });

  it('with the token live, the header price waits for room so the search stays usable (signed in as Max)', async () => {
    const page = await newPage({ evmKey: EVM_MAX_KEY, width: 1440, height: 800 });
    // the token is live in this browser's /v1/me (the suite runs before launch)
    await page.route('**/v1/me', async route => {
      const res = await route.fetch();
      await route.fulfill({ response: res, json: { ...(await res.json()), tokenLive: true, token: { usd: 0.00412, ch24: 6.1 } } });
    });
    await go(page, '/');
    await signIn(page);
    await go(page, '/');
    await page.waitForSelector('.tok');
    for (const width of [1241, 1280, 1340, 1366, 1440]) {
      await page.setViewportSize({ width, height: 800 });
      const m = await page.evaluate(() => {
        const r = (s: string) => document.querySelector(s)!.getBoundingClientRect();
        const tok = document.querySelector('.tok');
        return { cw: document.documentElement.clientWidth, right: r('.acct-btn').right, input: r('.hsearch input').width, tok: !!tok && getComputedStyle(tok).display !== 'none' };
      });
      expect(m.right, `account button at ${width}px`).toBeLessThanOrEqual(m.cw);
      expect(m.input, `search input at ${width}px`).toBeGreaterThanOrEqual(100);
      expect(m.tok, `price at ${width}px`).toBe(width > 1340);
    }
  });

  it('a page left open picks up new re-check alerts (and the price) without a reload', async () => {
    const page = await newPage();
    await page.clock.install();
    await go(page, '/');
    await signIn(page);
    const user = await db.user.findUniqueOrThrow({ where: { evmAddress: PRO.toLowerCase() } });
    const check = await db.check.findUniqueOrThrow({ where: { shortId: 'site002' } });
    await db.notification.create({ data: { userId: user.id, targetId: check.targetId, checkId: check.id, kind: 'changed', text: 'kairo.app changed since its last check' } });
    expect(await page.$('.acct-btn .acct-dot')).toBeNull();
    await page.clock.fastForward(75_000);
    await page.waitForSelector('.acct-btn .acct-dot', { timeout: 15_000 });
  });
});
