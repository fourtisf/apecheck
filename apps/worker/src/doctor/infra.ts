/**
 * Infrastructure probes: Postgres (and its migrations), Redis (and which workers listen on it), the SSRF-guarded server
 * fetch, the guard proxy's egress, the isolated browser host, and a page load from that browser through worker-checks'
 * guard.
 *
 * The browser probes never listen on BROWSER_GUARD_PORT: worker-checks owns that port and starts its guard there when
 * it starts (again on the next check after a failed browser launch), so a doctor holding it would make worker-checks' next browser launch fail with EADDRINUSE
 * (every check: "browse:unavailable"). They connect to the browser host as one more client instead: Playwright keeps
 * each connection's contexts apart, and close() from a client only ends that client's connection.
 */
import fs from 'node:fs';
import http from 'node:http';
import { createRequire } from 'node:module';
import net from 'node:net';
import path from 'node:path';
import type { Browser } from 'playwright';
import { QUEUES, type Env } from '@apecheck/core';
import { SsrfError, startGuardProxy, type Http, type HttpResponse } from '@apecheck/sources';
import { probeGuard } from '../browser/browser';
import { dbLabel, hostOf, wsLabel } from './redact';
import { errorText, fail, outcome, pass, skip, warn, type ProbeOutcome } from './result';

/* ---------------- Postgres ---------------- */

export const POSTGRES_REMEDY = 'check DATABASE_URL in .env and that PostgreSQL runs (systemctl status postgresql)';
export const MIGRATE_REMEDY = 'run as apecheck in /srv/apecheck/app: pnpm --filter db prisma migrate deploy (DEPLOY.md §5)';

/** The two read-only queries the probe needs (Prisma in production, a fake in tests). */
export interface DbInfo {
  /** server_version, e.g. "16.4 (Ubuntu 16.4-1)" */
  version(): Promise<string>;
  /** names of the migrations applied (finished, not rolled back) */
  applied(): Promise<string[]>;
}

export function prismaDbInfo(db: { $queryRaw<T = unknown>(query: TemplateStringsArray, ...values: unknown[]): PromiseLike<T> }): DbInfo {
  return {
    version: async () => (await db.$queryRaw<{ v: string }[]>`SELECT current_setting('server_version') AS v`)[0]?.v ?? '?',
    applied: async () =>
      (await db.$queryRaw<{ name: string }[]>`SELECT migration_name AS name FROM _prisma_migrations WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL`).map(r => r.name),
  };
}

/** The migrations this checkout ships (packages/db/prisma/migrations/<name>/migration.sql). */
export function migrationNames(dir: string): string[] {
  try {
    return fs
      .readdirSync(dir, { withFileTypes: true })
      .filter(d => d.isDirectory() && fs.existsSync(path.join(dir, d.name, 'migration.sql')))
      .map(d => d.name)
      .sort();
  } catch {
    return [];
  }
}

export async function probePostgres(deps: { env: Env; db: DbInfo; migrations: string[] }): Promise<ProbeOutcome> {
  const where = dbLabel(deps.env.DATABASE_URL, 5432);
  let version: string;
  try {
    version = `PostgreSQL ${(await deps.db.version()).split(' ')[0]}`;
  } catch (e) {
    return fail(`${where}: ${errorText(e)}`, POSTGRES_REMEDY);
  }
  let applied: Set<string>;
  try {
    applied = new Set(await deps.db.applied());
  } catch (e) {
    return fail(`${where}, ${version}: migrations unreadable (${errorText(e)})`, MIGRATE_REMEDY);
  }
  const pending = deps.migrations.filter(m => !applied.has(m));
  if (pending.length) return fail(`${where}, ${version}: ${pending.length} migration(s) not applied, the newest ${pending[pending.length - 1]}`, MIGRATE_REMEDY);
  const unknown = [...applied].filter(m => !deps.migrations.includes(m));
  const detail = `${where}, ${version}, ${applied.size} migrations applied${unknown.length ? `; ${unknown.length} applied migration(s) this checkout does not have (older code?)` : ''}`;
  return outcome({ ok: true, configured: true, importance: 'required', degraded: unknown.length > 0 }, detail, 'update the checkout to the version that migrated this database (DEPLOY.md §11)');
}

/* ---------------- Redis ---------------- */

export const REDIS_REMEDY = 'check REDIS_URL in .env and that Redis runs (systemctl status redis-server)';

/** What the probe calls on a Redis connection (ioredis in production). */
export interface RedisLike {
  ping(): Promise<string>;
  info(section: string): Promise<string>;
  call(command: string, ...args: string[]): Promise<unknown>;
}

/**
 * BullMQ workers listening on `queue` in Redis database `db`, from CLIENT LIST (which lists every database's clients):
 * a Worker names its blocking connection "<prefix>:<base64 of the queue name>" (plus ":w:<name>" for a named
 * worker), one per Worker.
 */
export function bullWorkers(clientList: string, queue: string, db = 0, prefix = 'bull'): number {
  const base = `${prefix}:${Buffer.from(queue).toString('base64')}`;
  let n = 0;
  for (const line of clientList.split('\n')) {
    const name = /(?:^|\s)name=(\S*)/.exec(line)?.[1];
    const lineDb = Number(/(?:^|\s)db=(\d+)/.exec(line)?.[1] ?? 0);
    if (name && lineDb === db && (name === base || name.startsWith(`${base}:w:`))) n++;
  }
  return n;
}

/** the database number in a redis:// URL (/<db>, default 0) */
export function redisDb(url: string): number {
  try {
    const n = Number(new URL(url).pathname.slice(1) || 0);
    return Number.isInteger(n) && n >= 0 ? n : 0;
  } catch {
    return 0;
  }
}

export async function probeRedis(deps: { env: Env; redis: RedisLike }): Promise<ProbeOutcome> {
  const where = dbLabel(deps.env.REDIS_URL, 6379);
  let pong: string;
  let version = '?';
  try {
    pong = await deps.redis.ping();
    version = /redis_version:(\S+)/.exec(await deps.redis.info('server'))?.[1] ?? '?';
  } catch (e) {
    return fail(`${where}: ${errorText(e)}`, REDIS_REMEDY);
  }
  let checks: number | null = null;
  let workers: string;
  try {
    const list = String(await deps.redis.call('CLIENT', 'LIST'));
    const db = redisDb(deps.env.REDIS_URL);
    const counts = Object.values(QUEUES).map(q => [q, bullWorkers(list, q, db)] as const);
    checks = counts.find(([q]) => q === QUEUES.checks)?.[1] ?? 0;
    workers = counts.map(([q, n]) => `${q} ${n}`).join(', ');
  } catch (e) {
    workers = `unknown (CLIENT LIST: ${errorText(e)})`;
  }
  const detail = `${where}, Redis ${version}, PING ${pong}; workers per queue: ${workers}`;
  if (checks === 0) {
    return warn(`${detail}; nothing consumes "checks", so new checks wait in the queue`, 'start it: pm2 start ecosystem.config.cjs --only worker-checks; then pm2 logs worker-checks');
  }
  return pass(detail);
}

/* ---------------- websites through the SSRF guard ---------------- */

export const WEB_REMEDY =
  'the VPS cannot open public websites as user apecheck: check DNS (resolvectl status; /etc/resolv.conf) and outbound HTTPS; OUTBOUND_PROXY must stay empty in production';

/** The server-side fetch every page-supplied URL (docs links, webhooks) goes through: createHttp with guard:true. */
export async function probeGuardedFetch(deps: { http: Http }): Promise<ProbeOutcome> {
  // the rule first, it needs no network: loopback must be refused before any connection
  let refusal = '';
  try {
    await deps.http.request('http://127.0.0.1/', { guard: true, timeoutMs: 3_000 });
  } catch (e) {
    if (e instanceof SsrfError) refusal = e.message;
  }
  if (!refusal) return fail('the SSRF guard did not refuse http://127.0.0.1/', 'SSRF_ALLOW_HOSTS must be empty (it is ignored only when NODE_ENV=production)');
  let res: HttpResponse;
  try {
    res = await deps.http.request('https://example.com/', { guard: true, timeoutMs: 10_000 });
  } catch (e) {
    return fail(`https://example.com/: ${errorText(e)}; loopback refused as it should be`, WEB_REMEDY);
  }
  if (res.status !== 200 || !/Example Domain/.test(res.text)) return fail(`https://example.com/ answered HTTP ${res.status} without its page`, WEB_REMEDY);
  return pass(`https://example.com/ HTTP 200 "Example Domain" in ${res.ms} ms; 127.0.0.1 refused (${refusal})`);
}

/** CONNECT `authority` through an HTTP proxy: the status, and on a refusal the proxy's reason (its body). */
export function connectThrough(proxyUrl: string, authority: string, timeoutMs: number): Promise<{ status: number; reason: string }> {
  const u = new URL(proxyUrl);
  return new Promise((resolve, reject) => {
    const req = http.request({ host: u.hostname, port: Number(u.port), method: 'CONNECT', path: authority, timeout: timeoutMs });
    // Node hands every answer to a CONNECT to 'connect' (the body, if any, follows on the socket)
    req.on('connect', (res, socket, head) => {
      const status = res.statusCode ?? 0;
      if (status === 200) {
        socket.destroy();
        resolve({ status, reason: '' });
        return;
      }
      const chunks: Buffer[] = [head];
      const done = () => {
        socket.destroy();
        resolve({ status, reason: Buffer.concat(chunks).toString('utf8').trim().slice(0, 200) });
      };
      socket.on('data', (c: Buffer) => chunks.push(c));
      socket.once('end', done);
      socket.once('error', done);
      setTimeout(done, 500).unref();
    });
    req.on('timeout', () => req.destroy(new Error(`no answer from the proxy within ${timeoutMs} ms`)));
    req.on('error', reject);
    req.end();
  });
}

/**
 * The guard proxy Chromium goes through, started by this process on a free port (never BROWSER_GUARD_PORT) with
 * worker-checks' settings: proves the guard's DNS and its outbound HTTPS work for this user, even before
 * worker-checks has started its own.
 */
export async function probeGuardEgress(deps: { env: Env; start?: typeof startGuardProxy; target?: string }): Promise<ProbeOutcome> {
  const { env } = deps;
  const production = env.NODE_ENV === 'production';
  const target = deps.target ?? 'example.com:443';
  const guard = await (deps.start ?? startGuardProxy)({
    allowHosts: production ? [] : env.SSRF_ALLOW_HOSTS,
    production,
    allowUnresolved: !!env.OUTBOUND_PROXY,
    upstreamProxy: env.OUTBOUND_PROXY ?? null,
    port: 0,
  });
  try {
    const r = await connectThrough(guard.url, target, 12_000);
    const who = `a guard on a free port (same code as worker-checks' guard)`;
    if (r.status === 200) return pass(`${who}: CONNECT ${target} HTTP 200, so the guard's DNS and outbound HTTPS work for this user`);
    if (r.status === 403) return fail(`${who} refused ${target}: ${r.reason || 'HTTP 403'}`, `DNS from this user fails or answers with a private address; ${WEB_REMEDY}`);
    if (r.status === 502) return fail(`${who}: CONNECT ${target} HTTP 502, the connection to it failed`, WEB_REMEDY);
    return fail(`${who}: CONNECT ${target} HTTP ${r.status}`, WEB_REMEDY);
  } finally {
    await guard.close().catch(() => undefined);
  }
}

/* ---------------- isolated browser host ---------------- */

export const BROWSER_HOST_REMEDY =
  'sudo systemctl status apecheck-browser; sudo journalctl -u apecheck-browser -n 20; after a playwright bump re-run sudo deploy/browser/install.sh (DEPLOY.md §6)';
export const BROWSER_GUARD_REMEDY =
  'pm2 logs worker-checks --lines 300 | grep -E "Chromium could not start|guard proxy"; BROWSER_GUARD_PORT must equal the port in deploy/browser/browser-firewall.nft';

/** apps/worker's Playwright version (the browser host must run the same major.minor, or it answers 428) */
export function playwrightVersion(): string {
  try {
    return (createRequire(import.meta.url)('playwright/package.json') as { version: string }).version;
  } catch {
    return '?';
  }
}

/** The guard port deploy/browser/browser-firewall.nft lets the browser user reach, or null when unreadable. */
export function firewallGuardPort(file: string): number | null {
  try {
    const m = /ip daddr 127\.0\.0\.1 tcp dport (\d+) accept/.exec(fs.readFileSync(file, 'utf8'));
    return m ? Number(m[1]) : null;
  } catch {
    return null;
  }
}

export function portOpen(port: number, host = '127.0.0.1', timeoutMs = 2_000): Promise<boolean> {
  return new Promise(resolve => {
    const s = net.connect({ host, port });
    const done = (open: boolean) => {
      s.destroy();
      resolve(open);
    };
    s.setTimeout(timeoutMs, () => done(false));
    s.once('connect', () => done(true));
    s.once('error', () => done(false));
  });
}

export interface BrowserDeps {
  env: Env;
  http: Http;
  /** the doctor's one connection to the browser host, shared by both browser probes (errors already redacted) */
  browser: () => Promise<Browser>;
}

/** The host answers (GET / needs no secret), and a Playwright client of apps/worker's version connects. */
export async function probeBrowserHost(deps: BrowserDeps): Promise<ProbeOutcome> {
  const endpoint = deps.env.BROWSER_WS_ENDPOINT;
  if (!endpoint) {
    return deps.env.NODE_ENV === 'production'
      ? fail('BROWSER_WS_ENDPOINT empty: worker-checks refuses to start in production', 'run sudo /srv/apecheck/app/deploy/browser/install.sh (DEPLOY.md §6); it sets BROWSER_WS_ENDPOINT in .env')
      : skip('BROWSER_WS_ENDPOINT empty: dev and tests launch Chromium inside the worker');
  }
  const label = wsLabel(endpoint);
  let root: HttpResponse;
  try {
    root = await deps.http.request(`http://${new URL(endpoint).host}/`, { timeoutMs: 5_000 });
  } catch (e) {
    return fail(`${label}: not listening (${errorText(e)})`, BROWSER_HOST_REMEDY);
  }
  if (root.status !== 200) return fail(`${label}: GET / answered HTTP ${root.status}, which is not the Playwright server`, BROWSER_HOST_REMEDY);
  try {
    const browser = await deps.browser();
    return pass(`${label}: Chromium ${browser.version()} connected (Playwright ${playwrightVersion()})`);
  } catch (e) {
    const msg = errorText(e);
    const remedy = /\b428\b|version mismatch/i.test(msg)
      ? `the host runs another Playwright than apps/worker's ${playwrightVersion()}: re-run sudo deploy/browser/install.sh`
      : /\b(?:400|404)\b/.test(msg)
        ? "BROWSER_WS_ENDPOINT's path is not the host's BROWSER_WS_PATH (/etc/apecheck/browser.env): re-run sudo deploy/browser/install.sh, which writes both"
        : BROWSER_HOST_REMEDY;
    return fail(`${label}: listening, but the connection failed: ${msg}`, remedy);
  }
}

/**
 * A page from the browser host through worker-checks' guard on BROWSER_GUARD_PORT, as every website check loads it:
 * the guard is reached (probeGuard, the same test worker-checks runs at launch), then https://example.com/ loads.
 */
export async function probeBrowserGuard(
  deps: BrowserDeps & { firewallPort?: number | null; portOpen?: (port: number) => Promise<boolean> },
): Promise<ProbeOutcome> {
  const { env } = deps;
  if (!env.BROWSER_WS_ENDPOINT) return skip('needs the browser host (BROWSER_WS_ENDPOINT empty)');
  const port = env.BROWSER_GUARD_PORT;
  if (deps.firewallPort && port !== deps.firewallPort) {
    return fail(
      `BROWSER_GUARD_PORT=${port}, but browser-firewall.nft lets the browser reach port ${deps.firewallPort} only: every website check fails`,
      `set BROWSER_GUARD_PORT=${deps.firewallPort} (or change both together and re-run sudo deploy/browser/install.sh)`,
    );
  }
  const guardUrl = `http://127.0.0.1:${port}`;
  if (!(await (deps.portOpen ?? portOpen)(port))) {
    return warn(
      `nothing listens on 127.0.0.1:${port}: worker-checks starts its guard there when it starts, so it is down or its browser launch failed; the doctor never starts one there`,
      `look for "browser is unusable" in pm2 logs worker-checks and at the Browser host row; then: ${BROWSER_GUARD_REMEDY}`,
    );
  }
  let browser: Browser;
  try {
    browser = await deps.browser();
  } catch (e) {
    return fail(`browser host not connected (${errorText(e)}): see the browser host row`, BROWSER_HOST_REMEDY);
  }
  try {
    await probeGuard(browser, guardUrl);
  } catch (e) {
    return fail(errorText(e), BROWSER_GUARD_REMEDY);
  }
  const ctx = await browser.newContext({ proxy: { server: guardUrl }, acceptDownloads: false, serviceWorkers: 'block', permissions: [] });
  try {
    const started = Date.now();
    const page = await ctx.newPage();
    const res = await page.goto('https://example.com/', { timeout: 20_000, waitUntil: 'domcontentloaded' });
    const title = await page.title();
    const ms = Date.now() - started;
    if (res?.status() !== 200 || !/Example Domain/i.test(title)) {
      return fail(`browser via the guard on ${hostOf(guardUrl)}: https://example.com/ answered HTTP ${res?.status() ?? '?'} "${title}"`, WEB_REMEDY);
    }
    return pass(`browser host reaches the guard on ${hostOf(guardUrl)}; https://example.com/ through it: HTTP 200 "${title}" in ${ms} ms`);
  } catch (e) {
    return fail(
      `browser via the guard on ${hostOf(guardUrl)}: ${errorText(e)}`,
      `ERR_TUNNEL_CONNECTION_FAILED means worker-checks' guard refused or could not connect (compare the "SSRF guard egress" row); ${WEB_REMEDY}`,
    );
  } finally {
    await ctx.close().catch(() => undefined);
  }
}
