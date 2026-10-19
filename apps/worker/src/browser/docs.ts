/**
 * Docs depth (HANDOFF §4 Stage B.5, Stage D "Docs"): open the docs link in the guarded browser and follow
 * links inside the docs (same host; under the docs path when the docs live on the main site) up to
 * depth 2 / 15 pages. Counts pages, broken links and "last updated" hints.
 */
import type { Page } from 'playwright';
import type { BrowseSession } from './browser';
import { pageText, screenshot, settle } from './page';
import { netErrorText } from '../pipeline/text';
import { DOCS_HINT_RE, DOCS_TEXT_RE } from './keywords';

export interface DocsResult {
  url: string;
  /** the docs root answered with a page */
  reachable: boolean;
  status: number | null;
  error: string | null;
  pages: number;
  broken: number;
  depth: number;
  lastUpdated: Date | null;
  technical: boolean;
  pdf: boolean;
  timedOut: boolean;
  /** text of the first docs pages, for claim extraction */
  text: string;
  /** every link seen inside the docs (GitHub / audit links feed Stage D) */
  links: { href: string; text: string }[];
  shot: Buffer | null;
}

const ASSET_RE = /\.(png|jpe?g|gif|svg|webp|ico|css|js|json|xml|zip|gz|mp4|webm|mp3|woff2?|ttf)(\?|$)/i;
const TECH_RE = /\b(api|sdk|smart contracts?|contract address|architecture|install|npm|function|endpoint|integration|parameters?|tokenomics|protocol|oracle|rpc|abi|solidity|rust|typescript|cli)\b/gi;

/** Pick the docs link from the site's links: an explicit "Docs" label beats a docs-ish URL. */
export function findDocsLink(links: { href: string; text: string }[], siteHost: string | null): string | null {
  const score = (l: { href: string; text: string }): number => {
    let u: URL;
    try {
      u = new URL(l.href);
    } catch {
      return -1;
    }
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return -1;
    const text = l.text.trim();
    if (DOCS_TEXT_RE.test(text)) return 10;
    if (/^docs\./i.test(u.hostname) || /gitbook\.io$|readme\.io$|mintlify|notion\.site$/i.test(u.hostname)) return 8;
    if (/^\/(docs?|documentation|developers?|whitepaper|litepaper)(\/|$|\.)/i.test(u.pathname)) return 7;
    if (DOCS_HINT_RE.test(text) && text.length <= 30) return 5;
    if (siteHost && u.hostname.replace(/^www\./, '') === siteHost && /\b(docs?|whitepaper)\b/i.test(u.pathname)) return 4;
    return -1;
  };
  let best: { href: string; s: number } | null = null;
  for (const l of links) {
    const s = score(l);
    if (s > 0 && (!best || s > best.s)) best = { href: l.href, s };
  }
  return best?.href ?? null;
}

/** "Last updated 3 days ago", "Last edited on Oct 2, 2026", <time datetime>, meta modified → newest date ≤ now. */
export function parseLastUpdated(text: string, hints: (string | null)[], now = Date.now()): Date | null {
  const dates: number[] = [];
  const push = (t: number) => {
    if (Number.isFinite(t) && t <= now + 86_400_000 && t > Date.UTC(2009, 0, 1)) dates.push(Math.min(t, now));
  };
  for (const h of hints) if (h) push(Date.parse(h));
  const re = /last\s+(?:updated|edited|modified|changed)\s*(?:on|:)?\s*([^\n]{3,40})/gi;
  for (const m of text.matchAll(re)) {
    const s = m[1].trim();
    const rel = /^(\d+|an?|one)\s+(minute|hour|day|week|month|year)s?\s+ago/i.exec(s);
    if (rel) {
      const n = /^\d+$/.test(rel[1]) ? Number(rel[1]) : 1;
      const unit = { minute: 60_000, hour: 3_600_000, day: 86_400_000, week: 604_800_000, month: 2_629_800_000, year: 31_557_600_000 }[rel[2].toLowerCase() as 'day'];
      push(now - n * unit);
      continue;
    }
    if (/^(today|just now)/i.test(s)) { push(now); continue; }
    if (/^yesterday/i.test(s)) { push(now - 86_400_000); continue; }
    const abs = /([A-Z][a-z]{2,8}\.? \d{1,2},? \d{4}|\d{4}-\d{2}-\d{2}|\d{1,2} [A-Z][a-z]{2,8},? \d{4}|\d{1,2}\/\d{1,2}\/\d{4})/.exec(s);
    if (abs) push(Date.parse(abs[1].replace('.', '')));
  }
  return dates.length ? new Date(Math.max(...dates)) : null;
}

function inScope(u: URL, root: URL, siteHost: string | null): boolean {
  if (u.host !== root.host) return false;
  const onMainSite = !!siteHost && root.hostname.replace(/^www\./, '') === siteHost;
  if (!onMainSite) return true;
  const base = root.pathname.replace(/\/[^/]*\.[a-z0-9]+$/i, '').replace(/\/+$/, '');
  return !base || u.pathname === base || u.pathname.startsWith(base + '/');
}

export interface CrawlOptions {
  siteHost: string | null;
  deadline: number;
  signal: AbortSignal;
  maxPages?: number;
  maxDepth?: number;
}

export async function crawlDocs(session: BrowseSession, docsUrl: string, opts: CrawlOptions): Promise<DocsResult> {
  const maxPages = opts.maxPages ?? 15;
  const maxDepth = opts.maxDepth ?? 2;
  const res: DocsResult = {
    url: docsUrl, reachable: false, status: null, error: null, pages: 0, broken: 0, depth: 0, lastUpdated: null,
    technical: false, pdf: false, timedOut: false, text: '', links: [], shot: null,
  };
  let root: URL;
  try {
    root = new URL(docsUrl);
  } catch {
    res.error = 'invalid docs link';
    return res;
  }
  if (/\.pdf($|\?)/i.test(root.pathname)) {
    // a PDF would be a download in the browser (downloads are off): count it as a single document
    res.pdf = true;
    res.pages = 1;
    res.reachable = true;
    return res;
  }
  let page: Page | null = null;
  const seen = new Set<string>();
  const queue: { url: string; depth: number }[] = [{ url: root.href.replace(/#.*$/, ''), depth: 0 }];
  seen.add(queue[0].url);
  const techTerms = new Set<string>();
  let codeBlocks = 0;
  const hints: (string | null)[] = [];
  let allText = '';
  try {
    page = await session.newPage();
    while (queue.length && res.pages + res.broken < maxPages) {
      if (opts.signal.aborted) break;
      const left = opts.deadline - Date.now();
      if (left < 1500) {
        res.timedOut = true;
        break;
      }
      const { url, depth } = queue.shift()!;
      if (!(await session.allowed(url))) continue;
      let status: number | null = null;
      let error: string | null = null;
      try {
        const resp = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: Math.min(10_000, left - 500) });
        status = resp?.status() ?? null;
        await settle(page, Math.min(2500, Math.max(300, opts.deadline - Date.now() - 500)));
        status = session.docStatus.get(page) ?? status;
      } catch (e) {
        error = netErrorText(e);
      }
      const isRoot = depth === 0;
      if (isRoot) {
        res.status = status;
        res.error = error;
        res.shot = await screenshot(page);
      }
      if (error || status == null || status >= 400) {
        res.broken++;
        if (isRoot) break;
        continue;
      }
      if (isRoot) res.reachable = true;
      res.pages++;
      res.depth = Math.max(res.depth, depth);
      const t = await pageText(page);
      if (!t) continue;
      if (res.text.length < 4000) res.text += (res.text ? '\n' : '') + `${t.hero}\n${t.text}`.slice(0, 4000 - res.text.length);
      allText += '\n' + t.text.slice(0, 8000);
      hints.push(t.modified, ...t.times);
      codeBlocks += t.codeBlocks;
      for (const m of t.text.matchAll(TECH_RE)) techTerms.add(m[1].toLowerCase());
      for (const l of t.links) {
        if (res.links.length < 400) res.links.push(l);
        if (depth >= maxDepth) continue;
        let u: URL;
        try {
          u = new URL(l.href);
        } catch {
          continue;
        }
        if ((u.protocol !== 'http:' && u.protocol !== 'https:') || ASSET_RE.test(u.pathname) || !inScope(u, root, opts.siteHost)) continue;
        const key = u.href.replace(/#.*$/, '');
        if (seen.has(key)) continue;
        seen.add(key);
        queue.push({ url: key, depth: depth + 1 });
      }
    }
    if (queue.length && res.pages + res.broken < maxPages && !opts.signal.aborted && opts.deadline - Date.now() < 1500) res.timedOut = true;
  } finally {
    await page?.close().catch(() => undefined);
  }
  res.lastUpdated = parseLastUpdated(allText, hints);
  res.technical = codeBlocks > 0 || techTerms.size >= 3;
  return res;
}
