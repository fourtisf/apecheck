/**
 * What a visitor sees in Chromium, against `next start` and the real API (see global-setup.ts):
 * - the feed keeps its tab, layout and filters after a report and Back, and through the nav pills;
 * - /coins and /deployers keep their URL filters on Back (and don't rewrite the URL to the defaults);
 * - a dark-theme visitor stays dark on an unknown /c/<id> (Next's client-rendered 404 shell) and after it;
 * - a check that stopped before a verdict opens on the Agent run, and its tabs don't claim conclusions;
 * - /bot shows a site check only as a captioned illustration, and a real thread only for a posted bot reply;
 * - the header fits from 1001 to 1240px, and the segmented controls fit a phone;
 * - every page gives X a link-preview image: a finished report its verdict card, any other page the site's preview.
 */
import type { Browser, Page } from 'playwright';
import { afterAll, beforeAll, beforeEach, describe, expect, inject, it } from 'vitest';
import { COINS, DEPLOYERS, POST_CHECK, BOT_CHECK, FAILED_CHECK, SITES, clearBotReply, seedBotReply } from './seed';
import { WEB_URL, flushRedis, openDb, playwright } from './env';

let browser: Browser;
let db: Awaited<ReturnType<typeof openDb>>;

beforeAll(async () => {
  browser = await playwright.chromium.launch({ headless: true });
  db = await openDb();
});
afterAll(async () => {
  await browser?.close();
  await db?.$disconnect();
});
// every request comes from 127.0.0.1: start each test with fresh rate limits and credits
beforeEach(() => flushRedis());

const logs = () => `server logs: ${inject('e2eLogDir')}`;

async function open(path: string, width = 1440, height = 900): Promise<Page> {
  const page = await browser.newPage({ viewport: { width, height } });
  await page.goto(WEB_URL + path);
  return page;
}

/** Wait until React has hydrated (or rendered) the element, so a click reaches its handler. */
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

/** Wait for a condition in the page; fails with what it last saw. */
async function until<T>(page: Page, fn: () => T | Promise<T>, ok: (v: T) => boolean, what: string, ms = 15_000): Promise<T> {
  const end = Date.now() + ms;
  let v: T = await fn();
  while (!ok(v) && Date.now() < end) {
    await page.waitForTimeout(100);
    v = await fn();
  }
  if (!ok(v)) throw new Error(`${what}: got ${JSON.stringify(v)} (${logs()})`);
  return v;
}

const pathOf = (page: Page) => page.url().slice(WEB_URL.length);

describe('feed list state', () => {
  const feedState = (page: Page) =>
    page.evaluate(() => ({
      grid: document.querySelector('button[aria-label="Grid view"]')?.getAttribute('aria-pressed'),
      type: document.querySelector('#fType button[aria-pressed="true"]')?.textContent,
      tab: document.querySelector('#ftabs [role="tab"][aria-selected="true"]')?.textContent,
      cards: [...document.querySelectorAll('#rows .gview a.gc')].map(a => a.getAttribute('href')),
    }));
  const expected = { grid: 'true', type: 'Sites', tab: 'Most real', cards: ['/c/site003', '/c/site001', '/c/site002'] };

  it('keeps tab, layout and filters after opening a verdict and pressing Back, and through the nav pills', async () => {
    const page = await open('/');
    await ready(page, '#ftabs [role="tab"]');
    await page.click('button[aria-label="Grid view"]');
    await page.click('#fType button:has-text("Sites")');
    await page.click('#ftabs [role="tab"]:has-text("Most real")');
    await until(page, () => feedState(page), s => JSON.stringify(s) === JSON.stringify(expected), 'filtered grid');

    await page.click('#rows .gview a.gc >> nth=0');
    await page.waitForURL(`${WEB_URL}/c/site003`);
    await page.goBack();
    await page.waitForURL(`${WEB_URL}/`);
    // the same list straight away (the saved rows), and still after the quiet refresh
    expect(await until(page, () => feedState(page), s => s.cards.length > 0, 'list after Back')).toEqual(expected);
    await page.waitForTimeout(800);
    expect(await feedState(page)).toEqual(expected);

    await page.click('.nav a:has-text("Coins")');
    await page.waitForURL(`${WEB_URL}/coins`);
    await page.click('.nav a:has-text("Feed")');
    await page.waitForURL(`${WEB_URL}/`);
    expect(await until(page, () => feedState(page), s => s.cards.length > 0, 'list after the Feed pill')).toEqual(expected);
    await page.close();
  });

  it('a full reload starts from the defaults (nothing is persisted beyond the visit)', async () => {
    const page = await open('/');
    await ready(page, '#ftabs [role="tab"]');
    await page.click('button[aria-label="Grid view"]');
    await page.reload();
    await ready(page, '#ftabs [role="tab"]');
    expect(await page.getAttribute('button[aria-label="List view"]', 'aria-pressed')).toBe('true');
    await page.close();
  });
});

describe('URL filters on Back', () => {
  it('/coins keeps ?tab=&chain= and the filtered rows', async () => {
    const sketchySol = COINS.filter(c => c.chain === 'SOL' && c.coin >= 35 && c.coin < 60)
      .sort((a, b) => b.coin - a.coin)
      .map(c => `/c/${c.id}`);
    const state = (page: Page) =>
      page.evaluate(() => ({
        tab: document.querySelector('#cTab button[aria-pressed="true"]')?.textContent,
        chain: (document.querySelector('#cChain') as HTMLSelectElement | null)?.value,
        rows: [...document.querySelectorAll('#cRows a.tr')].map(a => a.getAttribute('href')),
      }));
    const want = { tab: 'Sketchy', chain: 'sol', rows: sketchySol };

    const page = await open('/coins');
    await ready(page, '#cTab button');
    await page.click('#cTab button:has-text("Sketchy")');
    await page.selectOption('#cChain', 'sol');
    await page.waitForURL(`${WEB_URL}/coins?tab=sketchy&chain=sol`);
    await until(page, () => state(page), s => JSON.stringify(s) === JSON.stringify(want), 'filtered coins');

    await page.click('#cRows a.tr >> nth=0');
    await page.waitForURL(`${WEB_URL}${sketchySol[0]}`);
    await page.goBack();
    await page.waitForURL(`${WEB_URL}/coins?tab=sketchy&chain=sol`);
    await until(page, () => state(page), s => JSON.stringify(s) === JSON.stringify(want), 'coins after Back');
    // and the address bar is not rewritten to the unfiltered path afterwards
    await page.waitForTimeout(600);
    expect(pathOf(page)).toBe('/coins?tab=sketchy&chain=sol');
    await page.close();
  });

  it('/deployers keeps ?chain=&sort= and the filtered rows', async () => {
    const baseByDead = DEPLOYERS.filter(d => d.chain === 'BASE')
      .sort((a, b) => b.dead - a.dead)
      .map(d => `dep-base-${d.address}`);
    const state = (page: Page) =>
      page.evaluate(() => ({
        chain: document.querySelector('#dChain button[aria-pressed="true"]')?.textContent,
        sort: (document.querySelector('#dSort') as HTMLSelectElement | null)?.value,
        rows: [...document.querySelectorAll('#dRows .dep')].map(d => d.id),
      }));
    const want = { chain: 'Base', sort: 'dead', rows: baseByDead };

    const page = await open('/deployers');
    await ready(page, '#dChain button');
    await page.click('#dChain button:has-text("Base")');
    await page.selectOption('#dSort', 'dead');
    await page.waitForURL(`${WEB_URL}/deployers?chain=base&sort=dead`);
    await until(page, () => state(page), s => JSON.stringify(s) === JSON.stringify(want), 'filtered deployers');

    await page.click('.nav a:has-text("X bot")');
    await page.waitForURL(`${WEB_URL}/bot`);
    await page.goBack();
    await page.waitForURL(`${WEB_URL}/deployers?chain=base&sort=dead`);
    await until(page, () => state(page), s => JSON.stringify(s) === JSON.stringify(want), 'deployers after Back');
    await page.waitForTimeout(600);
    expect(pathOf(page)).toBe('/deployers?chain=base&sort=dead');
    await page.close();
  });
});

describe('theme', () => {
  it('a dark-theme visitor stays dark on an unknown report id and after leaving it', async () => {
    const page = await open('/api');
    await page.evaluate(() => localStorage.setItem('apecheck-theme', 'dark'));
    const res = await page.goto(`${WEB_URL}/c/doesnotexist`);
    expect(res?.status()).toBe(404);
    await ready(page, '#themeBtn');
    await until(page, () => page.getAttribute('html', 'data-theme'), t => t === 'dark', 'theme on the 404');
    expect(await page.getAttribute('#themeBtn', 'aria-label')).toBe('Switch to light mode');
    expect(await page.textContent('#app')).toContain("This check doesn't exist or has expired.");

    await page.click('text=Back to the feed');
    await page.waitForURL(`${WEB_URL}/`);
    await ready(page, '#ftabs [role="tab"]');
    expect(await page.getAttribute('html', 'data-theme')).toBe('dark');
    await page.close();
  });
});

describe('a check that stopped before a verdict', () => {
  it('opens on the Agent run, and Claims, Coin and the price card say the run stopped', async () => {
    const page = await open(`/c/${FAILED_CHECK.id}`);
    await ready(page, '#rt-run');
    expect(await page.getAttribute('#rt-run', 'aria-selected')).toBe('true');
    expect(await page.textContent('#tp')).toContain('The browser crashed');

    await page.click('#rt-claims');
    await until(page, () => page.textContent('#tp'), t => !!t?.includes('The check stopped before claims were tested.'), 'claims tab');
    expect(await page.textContent('#tp')).not.toContain('found no concrete claims');
    await page.click('#rt-coin');
    await until(page, () => page.textContent('#tp'), t => !!t?.includes('The check stopped before the coin was looked at'), 'coin tab');

    const side = (await page.textContent('.rep-side')) ?? '';
    expect(side).toContain('The check stopped before a verdict, so there is no price to track.');
    expect(side).not.toContain('No coin is linked');
    await page.close();
  });
});

describe('/bot example thread', () => {
  afterAll(async () => {
    await clearBotReply(db);
  });

  it('a check that ran on the site is a captioned illustration, never a reply on X', async () => {
    const page = await open('/bot');
    const thread = (await page.textContent('.thread')) ?? '';
    expect(await page.textContent('.thread-cap')).toContain('Example: how the bot would answer this post');
    expect(thread).toContain(POST_CHECK.text);
    expect(thread).toContain('You');
    expect(thread).not.toContain('Automated account');
    await page.close();
  });

  it('a bot reply that was posted is shown as the thread it was', async () => {
    await seedBotReply(db, true);
    const page = await open('/bot');
    expect(await page.locator('.thread-cap').count()).toBe(0);
    const thread = (await page.textContent('.thread')) ?? '';
    expect(thread).toContain(BOT_CHECK.mentionText);
    expect(thread).toContain(`@${BOT_CHECK.mentionBy}`);
    expect(thread).toContain('Automated account');
    expect(thread).not.toContain('real or larp?');
    // the seeded mention replies to the post the check read, so that post sits above it
    expect(thread).toContain(POST_CHECK.text);
    await page.close();

    // a quote tweet of the post replies to nothing: the thread never draws it as a reply under the post
    await db.botMention.update({ where: { tweetId: '9001' }, data: { inReplyToId: null } });
    const quoted = await open('/bot');
    const qthread = (await quoted.textContent('.thread')) ?? '';
    expect(qthread).toContain(BOT_CHECK.mentionText);
    expect(qthread).not.toContain(POST_CHECK.text);
    await quoted.close();
  });
});

describe('layout', () => {
  it('the header fits between 1001 and 1240px: "Connect wallet" is not clipped and the search stays usable', async () => {
    const page = await open('/', 1024, 768);
    await ready(page, '#themeBtn');
    for (const width of [1001, 1024, 1060, 1100, 1133, 1180, 1240, 1280]) {
      await page.setViewportSize({ width, height: 768 });
      const m = await page.evaluate(() => {
        const r = (s: string) => document.querySelector(s)!.getBoundingClientRect();
        return { cw: document.documentElement.clientWidth, wallet: r('.top-r .btn-primary').right, search: r('.hsearch').width, input: r('#hq').width };
      });
      expect(m.wallet, `wallet button at ${width}px`).toBeLessThanOrEqual(m.cw);
      expect(m.search, `search at ${width}px`).toBeGreaterThan(90);
      expect(m.input, `search input at ${width}px`).toBeGreaterThan(40);
    }
    await page.close();
  });

  it('segmented controls scroll inside a phone-width page instead of overflowing it', async () => {
    for (const [path, seg] of [['/deployers', '#dChain'], ['/coins', '#cTab']] as const) {
      for (const width of [390, 320]) {
        const page = await open(path, width, 800);
        await ready(page, `${seg} button`);
        const m = await page.evaluate((sel: string) => {
          const el = document.querySelector(sel) as HTMLElement;
          return { cw: document.documentElement.clientWidth, right: el.getBoundingClientRect().right, overflowX: getComputedStyle(el).overflowX };
        }, seg);
        expect(m.right, `${seg} at ${width}px`).toBeLessThanOrEqual(m.cw);
        expect(m.overflowX).toBe('auto');
        // the last option is still reachable
        await page.click(`${seg} button >> nth=-1`);
        expect(await page.getAttribute(`${seg} button >> nth=-1`, 'aria-pressed')).toBe('true');
        await page.close();
      }
    }
  });
});

describe('link previews', () => {
  /** The og:image and twitter:image of a page, as paths (metadataBase names the public host). */
  async function previewImages(path: string) {
    const html = await (await fetch(WEB_URL + path)).text();
    const meta = (attr: string, key: string) => html.match(new RegExp(`<meta ${attr}="${key}" content="([^"]+)"`))?.[1];
    const pathOf = (url?: string) => (url ? new URL(url).pathname : null);
    return { og: pathOf(meta('property', 'og:image')), twitter: pathOf(meta('name', 'twitter:image')) };
  }

  it("a finished report shows its verdict card; every other page, a report without a verdict included, the site's preview", async () => {
    for (const path of ['/', '/coins', '/bot', `/c/${FAILED_CHECK.id}`]) {
      expect(await previewImages(path), path).toEqual({ og: '/og.png', twitter: '/og.png' });
    }
    const card = `/card/${SITES[0].id}.png`;
    expect(await previewImages(`/c/${SITES[0].id}`)).toEqual({ og: card, twitter: card });

    const img = await fetch(WEB_URL + '/og.png');
    expect(img.status).toBe(200);
    expect(img.headers.get('content-type')).toBe('image/png');
  });
});
