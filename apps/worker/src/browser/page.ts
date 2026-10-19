/** Typed wrappers around the in-page scripts, plus loading / settling helpers. */
import type { Page } from 'playwright';
import type { DomSummary } from '../ai/types';
import { netErrorText } from '../pipeline/text';
import type { BrowseSession } from './browser';
import { PROBE_SCRIPT, SUMMARY_SCRIPT, TEXT_SCRIPT } from './page-scripts';

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

export async function screenshot(page: Page): Promise<Buffer | null> {
  try {
    return await page.screenshot({ type: 'jpeg', quality: 70, fullPage: false, timeout: 8000, animations: 'disabled' });
  } catch {
    return null;
  }
}

export async function domSummary(page: Page, maxEls = 80): Promise<DomSummary> {
  try {
    return (await page.evaluate(`${SUMMARY_SCRIPT}(${JSON.stringify({ maxEls })})`)) as DomSummary;
  } catch {
    return { url: page.url(), title: '', headings: [], elements: [], inputs: [], modalText: null, textSample: '' };
  }
}

export async function probe(page: Page): Promise<Probe> {
  try {
    return (await page.evaluate(PROBE_SCRIPT)) as Probe;
  } catch {
    return { url: page.url(), title: '', text: '', textLen: 0, modalText: null, added: 0, removed: 0, textEdits: 0, emailInput: false, amountInput: false, connectButton: false, h1: '' };
  }
}

export async function pageText(page: Page): Promise<PageText | null> {
  try {
    return (await page.evaluate(TEXT_SCRIPT)) as PageText;
  } catch {
    return null;
  }
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
}

/** Open the site in the session's first page and wait for network idle (max `timeoutMs`). */
export async function openSite(session: BrowseSession, url: string, timeoutMs: number): Promise<OpenResult> {
  const page = await session.newPage();
  const t0 = Date.now();
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
  let loadMs: number | null = null;
  if (!error) {
    loadMs = (await page
      .evaluate(`(() => { const n = performance.getEntriesByType('navigation')[0]; return n ? Math.round(n.loadEventEnd || n.domContentLoadedEventEnd || 0) : 0; })()`)
      .catch(() => 0)) as number;
    if (!loadMs) loadMs = Date.now() - t0;
  }
  const loaded = !error && status != null && status < 400;
  if (!loaded && !error && status != null) error = `HTTP ${status}`;
  return { page, loaded, status, loadMs, error, finalUrl: error ? null : page.url() };
}
