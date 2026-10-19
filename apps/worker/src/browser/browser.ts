/**
 * One Chromium per worker process, a fresh incognito context per check (HANDOFF §4 Stage B.1, §11).
 *
 * Isolation layers:
 *  1. Chromium sends everything (loopback included) through the SSRF guard proxy from @apecheck/sources,
 *     which vets and pins every destination.
 *  2. context.route('**') aborts non-http(s) schemes and any URL whose host fails checkUrl (defence in depth).
 *  3. No persistent profile, downloads off, service workers blocked, no permissions, WebRTC limited to proxied
 *     traffic, dialogs dismissed, downloads cancelled.
 *  4. The only wallet is the mock wallet (no keys; transactions are captured and simulated, never sent).
 */
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import { checkUrl as defaultCheckUrl, startGuardProxy, type GuardProxy, type SsrfCheck, type SsrfOptions } from '@apecheck/sources';
import type { Env } from '@apecheck/core';
import { OBSERVER_SCRIPT } from './page-scripts';
import { WALLET_BINDING, WalletRecorder, mockWalletScript, type WalletRecorderOptions } from './mock-wallet';

export type CheckUrlFn = (url: string) => Promise<SsrfCheck>;

export interface BrowserHostOptions {
  env: Env;
  /** 'guard' (default): Chromium goes through startGuardProxy. 'none' is for tests only. */
  proxy?: 'guard' | 'none';
  /** resolver override (tests map fixture host names to 127.0.0.1) */
  lookup?: SsrfOptions['lookup'];
  /** URL vetting for context.route; defaults to checkUrl with the env's allow-list */
  checkUrl?: CheckUrlFn;
  extraArgs?: string[];
  headless?: boolean;
}

const CHROME_ARGS = [
  '--disable-background-networking',
  '--disable-component-update',
  '--disable-sync',
  '--disable-default-apps',
  '--disable-extensions',
  '--disable-domain-reliability',
  '--disable-client-side-phishing-detection',
  '--disable-breakpad',
  '--no-first-run',
  '--no-default-browser-check',
  '--no-pings',
  '--disable-dev-shm-usage',
  '--deny-permission-prompts',
  '--disk-cache-size=1',
  '--media-cache-size=1',
  '--password-store=basic',
  '--use-mock-keychain',
  '--force-webrtc-ip-handling-policy=disable_non_proxied_udp',
  '--disable-features=Translate,OptimizationHints,MediaRouter,DialMediaRouteProvider,AutofillServerCommunication,CertificateTransparencyComponentUpdater,InterestFeedContentSuggestions,PrivacySandboxSettings4,NetworkPrediction,BackForwardCache,SafeBrowsingEnhancedProtection,AcceptCHFrame',
];

export class BrowserHost {
  private constructor(
    readonly browser: Browser,
    readonly guard: GuardProxy | null,
    readonly checkUrl: CheckUrlFn,
  ) {}

  static async launch(opts: BrowserHostOptions): Promise<BrowserHost> {
    const { env } = opts;
    const production = env.NODE_ENV === 'production';
    const ssrf: SsrfOptions = {
      allowHosts: production ? [] : env.SSRF_ALLOW_HOSTS,
      production,
      lookup: opts.lookup,
      // names the egress proxy resolves itself can't be resolved here; IP literals and local names are still refused
      allowUnresolved: !!env.OUTBOUND_PROXY,
    };
    const guard = opts.proxy === 'none' ? null : await startGuardProxy({ ...ssrf, upstreamProxy: env.OUTBOUND_PROXY ?? null });
    const args = [...CHROME_ARGS, ...(opts.extraArgs ?? [])];
    // <-loopback> removes Chromium's implicit proxy bypass for localhost, so loopback goes through the guard too
    if (guard) args.push(`--proxy-server=${guard.url}`, '--proxy-bypass-list=<-loopback>');
    let browser: Browser;
    try {
      browser = await chromium.launch({ headless: opts.headless ?? true, args });
    } catch (e) {
      await guard?.close().catch(() => undefined);
      throw e;
    }
    const check = opts.checkUrl ?? ((url: string) => defaultCheckUrl(url, ssrf));
    return new BrowserHost(browser, guard, check);
  }

  get connected(): boolean {
    return this.browser.isConnected();
  }

  userAgent(): string {
    const v = this.browser.version();
    return `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${v} Safari/537.36`;
  }

  async newSession(opts: { evmChainId: string; wallet?: WalletRecorderOptions }): Promise<BrowseSession> {
    const context = await this.browser.newContext({
      viewport: { width: 1280, height: 800 },
      acceptDownloads: false,
      serviceWorkers: 'block',
      permissions: [],
      locale: 'en-US',
      timezoneId: 'UTC',
      userAgent: this.userAgent(),
      ignoreHTTPSErrors: false,
      javaScriptEnabled: true,
    });
    const session = new BrowseSession(context, new WalletRecorder(opts.wallet), this.checkUrl);
    await session.init(opts.evmChainId);
    return session;
  }

  async close(): Promise<void> {
    await this.browser.close().catch(() => undefined);
    await this.guard?.close().catch(() => undefined);
  }
}

export interface PageErrorRecord {
  at: number;
  message: string;
}

/** One check's browser context and everything observed in it. */
export class BrowseSession {
  page: Page | null = null;
  readonly consoleErrors: string[] = [];
  readonly pageErrors: PageErrorRecord[] = [];
  readonly dialogs: string[] = [];
  readonly blocked: { url: string; reason: string }[] = [];
  readonly popups: Page[] = [];
  /** last main-frame document status per page */
  readonly docStatus = new WeakMap<Page, number>();
  private readonly hostVerdicts = new Map<string, Promise<SsrfCheck>>();
  private closed = false;
  /** >0 while we open a page ourselves, so it isn't mistaken for a popup the site opened */
  private creating = 0;

  constructor(
    readonly context: BrowserContext,
    readonly wallet: WalletRecorder,
    private readonly checkUrl: CheckUrlFn,
  ) {}

  async init(evmChainId: string): Promise<void> {
    const ctx = this.context;
    await ctx.exposeBinding(WALLET_BINDING, (_source, msg: unknown) => this.wallet.handle(msg));
    await ctx.addInitScript({ content: mockWalletScript({ evmChainId }) });
    await ctx.addInitScript({ content: OBSERVER_SCRIPT });
    await ctx.route('**/*', async route => {
      const url = route.request().url();
      const verdict = await this.vet(url, route.request().resourceType());
      if (verdict.ok) return route.continue().catch(() => undefined);
      if (this.blocked.length < 100) this.blocked.push({ url: url.slice(0, 200), reason: verdict.reason ?? 'blocked' });
      return route.abort('blockedbyclient').catch(() => undefined);
    });
    ctx.on('page', p => this.track(p));
  }

  private async vet(url: string, resourceType: string): Promise<{ ok: boolean; reason?: string }> {
    const scheme = url.slice(0, Math.max(0, url.indexOf(':'))).toLowerCase();
    if (scheme === 'data' || scheme === 'blob') return resourceType === 'document' ? { ok: false, reason: `${scheme}: document` } : { ok: true };
    if (scheme !== 'http' && scheme !== 'https') return { ok: false, reason: `blocked scheme ${scheme}:` };
    let origin: string;
    try {
      origin = new URL(url).origin;
    } catch {
      return { ok: false, reason: 'invalid URL' };
    }
    let p = this.hostVerdicts.get(origin);
    if (!p) {
      p = this.checkUrl(url).catch((e: unknown) => ({ ok: false, reason: e instanceof Error ? e.message : 'check failed' }));
      this.hostVerdicts.set(origin, p);
    }
    const v = await p;
    return { ok: v.ok, reason: v.reason };
  }

  /** Same verdict the route guard uses (open_link and docs links are vetted with it before navigating). */
  async allowed(url: string): Promise<boolean> {
    return (await this.vet(url, 'document')).ok;
  }

  private track(p: Page) {
    if (this.creating === 0 && this.page && p !== this.page && this.popups.length < 20) this.popups.push(p);
    p.on('download', d => void d.cancel().catch(() => undefined));
    p.on('dialog', d => {
      if (this.dialogs.length < 20) this.dialogs.push(d.message().slice(0, 300));
      void d.dismiss().catch(() => undefined);
    });
    p.on('console', m => {
      if (m.type() === 'error' && this.consoleErrors.length < 50) this.consoleErrors.push(m.text().slice(0, 300));
    });
    p.on('pageerror', e => {
      if (this.pageErrors.length < 50) this.pageErrors.push({ at: Date.now(), message: (e.message || String(e)).slice(0, 300) });
    });
    p.on('response', r => {
      if (r.request().isNavigationRequest() && r.frame() === p.mainFrame()) this.docStatus.set(p, r.status());
    });
  }

  async newPage(): Promise<Page> {
    this.creating++;
    try {
      const p = await this.context.newPage();
      if (!this.page) this.page = p;
      return p;
    } finally {
      this.creating--;
    }
  }

  get isClosed(): boolean {
    return this.closed;
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    await this.context.close().catch(() => undefined);
  }
}
