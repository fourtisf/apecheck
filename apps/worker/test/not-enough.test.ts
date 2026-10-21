/**
 * "Not enough to check" (pipeline/enough.ts): a check that could test nothing about the project ends FAILED with the
 * lookups that ran and what they found (never one that didn't run), never with the neutral middle of unknowns as a
 * score ("PARTLY REAL (50/100)"); a lookup that didn't answer makes it an outage instead; anything tested is still
 * scored. Real Postgres and Redis, FakeSources, heuristic AI. None of these targets has a site, so no browser is
 * started; the site states are covered on a standalone run (and with a real browser in pipeline.test.ts).
 */
import { Redis } from 'ioredis';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { detect, isNotEnough, progressKey } from '@apecheck/core';
import { reportError, type CoinRawFacts } from '@apecheck/sources';
import { memoryLogger } from '../src/log';
import { runCheck, type PipelineDeps } from '../src/pipeline';
import { nothingTested } from '../src/pipeline/enough';
import { dexInfo, dexOther, emptyCoinFacts, fakeSources, repoFacts, type FakeData } from './fakes';
import { post } from './fake-x';
import { createCheck, heuristicAi, prisma, resetDb, standaloneRun, testEnv } from './helpers';

/** the second incident: "CA: 0x17c6…" of the ESCO ecosystem (most likely on Sonic, a chain ApeCheck doesn't support) */
const ESCO = '0x17c63a297a76bed7e96a96bcf5f566de1efdd1fc';
/** a coin on Base (DexScreener lists it as $ORBIT, no website in its token info) */
const ORB = '0x4444444444444444444444444444444444444444';
const STRIDE_REASON =
  "Not enough to check: ApeCheck doesn't read X profiles, and no GitHub repo was found for @stridefun. Tag me under a post with its link or contract.";
const NOT_ON = 'is not on Base, Ethereum, BNB Chain or Arbitrum';

/** $ORBIT on Base, its coin facts as given (none read by default) */
const orbit = (facts: Partial<CoinRawFacts> = {}): FakeData => ({
  evmChains: { [ORB]: 'base' },
  dexTokens: { [ORB]: dexInfo({ chain: 'base', address: ORB }) },
  coinFacts: { [ORB]: { ...emptyCoinFacts('base', ORB), ...facts } },
});

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
  it('an X profile (the @stridefun incident): says profiles are not read and names only the GitHub search; no judge call, the bot is told', async () => {
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
    // the project's name was looked up on GitHub before saying none was found; nothing else was (no website or
    // contract search: the profile isn't read), so the reason claims no such search
    expect(d.sources.calls).toContain('github.search stridefun');
    expect(d.sources.calls.filter(x => /^(dex|evm|x)\./.test(x))).toEqual([]);
    expect(c.error).not.toMatch(/website|contract on|supported chain/);
    // nothing to judge: the judge never ran ("Scoring …" is its first step)
    expect(texts.some(t => /^Scoring\b/.test(t))).toBe(false);
    expect(texts.join('\n')).not.toMatch(/PARTLY|50\/100/);
    // the run ended (progress 100 %, the open report gets its "done") and the waiting mention gets its reply
    expect(await redis.get(progressKey(check.id))).toBe('1');
    expect(botReplies).toEqual([mention.id]);
  });

  it('a contract on none of the supported chains and on no other chain DexScreener lists: only the chains asked, no GitHub or website search claimed', async () => {
    const d = deps();
    const check = await createCheck(ESCO);
    expect((await runCheck(check.id, d)).status).toBe('failed');
    const c = await expectNoScore(check.id, `Not enough to check: 0x17c…d1fc ${NOT_ON}.`, 'WARN');
    expect(c.steps.some(s => s.text === `Contract 0x17c…d1fc not found on Base, Ethereum, BNB Chain or Arbitrum`)).toBe(true);
    // a bare contract has no name to search GitHub for: GitHub was never asked
    expect(c.steps.some(s => s.text === 'No GitHub link or project name to look up, code not checked')).toBe(true);
    expect(d.sources.calls.some(x => x.startsWith('github.'))).toBe(false);
    expect(d.sources.calls).toContain(`dex.otherChain ${ESCO}`);
  });

  it('a contract DexScreener lists only on Sonic, with no website in its token info (the ESCO incident): the chain is named', async () => {
    // no name or ticker in its token info: nothing to search GitHub for, so the reason is the chain and the website only
    const bare = deps({ dexOther: { [ESCO]: dexOther({ address: ESCO, name: null, symbol: null }) } });
    const first = await createCheck(ESCO);
    expect((await runCheck(first.id, bare)).status).toBe('failed');
    await expectNoScore(first.id, "Not enough to check: 0x17c…d1fc trades on Sonic, which ApeCheck can't read yet, and its token info lists no website.", 'WARN');
    expect(bare.sources.calls.some(x => x.startsWith('github.'))).toBe(false);

    // its ticker is searched on GitHub: that search is named too
    await resetDb();
    const named = deps({ dexOther: { [ESCO]: dexOther({ address: ESCO }) } });
    const second = await createCheck(ESCO);
    expect((await runCheck(second.id, named)).status).toBe('failed');
    await expectNoScore(
      second.id,
      "Not enough to check: 0x17c…d1fc trades on Sonic, which ApeCheck can't read yet, its token info lists no website, and no GitHub repo was found for it.",
      'WARN',
    );
    expect(named.sources.calls).toContain('github.search ESCO');
  });

  it('a post naming a contract no supported chain has: the post, the contract and the GitHub search by its author', async () => {
    const d = deps({ posts: { '1851000000000000100': xPost('1851000000000000100', `CA: ${ESCO}`, 'escoeco') } });
    const check = await createCheck('https://x.com/escoeco/status/1851000000000000100');
    expect((await runCheck(check.id, d)).status).toBe('failed');
    const c = await expectNoScore(
      check.id,
      `Not enough to check: the post by @escoeco links no project website, 0x17c…d1fc ${NOT_ON}, and no GitHub repo was found for @escoeco.`,
      'WARN',
    );
    expect(d.sources.calls).toContain('github.search escoeco');
    // the log says the contract is there but not on a supported chain, never "No contract found"
    expect(c.steps.some(s => s.status === 'WARN' && s.text === `Contract 0x17c…d1fc in the post ${NOT_ON}`)).toBe(true);
    expect(c.steps.some(s => /No contract found/.test(s.text))).toBe(false);
  });

  it('claims that nothing could confirm or contradict: judged first, then still no score', async () => {
    const d = deps({ posts: { '1851000000000000200': xPost('1851000000000000200', 'Partnered with Binance Labs for the next phase.', 'kairolabs') } });
    const check = await createCheck('https://x.com/kairolabs/status/1851000000000000200');
    expect((await runCheck(check.id, d)).status).toBe('failed');
    const c = await expectNoScore(
      check.id,
      'Not enough to check: the post by @kairolabs links no project website, no coin was found in it, and no GitHub repo was found for @kairolabs.',
      'WARN',
    );
    expect(c.steps.some(s => s.text === 'Scoring 1 claim')).toBe(true);
    expect(c.claims).toEqual([]);
  });

  it('a coin on Base with none of the facts its score is made of, every source having answered: no SKETCHY (50) made of unknowns', async () => {
    // its deployer wallet is known (shown with its history from ApeCheck's checks, never scored)
    const d = deps(orbit({ deployer: { address: '0xabcd00000000000000000000000000000000ef01', launched: null, dead: null, source: 'On-chain' } }));
    const check = await createCheck(ORB);
    expect((await runCheck(check.id, d)).status).toBe('failed');
    const c = await expectNoScore(check.id, 'Not enough to check: none of the coin facts ApeCheck scores were found for $ORBIT on Base, and no GitHub repo was found for it.', 'WARN');
    expect(d.sources.calls).toContain('github.search ORBIT');
    expect(c.steps.some(s => s.text === 'Mint and freeze authorities unknown')).toBe(true);
    expect(c.steps.some(s => s.text.startsWith('Deployer history: ') && s.text.endsWith('(0xabc…ef01)'))).toBe(true);
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

  it('a GitHub search slower than 15 s: GitHub unavailable, never "no GitHub repo was found" (that would be cached, never retried)', async () => {
    const d = deps();
    d.sources.github.searchByName = () => new Promise(() => undefined);
    const check = await createCheck('https://x.com/stridefun');
    expect(await runCheck(check.id, d)).toMatchObject({ status: 'failed', error: "Nothing about @stridefun could be checked: GitHub didn't answer" });
    const c = await expectNoScore(check.id, "Nothing about @stridefun could be checked: GitHub didn't answer", 'FAIL');
    expect(c.steps.some(s => s.text === 'GitHub unavailable, code not checked')).toBe(true);
    expect(c.steps.some(s => s.text === 'GitHub: no repository found')).toBe(false);
  }, 60_000);

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

  it('DexScreener down while every RPC asked answered "no code": it could list the contract on a chain no RPC was asked about', async () => {
    // its token lookup fails
    const down = deps();
    down.sources.dex.token = async () => {
      reportError('dexscreener.token: HTTP 503');
      return null;
    };
    const first = await createCheck(ESCO);
    await runCheck(first.id, down);
    await expectNoScore(first.id, "Nothing about 0x17c…d1fc could be checked: DexScreener didn't answer", 'FAIL');

    // its token lookup answers, the other-chain lookup fails
    await resetDb();
    const other = deps();
    other.sources.dex.otherChain = async () => {
      reportError('dexscreener.otherChain: HTTP 503');
      return null;
    };
    const second = await createCheck(ESCO);
    await runCheck(second.id, other);
    const c = await expectNoScore(second.id, "Nothing about 0x17c…d1fc could be checked: DexScreener didn't answer", 'FAIL');
    expect(c.steps.some(s => s.text === 'DexScreener unavailable, no market data')).toBe(true);
  });

  it("a coin whose every fact is unread because its RPC didn't answer: never the fake PARTLY REAL (50/100) · Coin: SKETCHY (50)", async () => {
    const d = deps(orbit({ errors: ['evm.tokenBasics base: RPC unavailable'] }));
    const check = await createCheck(ORB);
    expect(await runCheck(check.id, d)).toMatchObject({ status: 'failed', error: "Nothing about $ORBIT could be checked: the Base RPC didn't answer" });
    const c = await expectNoScore(check.id, "Nothing about $ORBIT could be checked: the Base RPC didn't answer", 'FAIL');
    expect(c.steps.map(s => s.text).join('\n')).not.toMatch(/PARTLY|SKETCHY|50\/100/);
  });

  it("a coin whose facts weren't gathered before Stage D ran out", async () => {
    const d = deps(orbit());
    d.sources.coinFacts = () => new Promise(() => undefined);
    d.limits = { evidence: 2000 };
    const check = await createCheck(ORB);
    await runCheck(check.id, d);
    await expectNoScore(check.id, "Nothing about $ORBIT could be checked: $ORBIT's on-chain data wasn't gathered in time", 'FAIL');
  });

  it("a post the free embed endpoints couldn't read", async () => {
    const check = await createCheck('https://x.com/escoeco/status/1851000000000000300');
    await runCheck(check.id, deps());
    await expectNoScore(check.id, "Nothing about the post by @escoeco could be checked: the post couldn't be read on X", 'FAIL');
  });
});

describe('the site, on a standalone run: only one that answered counts as tested', () => {
  function siteRun(degraded: string[], site: Partial<ReturnType<typeof standaloneRun>['run']['site']>) {
    const { run } = standaloneRun({ env, sources: fakeSources(env), browser: null });
    const d = detect('https://orbitswap.xyz');
    if (!d || d.kind === 'bad') throw new Error('not a site');
    run.detected = d;
    run.kind = 'site';
    run.domain = 'orbitswap.xyz';
    run.siteUrl = 'https://orbitswap.xyz/';
    run.site = { ...run.site, hasSite: true, ...site };
    run.degraded.push(...degraded);
    run.git = { facts: null, signal: { signal: 'warn', text: 'GitHub: no repository found', stepIdx: null }, plain: null, found: false, asked: { links: 0, search: 'orbitswap' } };
    return run;
  }

  it('a site that answered but failed to load (a dead project site) is a result: scored as not loading', () => {
    expect(nothingTested(siteRun([], { loaded: false, error: 'HTTP 502' }), [])).toBeNull();
    // too slow to load is the site's answer too
    expect(nothingTested(siteRun(['open:timeout'], { loaded: false, error: 'timed out' }), [])).toBeNull();
  });

  it('a bot wall is "Not enough to check"; our browser failing, or never getting to the site, is an outage', () => {
    expect(nothingTested(siteRun(['browse:blocked'], { loaded: false, error: 'blocked', infraError: 'blocked' }), [])).toEqual({
      message: 'Not enough to check: orbitswap.xyz blocks automated browsers, and no GitHub repo was found for it.',
      final: true,
    });
    expect(nothingTested(siteRun(['browse:error'], { loaded: false, infraError: 'browser error' }), [])).toEqual({
      message: 'Nothing about orbitswap.xyz could be checked: our test browser failed on orbitswap.xyz',
      final: false,
    });
    expect(nothingTested(siteRun(['open:skipped'], { loaded: false, error: 'could not be opened' }), [])).toEqual({
      message: 'Nothing about orbitswap.xyz could be checked: there was no time left to open orbitswap.xyz',
      final: false,
    });
  });

  it('the website a contract on Sonic moved the check to, behind a bot wall: "it" is never the contract named just before', () => {
    const run = siteRun(['browse:blocked'], { loaded: false, error: 'blocked', infraError: 'blocked' });
    run.otherChain = { address: ESCO, chain: 'Sonic', site: 'orbitswap.xyz' };
    expect(nothingTested(run, [])?.message).toBe(
      "Not enough to check: orbitswap.xyz blocks automated browsers, 0x17c…d1fc trades on Sonic, which ApeCheck can't read yet, and no GitHub repo was found for orbitswap.xyz.",
    );
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

  it('a coin with one fact read (its authorities), without any site or repo', async () => {
    const authorities = { mintRenounced: true, freezeActive: false, owner: null, text: 'Renounced', source: 'On-chain' as const };
    const check = await createCheck(ORB);
    expect((await runCheck(check.id, deps(orbit({ authorities })))).status).toBe('done');
    const c = await stored(check.id);
    expect(c).toMatchObject({ status: 'DONE', error: null, isLatest: true });
    expect(c.coinScore).toEqual(expect.any(Number));
    expect(c.coinFacts?.sigAuthorities).toBe('OK');
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
