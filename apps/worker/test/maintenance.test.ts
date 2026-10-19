/**
 * The M3 periodic jobs of worker-prices' "maintenance" queue:
 *  - deployer records from DevRadar (daily): skipped without Fourtis; Deployer rows upserted with the core record;
 *    coins whose report had no launch history are linked; nothing changes on a failed or missing answer; private
 *    checks are never read;
 *  - tier refresh (hourly): users seen in the last 7 days with a tier older than an hour, idle Pro/Max users daily;
 *    the token's balance across linked wallets, TIER_OVERRIDES while the token isn't live, a failed read keeps the tier.
 */
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import type { DevRadarFacts } from '@apecheck/sources';
import { memoryLogger } from '../src/log';
import { refreshDeployers } from '../src/maintenance/deployers';
import { refreshTiers } from '../src/maintenance/tiers';
import { balanceReader } from '../src/maintenance/index';
import { fakeSources, type FakeData } from './fakes';
import { prisma, resetDb, testEnv } from './helpers';

const DAY = 86_400_000;
const HOUR = 3600_000;

beforeEach(() => resetDb());
afterAll(() => prisma.$disconnect());

describe('deployer refresh', () => {
  const A = '0x' + 'a1'.repeat(20);
  const B = '0x' + 'b2'.repeat(20);
  const OLD = '0x' + 'c3'.repeat(20);
  const DEP = '0x' + 'De'.repeat(20);

  async function coin(ca: string, finishedAgo: number, facts: { deployerAddress?: string | null; linkTo?: string } = {}) {
    const t = await prisma.target.create({ data: { key: `ca:base:${ca}`, kind: 'COIN', chain: 'BASE', ca, name: ca.slice(0, 6) } });
    const c = await prisma.check.create({ data: { shortId: ca.slice(2, 9), targetId: t.id, targetRaw: ca, status: 'DONE', finishedAt: new Date(Date.now() - finishedAgo), isLatest: true } });
    await prisma.coinFacts.create({
      data: {
        checkId: c.id, deployerAddress: facts.deployerAddress ?? null, deployerId: facts.linkTo ?? null,
        sigDeployer: 'WARN', sigBundle: 'WARN', sigHolders: 'WARN', sigLp: 'WARN', sigAuthorities: 'WARN',
      },
    });
    return c;
  }
  const radar = (p: Partial<DevRadarFacts>): DevRadarFacts => ({ deployer: DEP, fundedFrom: 'Binance 14', launched: 3, dead: 0, firstSeen: '2025-01-02T00:00:00Z', ...p });

  it('does nothing while Fourtis is not configured', async () => {
    await coin(A, DAY);
    const sources = fakeSources(testEnv());
    expect(await refreshDeployers({ prisma, fourtis: sources.fourtis, log: memoryLogger() })).toMatchObject({ skipped: 'fourtis not configured', coins: 0 });
    expect(sources.calls.filter(c => c.startsWith('fourtis'))).toEqual([]);
    expect(await prisma.deployer.count()).toBe(0);
  });

  it('refreshes the deployers of coins checked in the last 30 days and links coins that had no history', async () => {
    const known = await prisma.deployer.create({ data: { chain: 'BASE', address: DEP.toLowerCase(), record: 'BUILDER', launched: 1, dead: 0 } });
    const a = await coin(A, DAY, { deployerAddress: DEP.toLowerCase(), linkTo: known.id });
    const b = await coin(B, 2 * DAY, { deployerAddress: null });
    await coin(OLD, 40 * DAY, { deployerAddress: DEP.toLowerCase() });
    const data: FakeData = { fourtisConfigured: true, devRadar: { [A]: radar({ launched: 9, dead: 7 }), [B]: radar({ launched: 9, dead: 7 }) } };
    const sources = fakeSources(testEnv(), data);
    const res = await refreshDeployers({ prisma, fourtis: sources.fourtis, log: memoryLogger() });
    expect(res).toMatchObject({ coins: 2, answered: 2, deployers: 1, linked: 1 });
    // the coin checked 40 days ago is not asked about
    expect(sources.calls.filter(c => c.startsWith('fourtis')).sort()).toEqual([`fourtis.devRadar base ${A}`, `fourtis.devRadar base ${B}`]);
    const d = await prisma.deployer.findUniqueOrThrow({ where: { chain_address: { chain: 'BASE', address: DEP.toLowerCase() } } });
    // 9 launched, 7 dead: core deployerRecord → serial launcher
    expect(d).toMatchObject({ id: known.id, record: 'SERIAL', launched: 9, dead: 7, fundedFrom: 'Binance 14' });
    expect(d.firstSeen?.toISOString()).toBe('2025-01-02T00:00:00.000Z');
    expect(await prisma.coinFacts.findUniqueOrThrow({ where: { checkId: b.id } })).toMatchObject({ deployerId: known.id, deployerAddress: DEP.toLowerCase() });
    expect(await prisma.coinFacts.findUniqueOrThrow({ where: { checkId: a.id } })).toMatchObject({ deployerId: known.id });
  });

  it('a coin whose report names another wallet is not linked; failed or missing answers change nothing', async () => {
    const other = '0x' + '99'.repeat(20);
    const a = await coin(A, DAY, { deployerAddress: other });
    await coin(B, DAY);
    const sources = fakeSources(testEnv(), { fourtisConfigured: true, devRadar: { [A]: radar({}), [B]: 'error' } });
    const res = await refreshDeployers({ prisma, fourtis: sources.fourtis, log: memoryLogger() });
    expect(res).toMatchObject({ coins: 2, answered: 1, deployers: 1, linked: 0 });
    expect(await prisma.coinFacts.findUniqueOrThrow({ where: { checkId: a.id } })).toMatchObject({ deployerId: null, deployerAddress: other });
    expect(await prisma.deployer.findFirstOrThrow()).toMatchObject({ record: 'BUILDER', launched: 3 });
  });

  it('a coin found by a website or X post check is refreshed and linked too; a check that assessed no coin is skipped', async () => {
    const facts = { sigDeployer: 'WARN', sigBundle: 'WARN', sigHolders: 'WARN', sigLp: 'WARN', sigAuthorities: 'WARN' } as const;
    // orbitswap.xyz: the site check found $ORBIT (saveTarget put its chain and contract on the SITE target)
    const site = await prisma.target.create({ data: { key: 'site:orbitswap.xyz', kind: 'SITE', domain: 'orbitswap.xyz', chain: 'BASE', ca: A, name: 'orbitswap.xyz' } });
    const siteCheck = await prisma.check.create({
      data: { shortId: 'site001', targetId: site.id, targetRaw: 'orbitswap.xyz', status: 'DONE', isLatest: true, finishedAt: new Date(Date.now() - DAY) },
    });
    await prisma.coinFacts.create({ data: { checkId: siteCheck.id, deployerAddress: DEP.toLowerCase(), ...facts } });
    // an X post whose check found $B
    const post = await prisma.target.create({ data: { key: 'x:kairolabs', kind: 'POST', handle: 'kairolabs', chain: 'BASE', ca: B, name: '@kairolabs' } });
    const postCheck = await prisma.check.create({
      data: { shortId: 'post001', targetId: post.id, targetRaw: 'https://x.com/kairolabs/status/1', status: 'DONE', isLatest: true, finishedAt: new Date(Date.now() - DAY) },
    });
    await prisma.coinFacts.create({ data: { checkId: postCheck.id, ...facts } });
    // a site with a contract on its target but whose check assessed no coin: nothing to ask DevRadar about
    const bare = await prisma.target.create({ data: { key: 'site:bare.xyz', kind: 'SITE', domain: 'bare.xyz', chain: 'BASE', ca: OLD, name: 'bare.xyz' } });
    await prisma.check.create({ data: { shortId: 'bare001', targetId: bare.id, targetRaw: 'bare.xyz', status: 'DONE', isLatest: true, finishedAt: new Date(Date.now() - DAY) } });

    const sources = fakeSources(testEnv(), { fourtisConfigured: true, devRadar: { [A]: radar({}), [B]: radar({}), [OLD]: radar({}) } });
    const res = await refreshDeployers({ prisma, fourtis: sources.fourtis, log: memoryLogger() });
    expect(res).toMatchObject({ coins: 2, answered: 2, deployers: 1, linked: 2 });
    expect(sources.calls.filter(c => c.startsWith('fourtis')).sort()).toEqual([`fourtis.devRadar base ${A}`, `fourtis.devRadar base ${B}`]);
    const dep = await prisma.deployer.findUniqueOrThrow({ where: { chain_address: { chain: 'BASE', address: DEP.toLowerCase() } } });
    expect(await prisma.coinFacts.findUniqueOrThrow({ where: { checkId: siteCheck.id } })).toMatchObject({ deployerId: dep.id });
    expect(await prisma.coinFacts.findUniqueOrThrow({ where: { checkId: postCheck.id } })).toMatchObject({ deployerId: dep.id, deployerAddress: DEP.toLowerCase() });
  });

  it('private (Max) checks are never read: a coin only they checked gets no Deployer row, and none is linked to them', async () => {
    const facts = { sigDeployer: 'WARN', sigBundle: 'WARN', sigHolders: 'WARN', sigLp: 'WARN', sigAuthorities: 'WARN' } as const;
    const privateCheck = async (targetId: string, ca: string, shortId: string) => {
      const c = await prisma.check.create({
        data: { shortId, targetId, targetRaw: ca, status: 'DONE', isPrivate: true, isLatest: false, finishedAt: new Date(Date.now() - DAY) },
      });
      await prisma.coinFacts.create({ data: { checkId: c.id, ...facts } });
      return c;
    };
    // a coin only a Max user checked, privately
    const P = '0x' + 'd4'.repeat(20);
    const tP = await prisma.target.create({ data: { key: `ca:base:${P}`, kind: 'COIN', chain: 'BASE', ca: P, name: 'priv' } });
    await privateCheck(tP.id, P, 'priv001');
    // a coin checked publicly two days ago and privately since: its public check is the one refreshed and linked
    const pub = await coin(A, 2 * DAY);
    const newerPrivate = await privateCheck(pub.targetId, A, 'priv002');
    const hidden = '0x' + '77'.repeat(20);
    const sources = fakeSources(testEnv(), { fourtisConfigured: true, devRadar: { [P]: radar({ deployer: hidden }), [A]: radar({}) } });

    const res = await refreshDeployers({ prisma, fourtis: sources.fourtis, log: memoryLogger() });
    expect(res).toMatchObject({ coins: 1, answered: 1, deployers: 1, linked: 1 });
    expect(sources.calls.filter(c => c.startsWith('fourtis'))).toEqual([`fourtis.devRadar base ${A}`]);
    expect(await prisma.deployer.findUnique({ where: { chain_address: { chain: 'BASE', address: hidden } } })).toBeNull();
    const dep = await prisma.deployer.findUniqueOrThrow({ where: { chain_address: { chain: 'BASE', address: DEP.toLowerCase() } } });
    expect(await prisma.coinFacts.findUniqueOrThrow({ where: { checkId: pub.id } })).toMatchObject({ deployerId: dep.id });
    expect(await prisma.coinFacts.findUniqueOrThrow({ where: { checkId: newerPrivate.id } })).toMatchObject({ deployerId: null });
  });
});

describe('tier refresh', () => {
  const TOKEN = 'ApeCheckMint11111111111111111111111111111111';
  const live = { TOKEN_CHAIN: 'sol', TOKEN_ADDRESS: TOKEN, PRO_MIN_HOLD: '250000', MAX_MIN_HOLD: '2500000' };
  let n = 0;
  const user = (data: { tier?: 'FREE' | 'PRO' | 'MAX'; seenAgo?: number | null; checkedAgo?: number | null; holding?: number | null; sol?: string; evm?: string }) =>
    prisma.user.create({
      data: {
        solAddress: data.sol ?? `So1User${String(++n).padStart(37, '1')}`,
        evmAddress: data.evm ?? null,
        tier: data.tier ?? 'FREE',
        lastSeenAt: data.seenAgo == null ? null : new Date(Date.now() - data.seenAgo),
        tierCheckedAt: data.checkedAgo == null ? null : new Date(Date.now() - data.checkedAgo),
        holding: data.holding ?? null,
      },
    });

  it('re-reads stale tiers of users seen this week and of idle paid users once a day', async () => {
    const buyer = await user({ seenAgo: HOUR, checkedAgo: 2 * HOUR, holding: 0 });
    const seller = await user({ tier: 'MAX', seenAgo: 3 * DAY, checkedAgo: 2 * HOUR, holding: 3_000_000 });
    const fresh = await user({ seenAgo: HOUR, checkedAgo: 10 * 60_000, holding: 0 });
    const gone = await user({ seenAgo: 30 * DAY, checkedAgo: 5 * DAY, holding: 0 });
    const idlePro = await user({ tier: 'PRO', seenAgo: 30 * DAY, checkedAgo: 2 * DAY, holding: 300_000 });
    const idleProRecent = await user({ tier: 'PRO', seenAgo: 30 * DAY, checkedAgo: 3 * HOUR, holding: 300_000 });
    const balances: Record<string, number | null> = {
      [buyer.solAddress!]: 400_000,
      [seller.solAddress!]: 10,
      [fresh.solAddress!]: 9_000_000,
      [gone.solAddress!]: 9_000_000,
      [idlePro.solAddress!]: 0,
      [idleProRecent.solAddress!]: 0,
    };
    const env = testEnv(live);
    const sources = fakeSources(env, { balances });
    const res = await refreshTiers({ env, prisma, readBalance: balanceReader(sources), log: memoryLogger() });
    expect(res).toMatchObject({ users: 3, read: 3, failed: 0, changed: 3 });
    const tier = async (id: string) => (await prisma.user.findUniqueOrThrow({ where: { id } })).tier;
    expect(await tier(buyer.id)).toBe('PRO');
    expect(await tier(seller.id)).toBe('FREE');
    expect(await tier(idlePro.id)).toBe('FREE');
    // not due: read less than an hour ago / not seen for a week / an idle Pro read today
    expect(await tier(fresh.id)).toBe('FREE');
    expect(await tier(gone.id)).toBe('FREE');
    expect(await tier(idleProRecent.id)).toBe('PRO');
    const b = await prisma.user.findUniqueOrThrow({ where: { id: buyer.id } });
    expect(Number(b.holding)).toBe(400_000);
    expect(Date.now() - b.tierCheckedAt!.getTime()).toBeLessThan(60_000);
  });

  it('a failed balance read keeps the tier; while the token is not live only TIER_OVERRIDES give a tier', async () => {
    const pro = await user({ tier: 'PRO', seenAgo: HOUR, checkedAgo: 2 * HOUR, holding: 300_000 });
    const env = testEnv(live);
    const res = await refreshTiers({ env, prisma, readBalance: balanceReader(fakeSources(env, { balances: { [pro.solAddress!]: null } })), log: memoryLogger() });
    expect(res).toMatchObject({ users: 1, read: 0, failed: 1, changed: 0 });
    expect(await prisma.user.findUniqueOrThrow({ where: { id: pro.id } })).toMatchObject({ tier: 'PRO' });

    await resetDb();
    const team = await user({ seenAgo: HOUR, evm: '0x' + 'Ab'.repeat(20) });
    const was = await user({ tier: 'MAX', seenAgo: HOUR });
    const notLive = testEnv({ TIER_OVERRIDES: `${'0x' + 'ab'.repeat(20)}:max` });
    const sources = fakeSources(notLive);
    const r2 = await refreshTiers({ env: notLive, prisma, readBalance: balanceReader(sources), log: memoryLogger() });
    expect(r2).toMatchObject({ users: 2, read: 0, changed: 2 });
    expect(sources.calls.filter(c => c.includes('tokenBalance'))).toEqual([]);
    expect(await prisma.user.findUniqueOrThrow({ where: { id: team.id } })).toMatchObject({ tier: 'MAX' });
    expect(await prisma.user.findUniqueOrThrow({ where: { id: was.id } })).toMatchObject({ tier: 'FREE' });
  });

  it('failed reads keep a paid tier only a day after the last good read: then Free, logged once', async () => {
    const idleMax = await user({ tier: 'MAX', seenAgo: 30 * DAY, checkedAgo: 25 * HOUR, holding: 3_000_000 });
    const seen = await user({ tier: 'PRO', seenAgo: HOUR, checkedAgo: 2 * HOUR, holding: 300_000 });
    await prisma.user.update({ where: { id: idleMax.id }, data: { tierReadAt: new Date(Date.now() - 25 * HOUR) } });
    await prisma.user.update({ where: { id: seen.id }, data: { tierReadAt: new Date(Date.now() - 23 * HOUR) } });
    const env = testEnv(live);
    const failing = balanceReader(fakeSources(env, { balances: { [idleMax.solAddress!]: null, [seen.solAddress!]: null } }));
    const log = memoryLogger();
    const res = await refreshTiers({ env, prisma, readBalance: failing, log });
    expect(res).toMatchObject({ users: 2, read: 0, failed: 2, changed: 1 });
    expect(await prisma.user.findUniqueOrThrow({ where: { id: idleMax.id } })).toMatchObject({ tier: 'FREE', holding: null });
    expect(await prisma.user.findUniqueOrThrow({ where: { id: seen.id } })).toMatchObject({ tier: 'PRO' });
    expect(log.lines.filter(l => l.includes('holding dropped'))).toEqual([expect.stringContaining(`warn user ${idleMax.id}:`)]);

    // an hour later the seen user is past the day too
    const later = Date.now() + 2 * HOUR;
    const log2 = memoryLogger();
    const r2 = await refreshTiers({ env, prisma, readBalance: failing, log: log2 }, later);
    expect(r2).toMatchObject({ failed: 1, changed: 1 });
    expect(await prisma.user.findUniqueOrThrow({ where: { id: seen.id } })).toMatchObject({ tier: 'FREE', holding: null });
    expect(log2.lines.filter(l => l.includes('holding dropped'))).toEqual([expect.stringContaining(`warn user ${seen.id}:`)]);
  });
});
