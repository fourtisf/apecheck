/**
 * `pnpm diagnose`: a read-only check of every dependency the check pipeline needs, run on the server as the app user
 * (DEPLOY.md "Doctor"). Every probe goes through the code the workers run (createSources(env) and its shared Http,
 * the SSRF guard, the worker's AnthropicAi, Prisma, ioredis, Playwright), has its own timeout, and writes nothing:
 * no database rows, no queue jobs, no posts. The output shows hosts only; keys and secret paths are redacted.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Redis } from 'ioredis';
import { chromium, type Browser } from 'playwright';
import { CHAINS, type Env } from '@apecheck/core';
import { envFilePath, findRepoRoot } from '@apecheck/core/node';
import { PrismaClient } from '@apecheck/db';
import { createHttp, createSources, type Http } from '@apecheck/sources';
import { AI_KEY_REMEDY, aiModeText, doctorAi, probeAi } from './ai';
import {
  DEXSCREENER_REMEDY, FOURTIS_REMEDY, GITHUB_REMEDY, X_BOT_REMEDY, X_READ_REMEDY,
  probeDexScreener, probeFourtis, probeGitHub, probeXBot, probeXRead,
} from './apis';
import {
  ETHERSCAN_REMEDY, EVM_PROBE_CHAINS, EVM_REMEDY, SOLANA_REMEDY, TRON_REMEDY,
  endpointRows, probeEtherscan, probeEvm, probeRobinhood, probeSolana, probeTron,
} from './chains';
import {
  BROWSER_GUARD_REMEDY, BROWSER_HOST_REMEDY, POSTGRES_REMEDY, REDIS_REMEDY, WEB_REMEDY,
  firewallGuardPort, migrationNames, prismaDbInfo, probeBrowserGuard, probeBrowserHost, probeGuardEgress, probeGuardedFetch,
  probePostgres, probeRedis, type DbInfo, type RedisLike,
} from './infra';
import { Redactor, WS_PATH_LABEL, hostOf } from './redact';
import { formatReport } from './report';
import { errorText, exitCode, runProbes, type Probe, type ProbeResult } from './result';
import { GECKOTERMINAL_REMEDY, probeGeckoTerminal } from './gecko';

export { Redactor } from './redact';
export { exitCode, runProbe, runProbes, classify } from './result';

type DoctorSources = Pick<ReturnType<typeof createSources>, 'evm' | 'sol' | 'tron' | 'dex' | 'github' | 'x' | 'fourtis'>;

export interface DoctorDeps {
  env: Env;
  http: Http;
  sources: DoctorSources;
  db: DbInfo;
  redis: RedisLike;
  /** migrations this checkout ships */
  migrations: string[];
  /** the guard port in deploy/browser/browser-firewall.nft */
  firewallPort: number | null;
  browser: () => Promise<Browser>;
}

/** One probe per dependency (per chain for the RPCs), in the order the table shows them. */
export function buildProbes(d: DoctorDeps): Probe[] {
  const { env, http, sources } = d;
  const probes: Probe[] = [
    { name: 'Postgres', timeoutMs: 10_000, remedy: POSTGRES_REMEDY, run: () => probePostgres(d) },
    { name: 'Redis', timeoutMs: 10_000, remedy: REDIS_REMEDY, run: () => probeRedis(d) },
    { name: 'Website fetch (SSRF guard)', remedy: WEB_REMEDY, run: () => probeGuardedFetch(d) },
    { name: 'SSRF guard egress', remedy: WEB_REMEDY, run: () => probeGuardEgress(d) },
    { name: 'Browser host', timeoutMs: 30_000, remedy: BROWSER_HOST_REMEDY, run: () => probeBrowserHost(d) },
    { name: 'Browser via guard', timeoutMs: 45_000, remedy: BROWSER_GUARD_REMEDY, run: () => probeBrowserGuard(d) },
  ];
  if (env.ANTHROPIC_API_KEY) {
    const ai = doctorAi(env);
    probes.push(
      { name: `AI judge (${env.AI_MODEL_JUDGE})`, timeoutMs: 45_000, remedy: AI_KEY_REMEDY, run: () => probeAi('judge', { env, ai }) },
      { name: `AI fast (${env.AI_MODEL_FAST})`, timeoutMs: 45_000, remedy: AI_KEY_REMEDY, run: () => probeAi('fast', { env, ai }) },
    );
  } else {
    probes.push({ name: 'AI (Anthropic)', remedy: AI_KEY_REMEDY, run: () => probeAi('fast', { env }) });
  }
  for (const chain of EVM_PROBE_CHAINS) {
    probes.push({ name: `RPC ${CHAINS[chain].name}`, timeoutMs: 30_000, remedy: EVM_REMEDY[chain], run: () => probeEvm(chain, { env, http, evm: sources.evm }) });
  }
  probes.push(
    { name: `RPC ${CHAINS.rh.name}`, remedy: EVM_REMEDY.rh, run: () => probeRobinhood(d) },
    { name: 'Etherscan V2', timeoutMs: 40_000, remedy: ETHERSCAN_REMEDY, run: () => probeEtherscan({ env, evm: sources.evm }) },
    { name: 'RPC Solana', timeoutMs: 30_000, remedy: SOLANA_REMEDY, run: () => probeSolana({ env, sol: sources.sol }) },
    { name: 'TronGrid', timeoutMs: 30_000, remedy: TRON_REMEDY, run: () => probeTron({ env, http, tron: sources.tron }) },
    { name: 'DexScreener', remedy: DEXSCREENER_REMEDY, run: () => probeDexScreener({ env, dex: sources.dex }) },
    { name: 'GeckoTerminal', remedy: GECKOTERMINAL_REMEDY, run: () => probeGeckoTerminal(sources as Parameters<typeof probeGeckoTerminal>[0]) },
    { name: 'GitHub', timeoutMs: 30_000, remedy: GITHUB_REMEDY, run: () => probeGitHub({ env, http, github: sources.github }) },
    { name: 'X reads (Bearer)', timeoutMs: 30_000, remedy: X_READ_REMEDY, run: () => probeXRead({ env, http, x: sources.x }) },
    { name: 'X bot (OAuth 1.0a)', remedy: X_BOT_REMEDY, run: () => probeXBot({ env, http }) },
    { name: 'Fourtis', timeoutMs: 30_000, remedy: FOURTIS_REMEDY, run: () => probeFourtis({ env, http, fourtis: sources.fourtis }) },
  );
  return probes;
}

export interface HeaderInfo {
  envFile: string;
  envFileExists: boolean;
  user: string;
  now: Date;
}

/** What the workers will run with: env file, mode, AI mode, egress and every chain endpoint (hosts only). */
export function headerLines(env: Env, info: HeaderInfo): string[] {
  const prod = env.NODE_ENV === 'production';
  const asUser = prod && info.user !== 'apecheck' ? ' (PM2 runs as apecheck: sudo -iu apecheck, then cd /srv/apecheck/app && pnpm diagnose)' : '';
  const rows = endpointRows(env);
  const w1 = Math.max(...rows.map(r => r[0].length));
  const w2 = Math.max(...rows.map(r => r[1].length));
  return [
    `ApeCheck doctor (read-only), ${info.now.toISOString()}`,
    `  env file   ${info.envFile}${info.envFileExists ? '' : ' (missing: the inherited environment is used)'}`,
    `  NODE_ENV   ${env.NODE_ENV}, running as ${info.user}${asUser}`,
    `  AI mode    ${aiModeText(env)}`,
    `  outbound   ${env.OUTBOUND_PROXY ? `through OUTBOUND_PROXY ${hostOf(env.OUTBOUND_PROXY)} (keep it empty in production, DEPLOY.md)` : 'direct (OUTBOUND_PROXY empty)'}`,
    '  endpoints  (host only)',
    ...rows.map(([label, host, source]) => `    ${label.padEnd(w1)}  ${host.padEnd(w2)}  ${source}`),
  ];
}

/** Every adapter warns once at construction about a missing key; the table says the same, so keep the output to it. */
function quietly<T>(fn: () => T): T {
  const warn = console.warn;
  console.warn = () => undefined;
  try {
    return fn();
  } finally {
    console.warn = warn;
  }
}

/** chromium.connect with the endpoint's secret path kept out of any error message (as browser.ts connectRemote). */
async function connectBrowser(endpoint: string): Promise<Browser> {
  const secret = new URL(endpoint).pathname;
  try {
    return await chromium.connect(endpoint, { timeout: 15_000 });
  } catch (e) {
    const msg = errorText(e);
    throw new Error(secret.length > 1 ? msg.split(secret).join(WS_PATH_LABEL) : msg);
  }
}

const settle = <T>(p: Promise<T>, ms: number) => Promise.race([p.then(() => undefined, () => undefined), new Promise<void>(r => setTimeout(r, ms).unref())]);

export interface DoctorRun {
  report: string;
  results: ProbeResult[];
  code: 0 | 1;
}

/** Build the real dependencies from env, run every probe, close what was opened. Never throws for a probe's sake. */
export async function runDoctor(env: Env, opts: { now?: Date } = {}): Promise<DoctorRun> {
  const root = findRepoRoot();
  const redact = new Redactor(env);
  const http = createHttp(env);
  const sources = quietly(() => createSources(env, { http }));
  const prisma = new PrismaClient({ datasourceUrl: env.DATABASE_URL, log: [] });
  const redis = new Redis(env.REDIS_URL, {
    lazyConnect: false,
    connectTimeout: 5_000,
    maxRetriesPerRequest: 1,
    enableOfflineQueue: true,
    retryStrategy: () => null,
  });
  // ioredis reports the reason (ECONNREFUSED, WRONGPASS) as an 'error' event and fails the command with
  // "Connection is closed": keep the reason for the Redis row (and without a listener it is printed as unhandled)
  let redisError = '';
  redis.on('error', (e: unknown) => {
    redisError = errorText(e);
  });
  const redisLike: RedisLike = {
    ping: () =>
      redis.ping().catch((e: unknown) => {
        throw new Error(redisError || errorText(e));
      }),
    info: section => redis.info(section),
    call: (command, ...args) => redis.call(command, ...args),
  };
  const conn: { browser: Promise<Browser> | null } = { browser: null };
  const deps: DoctorDeps = {
    env,
    http,
    sources,
    db: prismaDbInfo(prisma),
    redis: redisLike,
    migrations: migrationNames(path.join(root, 'packages/db/prisma/migrations')),
    firewallPort: firewallGuardPort(path.join(root, 'deploy/browser/browser-firewall.nft')),
    browser: () => (conn.browser ??= connectBrowser(env.BROWSER_WS_ENDPOINT ?? '')),
  };

  let user = '?';
  try {
    user = os.userInfo().username;
  } catch {
    user = process.env.USER ?? '?';
  }
  const envFile = envFilePath(root);
  const header = headerLines(env, { envFile, envFileExists: fs.existsSync(envFile), user, now: opts.now ?? new Date() });

  try {
    const results = await runProbes(buildProbes(deps));
    return { report: formatReport(header, results, s => redact.text(s)), results, code: exitCode(results) };
  } finally {
    // a hung close must not keep the command alive
    await Promise.all([
      settle(prisma.$disconnect(), 3_000),
      settle(redis.quit(), 2_000).then(() => redis.disconnect()),
      conn.browser ? settle(conn.browser.then(b => b.close()), 3_000) : Promise.resolve(),
    ]);
  }
}
