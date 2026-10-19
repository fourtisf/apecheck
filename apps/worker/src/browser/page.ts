/**
 * Typed wrappers around the in-page scripts, plus loading / settling helpers.
 *
 * The read scripts run in an isolated world of the page's main frame (CDP Page.createIsolatedWorld +
 * Runtime.evaluate): the page shares the DOM with them but can't redefine the builtins or DOM getters they
 * use, so their length caps hold and a hostile page can't push megabytes through the protocol. Every result
 * is clamped again here (types, lengths, list sizes, U+0000) before anything uses it.
 */
import type { CDPSession, Page } from 'playwright';
import type { DomElement, DomInput, DomSummary } from '../ai/types';
import { pgText } from '../pipeline/pgsafe';
import { netErrorText } from '../pipeline/text';
import type { BrowseSession } from './browser';
import { LOAD_MS_SCRIPT, PROBE_SCRIPT, SUMMARY_SCRIPT, TEXT_SCRIPT } from './page-scripts';

export interface PageText {
  title: string;
  hero: string;
  footer: string;
  text: string;
  links: { href: string; text: string }[];
  modified: string | null;
  times: (string | null)[];
  codeBlocks: number;
}

export interface Probe {
  url: string;
  title: string;
  text: string;
  textLen: number;
  modalText: string | null;
  added: number;
  removed: number;
  textEdits: number;
  emailInput: boolean;
  amountInput: boolean;
  connectButton: boolean;
  h1: string;
}

export const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));

/** A page script that doesn't answer within this is given up (a page can keep its main thread busy). */
export const READ_TIMEOUT_MS = 10_000;
const WORLD = '__apecheck_read';

const cdpSessions = new WeakMap<Page, Promise<CDPSession | null>>();

function cdpFor(page: Page): Promise<CDPSession | null> {
  let p = cdpSessions.get(page);
  if (!p) {
    p = page.context().newCDPSession(page).catch(() => null);
    cdpSessions.set(page, p);
  }
  return p;
}

function timeoutAfter<T>(p: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  p.catch(() => undefined);
  return Promise.race([
    p,
    new Promise<T>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`page script timed out after ${ms}ms`)), ms);
    }),
  ]).finally(() => clearTimeout(timer));
}

/**
 * Evaluate a read-only expression in the isolated world and return its JSON value (untrusted shape: clamp it).
 * Falls back to the main world only when no CDP session can be opened.
 */
export async function readPage(page: Page, expression: string, timeoutMs = READ_TIMEOUT_MS): Promise<unknown> {
  const cdp = await cdpFor(page);
  if (!cdp) return timeoutAfter(page.evaluate(expression), timeoutMs);
  let lastError: unknown = null;
  // a navigation can destroy the world between the two calls: one retry in the new document
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      return await timeoutAfter(
        (async () => {
          const { frameTree } = await cdp.send('Page.getFrameTree');
          const { executionContextId } = await cdp.send('Page.createIsolatedWorld', { frameId: frameTree.frame.id, worldName: WORLD });
          const r = await cdp.send('Runtime.evaluate', { expression, contextId: executionContextId, returnByValue: true, timeout: timeoutMs });
          if (r.exceptionDetails) throw new Error(`page script failed: ${(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text).slice(0, 200)}`);
          return r.result.value as unknown;
        })(),
        timeoutMs + 1000,
      );
    } catch (e) {
      lastError = e;
      if (/timed out|terminated/i.test(e instanceof Error ? e.message : String(e))) break;
    }
  }
  throw lastError;
}

/* ---------------- Node-side clamps ---------------- */

const str = (v: unknown, max: number): string => (typeof v === 'string' ? pgText(v.slice(0, max)) : '');
const strOrNull = (v: unknown, max: number): string | null => (typeof v === 'string' ? pgText(v.slice(0, max)) : null);
const num = (v: unknown, max = 1e9): number => (typeof v === 'number' && Number.isFinite(v) ? Math.max(0, Math.min(v, max)) : 0);
const bool = (v: unknown): boolean => v === true;
const list = (v: unknown, max: number): unknown[] => (Array.isArray(v) ? v.slice(0, max) : []);
const rec = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {});

export function clampSummary(v: unknown, fallbackUrl: string, maxEls = 80): DomSummary {
  const o = rec(v);
  const elements: DomElement[] = list(o.elements, maxEls)
    .map(rec)
    .map(e => ({
      id: Math.trunc(num(e.id, 1e6)),
      kind: e.kind === 'link' ? ('link' as const) : ('button' as const),
      text: str(e.text, 80),
      href: strOrNull(e.href, 500),
      disabled: bool(e.disabled),
      inViewport: bool(e.inViewport),
      inModal: bool(e.inModal),
    }))
    .filter(e => e.id > 0 && e.text);
  const inputs: DomInput[] = list(o.inputs, 20)
    .map(rec)
    .map(i => ({ id: Math.trunc(num(i.id, 1e6)), type: str(i.type, 30), label: str(i.label, 60) }))
    .filter(i => i.id > 0);
  return {
    url: str(o.url, 2000) || fallbackUrl,
    title: str(o.title, 160),
    headings: list(o.headings, 10).map(h => str(h, 120)).filter(Boolean),
    elements,
    inputs,
    modalText: strOrNull(o.modalText, 1500) || null,
    textSample: str(o.textSample, 2000),
  };
}

export function clampProbe(v: unknown, fallbackUrl: string): Probe {
  const o = rec(v);
  return {
    url: str(o.url, 2000) || fallbackUrl,
    title: str(o.title, 160),
    text: str(o.text, 30_000),
    textLen: num(o.textLen),
    modalText: strOrNull(o.modalText, 1500) || null,
    added: num(o.added),
    removed: num(o.removed),
    textEdits: num(o.textEdits),
    emailInput: bool(o.emailInput),
    amountInput: bool(o.amountInput),
    connectButton: bool(o.connectButton),
    h1: str(o.h1, 120),
  };
}

export function clampPageText(v: unknown): PageText | null {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = rec(v);
  return {
    title: str(o.title, 160),
    hero: str(o.hero, 6000),
    footer: str(o.footer, 3000),
    text: str(o.text, 20_000),
    links: list(o.links, 500)
      .map(rec)
      .map(l => ({ href: str(l.href, 500), text: str(l.text, 80) }))
      .filter(l => l.href),
    modified: strOrNull(o.modified, 100),
    times: list(o.times, 20).map(t => strOrNull(t, 100)),
    codeBlocks: Math.trunc(num(o.codeBlocks, 1e6)),
  };
}

const emptyProbe = (url: string): Probe => ({
  url, title: '', text: '', textLen: 0, modalText: null, added: 0, removed: 0, textEdits: 0, emailInput: false, amountInput: false, connectButton: false, h1: '',
});

export async function screenshot(page: Page): Promise<Buffer | null> {
  try {
    return await page.screenshot({ type: 'jpeg', quality: 70, fullPage: false, timeout: 8000, animations: 'disabled' });
  } catch {
    return null;
  }
}

export async function domSummary(page: Page, maxEls = 80): Promise<DomSummary> {
  try {
    return clampSummary(await readPage(page, `${SUMMARY_SCRIPT}(${JSON.stringify({ maxEls })})`), page.url(), maxEls);
  } catch {
    return { url: page.url(), title: '', headings: [], elements: [], inputs: [], modalText: null, textSample: '' };
  }
}

export async function probe(page: Page): Promise<Probe> {
  try {
    return clampProbe(await readPage(page, PROBE_SCRIPT), page.url());
  } catch {
    return emptyProbe(page.url());
  }
}

export async function pageText(page: Page): Promise<PageText | null> {
  try {
    return clampPageText(await readPage(page, TEXT_SCRIPT));
  } catch {
    return null;
  }
}

/* ---------------- bot walls ---------------- */

const WALL_TITLE_RE = /^\s*(just a moment\b|attention required!? \| cloudflare|access denied \| .{0,80} used cloudflare|ddos-guard\b|ddos protection by|vercel security checkpoint|checking your browser|please wait while we verify|one more step\b)/i;

/**
 * A bot challenge / anti-bot wall in front of the site (Cloudflare "Just a moment...", DDoS-Guard, Vercel
 * checkpoint, rate limiting): the reason, or null. A plain 403/503 behind Cloudflare without challenge markers
 * is not a wall (a real origin error must stay a failure).
 */
export function detectBotWall(status: number | null, headers: Record<string, string> | null | undefined, title: string | null | undefined): string | null {
  const h = headers ?? {};
  const t = (title ?? '').trim();
  if (h['cf-mitigated']) return 'Cloudflare bot challenge';
  if (/challenge/i.test(h['x-vercel-mitigated'] ?? '')) return 'Vercel bot challenge';
  if (status === 429) return 'rate limited';
  if (status != null && status >= 400 && WALL_TITLE_RE.test(t)) return 'bot challenge page';
  return null;
}

/** Wait for the network to go quiet, but never longer than `maxMs`. */
export async function settle(page: Page, maxMs: number, minMs = 0): Promise<void> {
  const started = Date.now();
  await page.waitForLoadState('networkidle', { timeout: Math.max(200, maxMs) }).catch(() => undefined);
  const left = minMs - (Date.now() - started);
  if (left > 0) await sleep(left);
}

export interface OpenResult {
  page: Page;
  loaded: boolean;
  status: number | null;
  loadMs: number | null;
  error: string | null;
  finalUrl: string | null;
  /** the site answered with a bot challenge instead of its page: we couldn't check it, the site isn't dead */
  botWall: string | null;
}

export const BOT_WALL_ERROR = 'the site blocks automated browsers';

/** Open the site in the session's first page and wait for network idle (max `timeoutMs`). */
export async function openSite(session: BrowseSession, url: string, timeoutMs: number): Promise<OpenResult> {
  const page = await session.newPage();
  const t0 = Date.now();
  const end = t0 + timeoutMs;
  let status: number | null = null;
  let error: string | null = null;
  try {
    const resp = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: timeoutMs });
    status = resp?.status() ?? null;
  } catch (e) {
    error = netErrorText(e);
    // the route guard refuses names it can't resolve; for the log that is a dead domain, not an attack
    const origin = (() => { try { return new URL(url).origin; } catch { return ''; } })();
    const refused = session.blocked.find(b => b.url.startsWith(origin));
    if (refused && /could not resolve/i.test(refused.reason)) error = 'the domain does not resolve';
  }
  if (!error) await settle(page, Math.max(1000, timeoutMs - (Date.now() - t0)));
  status = session.docStatus.get(page) ?? status;

  // a bot challenge is not a dead site: give a self-solving challenge a few seconds, then report it as such
  let botWall: string | null = null;
  if (!error && status != null && status >= 400) {
    const wall = async () => detectBotWall(session.docStatus.get(page) ?? status, session.docHeaders.get(page), await pageTitle(page));
    botWall = await wall();
    const waitUntil = Math.min(end, Date.now() + 8000);
    while (botWall && Date.now() < waitUntil) {
      await sleep(1000);
      status = session.docStatus.get(page) ?? status;
      if (status != null && status < 400) {
        botWall = null;
        await settle(page, Math.max(500, Math.min(5000, end - Date.now())));
        break;
      }
      botWall = await wall();
    }
  }

  let loadMs: number | null = null;
  if (!error) {
    loadMs = await readPage(page, LOAD_MS_SCRIPT, 3000).then(v => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? Math.min(Math.round(v), 600_000) : 0)).catch(() => 0);
    if (!loadMs) loadMs = Date.now() - t0;
  }
  const loaded = !error && status != null && status < 400;
  if (!loaded && !error && botWall) error = BOT_WALL_ERROR;
  if (!loaded && !error && status != null) error = `HTTP ${status}`;
  return { page, loaded, status, loadMs, error, finalUrl: error ? null : page.url(), botWall: loaded ? null : botWall };
}

async function pageTitle(page: Page): Promise<string> {
  const v = await readPage(page, 'String(document.title || "").slice(0, 200)', 3000).catch(() => '');
  return typeof v === 'string' ? v : '';
}
