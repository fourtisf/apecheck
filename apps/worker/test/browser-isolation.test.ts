/**
 * Browser isolation (HANDOFF §11, DEPLOY.md §6): the browser agent opens attacker-chosen pages, so
 *  - in-process launches (dev/test) give Chromium an explicit minimal environment, never this process's secrets;
 *  - production refuses to launch Chromium in worker-checks at all;
 *  - the isolated browser host (deploy/browser/browser-host.cjs) runs Chromium as another user with its sandbox on
 *    and a minimal environment, refuses to start when it could read the app's secrets, reach Postgres/Redis or run
 *    as root, and worker-checks drives it remotely with every context going through the SSRF guard.
 * The host tests run Chromium as `nobody`, so they need root to drop to it (skipped otherwise) and a checkout and
 * PLAYWRIGHT_BROWSERS_PATH that `nobody` can read.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { BrowserHost, CHROME_ARGS, browserIsolationProblem, chromeEnv, probeGuard } from '../src/browser/browser';
import { browseStage } from '../src/pipeline/browse';
import { fakeSources } from './fakes';
import { closedPort, serveFixture, testLookup, type FixtureSite } from './fixture-server';
import { standaloneRun, testEnv } from './helpers';

const here = path.dirname(fileURLToPath(import.meta.url));
const HOST_SCRIPT = path.resolve(here, '../../../deploy/browser/browser-host.cjs');
const WORKER_MODULES = path.resolve(here, '../node_modules');
const NOBODY = 65534;

interface Proc {
  pid: number;
  uid: number | null;
  args: string[];
  type: string;
  seccomp: number | null;
}
const hostLib = createRequire(import.meta.url)(HOST_SCRIPT) as {
  CHROME_ARGS: string[];
  UNSAFE_FLAGS: string[];
  processTree(rootPid: number): Proc[];
  sandboxProblems(tree: Proc[], opts?: { requireRenderer?: boolean }): string[];
  readConfig(env: Record<string, string | undefined>): { wsPath: string; port: number; forbiddenPaths: string[]; forbiddenPorts: number[] };
};

const isRoot = process.getuid?.() === 0;
const chromiumOf = (tree: Proc[]) => tree.filter(p => /headless_shell|chrome/.test(p.args[0] ?? ''));
const environ = (pid: number) => fs.readFileSync(`/proc/${pid}/environ`, 'utf8');

describe('in-process Chromium (dev/test)', () => {
  it('uses the same flags as the isolated browser host', () => {
    expect(CHROME_ARGS).toEqual(hostLib.CHROME_ARGS);
  });

  it.skipIf(process.platform !== 'linux')('gets an explicit minimal environment, never the process env and its secrets', async () => {
    const canary = `canary-${randomBytes(8).toString('hex')}`;
    process.env.APECHECK_TEST_SECRET = canary;
    const host = await BrowserHost.launch({ env: testEnv(), lookup: testLookup });
    try {
      const session = await host.newSession({ evmChainId: '0x1' });
      await (await session.newPage()).setContent('<p>hi</p>');
      const procs = chromiumOf(hostLib.processTree(process.pid));
      expect(procs.length).toBeGreaterThan(0);
      for (const p of procs) {
        const env = environ(p.pid);
        expect(env).not.toContain(canary);
        expect(env).not.toContain('DATABASE_URL=');
      }
      // child processes overwrite their environ with the process title; the browser process shows what it was given
      expect(environ(procs.find(p => p.type === 'browser')!.pid)).toContain('TZ=UTC');
      await session.close();
    } finally {
      delete process.env.APECHECK_TEST_SECRET;
      await host.close();
    }
    expect(Object.keys(chromeEnv({ HOME: '/h', DATABASE_URL: 'x', ANTHROPIC_API_KEY: 'k', DISPLAY: ':1' })).sort()).toEqual(['DISPLAY', 'HOME', 'LANG', 'PATH', 'TZ']);
  });

  it('is refused in production: Chromium only runs in the isolated browser host there', async () => {
    const env = testEnv({ NODE_ENV: 'production' });
    expect(browserIsolationProblem(env)).toMatch(/BROWSER_WS_ENDPOINT is not set/);
    await expect(BrowserHost.launch({ env })).rejects.toThrow(/BROWSER_WS_ENDPOINT is not set/);
    expect(browserIsolationProblem(testEnv({ NODE_ENV: 'production', BROWSER_WS_ENDPOINT: 'ws://127.0.0.1:9223/x' }))).toBeNull();
    expect(browserIsolationProblem(testEnv())).toBeNull();
  });
});

describe('sandbox verdict of a process tree', () => {
  const p = (pid: number, type: string, args: string[], seccomp: number | null): Proc => ({ pid, uid: 1, type, seccomp, args: ['/x/headless_shell', ...args] });

  it('accepts a sandboxed tree (the unsandboxed zygote for GPU/utility processes is normal)', () => {
    const tree = [p(1, 'root', ['--headless'], 0), p(2, 'zygote', ['--type=zygote', '--no-zygote-sandbox'], 0), p(3, 'renderer', ['--type=renderer'], 2)];
    expect(hostLib.sandboxProblems(tree)).toEqual([]);
  });

  it('flags --no-sandbox and other sandbox-off flags on any process', () => {
    for (const flag of hostLib.UNSAFE_FLAGS) {
      const problems = hostLib.sandboxProblems([p(1, 'root', [flag], 0), p(3, 'renderer', ['--type=renderer'], 2)]);
      expect(problems.join()).toContain(flag);
    }
  });

  it('flags a renderer outside seccomp-bpf, and a tree without a renderer when one is required', () => {
    expect(hostLib.sandboxProblems([p(1, 'root', [], 0), p(3, 'renderer', ['--type=renderer'], 0)]).join()).toMatch(/not under seccomp-bpf/);
    expect(hostLib.sandboxProblems([p(1, 'root', [], 0)]).join()).toMatch(/no renderer/);
    expect(hostLib.sandboxProblems([p(1, 'root', [], 0)], { requireRenderer: false })).toEqual([]);
  });

  it('requires a long random endpoint path', () => {
    expect(() => hostLib.readConfig({ BROWSER_WS_PATH: 'short' })).toThrow(/BROWSER_WS_PATH/);
    expect(() => hostLib.readConfig({})).toThrow(/BROWSER_WS_PATH/);
    const cfg = hostLib.readConfig({ BROWSER_WS_PATH: 'a'.repeat(32) });
    expect(cfg).toMatchObject({ port: 9223, forbiddenPorts: [5432, 6379] });
    expect(cfg.forbiddenPaths).toContain('/srv/apecheck/app/.env');
  });
});

/** Spawn the browser host; resolves with its port once it reports ready, rejects with its error output. */
function startHost(env: Record<string, string>, opts: { uid?: number } = {}): { child: ChildProcess; ready: Promise<number>; exited: Promise<{ code: number | null; output: string }> } {
  const child = spawn(process.execPath, [HOST_SCRIPT], {
    env,
    cwd: env.HOME,
    uid: opts.uid,
    gid: opts.uid,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  const exited = new Promise<{ code: number | null; output: string }>(resolve => child.once('exit', code => resolve({ code, output })));
  const ready = new Promise<number>((resolve, reject) => {
    const onData = (b: Buffer) => {
      output += b.toString();
      const m = /ready on ws:\/\/127\.0\.0\.1:(\d+)\//.exec(output);
      if (m) resolve(Number(m[1]));
    };
    child.stdout!.on('data', onData);
    child.stderr!.on('data', onData);
    void exited.then(({ code }) => reject(new Error(`browser host exited (${code}): ${output}`)));
  });
  ready.catch(() => undefined);
  return { child, ready, exited };
}

describe.skipIf(!isRoot || process.platform !== 'linux')('isolated browser host (deploy/browser/browser-host.cjs, as nobody)', () => {
  const wsPath = randomBytes(24).toString('hex');
  const canary = `canary-${randomBytes(8).toString('hex')}`;
  let home: string;
  let rootOnly: string;
  let site: FixtureSite;
  let hostProc: ChildProcess;
  let port: number;
  let guardPort: number;
  let host: BrowserHost;
  let env: ReturnType<typeof testEnv>;

  const hostEnv = (over: Record<string, string> = {}): Record<string, string> => ({
    PATH: '/usr/local/bin:/usr/bin:/bin',
    HOME: home,
    TMPDIR: home,
    NODE_PATH: WORKER_MODULES,
    PLAYWRIGHT_BROWSERS_PATH: process.env.PLAYWRIGHT_BROWSERS_PATH ?? '',
    BROWSER_WS_PATH: wsPath,
    BROWSER_PORT: '0',
    // the test machine has no browser firewall; the refusal is covered below with a port that is open
    BROWSER_FORBIDDEN_PORTS: '',
    BROWSER_FORBIDDEN_PATHS: rootOnly,
    APECHECK_TEST_SECRET: canary,
    ...over,
  });

  beforeAll(async () => {
    home = fs.mkdtempSync('/tmp/apecheck-browser-host-');
    fs.chownSync(home, NOBODY, NOBODY);
    rootOnly = path.join(fs.mkdtempSync('/tmp/apecheck-secret-'), '.env');
    fs.writeFileSync(rootOnly, 'SESSION_SECRET=x\n', { mode: 0o600 });
    site = await serveFixture('working-app');
    const started = startHost(hostEnv(), { uid: NOBODY });
    hostProc = started.child;
    port = await started.ready;
    guardPort = await closedPort();
    env = testEnv({ SSRF_ALLOW_HOSTS: site.host, BROWSER_WS_ENDPOINT: `ws://127.0.0.1:${port}/${wsPath}`, BROWSER_GUARD_PORT: String(guardPort) });
    host = await BrowserHost.launch({ env, lookup: testLookup });
  }, 120_000);

  afterAll(async () => {
    await host?.close();
    if (hostProc && hostProc.exitCode === null) {
      const gone = new Promise(r => hostProc.once('exit', r));
      hostProc.kill('SIGTERM');
      await gone;
    }
    await site?.close();
    if (home) fs.rmSync(home, { recursive: true, force: true });
    if (rootOnly) fs.rmSync(path.dirname(rootOnly), { recursive: true, force: true });
  });

  it('runs Stage B end to end through the remote browser, every context behind the guard on BROWSER_GUARD_PORT', async () => {
    expect(host.guard!.url).toBe(`http://127.0.0.1:${guardPort}`);
    const { run, steps } = standaloneRun({ env, sources: fakeSources(env), browser: host });
    run.siteUrl = site.url;
    run.domain = new URL(site.url).hostname;
    await browseStage(run);
    await steps.flush();
    expect(run.product!.launch.signal).toBe('ok');
    expect(run.product!.flow.signal).toBe('ok');
    expect(steps.rows.filter(r => r.screenshot).length).toBeGreaterThan(1);
  });

  it('Chromium runs as the browser user, with its sandbox on and none of the host environment', async () => {
    const session = await host.newSession({ evmChainId: '0x1' });
    await (await session.newPage()).goto(site.url);
    const tree = hostLib.processTree(hostProc.pid!);
    const procs = chromiumOf(tree);
    expect(procs.some(p => p.type === 'renderer')).toBe(true);
    expect(hostLib.sandboxProblems(tree)).toEqual([]);
    for (const p of procs) {
      expect(p.uid).toBe(NOBODY);
      expect(p.args).not.toContain('--no-sandbox');
      const env = environ(p.pid);
      expect(env).not.toContain(canary);
      expect(env).not.toContain(wsPath);
    }
    expect(procs.filter(p => p.type === 'renderer').every(p => p.seccomp === 2)).toBe(true);
    expect(environ(procs.find(p => p.type === 'browser')!.pid).split('\0').filter(Boolean).sort()).toEqual(
      expect.arrayContaining(['LANG=C.UTF-8', 'PATH=/usr/local/bin:/usr/bin:/bin', 'TZ=UTC']),
    );
    await session.close();
  });

  it('the guard still vets every request, loopback included', async () => {
    const ctx = await host.browser.newContext({ proxy: { server: host.guard!.url } });
    const res = await (await ctx.newPage()).goto(`http://127.0.0.1:${site.port}/`);
    expect(res?.status()).toBe(403);
    expect(host.guard!.blocked.some(b => b.host === '127.0.0.1')).toBe(true);
    await ctx.close();
  });

  it('checks on connect that the remote browser reaches the guard (a firewall/port mismatch fails loudly)', async () => {
    await expect(probeGuard(host.browser, host.guard!.url)).resolves.toBeUndefined();
    await expect(probeGuard(host.browser, `http://127.0.0.1:${await closedPort()}`)).rejects.toThrow(/cannot reach the guard proxy.*BROWSER_GUARD_PORT/);
  });

  it('a context created without a proxy fails closed', async () => {
    const ctx = await host.browser.newContext();
    await expect((await ctx.newPage()).goto(site.url, { timeout: 15_000 })).rejects.toThrow(/ERR_PROXY_CONNECTION_FAILED|ERR_TUNNEL_CONNECTION_FAILED|ERR_CONNECTION_REFUSED/);
    await ctx.close();
  });

  it('only the secret endpoint path connects, and connect errors never print it', async () => {
    await expect(chromium.connect(`ws://127.0.0.1:${port}/${'x'.repeat(48)}`, { timeout: 5000 })).rejects.toThrow();
    const wrong = 'y'.repeat(48);
    const err = await BrowserHost.launch({ env: testEnv({ BROWSER_WS_ENDPOINT: `ws://127.0.0.1:${port}/${wrong}`, BROWSER_GUARD_PORT: '0' }) }).catch((e: Error) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toMatch(/browser host unreachable/);
    expect((err as Error).message).not.toContain(wrong);
  });

  it('refuses to start as root, when it can read a forbidden path, reach a forbidden port, or has no secret path', async () => {
    const asRoot = startHost(hostEnv());
    expect(await asRoot.exited).toMatchObject({ code: 1, output: expect.stringMatching(/refusing to run as root/) });

    const readable = startHost(hostEnv({ BROWSER_FORBIDDEN_PATHS: `${rootOnly}:/etc/passwd` }), { uid: NOBODY });
    expect(await readable.exited).toMatchObject({ code: 1, output: expect.stringMatching(/can read \/etc\/passwd/) });

    const reachable = startHost(hostEnv({ BROWSER_FORBIDDEN_PORTS: String(site.port) }), { uid: NOBODY });
    expect(await reachable.exited).toMatchObject({ code: 1, output: expect.stringMatching(new RegExp(`can connect to 127\\.0\\.0\\.1:${site.port}.*firewall`)) });

    const noPath = startHost(hostEnv({ BROWSER_WS_PATH: 'short' }), { uid: NOBODY });
    expect(await noPath.exited).toMatchObject({ code: 1, output: expect.stringMatching(/BROWSER_WS_PATH/) });
  });
});
