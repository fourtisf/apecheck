/**
 * M4 in Chromium, against `next start`, the real API and worker-prices' webhook consumer (see global-setup.ts):
 * - /api for a signed-in Max wallet (TIER_OVERRIDES): create an API key (shown once, then only its prefix), call the API
 *   with it, revoke it; add a webhook to a local receiver (SSRF_ALLOW_HOSTS) whose secret is shown once, send a test
 *   ping, see it delivered and check its ApeCheck-Signature;
 * - /api for everyone else: the Max line under the code (with Connect wallet when signed out), no key or webhook lists;
 * - the code tabs' real shapes (REST report fields, the signature header, the MCP server and its tools);
 * - the Coin tab's wallet clusters for Pro, not for a signed-out reader;
 * - the page at 1440 and 390 px, light and dark (screenshots in the log folder, no sideways scroll).
 */
import { createHmac } from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import type { Browser, BrowserContext, Page } from 'playwright';
import { afterAll, beforeAll, beforeEach, describe, expect, inject, it } from 'vitest';
import { WEBHOOK_SIGNATURE_HEADER, type WebhookDeliveryDTO } from '@apecheck/core';
import { API_URL, HOOK_PORT, WEB_URL, flushRedis, openDb, playwright } from './env';
import { EVM_MAX_KEY, EVM_PRO_KEY, installFakeWallets, type FakeWalletOpts } from './wallets';

let browser: Browser;
let db: Awaited<ReturnType<typeof openDb>>;
const contexts: BrowserContext[] = [];

/** what the local webhook receiver got */
interface Received {
  path: string;
  headers: http.IncomingHttpHeaders;
  body: string;
}
const received: Received[] = [];
let receiver: http.Server;

const MAX_LINE = 'API keys, webhooks and MCP are part of Max.';
const CLUSTERS = [
  { label: 'Launch snipers', wallets: 14, pct: 12.4, fundedFrom: '0x9a1f00000000000000000000000000000000c0de' },
  { label: 'Team wallets', wallets: 3, pct: 6.25, fundedFrom: 'Binance hot wallet' },
];

async function cleanAccounts() {
  await db.notification.deleteMany({});
  await db.watch.deleteMany({});
  await db.user.deleteMany({}); // keys, webhooks and deliveries go with their user
}

beforeAll(async () => {
  browser = await playwright.chromium.launch({ headless: true });
  db = await openDb();
  await cleanAccounts();
  receiver = http.createServer((req, res) => {
    let body = '';
    req.setEncoding('utf8');
    req.on('data', c => (body += c));
    req.on('end', () => {
      received.push({ path: req.url ?? '', headers: req.headers, body });
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end('ok');
    });
  });
  await new Promise<void>(resolve => receiver.listen(HOOK_PORT, '127.0.0.1', resolve));
});
afterAll(async () => {
  for (const c of contexts) await c.close().catch(() => {});
  await browser?.close();
  await new Promise(resolve => receiver?.close(resolve));
  if (db) {
    // back to the seed's coin (no evidence at all)
    await db.$executeRaw`UPDATE "Check" SET evidence = NULL WHERE "shortId" = 'coin001'`.catch(() => {});
    await cleanAccounts();
    await db.$disconnect();
  }
});
beforeEach(async () => {
  flushRedis();
  await cleanAccounts();
  received.length = 0;
});

const logs = () => `server logs: ${inject('e2eLogDir')}`;

async function newPage(opts: FakeWalletOpts & { width?: number; height?: number; dark?: boolean } = {}): Promise<Page> {
  const ctx = await browser.newContext({ viewport: { width: opts.width ?? 1440, height: opts.height ?? 900 } });
  contexts.push(ctx);
  await ctx.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: WEB_URL });
  const page = await ctx.newPage();
  if (opts.dark) await page.addInitScript(() => localStorage.setItem('apecheck-theme', 'dark'));
  await installFakeWallets(page, opts);
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

async function go(page: Page, p: string) {
  await page.goto(WEB_URL + p);
  await ready(page, '.top-r > :last-child');
}

async function toastSays(page: Page, text: string) {
  await page.waitForFunction((t: string) => (document.querySelector('#toast.on')?.textContent ?? '').includes(t), text, { timeout: 15_000 }).catch(async () => {
    throw new Error(`toast never said "${text}"; last: "${await page.textContent('#toast')}" (${logs()})`);
  });
}

async function signIn(page: Page) {
  await page.click('.top-r .btn-primary:has-text("Connect wallet")');
  await page.click('.wopt:has-text("Test EVM Wallet")');
  await page.waitForSelector('.acct-btn', { timeout: 20_000 });
}

async function until<T>(fn: () => T | Promise<T>, ok: (v: T) => boolean, what: string, ms = 20_000): Promise<T> {
  const end = Date.now() + ms;
  let v: T = await fn();
  while (!ok(v) && Date.now() < end) {
    await new Promise(r => setTimeout(r, 150));
    v = await fn();
  }
  if (!ok(v)) throw new Error(`${what}: got ${JSON.stringify(v)} (${logs()})`);
  return v;
}

/** What sticks out past the right edge of the window (none: the page has no sideways scroll at this width). */
const sideScroll = (page: Page) =>
  page.evaluate(() => {
    if (document.documentElement.scrollWidth <= window.innerWidth) return [];
    return [...document.querySelectorAll('body *')]
      .filter(el => el.getBoundingClientRect().right > window.innerWidth + 1)
      .slice(0, 8)
      .map(el => `${el.tagName.toLowerCase()}.${[...el.classList].join('.')} ${Math.round(el.getBoundingClientRect().right)}px`);
  });

const callApi = (p: string, key: string) => fetch(API_URL + p, { headers: { Authorization: `Bearer ${key}` } });

describe('/api for viewers without Max', () => {
  it('signed out: the Max line with Connect wallet under the code, no key or webhook lists, the tiers', async () => {
    const page = await newPage();
    await go(page, '/api');
    const note = await page.textContent('.dev-g .dev-note');
    expect(note).toContain(MAX_LINE);
    expect(await page.$('.dev-g .dev-note .btn:has-text("Connect wallet")')).not.toBeNull();
    expect(await page.$('#keys')).toBeNull();
    expect(await page.$('#webhooks')).toBeNull();
    expect(await page.$$('.tiers .tier')).toHaveLength(3);
    // the line's Connect wallet opens the wallet picker
    await page.click('.dev-note .btn:has-text("Connect wallet")');
    await page.waitForSelector('.wopt');
  });

  it('Pro: the Max line without Connect wallet, no key or webhook lists', async () => {
    const page = await newPage({ evmKey: EVM_PRO_KEY });
    await go(page, '/api');
    await signIn(page);
    await page.waitForSelector('.dev-note');
    expect(await page.textContent('.dev-note')).toBe(MAX_LINE);
    expect(await page.$('#keys')).toBeNull();
    expect(await page.$('#webhooks')).toBeNull();
    // the server render knows the viewer too
    const html = await (await page.request.get(`${WEB_URL}/api`)).text();
    expect(html).toContain(MAX_LINE);
    expect(html).not.toContain('Your API keys');
  });

  it('the code tabs show the real shapes: report fields, the signature header, the MCP server and its tools', async () => {
    const page = await newPage();
    await go(page, '/api');
    const rest = await page.textContent('#code-rest');
    for (const k of ['"narrative"', '"coin"', '"total"', '"summary"', '"claims"', '"result"', '"report_url"', 'Content-Type: application/json']) expect(rest).toContain(k);
    await page.click('#code-tab-hook');
    const hook = await page.textContent('#code-hook');
    expect(hook).toContain(`${WEBHOOK_SIGNATURE_HEADER}: t=`);
    expect(hook).toContain(',v1=');
    expect(hook).not.toContain('"signature"');
    for (const k of ['"event"', '"check.completed"', '"created"', '"verdict"', '"report_url"']) expect(hook).toContain(k);
    await page.click('#code-tab-mcp');
    const mcp = await page.textContent('#code-mcp');
    expect(mcp).toContain('"apecheck"');
    expect(mcp).toContain('https://mcp.apecheck.io');
    for (const t of ['run_check(target)', 'get_check(id)', 'ask_followup(id, question)', 'deployer_history(wallet)']) expect(mcp).toContain(t);
  });
});

describe('/api for a Max wallet', () => {
  it('creates an API key shown once, then only its prefix; the key works until it is revoked', async () => {
    const page = await newPage({ evmKey: EVM_MAX_KEY });
    await go(page, '/api');
    await signIn(page);
    await page.waitForSelector('#keys .tbl-empty:has-text("No API keys yet")');
    expect(await page.$('.dev-note')).toBeNull();

    await page.fill('#keys .dev-field input', 'trading bot');
    await page.click('#keys .dev-field button:has-text("Create key")');
    await page.waitForSelector('#keys .dev-once');
    const key = await page.inputValue('#keys .dev-once input');
    expect(key).toMatch(/^ak_live_[A-Za-z0-9]{32}$/);
    expect(await page.textContent('#keys .dev-once')).toContain("It won't be shown again.");
    // the field has focus (a screen reader reads it) and Copy puts the key on the clipboard
    expect(await page.evaluate(() => (document.activeElement as HTMLInputElement | null)?.getAttribute('aria-label'))).toBe('New API key');
    await page.click('#keys .dev-once button:has-text("Copy")');
    await toastSays(page, 'Copied');
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(key);

    const row = await page.textContent('#keys .ktbl .tr:not(.th)');
    expect(row).toContain('trading bot');
    expect(row).toContain(`${key.slice(0, 12)}…`);
    expect(row).toContain('Never');
    const stored = await db.apiKey.findFirstOrThrow({ where: { name: 'trading bot' } });
    expect(stored.prefix).toBe(key.slice(0, 12));
    expect(stored.hash).not.toContain(key);

    // the key calls the API as its Max owner
    const res = await callApi('/v1/feed?limit=1', key);
    expect(res.status).toBe(200);

    // Done: the key is gone from the page for good; a reload shows only the prefix and when it was used
    await page.click('#keys .dev-once button:has-text("Done")');
    expect(await page.$('#keys .dev-once')).toBeNull();
    expect(await page.content()).not.toContain(key);
    await go(page, '/api');
    await page.waitForSelector('#keys .ktbl [data-key-id]');
    expect(await page.content()).not.toContain(key);
    const after = await page.textContent('#keys .ktbl [data-key-id]');
    expect(after).toContain(`${key.slice(0, 12)}…`);
    expect(after).toContain('just now'); // last used

    // Revoke asks once more, then the key stops working
    await page.click('#keys [data-key-id] button:has-text("Revoke")');
    expect(await page.evaluate(() => document.activeElement?.textContent)).toBe('Yes, revoke');
    await page.click('#keys [data-key-id] button:has-text("Yes, revoke")');
    await toastSays(page, 'Revoked trading bot');
    await page.waitForSelector('#keys .tbl-empty:has-text("No API keys yet")');
    expect((await db.apiKey.findUniqueOrThrow({ where: { id: stored.id } })).revokedAt).not.toBeNull();
    const gone = await callApi('/v1/feed?limit=1', key);
    expect(gone.status).toBe(401);
    expect(((await gone.json()) as { code: string }).code).toBe('invalid_key');
  });

  it('adds a webhook (secret shown once), sends a test ping, shows it delivered; the receiver can check the signature', async () => {
    const page = await newPage({ evmKey: EVM_MAX_KEY });
    await go(page, '/api');
    await signIn(page);
    await page.waitForSelector('#webhooks .tbl-empty:has-text("No webhooks yet")');

    // a URL that can't be one is answered in the page, before any request
    await page.fill('#webhooks .dev-field input', 'not a url');
    await page.click('#webhooks button:has-text("Add webhook")');
    expect(await page.textContent('#webhooks .dev-msg')).toBe('Enter the full URL of your endpoint, starting with https://.');
    // a private address is refused by the API (only 127.0.0.1:HOOK_PORT is let through in this suite)
    await page.fill('#webhooks .dev-field input', 'http://127.0.0.1:1/hook');
    await page.click('#webhooks button:has-text("Add webhook")');
    await page.waitForFunction(() => document.querySelector('#webhooks .dev-msg')?.textContent === 'Webhook URLs must point to a public server.');

    const url = `http://127.0.0.1:${HOOK_PORT}/apecheck`;
    await page.fill('#webhooks .dev-field input', url);
    await page.check('#webhooks .dev-ev:has-text("watch.changed") input');
    await page.click('#webhooks button:has-text("Add webhook")');
    await page.waitForSelector('#webhooks .dev-once');
    const secret = await page.inputValue('#webhooks .dev-once input');
    expect(secret).toMatch(/^whsec_[A-Za-z0-9]{32}$/);
    expect(await page.textContent('#webhooks .dev-once')).toContain(url);
    expect(await page.$('#webhooks .dev-msg')).toBeNull();

    const row = page.locator('#webhooks [data-hook-id]');
    expect(await row.locator('.dev-url').textContent()).toBe(url);
    expect(await row.locator('.nm2').textContent()).toBe('check.completed · watch.changed');
    expect(await row.locator('.c-sc .pill').textContent()).toBe('Active');
    expect(await row.locator('.c-col').textContent()).toBe('No deliveries yet');

    await page.click('#webhooks .dev-once button:has-text("Done")');
    expect(await page.content()).not.toContain(secret);

    // Send test: a ping is queued, the deliveries open and fill in once worker-prices delivered it
    await row.locator('button:has-text("Send test")').click();
    await toastSays(page, 'Test ping sent');
    // keyboard focus stays on the button while the request runs (never dropped to <body>)
    expect(await page.evaluate(() => document.activeElement?.textContent)).toBe('Send test');
    expect(await row.locator('button:has-text("Deliveries")').getAttribute('aria-expanded')).toBe('true');
    await page.waitForSelector('#webhooks .dlv li[data-delivery="ok"]', { timeout: 30_000 }).catch(async () => {
      throw new Error(`the ping was never delivered: ${await page.textContent('#webhooks .dev-more')} (${logs()})`);
    });
    const li = await page.textContent('#webhooks .dlv li[data-delivery="ok"]');
    expect(li).toContain('Delivered');
    expect(li).toContain('ping');
    expect(li).toContain('HTTP 200');
    expect(li).toContain('1 attempt');
    // the row's own status follows (last delivery, HTTP code)
    await until(() => row.locator('.c-col').textContent(), t => !!t?.startsWith('HTTP 200 · '), 'last delivery');

    // what arrived: the WebhookPayload, signed "t=…,v1=…" with the secret over `${t}.${body}`
    const got = await until(() => received.slice(), r => r.length === 1, 'deliveries received');
    expect(got[0].path).toBe('/apecheck');
    expect(got[0].headers['content-type']).toMatch(/^application\/json/);
    expect(got[0].headers['user-agent']).toBe('ApeCheck-Webhooks/1.0');
    const sig = String(got[0].headers[WEBHOOK_SIGNATURE_HEADER.toLowerCase()] ?? '');
    const m = /^t=(\d+),v1=([0-9a-f]{64})$/.exec(sig);
    expect(m, sig).not.toBeNull();
    expect(Math.abs(Date.now() / 1000 - Number(m![1]))).toBeLessThan(120);
    expect(createHmac('sha256', secret).update(`${m![1]}.${got[0].body}`).digest('hex')).toBe(m![2]);
    const payload = JSON.parse(got[0].body) as { id: string; event: string; created: string };
    expect(payload.event).toBe('ping');
    expect(typeof payload.id).toBe('string');
    expect(Number.isNaN(Date.parse(payload.created))).toBe(false);

    // a reload keeps the delivery and never shows the secret again
    await go(page, '/api');
    await page.waitForSelector('#webhooks [data-hook-id]');
    expect(await page.content()).not.toContain(secret);
    await page.click('#webhooks [data-hook-id] button:has-text("Deliveries")');
    await page.waitForSelector('#webhooks .dlv li[data-delivery="ok"]');

    // Delete asks once more
    await page.click('#webhooks [data-hook-id] button:has-text("Delete")');
    await page.click('#webhooks [data-hook-id] button:has-text("Yes, delete")');
    await toastSays(page, 'Webhook deleted');
    await page.waitForSelector('#webhooks .tbl-empty:has-text("No webhooks yet")');
    expect(await db.webhook.count()).toBe(0);
  });

  it('a webhook turned off after failed deliveries reads Disabled and comes back with Enable', async () => {
    const page = await newPage({ evmKey: EVM_MAX_KEY });
    await go(page, '/api');
    await signIn(page);
    await page.fill('#webhooks .dev-field input', `http://127.0.0.1:${HOOK_PORT}/off`);
    await page.click('#webhooks button:has-text("Add webhook")');
    await page.waitForSelector('#webhooks .dev-once');
    await page.click('#webhooks .dev-once button:has-text("Done")');
    // what worker-prices does after 20 failed deliveries in a row
    await db.webhook.updateMany({ data: { disabledAt: new Date(), failCount: 20, lastStatus: 500, lastDeliveryAt: new Date() } });
    await go(page, '/api');
    const row = page.locator('#webhooks [data-hook-id]');
    await row.waitFor();
    expect(await row.locator('.c-sc .pill').textContent()).toBe('Disabled');
    expect(await row.locator('.nm2').textContent()).toContain('Turned off after 20 failed deliveries in a row');
    expect(await row.locator('button:has-text("Send test")').count()).toBe(0);
    await row.locator('button:has-text("Enable")').click();
    await toastSays(page, 'Webhook enabled');
    await until(() => row.locator('.c-sc .pill').textContent(), t => t === 'Active', 'status after Enable');
    // the same button now sends a test, and it still has focus
    expect(await page.evaluate(() => document.activeElement?.textContent)).toBe('Send test');
    const hook = await db.webhook.findFirstOrThrow({});
    expect(hook.disabledAt).toBeNull();
    expect(hook.failCount).toBe(0);
  });

  it('Send test looks for a stuck ping less and less often, and stops at a 429', async () => {
    const page = await newPage({ evmKey: EVM_MAX_KEY });
    await go(page, '/api');
    await signIn(page);
    await page.fill('#webhooks .dev-field input', `http://127.0.0.1:${HOOK_PORT}/stuck`);
    await page.click('#webhooks button:has-text("Add webhook")');
    await page.waitForSelector('#webhooks .dev-once');
    await page.click('#webhooks .dev-once button:has-text("Done")');

    // the ping stays pending (worker-prices down or backlogged): every read of the deliveries says so, until the API
    // starts answering 429 (with the API's own CORS headers, so the page reads the 429 and not a network error)
    const reads: number[] = [];
    let limited = false;
    await page.route(`${API_URL}/v1/webhooks/*/deliveries`, async route => {
      const refuse = limited;
      reads.push(Date.now());
      const res = await route.fetch();
      if (refuse) return route.fulfill({ response: res, status: 429, json: { code: 'rate_limited', error: 'Too many requests. Wait a minute and try again.' } });
      const { items } = (await res.json()) as { items: WebhookDeliveryDTO[] };
      return route.fulfill({ response: res, json: { items: items.map(d => ({ ...d, status: 'pending', attempts: 0, responseCode: null, error: null, deliveredAt: null })) } });
    });

    const row = page.locator('#webhooks [data-hook-id]');
    const clicked = Date.now();
    await row.locator('button:has-text("Send test")').click();
    await toastSays(page, 'Test ping sent');
    // the deliveries open (one read), then the page looks again 1.5 s, 3 s and 6 s after the ping went out (not every 1.5 s)
    await until(() => reads.length, n => n >= 4, 'reads of the deliveries');
    expect(reads[1] - clicked).toBeGreaterThanOrEqual(1500);
    expect(reads[3] - clicked).toBeGreaterThanOrEqual(6000);
    expect(await page.$('#webhooks .dlv li[data-delivery="pending"]')).not.toBeNull();

    // the next look is refused: the panel says so and the page stops looking
    limited = true;
    const before = reads.length;
    await page
      .waitForFunction(() => /Too many requests/.test(document.querySelector('#webhooks .dev-more')?.textContent ?? ''), null, { timeout: 15_000 })
      .catch(async () => {
        throw new Error(`no 429 shown: ${await page.textContent('#webhooks .dev-more')} (${logs()})`);
      });
    expect(reads.length).toBe(before + 1);
    await page.waitForTimeout(7_000); // past the next look (6 s on)
    expect(reads.length).toBe(before + 1);
    await page.unroute(`${API_URL}/v1/webhooks/*/deliveries`);
  });

  it('Delete takes a webhook and its secret off the page, also when another tab deleted it first', async () => {
    const page = await newPage({ evmKey: EVM_MAX_KEY });
    await go(page, '/api');
    await signIn(page);
    const row = page.locator('#webhooks [data-hook-id]');

    // deleted straight after adding it: the secret shown for it goes too
    await page.fill('#webhooks .dev-field input', `http://127.0.0.1:${HOOK_PORT}/first`);
    await page.click('#webhooks button:has-text("Add webhook")');
    await page.waitForSelector('#webhooks .dev-once');
    await row.locator('button:has-text("Delete")').click();
    await row.locator('button:has-text("Yes, delete")').click();
    await toastSays(page, 'Webhook deleted');
    await page.waitForSelector('#webhooks .tbl-empty:has-text("No webhooks yet")');
    expect(await page.$('#webhooks .dev-once')).toBeNull();

    // deleted in another tab while this one still shows it (404): what was asked for is done, so the row goes
    await page.fill('#webhooks .dev-field input', `http://127.0.0.1:${HOOK_PORT}/second`);
    await page.click('#webhooks button:has-text("Add webhook")');
    await page.waitForSelector('#webhooks .dev-once');
    expect(await db.webhook.deleteMany({})).toEqual({ count: 1 });
    await row.locator('button:has-text("Delete")').click();
    await row.locator('button:has-text("Yes, delete")').click();
    await toastSays(page, 'Webhook deleted');
    await page.waitForSelector('#webhooks .tbl-empty:has-text("No webhooks yet")');
    expect(await page.$('#webhooks [data-hook-id]')).toBeNull();
    expect(await page.$('#webhooks .dev-once')).toBeNull();
  });

  it('signed out meanwhile: Revoke takes the page back to the Max line, the new key with it', async () => {
    const page = await newPage({ evmKey: EVM_MAX_KEY });
    await go(page, '/api');
    await signIn(page);
    await page.click('#keys .dev-field button:has-text("Create key")');
    await page.waitForSelector('#keys .dev-once');
    const key = await page.inputValue('#keys .dev-once input');
    // the session ends elsewhere (signed out in another tab, or expired): the API no longer knows it
    flushRedis();
    await page.click('#keys [data-key-id] button:has-text("Revoke")');
    await page.click('#keys [data-key-id] button:has-text("Yes, revoke")');
    await page.waitForSelector('.dev-note .btn:has-text("Connect wallet")', { timeout: 15_000 }).catch(async () => {
      throw new Error(`the page stayed signed in: ${await page.textContent('.dev-g')} (${logs()})`);
    });
    expect(await page.$('#keys')).toBeNull();
    expect(await page.$('#webhooks')).toBeNull();
    expect(await page.content()).not.toContain(key);
  });
});

describe('Coin tab: wallet clusters', () => {
  beforeAll(async () => {
    await db.check.update({ where: { shortId: 'coin001' }, data: { evidence: { clusters: CLUSTERS } } });
  });

  it('Pro sees the clusters in the facts style; a signed-out reader does not', async () => {
    const out = await newPage();
    await go(out, '/c/coin001');
    await out.click('.rtabs button:has-text("Coin")');
    await out.waitForSelector('.coin-g');
    expect(await out.$('.clusters')).toBeNull();

    const page = await newPage({ evmKey: EVM_PRO_KEY });
    await go(page, '/c/coin001');
    await signIn(page);
    await page.click('.rtabs button:has-text("Coin")');
    await page.waitForSelector('.clusters');
    expect(await page.textContent('.clusters .h4')).toBe('Wallet clusters Pro');
    const rows = await page.$$eval('.clusters .facts dt', els => els.map(e => e.textContent));
    expect(rows).toEqual(['Launch snipers', 'Team wallets']);
    const values = await page.$$eval('.clusters .facts dd:not(.src)', els => els.map(e => e.textContent));
    expect(values).toEqual(['12.4% of supply14 wallets, funded from 0x9a1…c0de', '6.3% of supply3 wallets, funded from Binance hot wallet']);
    expect(await page.$$eval('.clusters .facts dd.src', els => els.map(e => e.textContent))).toEqual(['On-chain', 'On-chain']);
    const dir = path.join(inject('e2eLogDir'), 'm4-shots');
    fs.mkdirSync(dir, { recursive: true });
    await page.locator('#tp').screenshot({ path: path.join(dir, 'coin-clusters-1440-light.png') });
  });
});

describe('/api at 1440, 900 and 390 px, light and dark', () => {
  for (const width of [1440, 900, 390]) {
    for (const dark of [false, true]) {
      it(`${width}px ${dark ? 'dark' : 'light'}: a Max viewer's keys and webhooks fit the page`, async () => {
        const page = await newPage({ evmKey: EVM_MAX_KEY, width, height: 900, dark });
        await go(page, '/api');
        await signIn(page);
        await page.fill('#keys .dev-field input', 'trading bot');
        await page.click('#keys .dev-field button:has-text("Create key")');
        await page.waitForSelector('#keys .dev-once');
        await page.fill('#webhooks .dev-field input', `http://127.0.0.1:${HOOK_PORT}/apecheck`);
        await page.click('#webhooks button:has-text("Add webhook")');
        await page.waitForSelector('#webhooks .dev-once');
        await page.click('#webhooks .dev-once button:has-text("Done")');
        await page.locator('#webhooks [data-hook-id] button:has-text("Send test")').click();
        await page.waitForSelector('#webhooks .dlv li[data-delivery="ok"]', { timeout: 30_000 });
        await page.waitForFunction(() => /HTTP 200/.test(document.querySelector('#webhooks [data-hook-id] .c-mob')?.textContent ?? ''));
        expect(await page.evaluate(() => document.documentElement.dataset.theme ?? 'light')).toBe(dark ? 'dark' : 'light');
        expect(await sideScroll(page)).toEqual([]);
        // nothing in the lists spills out of its table
        const spill = await page.$$eval('.dev-tbl', tbls => tbls.some(t => t.scrollWidth > t.clientWidth + 1));
        expect(spill).toBe(false);
        if (width > 1000) {
          // the header's columns line up with the rows'
          for (const tbl of ['.ktbl', '.htbl']) {
            const lefts = await page.$$eval(`${tbl} > .tr, ${tbl} > .hook > .tr`, rows =>
              rows.map(r => [...r.children].filter(c => getComputedStyle(c).display !== 'none').map(c => Math.round(c.getBoundingClientRect().left))),
            );
            for (const row of lefts.slice(1)) expect(row).toEqual(lefts[0]);
          }
        }

        const dir = path.join(inject('e2eLogDir'), 'm4-shots');
        fs.mkdirSync(dir, { recursive: true });
        // (the sticky header would be drawn in the middle of a full-page capture)
        await page.addStyleTag({ content: '.top{position:relative}' });
        await page.screenshot({ path: path.join(dir, `api-max-${width}-${dark ? 'dark' : 'light'}.png`), fullPage: true });

        const anon = await newPage({ width, height: 900, dark });
        await go(anon, '/api');
        expect(await sideScroll(anon)).toEqual([]);
        await anon.locator('.dev-g').screenshot({ path: path.join(dir, `api-anon-${width}-${dark ? 'dark' : 'light'}.png`) });
      });
    }
  }
});
