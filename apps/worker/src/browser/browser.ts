/**
 * One Chromium per worker process, a fresh incognito context per check (HANDOFF §4 Stage B.1, §11).
 *
 * Isolation layers:
 *  0. Production: Chromium is not started here. It runs in the isolated browser host (deploy/browser/browser-host.cjs,
 *     systemd unit apecheck-browser.service) as another OS user with its own sandbox on, no access to .env or the app
 *     tree, and a firewall that lets it reach only the guard proxy below; this process connects to it
 *     (BROWSER_WS_ENDPOINT) and gives every context the guard as its proxy. Dev/test launch Chromium in-process, with
 *     an explicit minimal environment (chromeEnv), never the process env and its secrets.
 *  1. Chromium sends everything (loopback included) through the SSRF guard proxy from @apecheck/sources,
 *     which vets and pins every destination.
 *  2. context.route('**') aborts non-http(s) schemes and any URL whose host fails checkUrl (defence in depth).
 *  3. No persistent profile, downloads off, service workers blocked, no permissions, WebRTC limited to proxied
 *     traffic, dialogs dismissed, downloads cancelled.
 *  4. The only wallet is the mock wallet (no keys; transactions are captured and simulated, never sent).
 */
import os from 'node:os';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import { checkUrl as defaultCheckUrl, startGuardProxy, type GuardProxy, type SsrfCheck, type SsrfOptions } from '@apecheck/sources';
import type { Env } from '@apecheck/core';
import { pgText } from '../pipeline/pgsafe';
import { WALLET_BINDING, WalletRecorder, mockWalletScript, type WalletRecorderOptions } from './mock-wallet';

export type CheckUrlFn = (url: string) => Promise<SsrfCheck>;

export interface BrowserHostOptions {
  env: Env;
  /** 'guard' (default): Chromium goes through startGuardProxy. 'none' is for in-process test launches only. */
  proxy?: 'guard' | 'none';
  /** resolver override (tests map fixture host names to 127.0.0.1) */
  lookup?: SsrfOptions['lookup'];
  /** URL vetting for context.route; defaults to checkUrl with the env's allow-list */
  checkUrl?: CheckUrlFn;
  /** in-process launches only (dev/test); the remote browser host owns its launch options */
  extraArgs?: string[];
  headless?: boolean;
}

/** Keep identical to CHROME_ARGS in deploy/browser/browser-host.cjs (test/browser-isolation.test.ts checks). */
export const CHROME_ARGS = [
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

/**
 * Chromium's whole environment for an in-process launch: never process.env, which holds every secret loadEnv() read
 * from .env (X tokens, API keys, SESSION_SECRET, DATABASE_URL). Display variables pass only so a headed debug run works.
 */
export function chromeEnv(source: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const env: Record<string, string> = { PATH: '/usr/local/bin:/usr/bin:/bin', HOME: source.HOME || os.tmpdir(), TZ: 'UTC', LANG: 'C.UTF-8' };
  for (const k of ['DISPLAY', 'WAYLAND_DISPLAY', 'XDG_RUNTIME_DIR', 'FONTCONFIG_PATH'] as const) {
    const v = source[k];
    if (v) env[k] = v;
  }
  return env;
}

/** Why this process may not start Chromium itself (production without the isolated browser host), or null. */
export function browserIsolationProblem(env: Env): string | null {
  if (env.NODE_ENV !== 'production' || env.BROWSER_WS_ENDPOINT) return null;
  return 'BROWSER_WS_ENDPOINT is not set: in production Chromium runs only in the isolated browser host (apecheck-browser.service, DEPLOY.md §6), never inside worker-checks';
}

const CONNECT_ATTEMPTS = 10;

/** Connect to the browser host, riding out its restart (systemd brings it back within seconds). */
async function connectRemote(endpoint: string): Promise<Browser> {
  // the endpoint's path is the host's shared secret: keep it out of error messages and logs
  const secret = new URL(endpoint).pathname;
  const redact = (s: string) => (secret.length > 1 ? s.split(secret).join('/<BROWSER_WS_PATH>') : s);
  let last = '';
  for (let i = 0; i < CONNECT_ATTEMPTS; i++) {
    if (i) await new Promise(r => setTimeout(r, 1000));
    try {
      return await chromium.connect(endpoint, { timeout: 30_000 });
    } catch (e) {
      last = redact(e instanceof Error ? e.message : String(e));
      if (!/ECONNREFUSED|ECONNRESET|socket hang up/.test(last)) break;
    }
  }
  throw new Error(`browser host unreachable: ${last}`);
}

/**
 * The remote browser must reach the guard: its firewall allows BROWSER_GUARD_PORT only, so a port mismatch would
 * otherwise show up as every site "not loading". Loopback is proxied and refused by the guard, so any answer here
 * is the guard's own 403.
 */
export async function probeGuard(browser: Browser, proxy: string): Promise<void> {
  const ctx = await browser.newContext({ proxy: { server: proxy } });
  try {
    const res = await (await ctx.newPage()).goto('http://127.0.0.1/', { timeout: 15_000 });
    if (res?.status() !== 403 || !(await res.text()).includes('ApeCheck SSRF guard')) throw new Error(`unexpected answer ${res?.status()}`);
  } catch (e) {
    throw new Error(`the browser host cannot reach the guard proxy at ${proxy} (its firewall must allow BROWSER_GUARD_PORT): ${e instanceof Error ? e.message.split('\n')[0] : e}`);
  } finally {
    await ctx.close().catch(() => undefined);
  }
}

export class BrowserHost {
  private constructor(
    readonly browser: Browser,
    readonly guard: GuardProxy | null,
    readonly checkUrl: CheckUrlFn,
    /** remote browser: every context's proxy (the guard); in-process launches set it on the command line instead */
    private readonly contextProxy?: { server: string },
  ) {}

  static async launch(opts: BrowserHostOptions): Promise<BrowserHost> {
    const { env } = opts;
    const production = env.NODE_ENV === 'production';
    const problem = browserIsolationProblem(env);
    if (problem) throw new Error(problem);
    const remote = env.BROWSER_WS_ENDPOINT;
    if (remote && opts.proxy === 'none') throw new Error('a remote browser always goes through the guard proxy');
    const ssrf: SsrfOptions = {
      allowHosts: production ? [] : env.SSRF_ALLOW_HOSTS,
      production,
      lookup: opts.lookup,
      // names the egress proxy resolves itself can't be resolved here; IP literals and local names are still refused
      allowUnresolved: !!env.OUTBOUND_PROXY,
    };
    // remote: the guard listens on BROWSER_GUARD_PORT, the only port the browser user's firewall lets it reach
    const guard =
      opts.proxy === 'none' ? null : await startGuardProxy({ ...ssrf, upstreamProxy: env.OUTBOUND_PROXY ?? null, port: remote ? env.BROWSER_GUARD_PORT : 0 });
    let browser: Browser;
    try {
      if (remote) {
        // the host (deploy/browser/browser-host.cjs) owns the launch: sandbox on, its own flags, a minimal environment
        browser = await connectRemote(remote);
        try {
          await probeGuard(browser, guard!.url);
        } catch (e) {
          await browser.close().catch(() => undefined);
          throw e;
        }
      } else {
        const args = [...CHROME_ARGS, ...(opts.extraArgs ?? [])];
        // <-loopback> removes Chromium's implicit proxy bypass for localhost, so loopback goes through the guard too
        if (guard) args.push(`--proxy-server=${guard.url}`, '--proxy-bypass-list=<-loopback>');
        // dev/test only (production is refused above): tests run as root, where Chromium's sandbox can't start
        browser = await chromium.launch({ headless: opts.headless ?? true, args, chromiumSandbox: false, env: chromeEnv() });
      }
    } catch (e) {
      await guard?.close().catch(() => undefined);
      throw e;
    }
    const check = opts.checkUrl ?? ((url: string) => defaultCheckUrl(url, ssrf));
    // per-context proxy: Playwright adds <-loopback> to its bypass list, so loopback goes through the guard as well
    return new BrowserHost(browser, guard, check, remote && guard ? { server: guard.url } : undefined);
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
      proxy: this.contextProxy,
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

/** A string the page controls, clipped to `max` and safe to store. */
export function pageString(v: unknown, max: number): string {
  return pgText(String(v ?? '').slice(0, max));
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
  /** response headers of that document (lower-case names), to tell a bot challenge from a dead site */
  readonly docHeaders = new WeakMap<Page, Record<string, string>>();
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
    // page-supplied text: clipped and stripped of U+0000 / lone surrogates (Postgres refuses them) right here
    p.on('dialog', d => {
      if (this.dialogs.length < 20) this.dialogs.push(pageString(d.message(), 300));
      void d.dismiss().catch(() => undefined);
    });
    p.on('console', m => {
      if (m.type() === 'error' && this.consoleErrors.length < 50) this.consoleErrors.push(pageString(m.text(), 300));
    });
    p.on('pageerror', e => {
      if (this.pageErrors.length < 50) this.pageErrors.push({ at: Date.now(), message: pageString(e.message || String(e), 300) });
    });
    p.on('response', r => {
      if (r.request().isNavigationRequest() && r.frame() === p.mainFrame()) {
        this.docStatus.set(p, r.status());
        this.docHeaders.set(p, r.headers());
      }
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
