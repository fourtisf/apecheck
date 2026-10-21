/**
 * The pipeline when things run late or twice: abandoned stages, a coin whose Stage D ran short, model
 * fallbacks, re-runs of a stalled job, a run that lost its check to another run, checks that would never
 * finish. Real Postgres / Redis db 2 / Chromium, FakeSources, heuristic AI.
 */
import { Redis } from 'ioredis';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { checkChannel, scoreCheck, scoreCoin, sigFromDb, claimStatusFromDb, type CheckChannelMsg, type CheckEvidence, type Judged, type Signal } from '@apecheck/core';
import { ResilientAi, type AiAdapter } from '../src/ai';
import { BrowserHost } from '../src/browser/browser';
import { memoryLogger } from '../src/log';
import { recoverStaleChecks, runCheck, type PipelineDeps } from '../src/pipeline';
import { finalJudgement } from '../src/pipeline/judge';
import { scoredSignals } from '../src/pipeline/signals';
import { BrowserPool, checkBrowserAtStartup } from '../src/worker';
import { serveFixture, testLookup, type FixtureSite } from './fixture-server';
import { dexInfo, fakeSources, repoFacts, xUser, type FakeData } from './fakes';
import { createCheck, heuristicAi, prisma, resetDb, standaloneRun, testEnv } from './helpers';

const PNG = Buffer.from('89504e470d0a1a0a0000000d4948445200000001000000010806000000', 'hex');
const COIN = '0x3333333333333333333333333333333333333333';
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

let host: BrowserHost;
let env: ReturnType<typeof testEnv>;
let redis: Redis;
let sub: Redis;
const sites = new Map<string, FixtureSite>();
const messages: { channel: string; msg: CheckChannelMsg }[] = [];

function deps(data: FakeData = {}, ai: AiAdapter = heuristicAi()): PipelineDeps {
  return { env, prisma, redis, sources: fakeSources(env, data), ai, browser: async () => host, log: memoryLogger(), fetchCard: async () => PNG };
}

beforeAll(async () => {
  for (const n of ['working-app', 'waitlist']) sites.set(n, await serveFixture(n));
  env = testEnv({ SSRF_ALLOW_HOSTS: [...sites.values()].map(s => s.host).join(',') });
  host = await BrowserHost.launch({ env, lookup: testLookup });
  redis = new Redis(process.env.REDIS_URL!);
  sub = new Redis(process.env.REDIS_URL!);
  sub.on('pmessage', (_p, channel, raw) => messages.push({ channel, msg: JSON.parse(raw) }));
  await sub.psubscribe('check:*');
});

afterAll(async () => {
  await host?.close();
  for (const s of sites.values()) await s.close();
  await sub?.quit();
  await redis?.quit();
  await prisma.$disconnect();
});

beforeEach(async () => {
  await resetDb();
  messages.length = 0;
});

async function stored(checkId: string) {
  return prisma.check.findUniqueOrThrow({
    where: { id: checkId },
    include: { steps: { orderBy: { idx: 'asc' } }, claims: { orderBy: { idx: 'asc' } }, coinFacts: { include: { deployer: true } }, target: true },
  });
}

const sig = (v: string | null) => sigFromDb(v) as Signal;

describe('Stage A abandoned at its timeout', () => {
  it('a lookup that answers after the timeout adds no step, changes no field and never re-keys the Target', async () => {
    // an earlier check owns the canonical key the late answer would point to
    const owner = await prisma.target.create({ data: { key: `ca:base:${COIN}`, kind: 'COIN', chain: 'BASE', ca: COIN, name: '$LATE', checkCount: 1 } });
    const check = await createCheck(COIN);
    const d = deps({ evmChains: { [COIN]: 'base' }, dexTokens: { [COIN]: dexInfo({ chain: 'base', address: COIN, websites: ['https://orbit-late.xyz'] }) } });
    const detect = d.sources.evm.detectChain.bind(d.sources.evm);
    d.sources.evm.detectChain = vi.fn(async (a: string) => {
      await sleep(3000);
      return detect(a);
    });
    d.limits = { resolve: 2000 };
    expect((await runCheck(check.id, d)).status).toBe('done');
    const before = await stored(check.id);
    expect(before.steps.some(s => s.status === 'WARN' && /^Resolving the target timed out/.test(s.text))).toBe(true);
    // the late answer arrives after the check is done
    await sleep(2500);
    const after = await stored(check.id);
    expect(after.steps.map(s => [s.idx, s.text])).toEqual(before.steps.map(s => [s.idx, s.text]));
    expect(after.steps.some(s => /^Contract on Base|^Website from token metadata/.test(s.text))).toBe(false);
    expect(after.targetId).toBe(before.targetId);
    expect(after.target.key).toBe(`ca:evm:${COIN}`);
    expect((await prisma.target.findUniqueOrThrow({ where: { id: owner.id } })).checkCount).toBe(1);
    expect(await prisma.check.count({ where: { targetId: after.targetId, isLatest: true } })).toBe(1);
  }, 60_000);
});

describe('a coin whose Stage D ran short', () => {
  const coinData = (): FakeData => ({
    evmChains: { [COIN]: 'base' },
    dexTokens: { [COIN]: dexInfo({ chain: 'base', address: COIN, websites: [], socials: [] }) },
  });

  it('is scored as unknown (deployer mixed, every section warn), never as "no coin"', async () => {
    const check = await createCheck(COIN);
    const d = deps(coinData());
    d.sources.coinFacts = vi.fn(() => new Promise<never>(() => undefined));
    d.limits = { evidence: 2000 };
    expect((await runCheck(check.id, d)).status).toBe('done');
    const c = await stored(check.id);
    expect(c.steps.some(s => s.status === 'WARN' && s.text === 'Coin data not gathered in time; counts as unknown')).toBe(true);
    expect(c.coinFacts).not.toBeNull();
    expect([c.coinFacts!.sigDeployer, c.coinFacts!.sigBundle, c.coinFacts!.sigHolders, c.coinFacts!.sigLp, c.coinFacts!.sigAuthorities]).toEqual(['WARN', 'WARN', 'WARN', 'WARN', 'WARN']);
    expect(c.coinScore).toBe(scoreCoin({ deployer: 'mixed', bundle: 'warn', holders: 'warn', lp: 'warn', authorities: 'warn' }).score);
    const r = scoreCheck(
      { ...scoredSignals({ launch: sig(c.sigLaunch), flow: sig(c.sigFlow), docs: sig(c.sigDocs), acct: sigFromDb(c.sigAcct), git: sig(c.sigGit) }), claims: c.claims.map(x => claimStatusFromDb(x.status)) },
      { deployer: 'mixed', bundle: 'warn', holders: 'warn', lp: 'warn', authorities: 'warn' },
    );
    // the coin is averaged into the total, not left out
    expect(c.totalScore).toBe(r.total);
    expect(r.coin).not.toBeNull();
    expect(c.steps[c.steps.length - 1].text).toMatch(/and the coin$/);
  });

  it("uses coin facts that already arrived (they're asked right after Stage A), logged after the timeout line", async () => {
    const check = await createCheck(COIN);
    const data: FakeData = {
      ...coinData(),
      coinFacts: {
        [COIN]: {
          chain: 'base', address: COIN, token: null, deployer: null, bundle: { pct: 3.2, wallets: 2, source: 'BundleScan' }, holders: null,
          lp: { status: 'burned', lockedDays: null, source: 'On-chain' }, authorities: null, market: null, stubbed: [], errors: [],
        },
      },
      search: [repoFacts({ fullName: 'orbit/orbit' })],
    };
    const d = deps(data);
    const search = d.sources.github.searchByName.bind(d.sources.github);
    d.sources.github.searchByName = vi.fn(async (n: string) => {
      await sleep(5000);
      return search(n);
    });
    d.limits = { evidence: 1500 };
    expect((await runCheck(check.id, d)).status).toBe('done');
    const c = await stored(check.id);
    const texts = c.steps.map(s => s.text);
    const timedOut = texts.findIndex(t => /^Gathering evidence timed out/.test(t));
    expect(timedOut).toBeGreaterThan(0);
    expect(texts.findIndex(t => t.startsWith('Launch: 3.2% of supply'))).toBeGreaterThan(timedOut);
    expect(c.coinFacts).toMatchObject({ sigBundle: 'OK', sigLp: 'OK', lpStatus: 'burned' });
  }, 60_000);
});

describe('model fallbacks are in the log', () => {
  it('claims and judge falling back to the stand-in each leave a warn step', async () => {
    const fail = async () => {
      throw Object.assign(new Error('429 rate_limit_error'), { status: 429 });
    };
    const broken: AiAdapter = {
      mode: 'anthropic', judgeModel: 'judge-model', fastModel: 'fast-model',
      newExplore: siteUrl => ({ siteUrl, memory: {} }),
      exploreStep: fail, extractClaims: fail, judge: fail, answer: fail,
    };
    const check = await createCheck(sites.get('waitlist')!.url);
    expect((await runCheck(check.id, deps({}, new ResilientAi(broken)))).status).toBe('done');
    const c = await stored(check.id);
    const warns = c.steps.filter(s => s.status === 'WARN').map(s => s.text);
    expect(warns).toContain('The AI model could not read the claims; used the simple extractor');
    expect(warns).toContain('The AI model could not review the claims; used the simple rules');
    expect((c.evidence as CheckEvidence).ai?.mode).toBe('heuristic');
  });

  it('a judge that times out leaves a warn step', async () => {
    const check = await createCheck(sites.get('waitlist')!.url);
    const ai = heuristicAi();
    ai.judge = () => new Promise<Judged>(() => undefined);
    const d = deps({}, ai);
    d.limits = { judge: 1500 };
    expect((await runCheck(check.id, d)).status).toBe('done');
    const c = await stored(check.id);
    expect(c.steps[c.steps.length - 1]).toMatchObject({ status: 'WARN', text: 'Claim review timed out; used the simple rules' });
    // the plain stand-in run has no such lines
    const plain = await createCheck(sites.get('waitlist')!.url);
    await runCheck(plain.id, deps());
    expect((await stored(plain.id)).steps.some(s => /used the simple (rules|extractor)/.test(s.text))).toBe(false);
  });
});

describe('re-runs and runs that lost their check', () => {
  it('a re-run of a stalled job continues the step idx, so open streams and cached screenshots stay right', async () => {
    const check = await createCheck(sites.get('waitlist')!.url);
    await prisma.check.update({ where: { id: check.id }, data: { status: 'RUNNING', startedAt: new Date(Date.now() - 60_000) } });
    for (let idx = 0; idx < 4; idx++) await prisma.checkStep.create({ data: { checkId: check.id, idx, tMs: idx * 100, status: 'INFO', text: `first run step ${idx}`, screenshot: `${check.id}/${idx}.jpg` } });
    expect((await runCheck(check.id, deps())).status).toBe('done');
    const c = await stored(check.id);
    expect(c.steps[0]).toMatchObject({ idx: 4, status: 'INFO', text: 'Check restarted: the worker stopped before it finished, so it runs again from the start' });
    expect(c.steps.map(s => s.idx)).toEqual(c.steps.map((_, i) => i + 4));
    expect(c.steps.some(s => s.text.startsWith('first run'))).toBe(false);
    for (const s of c.steps.filter(x => x.screenshot)) expect(s.screenshot).toBe(`${check.id}/${s.idx}.jpg`);
    const streamed = messages.filter(m => m.channel === checkChannel(check.id) && m.msg.type === 'step').map(m => (m.msg as Extract<CheckChannelMsg, { type: 'step' }>).step.idx);
    expect(Math.min(...streamed)).toBe(4);
  });

  it('a run whose check was taken over by another run stops writing and announces nothing', async () => {
    const check = await createCheck(sites.get('working-app')!.url);
    const d = deps({ repos: { 'orbitswap/core': [repoFacts({ fullName: 'orbitswap/core' })] }, users: { orbitswap: xUser({ handle: 'orbitswap' }) } });
    const takeover = new Date(Date.now() + 1000);
    const fromUrl = d.sources.github.fromUrl.bind(d.sources.github);
    d.sources.github.fromUrl = vi.fn(async (u: string) => {
      // the job is re-run elsewhere while this run is in Stage D
      await prisma.check.update({ where: { id: check.id }, data: { startedAt: takeover } });
      return fromUrl(u);
    });
    const res = await runCheck(check.id, d);
    expect(res.status).toBe('skipped');
    const c = await stored(check.id);
    expect(c.status).toBe('RUNNING');
    expect(c.startedAt?.getTime()).toBe(takeover.getTime());
    expect(c.narScore).toBeNull();
    expect(c.steps.some(s => /^GitHub:|^Scoring/.test(s.text))).toBe(false);
    await sleep(200);
    expect(messages.some(m => m.channel === checkChannel(check.id) && m.msg.type === 'done')).toBe(false);
  }, 60_000);
});

describe('checks that would never finish', () => {
  it('a database error while claiming the check: transient → the job retries (check untouched), otherwise FAILED at once', async () => {
    const check = await createCheck(sites.get('waitlist')!.url);
    const flaky = (err: Error) => {
      let n = 0;
      return new Proxy(prisma, {
        get(t, k) {
          const v = Reflect.get(t, k);
          if (k === '$transaction') return (...a: unknown[]) => (++n === 1 ? Promise.reject(err) : (v as (...x: unknown[]) => unknown).apply(t, a));
          return typeof v === 'function' ? v.bind(t) : v;
        },
      });
    };
    const d = deps();
    d.prisma = flaky(Object.assign(new Error('Timed out fetching a new connection from the connection pool'), { code: 'P2024' }));
    await expect(runCheck(check.id, d)).rejects.toThrow(/Timed out fetching/);
    expect((await stored(check.id)).status).toBe('QUEUED');

    d.prisma = flaky(new Error('something else entirely'));
    expect((await runCheck(check.id, d)).status).toBe('failed');
    const c = await stored(check.id);
    expect(c.status).toBe('FAILED');
    expect(c.error).toBe('The check hit an error and could not finish');
    expect(c.steps[c.steps.length - 1].status).toBe('FAIL');
  });

  it('periodic recovery ends QUEUED / RUNNING checks whose job is gone or failed, and leaves live ones alone', async () => {
    const now = Date.now();
    const mk = async (status: 'QUEUED' | 'RUNNING', createdAgo: number, startedAgo: number | null) => {
      const c = await createCheck(sites.get('waitlist')!.url);
      return prisma.check.update({ where: { id: c.id }, data: { status, createdAt: new Date(now - createdAgo), startedAt: startedAgo == null ? null : new Date(now - startedAgo) } });
    };
    const lostQueued = await mk('QUEUED', 20 * 60_000, null);
    const waitingQueued = await mk('QUEUED', 20 * 60_000, null);
    const freshQueued = await mk('QUEUED', 60_000, null);
    const failedRunning = await mk('RUNNING', 10 * 60_000, 5 * 60_000);
    const activeRunning = await mk('RUNNING', 10 * 60_000, 5 * 60_000);
    const states: Record<string, string | null> = {
      [lostQueued.id]: null, [waitingQueued.id]: 'waiting', [freshQueued.id]: null, [failedRunning.id]: 'failed', [activeRunning.id]: 'active',
    };
    const n = await recoverStaleChecks({ prisma, redis, env, log: memoryLogger() }, now, async id => states[id] ?? null);
    expect(n).toBe(2);
    const status = async (id: string) => (await prisma.check.findUniqueOrThrow({ where: { id }, select: { status: true } })).status;
    expect(await status(lostQueued.id)).toBe('FAILED');
    expect(await status(failedRunning.id)).toBe('FAILED');
    expect(await status(waitingQueued.id)).toBe('QUEUED');
    expect(await status(freshQueued.id)).toBe('QUEUED');
    expect(await status(activeRunning.id)).toBe('RUNNING');
    const lost = await stored(lostQueued.id);
    expect(lost.error).toBe('The check could not be run');
    expect(lost.steps[lost.steps.length - 1]).toMatchObject({ status: 'FAIL', text: 'Check stopped: it could not be run' });
    await sleep(200);
    expect(messages.find(m => m.channel === checkChannel(lostQueued.id) && m.msg.type === 'done')?.msg).toEqual({ type: 'done', status: 'failed' });
  });
});

describe('unknown people signals', () => {
  it('an unchecked X account is null (left out of the score) whatever the judge says; git can only be lowered, never made ok', () => {
    const { run } = standaloneRun({ env, sources: fakeSources(env), browser: null });
    const judged = (acct: Signal, git: Signal): Judged => ({ claims: [], acct, git, summary: 'x', coinSummary: null });
    // X account linked (never read), GitHub down: acct not checked, git warn whatever the model says
    run.handle = 'orbit';
    run.git.unknown = 'unavailable';
    run.judged = judged('ok', 'ok');
    expect(finalJudgement(run)).toMatchObject({ acct: null, git: 'warn' });
    run.judged = judged('fail', 'fail');
    expect(finalJudgement(run)).toMatchObject({ acct: null, git: 'warn' });
    // Stage D never got to GitHub (timed out): unknown → warn
    run.git.unknown = null;
    run.judged = judged('ok', 'ok');
    expect(finalJudgement(run).git).toBe('warn');
    // nothing to look up (no X account, no repo link or name): the judge may say fail for git, never ok
    run.handle = null;
    run.git.unknown = 'nothing-to-look-up';
    run.judged = judged('ok', 'ok');
    expect(finalJudgement(run)).toMatchObject({ acct: null, git: 'warn' });
    run.judged = judged('fail', 'fail');
    expect(finalJudgement(run)).toMatchObject({ acct: null, git: 'fail' });
    // a deterministic signal always wins
    run.acct.signal = { signal: 'ok', text: '@orbit: 2y old', stepIdx: 3 };
    run.git.signal = { signal: 'warn', text: 'GitHub: thin', stepIdx: 4 };
    expect(finalJudgement(run)).toMatchObject({ acct: 'ok', git: 'warn' });
  });
});

describe('browser pool', () => {
  it('after a crash, concurrent callers share one relaunch and every launched browser can be closed', async () => {
    type FakeHost = { id: number; connected: boolean; closed: number; close(): Promise<void> };
    const launched: FakeHost[] = [];
    const spy = vi.spyOn(BrowserHost, 'launch').mockImplementation(async () => {
      await sleep(20);
      const h: FakeHost = { id: launched.length + 1, connected: true, closed: 0, async close() { this.closed++; this.connected = false; } };
      launched.push(h);
      return h as unknown as BrowserHost;
    });
    try {
      const pool = new BrowserPool({ env }, memoryLogger());
      const first = (await pool.get()) as unknown as FakeHost;
      expect(first.id).toBe(1);
      first.connected = false;
      const [a, b, c] = (await Promise.all([pool.get(), pool.get(), pool.get()])) as unknown as FakeHost[];
      expect(spy).toHaveBeenCalledTimes(2);
      expect([a.id, b.id, c.id]).toEqual([2, 2, 2]);
      expect(first.closed).toBe(1);
      await pool.close();
      expect(launched.map(h => h.closed)).toEqual([1, 1]);
    } finally {
      spy.mockRestore();
    }
  });
});

describe('the browser at worker startup', () => {
  const SECRET = '/0f3c9a7d1e2b4c6a8d0e1f2a3b4c5d6e';
  const remote = () => testEnv({ BROWSER_WS_ENDPOINT: `ws://127.0.0.1:9223${SECRET}` });
  const fakeHost = (version: string) => ({ connected: true, browser: { version: () => version }, async close() {} });

  it('connected: one line with the Chromium version, and the first check reuses that launch (one guard, one port)', async () => {
    const spy = vi.spyOn(BrowserHost, 'launch').mockImplementation(async () => fakeHost('141.0.7390.37') as unknown as BrowserHost);
    try {
      const log = memoryLogger();
      const pool = new BrowserPool({ env: remote() }, log);
      expect(await checkBrowserAtStartup(pool, remote(), log)).toBe(true);
      expect(log.lines).toEqual(['info browser host connected (Chromium 141.0.7390.37)']);
      await pool.get();
      expect(spy).toHaveBeenCalledTimes(1);
      await pool.close();
    } finally {
      spy.mockRestore();
    }
  });

  it('a host that is down: a clear error with the DEPLOY.md §6 hint, never a throw, never the endpoint path', async () => {
    const spy = vi.spyOn(BrowserHost, 'launch').mockRejectedValue(new Error(`browser host unreachable: connect ECONNREFUSED 127.0.0.1:9223 (ws://127.0.0.1:9223${SECRET})`));
    try {
      const log = memoryLogger();
      const pool = new BrowserPool({ env: remote() }, log);
      expect(await checkBrowserAtStartup(pool, remote(), log)).toBe(false);
      const line = log.lines.find(l => l.startsWith('error the browser is unusable'));
      expect(line).toMatch(/ECONNREFUSED 127\.0\.0\.1:9223/);
      expect(line).toMatch(/DEPLOY\.md §6/);
      expect(line).not.toContain(SECRET);
      expect(line).toContain('/<BROWSER_WS_PATH>');
      // the next check tries again
      await pool.get();
      expect(spy).toHaveBeenCalledTimes(2);
    } finally {
      spy.mockRestore();
    }
  });

  it('a host that does not answer: reported after the timeout without waiting for it, and again once it is up', async () => {
    const spy = vi.spyOn(BrowserHost, 'launch').mockImplementation(async () => {
      await sleep(300);
      return fakeHost('141.0.7390.37') as unknown as BrowserHost;
    });
    try {
      const log = memoryLogger();
      const pool = new BrowserPool({ env: remote() }, log);
      const t0 = Date.now();
      expect(await checkBrowserAtStartup(pool, remote(), log, 50)).toBe(false);
      expect(Date.now() - t0).toBeLessThan(250);
      expect(log.lines).toEqual([expect.stringMatching(/^error the browser did not answer within 0 s \(still trying\); .*DEPLOY\.md §6/)]);
      await pool.get();
      expect(log.lines[1]).toBe('info browser host connected (Chromium 141.0.7390.37)');
      expect(spy).toHaveBeenCalledTimes(1);
      await pool.close();
    } finally {
      spy.mockRestore();
    }
  });
});

