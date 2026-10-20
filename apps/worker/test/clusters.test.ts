/**
 * M4 "deep holder clusters" (Pro/Max): WhaleFlow's clusters ride from coinFacts (Stage D) into Check.evidence.clusters,
 * where the API serves them to Pro/Max viewers only. Nothing is stored when WhaleFlow is unconfigured or sent none,
 * and no cluster detail ever lands in the public step log.
 */
import { Redis } from 'ioredis';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { CheckEvidence } from '@apecheck/core';
import type { CoinRawFacts, HolderCluster } from '@apecheck/sources';
import { loadAnswerData } from '../src/ai';
import { publicEvidence } from '../src/ai/answer-data';
import { answerUserText } from '../src/ai/prompts';
import { memoryLogger } from '../src/log';
import { runCheck, type PipelineDeps } from '../src/pipeline';
import { fakeSources } from './fakes';
import { createCheck, heuristicAi, prisma, resetDb, testEnv } from './helpers';

const COIN = '0x2222222222222222222222222222222222222222';
let redis: Redis;
let env: ReturnType<typeof testEnv>;

beforeAll(async () => {
  env = testEnv();
  redis = new Redis(process.env.REDIS_URL!, { maxRetriesPerRequest: 2 });
});
afterAll(async () => {
  await redis.quit();
  await prisma.$disconnect();
});
beforeEach(async () => {
  await resetDb();
});

function facts(over: Partial<CoinRawFacts> = {}): CoinRawFacts {
  return {
    chain: 'base', address: COIN, token: { name: 'Orbit', symbol: 'ORBIT', decimals: 18, supply: '1000000000' },
    deployer: null, bundle: null,
    holders: { top10Pct: 31, devHoldPct: 2, count: 1840, source: 'WhaleFlow' },
    lp: null,
    authorities: { mintRenounced: true, freezeActive: false, owner: null, text: 'Renounced', source: 'On-chain' },
    market: null, stubbed: [], errors: [],
    ...over,
  };
}

/** a coin check (no website, so no browser) with these coin facts */
async function coinCheck(raw: CoinRawFacts) {
  const check = await createCheck(COIN);
  const deps: PipelineDeps = {
    env,
    prisma,
    redis,
    sources: fakeSources(env, { evmChains: { [COIN]: 'base' }, coinFacts: { [COIN]: raw }, fourtisConfigured: raw.stubbed.includes('fourtis') ? false : true }),
    ai: heuristicAi(),
    browser: async () => null,
    log: memoryLogger(),
    fetchCard: async () => null,
  };
  const res = await runCheck(check.id, deps);
  expect(res.status).toBe('done');
  return prisma.check.findUniqueOrThrow({ where: { id: check.id }, include: { steps: { orderBy: { idx: 'asc' } } } });
}

describe('holder clusters (M4)', () => {
  it("WhaleFlow's clusters are stored in Check.evidence.clusters, as they came, and never in the public log", async () => {
    const clusters: HolderCluster[] = [
      { label: 'Cluster A', wallets: 12, pct: 18.2, fundedFrom: 'Binance hot wallet' },
      { label: 'Cluster B', wallets: 4, pct: 6.5, fundedFrom: null },
    ];
    const c = await coinCheck(facts({ clusters }));
    const ev = c.evidence as CheckEvidence;
    expect(ev.clusters).toEqual(clusters);
    // the step log is public: the clusters are Pro/Max data
    const log = c.steps.map(s => s.text).join('\n');
    expect(log).not.toMatch(/Cluster A|Binance hot wallet|cluster/i);
    expect(log).toContain('Top 10 holders own 31%');
  });

  it('follow-up answers never see the clusters: answers are public (every viewer, the bot on X), clusters Pro/Max only', async () => {
    const clusters: HolderCluster[] = [
      { label: 'Cluster A', wallets: 14, pct: 22.5, fundedFrom: 'Binance hot wallet' },
      { label: 'Cluster B', wallets: 4, pct: 6.5, fundedFrom: '0xfeedfacefeedfacefeedfacefeedfacefeedface' },
    ];
    const c = await coinCheck(facts({ clusters }));
    // still stored for the API's Pro/Max viewers
    expect((c.evidence as CheckEvidence).clusters).toEqual(clusters);

    const data = (await loadAnswerData(prisma, c.id))!;
    expect(data).not.toBeNull();
    expect('clusters' in data.evidence).toBe(false);
    // the rest of the evidence still reaches the answerer
    expect(data.evidence.stepsExpected).toBe((c.evidence as CheckEvidence).stepsExpected);
    const prompt = answerUserText('are the top holders funded from one wallet?', data);
    expect(prompt).not.toMatch(/Cluster A|Cluster B|Binance hot wallet|0xfeedface|22\.5|"clusters"/);
    expect(prompt).toContain('check_data');

    // the helper drops only the viewer-gated keys and never touches the stored object
    const ev = { launch: 'x', clusters } as CheckEvidence;
    expect(publicEvidence(ev)).toEqual({ launch: 'x' });
    expect(ev.clusters).toBe(clusters);
    expect(publicEvidence(null)).toEqual({});
  });

  it('no clusters from WhaleFlow (none sent, WhaleFlow down or unconfigured) → nothing stored, nothing invented', async () => {
    const noClusters = await coinCheck(facts());
    expect('clusters' in (noClusters.evidence as object)).toBe(false);

    await resetDb();
    const unconfigured = await coinCheck(facts({ holders: null, stubbed: ['fourtis'] }));
    expect('clusters' in (unconfigured.evidence as object)).toBe(false);

    await resetDb();
    const empty = await coinCheck(facts({ clusters: [] }));
    expect('clusters' in (empty.evidence as object)).toBe(false);
  });

  it('a site check has no clusters key at all', async () => {
    const check = await createCheck('nothing-here.test');
    const deps: PipelineDeps = {
      env, prisma, redis, sources: fakeSources(env), ai: heuristicAi(), browser: async () => null, log: memoryLogger(), fetchCard: async () => null,
    };
    expect((await runCheck(check.id, deps)).status).toBe('done');
    const c = await prisma.check.findUniqueOrThrow({ where: { id: check.id } });
    expect('clusters' in (c.evidence as object)).toBe(false);
  });
});
