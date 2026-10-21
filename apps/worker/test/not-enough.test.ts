/**
 * "Not enough to check" (pipeline/enough.ts): a check that could test nothing about the project ends FAILED with what
 * was looked for, never with the neutral middle of unknowns as a score ("PARTLY REAL (50/100)"); a lookup that didn't
 * answer makes it an outage instead; anything tested is still scored. Real Postgres and Redis, FakeSources, heuristic
 * AI. None of these targets has a site, so no browser is started.
 */
import { Redis } from 'ioredis';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { isNotEnough, progressKey } from '@apecheck/core';
import { reportError } from '@apecheck/sources';
import { memoryLogger } from '../src/log';
import { runCheck, type PipelineDeps } from '../src/pipeline';
import { fakeSources, repoFacts, type FakeData } from './fakes';
import { post } from './fake-x';
import { createCheck, heuristicAi, prisma, resetDb, testEnv } from './helpers';

/** the second incident: "CA: 0x17c6…" of the ESCO ecosystem (most likely on Sonic, a chain ApeCheck doesn't support) */
const ESCO = '0x17c63a297a76bed7e96a96bcf5f566de1efdd1fc';
const STRIDE_REASON = 'Not enough to check: no website, GitHub repo or contract on a supported chain was found for @stridefun.';

let env: ReturnType<typeof testEnv>;
let redis: Redis;
const botReplies: string[] = [];

function deps(data: FakeData = {}): PipelineDeps & { sources: ReturnType<typeof fakeSources> } {
  return {
    env,
    prisma,
    redis,
    sources: fakeSources(env, data),
    ai: heuristicAi(),
    browser: async () => {
      throw new Error('no site here: the browser is never asked for');
    },
    log: memoryLogger(),
    fetchCard: async () => null,
    hooks: { enqueueBotReply: async id => void botReplies.push(id) },
  };
}

const stored = (checkId: string) =>
  prisma.check.findUniqueOrThrow({ where: { id: checkId }, include: { steps: { orderBy: { idx: 'asc' } }, claims: true, coinFacts: true } });

/** FAILED with `error` as Check.error and as the last step (`status`), no score and nothing published as a verdict. */
async function expectNoScore(checkId: string, error: string, status: 'WARN' | 'FAIL') {
  const c = await stored(checkId);
  expect(c).toMatchObject({ status: 'FAILED', error, narScore: null, narBand: null, coinScore: null, totalScore: null, sigLaunch: null, sigGit: null, isLatest: false });
  expect(c.finishedAt).not.toBeNull();
  expect(c.steps.at(-1)).toMatchObject({ status, text: error });
  expect(c.coinFacts).toBeNull();
  return c;
}

const xPost = (id: string, text: string, handle: string) => post({ id, text, authorHandle: handle, authorId: '880' });

beforeAll(() => {
  env = testEnv();
  redis = new Redis(process.env.REDIS_URL!);
});
afterAll(async () => {
  await redis.quit();
  await prisma.$disconnect();
});
beforeEach(async () => {
  await resetDb();
  botReplies.length = 0;
});

describe('nothing about the project could be tested: "Not enough to check", no score', () => {
  it('an X profile with no site, repo or contract (the @stridefun incident) names what was looked for; no judge call, the bot is told', async () => {
    const check = await createCheck('https://x.com/stridefun');
    const mention = await prisma.botMention.create({
      data: { tweetId: '1851000000000000001', authorId: '42', authorHandle: 'degen_rina', text: '@ApeCheckBot', checkId: check.id, status: 'QUEUED', kind: 'check' },
    });
    const d = deps();
    const res = await runCheck(check.id, d);
    expect(res).toEqual({ status: 'failed', checkId: check.id, error: STRIDE_REASON });
    const c = await expectNoScore(check.id, STRIDE_REASON, 'WARN');
    expect(isNotEnough(c.error)).toBe(true);
    const texts = c.steps.map(s => s.text);
    expect(texts).toContain('No website found to open');
    expect(texts).toContain('GitHub: no repository found');
    // the project's name was looked up on GitHub before saying none was found
    expect(d.sources.calls).toContain('github.search stridefun');
    // nothing to judge: the judge never ran ("Scoring …" is its first step)
    expect(texts.some(t => /^Scoring\b/.test(t))).toBe(false);
    expect(texts.join('\n')).not.toMatch(/PARTLY|50\/100/);
    // the run ended (progress 100 %, the open report gets its "done") and the waiting mention gets its reply
    expect(await redis.get(progressKey(check.id))).toBe('1');
    expect(botReplies).toEqual([mention.id]);
  });

  it('a contract on none of the supported chains (the ESCO incident) names the chains asked', async () => {
    const check = await createCheck(ESCO);
    expect((await runCheck(check.id, deps())).status).toBe('failed');
    const c = await expectNoScore(check.id, 'Not enough to check: 0x17c…d1fc is not on Base, Ethereum, BNB Chain or Arbitrum, and no website or GitHub repo was found for it.', 'WARN');
    expect(c.steps.some(s => s.text === 'Contract 0x17c…d1fc not found on Base, Ethereum, BNB Chain or Arbitrum')).toBe(true);
  });

  it('a post naming a contract no supported chain has: the contract and the post are both named', async () => {
    const d = deps({ posts: { '1851000000000000100': xPost('1851000000000000100', `CA: ${ESCO}`, 'escoeco') } });
    const check = await createCheck('https://x.com/escoeco/status/1851000000000000100');
    expect((await runCheck(check.id, d)).status).toBe('failed');
    const c = await expectNoScore(
      check.id,
      'Not enough to check: 0x17c…d1fc is not on Base, Ethereum, BNB Chain or Arbitrum, and no website or GitHub repo was found for the post by @escoeco.',
      'WARN',
    );
    // the log says the contract is there but not on a supported chain, never "No contract found"
    expect(c.steps.some(s => s.status === 'WARN' && s.text === 'Contract 0x17c…d1fc in the post is not on Base, Ethereum, BNB Chain or Arbitrum')).toBe(true);
    expect(c.steps.some(s => /No contract found/.test(s.text))).toBe(false);
  });

  it('claims that nothing could confirm or contradict: judged first, then still no score', async () => {
    const d = deps({ posts: { '1851000000000000200': xPost('1851000000000000200', 'Partnered with Binance Labs for the next phase.', 'kairolabs') } });
    const check = await createCheck('https://x.com/kairolabs/status/1851000000000000200');
    expect((await runCheck(check.id, d)).status).toBe('failed');
    const c = await expectNoScore(check.id, 'Not enough to check: no website, GitHub repo or contract on a supported chain was found for the post by @kairolabs.', 'WARN');
    expect(c.steps.some(s => s.text === 'Scoring 1 claim')).toBe(true);
    expect(c.claims).toEqual([]);
  });
});

describe('a lookup that could have found something did not answer: an outage, not "Not enough to check"', () => {
  it('GitHub down', async () => {
    const d = deps();
    d.sources.github.searchByName = async () => {
      reportError('github.search: HTTP 503');
      return [];
    };
    const check = await createCheck('https://x.com/stridefun');
    expect(await runCheck(check.id, d)).toMatchObject({ status: 'failed', error: "Nothing about @stridefun could be checked: GitHub didn't answer" });
    const c = await expectNoScore(check.id, "Nothing about @stridefun could be checked: GitHub didn't answer", 'FAIL');
    expect(isNotEnough(c.error)).toBe(false);
  });

  it("an RPC that didn't answer while looking for the contract's chain", async () => {
    const d = deps();
    d.sources.evm.detectChain = async () => {
      reportError('evm.getCode base: RPC unavailable');
      return null;
    };
    const check = await createCheck(ESCO);
    await runCheck(check.id, d);
    await expectNoScore(check.id, "Nothing about 0x17c…d1fc could be checked: the Base RPC didn't answer", 'FAIL');
  });

  it("a post the free embed endpoints couldn't read", async () => {
    const check = await createCheck('https://x.com/escoeco/status/1851000000000000300');
    await runCheck(check.id, deps());
    await expectNoScore(check.id, "Nothing about the post by @escoeco could be checked: the post couldn't be read on X", 'FAIL');
  });
});

describe('anything tested is scored as before', () => {
  it('a GitHub repo found by name, without any site or contract', async () => {
    const check = await createCheck('https://x.com/orbitswap');
    expect((await runCheck(check.id, deps({ search: [repoFacts({ fullName: 'orbitswap/core' })] }))).status).toBe('done');
    const c = await stored(check.id);
    expect(c).toMatchObject({ status: 'DONE', error: null, sigGit: 'OK', isLatest: true });
    expect(c.narScore).toEqual(expect.any(Number));
  });

  it('a claim contradicted by what was found (says open source, no repo anywhere)', async () => {
    const d = deps({ posts: { '1851000000000000400': xPost('1851000000000000400', 'Fully open source and community owned.', 'kairolabs') } });
    const check = await createCheck('https://x.com/kairolabs/status/1851000000000000400');
    expect((await runCheck(check.id, d)).status).toBe('done');
    const c = await stored(check.id);
    expect(c).toMatchObject({ status: 'DONE', sigGit: 'FAIL' });
    expect(c.claims.map(x => x.status)).toEqual(['CONTRADICTED']);
  });
});
