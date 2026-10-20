#!/usr/bin/env node
'use strict';
/**
 * ApeCheck isolated browser host (HANDOFF §11, DEPLOY.md §6).
 *
 * The browser agent opens attacker-chosen pages, so in production Chromium never runs inside worker-checks. This
 * standalone script runs it instead, under systemd (apecheck-browser.service) as the dedicated `apecheck-browser`
 * user, which cannot read the app tree, .env, the PM2 home or the backup credentials, and whose only network egress
 * is worker-checks' SSRF guard proxy (browser-firewall.nft). worker-checks connects with Playwright
 * (BROWSER_WS_ENDPOINT) and gives every check context the guard as its proxy.
 *
 * Guarantees, checked at startup (the service refuses to start otherwise) and every 30 s afterwards:
 *  - not root, and none of BROWSER_FORBIDDEN_PATHS (.env, app tree, backups) is readable by this process;
 *  - none of BROWSER_FORBIDDEN_PORTS (Postgres, Redis, ...) on 127.0.0.1 can be reached (the firewall is applied);
 *  - Chromium runs with its own sandbox (chromiumSandbox: true): no --no-sandbox anywhere in the process tree and
 *    every renderer under seccomp-bpf (Seccomp: 2 in /proc/<pid>/status);
 *  - Chromium gets an explicit minimal environment, never this process's variables;
 *  - a context created without a proxy fails closed (the launch-level proxy is a dead port);
 *  - Playwright's HTTP side answers only GET / (never GET /json, which tells anyone BROWSER_WS_PATH; hidingWsPath).
 * Who may connect to the port at all (the app user and root) is browser-firewall.nft's job.
 *
 * It depends only on playwright-core (installed next to it in /opt/apecheck-browser by deploy/browser/install.sh,
 * the exact version apps/worker pins) and reads only its own environment (/etc/apecheck/browser.env):
 *   BROWSER_WS_PATH          required, ≥ 32 random chars [A-Za-z0-9_-]; the endpoint is ws://127.0.0.1:<port>/<path>
 *   BROWSER_PORT             default 9223 (0 = any free port, tests)
 *   BROWSER_FORBIDDEN_PATHS  ':'-separated, default /srv/apecheck:/srv/apecheck/app/.env:/var/backups/apecheck
 *   BROWSER_FORBIDDEN_PORTS  ','-separated, default 5432,6379 (empty disables the check, tests only)
 *   PLAYWRIGHT_BROWSERS_PATH where the Chromium build lives (/opt/apecheck-browser/browsers)
 *
 * Keep CHROME_ARGS identical to apps/worker/src/browser/browser.ts (apps/worker/test/browser-isolation.test.ts
 * enforces it): dev and tests launch Chromium in-process with the same flags.
 */
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');

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

/** Flags that switch Chromium's sandbox off or weaken it; none may appear on any process of the tree. */
const UNSAFE_FLAGS = ['--no-sandbox', '--disable-seccomp-filter-sandbox', '--disable-namespace-sandbox', '--single-process', '--no-zygote', '--in-process-gpu'];

/**
 * The launch-level proxy. worker-checks sets the guard as each context's proxy; anything else (a context created
 * without one, browser-level background requests) goes to this dead port and fails.
 */
const FAIL_CLOSED_PROXY = 'http://127.0.0.1:9';

const DEFAULTS = {
  port: 9223,
  forbiddenPaths: ['/srv/apecheck', '/srv/apecheck/app/.env', '/var/backups/apecheck'],
  forbiddenPorts: [5432, 6379],
};

const WATCH_MS = 30_000;

function log(level, msg) {
  (level === 'error' ? console.error : console.log)(`[apecheck-browser] ${level.toUpperCase()} ${msg}`);
}

function loadPlaywright() {
  for (const name of ['playwright-core', 'playwright']) {
    try {
      return require(name);
    } catch (e) {
      if (!(e && e.code === 'MODULE_NOT_FOUND' && String(e.message).includes(`'${name}'`))) throw e;
    }
  }
  throw new Error('playwright-core is not installed next to browser-host.cjs (run deploy/browser/install.sh)');
}

function list(value, sep) {
  return String(value).split(sep).map(s => s.trim()).filter(Boolean);
}

/** Parse the host's own environment (see the header). Throws with an operator-readable message. */
function readConfig(env = process.env) {
  const wsPath = (env.BROWSER_WS_PATH || '').trim().replace(/^\/+/, '');
  if (!/^[A-Za-z0-9_-]{32,}$/.test(wsPath)) {
    throw new Error('BROWSER_WS_PATH must be a random token of at least 32 characters [A-Za-z0-9_-] (deploy/browser/install.sh writes one)');
  }
  const rawPort = (env.BROWSER_PORT || '').trim();
  const port = rawPort === '' ? DEFAULTS.port : Number(rawPort);
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error(`BROWSER_PORT=${rawPort} is not a port`);
  const forbiddenPaths = env.BROWSER_FORBIDDEN_PATHS == null ? DEFAULTS.forbiddenPaths : list(env.BROWSER_FORBIDDEN_PATHS, ':');
  const forbiddenPorts = env.BROWSER_FORBIDDEN_PORTS == null ? DEFAULTS.forbiddenPorts : list(env.BROWSER_FORBIDDEN_PORTS, ',').map(Number);
  if (forbiddenPorts.some(p => !Number.isInteger(p) || p <= 0 || p > 65535)) throw new Error(`BROWSER_FORBIDDEN_PORTS=${env.BROWSER_FORBIDDEN_PORTS} is not a port list`);
  return { wsPath, port, forbiddenPaths, forbiddenPorts };
}

/**
 * Chromium's whole environment. Never this process's variables: whatever runs in an exploited renderer or browser
 * process can read its own environ, so it gets nothing that isn't needed to start a headless browser.
 */
function browserEnv(home) {
  return {
    PATH: '/usr/local/bin:/usr/bin:/bin',
    HOME: home,
    TMPDIR: home,
    XDG_CONFIG_HOME: path.join(home, '.config'),
    XDG_CACHE_HOME: path.join(home, '.cache'),
    TZ: 'UTC',
    LANG: 'C.UTF-8',
  };
}

/** The forbidden paths this process can read (it must not be able to read any). */
function readableForbidden(paths) {
  return paths.filter(p => {
    try {
      fs.accessSync(p, fs.constants.R_OK);
      return true;
    } catch {
      return false;
    }
  });
}

/** The forbidden local ports that accept a TCP connection from this process (the firewall must refuse all). */
async function reachablePorts(ports, host = '127.0.0.1', timeoutMs = 2000) {
  const results = await Promise.all(
    ports.map(
      port =>
        new Promise(resolve => {
          const s = net.connect({ host, port });
          const done = ok => {
            s.destroy();
            resolve(ok ? port : null);
          };
          s.setTimeout(timeoutMs, () => done(false));
          s.once('connect', () => done(true));
          s.once('error', () => done(false));
        }),
    ),
  );
  return results.filter(p => p != null);
}

function readProc(procDir, pid, file) {
  try {
    return fs.readFileSync(path.join(procDir, String(pid), file), 'utf8');
  } catch {
    return null;
  }
}

/**
 * `rootPid` and all its descendants: { pid, ppid, uid, args, type, seccomp }. Chromium rewrites the title of its
 * child processes into one space-separated string, so arguments are split on NUL and spaces.
 */
function processTree(rootPid, procDir = '/proc') {
  const all = new Map();
  for (const name of fs.readdirSync(procDir)) {
    if (!/^\d+$/.test(name)) continue;
    const stat = readProc(procDir, name, 'stat');
    if (!stat) continue;
    const ppid = Number(stat.slice(stat.lastIndexOf(')') + 2).split(' ')[1]);
    all.set(Number(name), ppid);
  }
  const pids = new Set([rootPid]);
  for (let grew = true; grew; ) {
    grew = false;
    for (const [pid, ppid] of all) {
      if (!pids.has(pid) && pids.has(ppid)) {
        pids.add(pid);
        grew = true;
      }
    }
  }
  const tree = [];
  for (const pid of pids) {
    const cmdline = readProc(procDir, pid, 'cmdline');
    const status = readProc(procDir, pid, 'status');
    if (cmdline == null || status == null) continue;
    const args = cmdline.split(/[\0 ]+/).filter(Boolean);
    const type = (args.find(a => a.startsWith('--type=')) || '').slice('--type='.length) || (pid === rootPid ? 'root' : 'browser');
    const seccomp = /^Seccomp:\s*(\d+)/m.exec(status);
    const uid = /^Uid:\s*(\d+)/m.exec(status);
    tree.push({ pid, ppid: all.get(pid) ?? 0, uid: uid ? Number(uid[1]) : null, args, type, seccomp: seccomp ? Number(seccomp[1]) : null });
  }
  return tree;
}

/**
 * What is wrong with a Chromium process tree's sandboxing (empty = fine): unsafe flags on any process, a renderer
 * not under seccomp-bpf, and (requireRenderer) no renderer at all to judge by.
 */
function sandboxProblems(tree, { requireRenderer = true } = {}) {
  const problems = [];
  for (const p of tree) {
    const bad = p.args.filter(a => UNSAFE_FLAGS.includes(a));
    if (bad.length) problems.push(`pid ${p.pid} (${p.type}) runs with ${bad.join(' ')}`);
  }
  const renderers = tree.filter(p => p.type === 'renderer');
  if (requireRenderer && renderers.length === 0) problems.push('no renderer process found to verify');
  for (const r of renderers) {
    if (r.seccomp !== 2) problems.push(`renderer pid ${r.pid} is not under seccomp-bpf (Seccomp: ${r.seccomp ?? 'unknown'})`);
  }
  return problems;
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

/**
 * Run `launch` (chromium.launchServer) with every HTTP server it creates answering plain requests for `/` only, and
 * resolve to { result, servers }: its result and how many servers got that filter (Playwright creates exactly one).
 * Playwright answers GET /json with { wsEndpointPath }, i.e. BROWSER_WS_PATH, to anything that connects
 * (playwright-core lib/remote/playwrightServer.js), and chromium.connect('http://127.0.0.1:9223') uses just that to
 * find the endpoint. Nothing of ours needs it: worker-checks connects to the full ws:// endpoint (a WebSocket upgrade,
 * which Playwright matches against the path and which this leaves alone) and the doctor only fetches GET /.
 */
async function hidingWsPath(launch) {
  const http = require('node:http');
  const createServer = http.createServer;
  let servers = 0;
  http.createServer = (...args) => {
    const i = args.findIndex(a => typeof a === 'function');
    if (i >= 0) {
      const onRequest = args[i];
      args[i] = function (req, res) {
        if (req.url === '/') return onRequest.call(this, req, res);
        res.statusCode = 404;
        res.end();
      };
      servers++;
    }
    return createServer(...args);
  };
  try {
    return { result: await launch(), servers };
  } finally {
    http.createServer = createServer;
  }
}

function launchOptions(home) {
  return {
    headless: true,
    chromiumSandbox: true,
    args: CHROME_ARGS,
    env: browserEnv(home),
    proxy: { server: FAIL_CLOSED_PROXY },
  };
}

/**
 * Launch a throwaway browser with the served browser's exact options, render a page and check its renderers.
 * Chromium refuses to start without a usable sandbox when chromiumSandbox is on, so a failure usually shows up
 * here as a launch error naming the cause (e.g. the AppArmor userns profile is missing).
 */
async function probeSandbox(chromium, home) {
  const browser = await chromium.launch(launchOptions(home));
  const version = browser.version();
  try {
    const page = await browser.newPage();
    await page.setContent('<!doctype html><p>sandbox self-check</p>');
    let problems = [];
    for (let i = 0; i < 50; i++) {
      problems = sandboxProblems(processTree(process.pid));
      if (!problems.includes('no renderer process found to verify')) break;
      await sleep(100);
    }
    return { problems, version };
  } finally {
    await browser.close().catch(() => undefined);
  }
}

async function main() {
  if (typeof process.getuid === 'function' && process.getuid() === 0) {
    throw new Error('refusing to run as root: Chromium must run as the unprivileged apecheck-browser user (DEPLOY.md §6)');
  }
  const cfg = readConfig();
  const readable = readableForbidden(cfg.forbiddenPaths);
  if (readable.length) {
    throw new Error(`this user can read ${readable.join(', ')}: run as the apecheck-browser user with /srv/apecheck mode 0750 (DEPLOY.md §2, §6)`);
  }
  const reachable = await reachablePorts(cfg.forbiddenPorts);
  if (reachable.length) {
    throw new Error(`this user can connect to 127.0.0.1:${reachable.join(', 127.0.0.1:')}: the browser firewall (browser-firewall.nft) is not applied`);
  }

  const { chromium } = loadPlaywright();
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'apecheck-browser-'));
  const probe = await probeSandbox(chromium, home);
  if (probe.problems.length) throw new Error(`Chromium sandbox self-check failed: ${probe.problems.join('; ')}`);

  const { result: server, servers } = await hidingWsPath(() =>
    chromium.launchServer({ ...launchOptions(home), host: '127.0.0.1', port: cfg.port, wsPath: `/${cfg.wsPath}` }),
  );
  if (servers !== 1) {
    await server.close().catch(() => undefined);
    throw new Error(`Playwright created ${servers} HTTP servers for launchServer, not the 1 whose GET /json browser-host.cjs hides (it tells anyone who connects BROWSER_WS_PATH): update hidingWsPath for this Playwright version`);
  }
  const browserPid = server.process().pid;
  const check = () => sandboxProblems(processTree(browserPid), { requireRenderer: false });
  const first = check();
  if (first.length) {
    await server.close().catch(() => undefined);
    throw new Error(`Chromium sandbox self-check failed: ${first.join('; ')}`);
  }

  let stopping = false;
  server.on('close', (code, signal) => {
    if (stopping) return;
    log('error', `Chromium exited (code ${code}, signal ${signal}); exiting so systemd restarts the host`);
    process.exit(1);
  });
  const watch = setInterval(() => {
    const problems = check();
    if (problems.length === 0) return;
    log('error', `sandbox check failed, stopping: ${problems.join('; ')}`);
    stopping = true;
    void server.kill().finally(() => process.exit(1));
  }, WATCH_MS);
  watch.unref();

  const shutdown = () => {
    if (stopping) return;
    stopping = true;
    clearInterval(watch);
    server.close().catch(() => undefined).finally(() => process.exit(0));
  };
  process.once('SIGTERM', shutdown);
  process.once('SIGINT', shutdown);

  const port = new URL(server.wsEndpoint()).port;
  log('info', `ready on ws://127.0.0.1:${port}/<BROWSER_WS_PATH> as uid ${process.getuid()}; Chromium ${probe.version} (pid ${browserPid}), sandbox verified`);
}

module.exports = {
  CHROME_ARGS,
  UNSAFE_FLAGS,
  FAIL_CLOSED_PROXY,
  DEFAULTS,
  readConfig,
  browserEnv,
  readableForbidden,
  reachablePorts,
  processTree,
  sandboxProblems,
  hidingWsPath,
  main,
};

if (require.main === module) {
  main().catch(e => {
    log('error', e && e.message ? e.message : String(e));
    process.exit(1);
  });
}
