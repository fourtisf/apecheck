/**
 * Bounded exploration (HANDOFF §4 Stage B.3–B.5). The AI adapter picks one of four actions per turn
 * (click / scroll / open_link / done); this module executes it in the guarded browser, works out what
 * happened (navigation, popup, wallet request, captured transaction, waitlist / coming-soon / error screen,
 * dead button, JS error) and logs one step with a screenshot per action.
 */
import type { Page } from 'playwright';
import { CHAINS, type ChainKey } from '@apecheck/core';
import type { AiAdapter, AiCallCtx, BrowserAction, DomElement, DomSummary, ExploreFlags } from '../ai/types';
import type { StepSink, StepInput } from '../pipeline/steps';
import { netErrorText, quote, shortUrl } from '../pipeline/text';
import type { BrowseSession } from './browser';
import {
  AVOID_RE,
  COMING_SOON_RE,
  CONNECT_RE,
  ERROR_SCREEN_RE,
  MAIN_ACTION_RE,
  NEEDS_FUNDS_RE,
  NOT_FOUND_RE,
  WAITLIST_RE,
  WALLET_CHOICE_RE,
  isAppUrl,
  launchRank,
  textSignature,
} from './keywords';
import type { CapturedTx } from './mock-wallet';
import { domSummary, probe, screenshot, settle, sleep } from './page';
import { FILL_AMOUNT_SCRIPT } from './page-scripts';

export type ActionRole = 'entry' | 'connect' | 'wallet' | 'main' | 'other';
export type Outcome =
  | 'app' | 'navigated' | 'wallet' | 'tx' | 'waitlist' | 'coming_soon' | 'error' | 'js_error' | 'not_found'
  | 'needs_funds' | 'modal' | 'changed' | 'dead' | 'missing' | 'blocked' | 'scrolled';

export interface ActionRecord {
  tool: BrowserAction['tool'];
  label: string;
  role: ActionRole;
  outcome: Outcome;
  status: StepInput['status'];
  text: string;
  stepIdx: number;
  url: string | null;
}

export interface SimOutcome {
  status: 'ok' | 'fail' | 'skipped';
  detail: string | null;
  needsFunds: boolean;
  chain: ChainKey | null;
}

/**
 * Why a captured transaction couldn't be simulated, in plain words for the log (the raw transport error,
 * e.g. "getaddrinfo ENOTFOUND …", stays in Check.evidence). It is our RPC that failed, not the project.
 */
export function simSkipReason(sim: Pick<SimOutcome, 'detail' | 'chain'>): string {
  const d = sim.detail ?? '';
  if (/^(no transaction payload|transaction could not be serialised|not simulated in time)$/.test(d)) return d;
  const unsupported = /^unsupported chain(?: (0x[0-9a-f]+))?/i.exec(d);
  if (unsupported) {
    const id = unsupported[1] ? Number.parseInt(unsupported[1], 16) : NaN;
    return Number.isFinite(id) ? `it targets a chain ApeCheck can't simulate (chain id ${id})` : "it targets a chain ApeCheck can't simulate";
  }
  if (/timed out|timeout/i.test(d)) return sim.chain ? `our ${CHAINS[sim.chain].name} RPC timed out` : 'the RPC timed out';
  return sim.chain ? `our ${CHAINS[sim.chain].name} RPC didn't answer` : 'no RPC';
}

export interface ExploreDeps {
  session: BrowseSession;
  ai: AiAdapter;
  aiCtx?: AiCallCtx;
  steps: StepSink;
  siteUrl: string;
  maxActions: number;
  /** epoch ms; exploration stops before this */
  deadline: number;
  signal: AbortSignal;
  /** simulate a captured transaction; `maxMs` is what is left of the stage for it */
  simulate(tx: CapturedTx, maxMs: number): Promise<SimOutcome>;
  onAction?(done: number): void;
}

export interface TxResult {
  reached: boolean;
  kind: 'evm' | 'sol';
  simulated: 'ok' | 'fail' | 'skipped';
  detail: string | null;
  needsFunds: boolean;
  chain: ChainKey | null;
  stepIdx: number;
}

export interface ExploreResult {
  actions: ActionRecord[];
  /** the landing page shows an app entry (Launch app / Trade / Connect wallet…) */
  entryFound: boolean;
  appReached: boolean;
  /**
   * How the app was reached: 'page' = an app screen was seen (app route or link, an amount field, a
   * transaction); 'wallet' = only a wallet connect on a page that otherwise shows no app. A wallet connect
   * alone doesn't outweigh an app entry that leads to a waitlist, 'Coming soon', a 404 or nothing.
   */
  appVia: 'page' | 'wallet' | null;
  appUrl: string | null;
  appStepIdx: number | null;
  /** `main`: on the main action inside the app, not on the way into it */
  waitlist: { stepIdx: number; text: string; main: boolean } | null;
  comingSoon: { stepIdx: number; text: string; main: boolean } | null;
  errorScreen: { stepIdx: number; text: string; main: boolean } | null;
  jsError: { stepIdx: number; text: string } | null;
  deadLaunch: { stepIdx: number; text: string } | null;
  launch404: { stepIdx: number; text: string } | null;
  deadButtons: string[];
  mainTried: boolean;
  /** the main action asked the wallet to sign (a transaction is `tx`) */
  mainOk: { stepIdx: number; text: string } | null;
  /** the main action only opened a dialog / changed the page / asked to connect: the flow wasn't completed */
  mainPartial: { stepIdx: number; text: string; kind: 'modal' | 'changed' | 'navigated' | 'connect' } | null;
  needsFunds: { stepIdx: number; text: string } | null;
  tx: TxResult | null;
  doneReason: string | null;
  /** key screenshots for the judge (first app screen, last action) */
  keyShots: Buffer[];
}

const normUrl = (u: string) => u.replace(/#$/, '').replace(/\/+$/, '');

/** Text that appeared after an action (lines not present before). */
export function newLines(before: string, after: string): string {
  const seen = new Set(before.split('\n').map(l => l.trim()).filter(Boolean));
  return after
    .split('\n')
    .map(l => l.trim())
    .filter(l => l && !seen.has(l))
    .join('\n')
    .slice(0, 4000);
}

/** Find the element the model meant: "#4", exact text, then the closest partial match. */
export function resolveElement(summary: DomSummary, text: string): DomElement | null {
  const t = text.trim();
  const ref = /^\[?#?(\d{1,3})\]?$/.exec(t);
  if (ref) {
    const hit = summary.elements.find(e => e.id === Number(ref[1]));
    if (hit) return hit;
  }
  const lc = t.toLowerCase().replace(/^['"]|['"]$/g, '');
  const usable = summary.elements;
  const exact = usable.filter(e => e.text.toLowerCase() === lc);
  if (exact.length) return exact.find(e => !e.disabled && e.inViewport) ?? exact.find(e => !e.disabled) ?? exact[0];
  const partial = usable
    .filter(e => e.text && (e.text.toLowerCase().includes(lc) || (lc.includes(e.text.toLowerCase()) && e.text.length >= 3)))
    .sort((a, b) => Number(a.disabled) - Number(b.disabled) || a.text.length - b.text.length);
  return partial[0] ?? null;
}

function roleOf(el: DomElement, flags: ExploreFlags, siteHost: string | null, modalOpen: boolean): ActionRole {
  const text = el.text.trim();
  if (modalOpen && el.inModal && WALLET_CHOICE_RE.test(text) && !flags.walletConnected) return 'wallet';
  if (CONNECT_RE.test(text)) return flags.appReached ? 'connect' : 'entry';
  if (!flags.appReached && (launchRank(text) >= 0 || (el.href && isAppUrl(el.href, siteHost)))) return 'entry';
  if ((flags.appReached || flags.walletConnected) && MAIN_ACTION_RE.test(text)) return 'main';
  return 'other';
}

function hostOf(url: string): string | null {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return null;
  }
}

function snippet(text: string, re: RegExp): string {
  const line = text.split('\n').find(l => re.test(l)) ?? text;
  const s = line.replace(/\s+/g, ' ').trim();
  return s.length > 80 ? s.slice(0, 79) + '…' : s;
}

export class Explorer {
  private page: Page;
  private readonly flags: ExploreFlags = {
    appReached: false, walletRequested: false, walletConnected: false, txCaptured: false, waitlist: false, comingSoon: false, errorScreen: false,
  };
  private readonly r: ExploreResult = {
    actions: [], entryFound: false, appReached: false, appVia: null, appUrl: null, appStepIdx: null, waitlist: null, comingSoon: null, errorScreen: null,
    jsError: null, deadLaunch: null, launch404: null, deadButtons: [], mainTried: false, mainOk: null, mainPartial: null, needsFunds: null, tx: null,
    doneReason: null, keyShots: [],
  };
  private readonly siteHost: string | null;
  private readonly filled = new Set<string>();

  constructor(private readonly d: ExploreDeps) {
    if (!d.session.page) throw new Error('open the site before exploring');
    this.page = d.session.page;
    this.siteHost = hostOf(d.siteUrl);
  }

  /** what has been observed so far (live: an action still in flight after a stage timeout can't change it once aborted) */
  get result(): ExploreResult {
    return this.r;
  }

  /**
   * A copy of the result as it stands now. The pipeline takes it when the explore stage ends, so nothing an
   * abandoned action does later can change the verdict without a log step.
   */
  snapshot(): ExploreResult {
    const r = this.r;
    return { ...r, actions: [...r.actions], deadButtons: [...r.deadButtons], keyShots: [...r.keyShots], tx: r.tx ? { ...r.tx } : null };
  }

  private left(): number {
    return this.d.deadline - Date.now();
  }

  /** the stage ended (timeout or budget): whatever an action still in flight finds is not recorded */
  private get stopped(): boolean {
    return this.d.signal.aborted;
  }

  async run(): Promise<ExploreResult> {
    const { ai, maxActions, signal } = this.d;
    const state = ai.newExplore(this.d.siteUrl);
    const history: { action: string; result: string }[] = [];
    let lastResult: string | null = null;

    for (let i = 0; i < maxActions; i++) {
      if (signal.aborted || this.left() < 4000) break;
      this.syncWalletFlags();
      // like a tester would: put a small amount in an empty amount field once per app screen, so a
      // main button that waits for input ("Enter an amount") becomes something to try
      if (this.flags.appReached && !this.filled.has(this.page.url())) {
        this.filled.add(this.page.url());
        if (await this.page.evaluate(FILL_AMOUNT_SCRIPT).catch(() => false)) await sleep(500);
      }
      const summary = await domSummary(this.page);
      if (i === 0) {
        this.r.entryFound = summary.elements.some(
          e => launchRank(e.text) >= 0 || CONNECT_RE.test(e.text) || (!!e.href && isAppUrl(e.href, this.siteHost) && !AVOID_RE.test(e.text)),
        );
      }
      // the stand-in doesn't look at pixels; the model gets the current screen every turn
      const shot = ai.mode === 'heuristic' ? null : await screenshot(this.page);
      let action: BrowserAction;
      const aiSignal = AbortSignal.any([signal, AbortSignal.timeout(Math.max(1000, this.left() - 3000))]);
      try {
        action = await ai.exploreStep(state, { step: i, maxSteps: maxActions, summary, screenshot: shot, lastResult, flags: { ...this.flags }, history }, { ...this.d.aiCtx, signal: aiSignal });
      } catch (e) {
        if (signal.aborted) throw e;
        this.r.doneReason = `agent stopped: ${e instanceof Error ? e.message.slice(0, 80) : 'error'}`;
        break;
      }
      if (action.tool === 'done') {
        this.r.doneReason = action.reason.slice(0, 200);
        break;
      }
      const rec = await this.execute(action, summary);
      if (this.stopped) break;
      this.r.actions.push(rec);
      this.d.onAction?.(this.r.actions.length);
      lastResult = rec.text;
      history.push({ action: rec.tool === 'click' ? `click ${quote(rec.label)}` : rec.tool === 'scroll' ? 'scroll' : `open ${rec.label}`, result: rec.text });
      if (this.flags.txCaptured) {
        this.r.doneReason ??= 'The main flow reached a transaction';
        break;
      }
    }
    this.syncWalletFlags();
    return this.r;
  }

  /**
   * Only copies what the wallet saw. Whether that means the app was reached is decided per action in click():
   * a connect that lands on a waitlist / 'Coming soon' screen is not an app.
   */
  private syncWalletFlags() {
    const w = this.d.session.wallet;
    this.flags.walletRequested = w.requested;
    this.flags.walletConnected = w.connected;
  }

  private markApp(url: string, stepIdx: number | null, via: 'page' | 'wallet') {
    if (this.stopped) return;
    this.flags.appReached = true;
    this.r.appReached = true;
    if (via === 'page' || !this.r.appVia) this.r.appVia = via;
    if (!this.r.appUrl) this.r.appUrl = url;
    if (this.r.appStepIdx == null && stepIdx != null && stepIdx >= 0) this.r.appStepIdx = stepIdx;
  }

  private async log(s: StepInput, keyShot = false): Promise<number> {
    if (this.stopped) return -1;
    if (keyShot && s.shot && this.r.keyShots.length < 2) this.r.keyShots.push(s.shot);
    return this.d.steps.step(s);
  }

  /** The action that was in flight when the stage ended: returned to the loop, never recorded. */
  private abandoned(tool: BrowserAction['tool'], label: string, role: ActionRole): ActionRecord {
    return this.record(tool, label, role, 'missing', 'info', 'Stopped: the time for trying the app ran out', -1, null);
  }

  private async execute(action: BrowserAction, summary: DomSummary): Promise<ActionRecord> {
    if (action.tool === 'scroll') return this.scroll(action.direction);
    if (action.tool === 'open_link') return this.openLink(action.url, summary);
    if (action.tool === 'click') return this.click(action.text, summary);
    throw new Error('unexpected action');
  }

  private record(tool: BrowserAction['tool'], label: string, role: ActionRole, outcome: Outcome, status: StepInput['status'], text: string, stepIdx: number, url: string | null): ActionRecord {
    return { tool, label, role, outcome, status, text, stepIdx, url };
  }

  private async scroll(direction: 'down' | 'up'): Promise<ActionRecord> {
    await this.page.mouse.wheel(0, direction === 'up' ? -700 : 700).catch(() => undefined);
    await sleep(700);
    const text = direction === 'up' ? 'Scrolled back up the page' : 'Scrolled down the page';
    const idx = await this.log({ status: 'info', text, url: this.page.url(), caption: direction === 'up' ? 'Scrolling up' : 'Scrolling down', shot: await screenshot(this.page) });
    return this.record('scroll', direction, 'other', 'scrolled', 'info', text, idx, this.page.url());
  }

  private async openLink(url: string, summary: DomSummary): Promise<ActionRecord> {
    const wanted = normUrl(url.trim());
    const onPage = summary.elements.some(e => e.href && normUrl(e.href) === wanted);
    if (!onPage) {
      const text = 'Skipped a link that is not on the page';
      const idx = await this.log({ status: 'info', text });
      return this.record('open_link', shortUrl(url), 'other', 'blocked', 'info', text, idx, null);
    }
    if (!(await this.d.session.allowed(url))) {
      const text = `Skipped ${shortUrl(url)}: blocked by the SSRF guard`;
      const idx = await this.log({ status: 'info', text });
      return this.record('open_link', shortUrl(url), 'other', 'blocked', 'info', text, idx, null);
    }
    const appLike = isAppUrl(url, this.siteHost);
    let error: string | null = null;
    try {
      await this.page.goto(url, { waitUntil: 'domcontentloaded', timeout: Math.max(3000, Math.min(15_000, this.left() - 2000)) });
      await settle(this.page, Math.min(5000, Math.max(500, this.left() - 2000)));
    } catch (e) {
      error = netErrorText(e);
    }
    const status = this.d.session.docStatus.get(this.page) ?? null;
    const after = await probe(this.page);
    const shot = await screenshot(this.page);
    const label = shortUrl(url);
    if (this.stopped) return this.abandoned('open_link', label, appLike ? 'entry' : 'other');
    const caption = `Opening ${label}`;
    if (error || (status != null && status >= 400) || NOT_FOUND_RE.test(`${after.title} ${after.h1}`)) {
      const text = error ? `${label} doesn't load (${error})` : `${label} returns ${status === 404 || status == null ? '404' : `HTTP ${status}`}`;
      const idx = await this.log({ status: 'warn', text, url, caption, shot });
      return this.record('open_link', label, appLike ? 'entry' : 'other', 'not_found', 'warn', text, idx, url);
    }
    if (appLike || after.connectButton || after.amountInput) {
      const text = `Opened the app at ${shortUrl(after.url)}`;
      const idx = await this.log({ status: 'ok', text, url: after.url, caption, shot }, true);
      this.markApp(after.url, idx, 'page');
      return this.record('open_link', label, 'entry', 'app', 'ok', text, idx, after.url);
    }
    const text = `Opened ${shortUrl(after.url)}`;
    const idx = await this.log({ status: 'info', text, url: after.url, caption, shot });
    return this.record('open_link', label, 'other', 'navigated', 'info', text, idx, after.url);
  }

  private async click(text: string, summary: DomSummary): Promise<ActionRecord> {
    const el = resolveElement(summary, text);
    if (!el) {
      const msg = `Couldn't find ${quote(text)} on the page`;
      const idx = await this.log({ status: 'info', text: msg });
      return this.record('click', text, 'other', 'missing', 'info', msg, idx, null);
    }
    const label = el.text;
    const q = quote(label);
    const role = roleOf(el, this.flags, this.siteHost, !!summary.modalText);
    const page = this.page;
    const s = this.d.session;
    if (role === 'main') await page.evaluate(FILL_AMOUNT_SCRIPT).catch(() => false);

    // baseline: how much the page changes on its own (tickers, carousels) over a short window
    const before0 = await probe(page);
    await sleep(500);
    const before = await probe(page);
    const noise = before.added + before.removed - (before0.added + before0.removed);
    const w0 = s.wallet.activity, sig0 = s.wallet.signatures, tx0 = s.wallet.txs.length, err0 = s.pageErrors.length, pop0 = s.popups.length, dlg0 = s.dialogs.length;
    const url0 = page.url();
    const t0 = Date.now();

    const loc = page.locator(`[data-apecheck-id="${el.id}"]`).first();
    try {
      await loc.click({ timeout: 3000 });
    } catch {
      try {
        await loc.dispatchEvent('click', undefined, { timeout: 2000 });
      } catch {
        const msg = `Couldn't click ${q}`;
        const idx = await this.log({ status: 'info', text: msg });
        return this.record('click', label, role, 'missing', 'info', msg, idx, null);
      }
    }
    await sleep(400);
    await settle(page, Math.min(4000, Math.max(500, this.left() - 3000)), 1000);
    let pageNow = page;
    if (s.popups.length > pop0) {
      pageNow = s.popups[s.popups.length - 1];
      await pageNow.waitForLoadState('domcontentloaded', { timeout: Math.min(15_000, Math.max(1000, this.left() - 3000)) }).catch(() => undefined);
      await settle(pageNow, Math.min(5000, Math.max(500, this.left() - 3000)));
    }
    let after = await probe(pageNow);
    if (!after.textLen && normUrl(pageNow.url()) !== normUrl(url0)) {
      await pageNow.waitForLoadState('domcontentloaded', { timeout: 5000 }).catch(() => undefined);
      after = await probe(pageNow);
    }
    const elapsed = Date.now() - t0;
    const navigated = pageNow !== page || normUrl(after.url) !== normUrl(url0);
    if (this.stopped) return this.abandoned('click', label, role);
    if (navigated) this.page = pageNow;

    const jsErr = s.pageErrors.slice(err0)[0]?.message ?? null;
    const dialog = s.dialogs.slice(dlg0)[0] ?? null;
    const modalNew = after.modalText && after.modalText !== before.modalText ? after.modalText : null;
    const appeared = navigated ? '' : newLines(before.text, after.text);
    // on a new page only its headline, a dialog or a short page count as the screen's message
    const screenText = [dialog, modalNew, navigated ? `${after.title}\n${after.h1}` : appeared, navigated && after.textLen < 1500 ? after.text : '']
      .filter(Boolean)
      .join('\n');
    const status = navigated ? s.docStatus.get(pageNow) ?? null : null;
    const mutations = after.added + after.removed - (before.added + before.removed);
    const changed = textSignature(before.text) !== textSignature(after.text) || mutations > Math.max(3, (noise * elapsed) / 500 * 1.5 + 3);

    let outcome: Outcome;
    if (s.wallet.txs.length > tx0) outcome = 'tx';
    else if (navigated && ((status != null && status >= 400) || NOT_FOUND_RE.test(`${after.title} ${after.h1}`))) outcome = 'not_found';
    else if (WAITLIST_RE.test(screenText) && (after.emailInput || /wait ?list/i.test(screenText))) outcome = 'waitlist';
    else if (COMING_SOON_RE.test(screenText)) outcome = 'coming_soon';
    else if (ERROR_SCREEN_RE.test(screenText)) outcome = 'error';
    else if (navigated) outcome = isAppUrl(after.url, this.siteHost) || after.connectButton || after.amountInput ? 'app' : 'navigated';
    else if (s.wallet.activity > w0) outcome = 'wallet';
    else if (jsErr) outcome = 'js_error';
    else if (role === 'main' && NEEDS_FUNDS_RE.test(appeared || after.text)) outcome = 'needs_funds';
    else if (modalNew || dialog) outcome = 'modal';
    else if (changed) outcome = 'changed';
    else outcome = 'dead';

    this.syncWalletFlags();
    const walletRose = s.wallet.activity > w0;
    const signed = s.wallet.signatures > sig0;
    const shot = await screenshot(pageNow);
    if (this.stopped) return this.abandoned('click', label, role);
    const url = after.url || pageNow.url();
    // a wallet connect counts as reaching an app screen only when that screen shows one (an amount field, an app route)
    const walletVia = (): 'page' | 'wallet' => (after.amountInput || isAppUrl(url, this.siteHost) ? 'page' : 'wallet');
    const caption = role === 'main' ? 'Trying the main flow' : role === 'connect' || role === 'wallet' ? 'Connecting the test wallet' : `Clicking ${q}`;
    const step = (st: StepInput['status'], text: string, key = false) => this.log({ status: st, text, url, caption, shot }, key);
    const rec = async (st: StepInput['status'], text: string, key = false) => {
      const idx = await step(st, text, key);
      return { idx, record: this.record('click', label, role, outcome, st, text, idx, url) };
    };

    if (outcome === 'tx') {
      const tx = s.wallet.txs[s.wallet.txs.length - 1];
      this.flags.txCaptured = true;
      this.r.mainTried = true;
      // bounded by what is left of the stage, so a slow RPC ends as "not simulated" inside the stage, not after it
      const sim = await this.d.simulate(tx, Math.max(1000, Math.min(15_000, this.left() - 1500)));
      // the stage ended while simulating: the pipeline records the captured transaction itself
      if (this.stopped) return this.abandoned('click', label, role);
      const text =
        sim.status === 'ok'
          ? 'Main flow reached a transaction; simulation succeeded'
          : sim.status === 'skipped'
            ? `Main flow reached a transaction; it could not be simulated (${simSkipReason(sim)})`
            : sim.needsFunds
              ? 'Main flow reached a transaction, but the test wallet has no funds to finish it'
              : `Main flow reached a transaction; simulation failed: ${sim.detail ?? 'reverted'}`;
      const st: StepInput['status'] = sim.status === 'ok' ? 'ok' : sim.status === 'skipped' || sim.needsFunds ? 'warn' : 'fail';
      const { idx, record } = await rec(st, text, true);
      this.markApp(url, idx, 'page');
      this.r.tx = { reached: true, kind: tx.kind, simulated: sim.status, detail: sim.detail, needsFunds: sim.needsFunds, chain: sim.chain, stepIdx: idx };
      return record;
    }

    if (role === 'main') {
      this.r.mainTried = true;
      switch (outcome) {
        case 'coming_soon': {
          const { idx, record } = await rec('warn', "Main flow stops at a 'Coming soon' screen", true);
          this.flags.comingSoon = true;
          this.r.comingSoon ??= { stepIdx: idx, text: record.text, main: true };
          return record;
        }
        case 'waitlist': {
          const { idx, record } = await rec('warn', 'Main flow stops at a waitlist form', true);
          this.flags.waitlist = true;
          this.r.waitlist ??= { stepIdx: idx, text: record.text, main: true };
          return record;
        }
        case 'error':
        case 'not_found': {
          const what = outcome === 'not_found' ? 'a 404 page' : `an error: ${snippet(screenText, ERROR_SCREEN_RE)}`;
          const { idx, record } = await rec('fail', `Main flow shows ${what}`, true);
          this.flags.errorScreen = true;
          this.r.errorScreen ??= { stepIdx: idx, text: record.text, main: true };
          return record;
        }
        case 'js_error': {
          const { idx, record } = await rec('fail', `Main flow throws an error: ${jsErr!.slice(0, 100)}`, true);
          this.flags.errorScreen = true;
          this.r.jsError ??= { stepIdx: idx, text: record.text };
          return record;
        }
        case 'needs_funds': {
          const { idx, record } = await rec('warn', `${q} needs funds the test wallet doesn't have`, true);
          this.r.needsFunds ??= { stepIdx: idx, text: record.text };
          return record;
        }
        case 'dead': {
          this.r.deadButtons.push(label);
          const { record } = await rec('warn', `${q} does nothing when clicked`);
          return record;
        }
        default: {
          // only a signature request (a transaction is handled above) shows the main action works; a dialog
          // ("Select a token"), a page change or a connect request is a flow that wasn't completed
          if (outcome === 'wallet' && signed) {
            const text = `${q} asked the test wallet to sign; the flow works up to that point`;
            const { idx, record } = await rec('ok', text, true);
            this.r.mainOk ??= { stepIdx: idx, text };
            return record;
          }
          const kind = outcome === 'modal' ? 'modal' : outcome === 'wallet' ? 'connect' : outcome === 'app' || outcome === 'navigated' ? 'navigated' : 'changed';
          const text =
            kind === 'modal' ? `${q} opens a dialog; no transaction or signature followed`
            : kind === 'connect' ? `${q} only made a wallet request (connect or network switch); no transaction or signature followed`
            : kind === 'navigated' ? `${q} opens ${shortUrl(url)}; no transaction or signature followed`
            : `${q} changes the page, but no transaction or signature followed`;
          const { idx, record } = await rec('info', text, true);
          this.r.mainPartial ??= { stepIdx: idx, text, kind };
          return record;
        }
      }
    }

    if (role === 'entry' || role === 'connect' || role === 'wallet') {
      switch (outcome) {
        case 'app':
        case 'navigated': {
          if (outcome === 'navigated' && role !== 'entry' && !walletRose) break;
          // a page that asks the wallet to connect as it opens is an app too
          const appLike = outcome === 'app' || walletRose;
          const text = `${q} opens ${shortUrl(url)}`;
          const { idx, record } = await rec(appLike ? 'ok' : 'info', text, appLike);
          if (appLike) this.markApp(url, idx, 'page');
          return record;
        }
        case 'wallet': {
          const { idx, record } = await rec('ok', `${q} asked the test wallet to connect`, true);
          this.markApp(url, idx, walletVia());
          return record;
        }
        case 'waitlist': {
          const { idx, record } = await rec('warn', `${q} opens a waitlist form`, true);
          this.flags.waitlist = true;
          this.r.waitlist ??= { stepIdx: idx, text: record.text, main: false };
          return record;
        }
        case 'coming_soon': {
          const { idx, record } = await rec('warn', `${q} shows 'Coming soon'`, true);
          this.flags.comingSoon = true;
          this.r.comingSoon ??= { stepIdx: idx, text: record.text, main: false };
          return record;
        }
        case 'not_found': {
          const { idx, record } = await rec('fail', `${q} leads to a 404 page`, true);
          this.r.launch404 ??= { stepIdx: idx, text: record.text };
          return record;
        }
        case 'error': {
          const { idx, record } = await rec('fail', `${q} shows an error: ${snippet(screenText, ERROR_SCREEN_RE)}`, true);
          this.flags.errorScreen = true;
          this.r.errorScreen ??= { stepIdx: idx, text: record.text, main: false };
          return record;
        }
        case 'js_error':
        case 'dead': {
          this.r.deadButtons.push(label);
          const text = outcome === 'js_error' ? `${q} throws a JS error and does nothing else` : `${q} does nothing when clicked`;
          const st = role === 'entry' ? 'fail' : 'warn';
          const { idx, record } = await rec(st, text, role === 'entry');
          if (role === 'entry') this.r.deadLaunch ??= { stepIdx: idx, text };
          return record;
        }
        case 'modal': {
          const picker = WALLET_CHOICE_RE.test(modalNew ?? '') || /wallet/i.test(modalNew ?? '');
          const { record } = await rec('info', picker ? `${q} opens a wallet picker` : `${q} opens a dialog`);
          return record;
        }
        default:
          break;
      }
    }

    // anything else: a plain click
    if (outcome === 'dead') this.r.deadButtons.push(label);
    if (outcome === 'app' || (outcome === 'navigated' && walletRose)) {
      const { idx, record } = await rec('ok', `${q} opens ${shortUrl(url)}`, true);
      this.markApp(url, idx, 'page');
      return record;
    }
    const plain =
      outcome === 'dead' ? `${q} does nothing when clicked`
      : outcome === 'navigated' ? `${q} opens ${shortUrl(url)}`
      : outcome === 'wallet' ? `${q} asked the test wallet to connect`
      : outcome === 'modal' ? `${q} opens a dialog`
      : `Clicked ${q}`;
    const { idx, record } = await rec('info', plain);
    if (outcome === 'wallet') this.markApp(url, idx, walletVia());
    return record;
  }
}
