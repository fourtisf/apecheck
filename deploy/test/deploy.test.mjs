/**
 * Deploy artifacts: the isolated browser host's unit, firewall, AppArmor profile and installer, and their
 * agreement with the app's config (HANDOFF §11, DEPLOY.md §6). Run from the repo root:
 *
 *   node --test deploy/test/deploy.test.mjs        (or: pnpm test:deploy)
 *
 * The browser host itself (sandbox, environment, refusals, Stage B through it) is exercised with real Chromium in
 * apps/worker/test/browser-isolation.test.ts. Checks that need root or a system tool skip without it.
 */
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const require = createRequire(import.meta.url);
const read = p => fs.readFileSync(path.join(root, p), 'utf8');
const has = cmd => spawnSync('sh', ['-c', `command -v ${cmd}`], { stdio: 'ignore' }).status === 0;
const isRoot = process.getuid?.() === 0;
const tmp = prefix => fs.mkdtempSync(path.join(os.tmpdir(), prefix));

const host = require(path.join(root, 'deploy/browser/browser-host.cjs'));
const UNIT = read('deploy/browser/apecheck-browser.service');
const NFT = read('deploy/browser/browser-firewall.nft');
const APPARMOR = read('deploy/browser/apparmor-apecheck-chromium');
const INSTALL = read('deploy/browser/install.sh');
const ENV_EXAMPLE = read('.env.example');

const envExample = key => new RegExp(`^${key}=([^\\s#]*)`, 'm').exec(ENV_EXAMPLE)?.[1];

test('ports, paths and the user agree across host, unit, firewall, installer, .env.example and the core env', () => {
  const nftGuardPort = /ip daddr 127\.0\.0\.1 tcp dport (\d+) accept/.exec(NFT)?.[1];
  assert.equal(nftGuardPort, '9224');
  assert.equal(envExample('BROWSER_GUARD_PORT'), nftGuardPort, '.env.example BROWSER_GUARD_PORT must be the port the firewall allows');
  assert.equal(/BROWSER_GUARD_PORT: int\((\d+)\)/.exec(read('packages/core/src/env.ts'))?.[1], nftGuardPort, 'core env default');

  assert.equal(host.DEFAULTS.port, 9223);
  assert.match(INSTALL, /^BROWSER_PORT=9223$/m);
  assert.equal(envExample('BROWSER_WS_ENDPOINT'), '', '.env.example leaves the endpoint to install.sh');

  assert.match(INSTALL, /^PREFIX=\/opt\/apecheck-browser$/m);
  assert.match(UNIT, /^ExecStart=\/usr\/bin\/node \/opt\/apecheck-browser\/browser-host\.cjs$/m);
  assert.match(UNIT, /PLAYWRIGHT_BROWSERS_PATH=\/opt\/apecheck-browser\/browsers/);
  assert.match(APPARMOR, /^profile apecheck-chromium \/opt\/apecheck-browser\/browsers\//m);
  assert.match(UNIT, /^ExecStartPre=\+\/usr\/sbin\/nft -f \/etc\/apecheck\/browser-firewall\.nft$/m);
  assert.match(INSTALL, /"\$ETC\/browser-firewall\.nft"/);
  assert.match(UNIT, /^EnvironmentFile=\/etc\/apecheck\/browser\.env$/m);

  assert.match(UNIT, /^User=apecheck-browser$/m);
  assert.match(NFT, /meta skuid "apecheck-browser" jump browser/);
  assert.match(INSTALL, /^BROWSER_USER=apecheck-browser$/m);

  // the app's data is hidden from the unit, and the host refuses to start if it could read it anyway
  assert.match(UNIT, /^InaccessiblePaths=.*-\/srv\/apecheck\b/m);
  assert.ok(host.DEFAULTS.forbiddenPaths.includes('/srv/apecheck/app/.env'));
  assert.deepEqual(host.DEFAULTS.forbiddenPorts, [5432, 6379]);
});

test('the unit keeps Chromium sandboxable and locked down', () => {
  // the sandbox needs user, pid and net namespaces; MemoryDenyWriteExecute would break V8's JIT
  assert.match(UNIT, /^RestrictNamespaces=user pid net$/m);
  assert.doesNotMatch(UNIT, /^MemoryDenyWriteExecute=/m);
  assert.doesNotMatch(UNIT, /^PrivateUsers=/m);
  for (const line of ['NoNewPrivileges=yes', 'ProtectSystem=strict', 'ProtectHome=yes', 'PrivateTmp=yes', 'CapabilityBoundingSet=', 'IPAddressDeny=any', 'IPAddressAllow=localhost']) {
    assert.match(UNIT, new RegExp(`^${line.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'm'), line);
  }
});

test('the unit is valid systemd (systemd-analyze verify, no warnings)', { skip: !has('systemd-analyze') && 'systemd-analyze not installed' }, () => {
  const dir = tmp('apecheck-unit-');
  try {
    const nft = has('nft') ? execFileSync('sh', ['-c', 'command -v nft'], { encoding: 'utf8' }).trim() : '/bin/true';
    const file = path.join(dir, 'apecheck-browser.service');
    fs.writeFileSync(file, UNIT.replace('/usr/bin/node', process.execPath).replace('/usr/sbin/nft', nft));
    const r = spawnSync('systemd-analyze', ['verify', file], { encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(`${r.stdout}${r.stderr}`.trim(), '', 'systemd-analyze reported problems');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('the firewall ruleset is valid nftables (nft -c)', { skip: !(isRoot && has('nft')) && 'needs root and nft' }, () => {
  const dir = tmp('apecheck-nft-');
  try {
    // the browser user only exists on the server; check the same rules for an existing one
    const file = path.join(dir, 'fw.nft');
    fs.writeFileSync(file, NFT.replaceAll('"apecheck-browser"', '"nobody"'));
    const r = spawnSync('nft', ['-c', '-f', file], { encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('the AppArmor profile parses', { skip: !has('apparmor_parser') && 'apparmor_parser not installed' }, () => {
  const r = spawnSync('apparmor_parser', ['-Q', '-K', '-T', path.join(root, 'deploy/browser/apparmor-apecheck-chromium')], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
});

test('install.sh is valid bash', () => {
  const r = spawnSync('bash', ['-n', path.join(root, 'deploy/browser/install.sh')], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
});

/** A minimal copy of the checkout for install.sh, with an .env owned by someone else. */
function appCopy(envBody) {
  const dir = tmp('apecheck-install-');
  const app = path.join(dir, 'app');
  fs.mkdirSync(path.join(app, 'deploy'), { recursive: true });
  fs.mkdirSync(path.join(app, 'apps/worker'), { recursive: true });
  fs.cpSync(path.join(root, 'deploy/browser'), path.join(app, 'deploy/browser'), { recursive: true });
  fs.copyFileSync(path.join(root, 'apps/worker/package.json'), path.join(app, 'apps/worker/package.json'));
  const env = path.join(app, '.env');
  fs.writeFileSync(env, envBody, { mode: 0o640 });
  fs.chmodSync(env, 0o640);
  fs.chownSync(env, 65534, 65534);
  return { dir, app, env, out: path.join(dir, 'out') };
}

function installSandboxed(c, runs = 1) {
  return spawnSync(path.join(root, 'deploy/test/install-sandboxed.sh'), [c.app, c.out, String(runs)], { encoding: 'utf8' });
}

const canSandbox = isRoot && has('unshare');

test('install.sh installs the host, its config, the unit and the .env endpoint, idempotently', { skip: !canSandbox && 'needs root and unshare' }, () => {
  const c = appCopy('NODE_ENV=production\nSESSION_SECRET=x\n');
  try {
    const r = installSandboxed(c, 2);
    const log = () => `${r.stderr}\n${fs.readFileSync(path.join(c.out, 'stdout.log'), 'utf8')}`;
    assert.equal(r.status, 0, log());
    const fsOut = p => path.join(c.out, 'fs', p);
    const calls = fs.readFileSync(path.join(c.out, 'calls.log'), 'utf8');

    // the exact Playwright the worker pins, its headless Chromium + system libs, in the root-owned prefix
    const pw = require(path.join(root, 'apps/worker/package.json')).dependencies.playwright;
    assert.deepEqual(JSON.parse(fs.readFileSync(fsOut('opt-apecheck-browser/package.json'), 'utf8')).dependencies, { 'playwright-core': pw });
    assert.equal(fs.readFileSync(fsOut('opt-apecheck-browser/browser-host.cjs'), 'utf8'), read('deploy/browser/browser-host.cjs'));
    assert.match(calls, /^npm install --prefix \/opt\/apecheck-browser .*--ignore-scripts/m);
    assert.match(calls, /^playwright-cli install --with-deps --only-shell chromium PLAYWRIGHT_BROWSERS_PATH=\/opt\/apecheck-browser\/browsers$/m);
    assert.match(calls, /^adduser --system --group --no-create-home .*apecheck-browser$/m);
    assert.match(calls, /^apparmor_parser -r \/etc\/apparmor\.d\/apecheck-chromium$/m);
    for (const c2 of ['daemon-reload', 'enable apecheck-browser.service', 'restart apecheck-browser.service']) assert.match(calls, new RegExp(`^systemctl ${c2}$`, 'm'));

    // root-only config with a long random endpoint secret, kept across runs
    const envFile = fsOut('etc-apecheck/browser.env');
    assert.equal(fs.statSync(envFile).mode & 0o777, 0o600);
    assert.equal(fs.statSync(fsOut('etc-apecheck')).mode & 0o777, 0o700);
    assert.equal(fs.statSync(fsOut('etc-apecheck/browser-firewall.nft')).mode & 0o777, 0o600);
    const browserEnv = fs.readFileSync(envFile, 'utf8');
    const wsPath = /^BROWSER_WS_PATH=([0-9a-f]{64})$/m.exec(browserEnv)?.[1];
    assert.ok(wsPath, browserEnv);
    assert.match(browserEnv, new RegExp(`^BROWSER_FORBIDDEN_PATHS=.*:${c.app.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/\\.env:`, 'm'));
    assert.doesNotThrow(() => host.readConfig(Object.fromEntries(browserEnv.split('\n').filter(l => /^[A-Z_]+=/.test(l)).map(l => l.split(/=(.*)/s).slice(0, 2)))));

    // the unit points at the node that is installed
    assert.match(fs.readFileSync(fsOut('apecheck-browser.service'), 'utf8'), new RegExp(`^ExecStart=${process.execPath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} /opt/apecheck-browser/browser-host\\.cjs$`, 'm'));

    // the app's .env gets the endpoint once, with its owner and mode unchanged
    const appEnv = fs.readFileSync(c.env, 'utf8');
    assert.equal(appEnv.match(/^BROWSER_WS_ENDPOINT=/gm)?.length, 1, appEnv);
    assert.match(appEnv, new RegExp(`^BROWSER_WS_ENDPOINT=ws://127\\.0\\.0\\.1:9223/${wsPath}$`, 'm'));
    assert.match(appEnv, /^SESSION_SECRET=x$/m);
    const st = fs.statSync(c.env);
    assert.deepEqual([st.uid, st.gid, st.mode & 0o777], [65534, 65534, 0o640]);
  } finally {
    fs.rmSync(c.dir, { recursive: true, force: true });
  }
});

test('install.sh refuses a BROWSER_GUARD_PORT the firewall does not allow, before changing anything', { skip: !canSandbox && 'needs root and unshare' }, () => {
  const c = appCopy('NODE_ENV=production\nBROWSER_GUARD_PORT=9999\n');
  try {
    const r = installSandboxed(c);
    assert.notEqual(r.status, 0);
    assert.match(fs.readFileSync(path.join(c.out, 'stdout.log'), 'utf8'), /BROWSER_GUARD_PORT=9999 in \.env but browser-firewall\.nft allows 9224/);
    assert.equal(fs.readFileSync(path.join(c.out, 'calls.log'), 'utf8'), '');
    assert.equal(fs.existsSync(path.join(c.out, 'fs/etc-apecheck')), false);
  } finally {
    fs.rmSync(c.dir, { recursive: true, force: true });
  }
});

test('ecosystem.config.cjs: five PM2 apps from the repo, Chromium in none of them', () => {
  const { apps } = require(path.join(root, 'ecosystem.config.cjs'));
  assert.deepEqual(apps.map(a => a.name), ['web', 'api', 'worker-checks', 'worker-bot', 'worker-prices']);
  for (const a of apps) assert.equal(a.uid, undefined, `${a.name}: PM2 runs as the app user and cannot switch users`);
  const checks = apps.find(a => a.name === 'worker-checks');
  assert.equal(checks.script, 'src/checks.ts');
  assert.equal(checks.max_memory_restart, '1G', 'Chromium lives in apecheck-browser.service (MemoryMax there)');
});

test('DEPLOY.md installs the browser host and keeps Chromium current', () => {
  const md = read('DEPLOY.md');
  assert.match(md, /sudo \/srv\/apecheck\/app\/deploy\/browser\/install\.sh/);
  assert.match(md, /^## 13\. Keeping Chromium current/m);
  assert.match(md, /chmod 0?750 \/srv\/apecheck/);
  const install = md.slice(md.indexOf('## 5.'), md.indexOf('## 6.'));
  assert.doesNotMatch(install, /exec playwright install|bin\/playwright install/, 'the app user no longer gets its own Chromium on the server');
});
