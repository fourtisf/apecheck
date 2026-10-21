/** GET /v1/deployers, GET /v1/insights, GET /v1/bot/stats */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  NAR_BANDS,
  TUNING,
  checkedOut,
  deployerKey,
  type BotStatsDTO,
  type ChainKey,
  type DeployerRowDTO,
  type DeployersResponse,
  type InsightsDTO,
} from '@apecheck/core';
import { Prisma, deployerCoins, type DeployerCoinRow, type PrismaClient } from '@apecheck/db';
import type { AppDeps } from '../context';
import { loadSeries, summaryInclude, toDeployerCoinDTO, toSummary } from '../mappers';
import { ChainFilterZ, opt, startOfUtcDay, viewerOf } from './util';

type DeployerSort = 'real' | 'checked' | 'recent';

const DeployersQueryZ = z.object({
  chain: ChainFilterZ,
  // `dead` and `launched` sorted by launch records ApeCheck no longer has: old links read as `checked`
  sort: opt(
    z
      .enum(['real', 'checked', 'recent', 'dead', 'launched'])
      .default('real')
      .transform((v): DeployerSort => (v === 'dead' || v === 'launched' ? 'checked' : v)),
  ),
  limit: opt(z.coerce.number().int().min(1).max(500).default(200)),
});

/** most coin rows the deployers page and "Builders worth watching" read (one per checked coin with a known deployer) */
export const DEPLOYER_COINS_MAX = 5000;

/**
 * Every deployer wallet named by a finished public coin check, with the coins from it that ApeCheck has checked
 * (packages/db deployerCoins: one row per coin, its newest public check naming the wallet). A wallet only private (Max)
 * checks name never shows up: listing it would publish that someone privately vetted a coin of that wallet.
 */
export async function deployerRows(prisma: PrismaClient, chain: ChainKey | null): Promise<DeployerRowDTO[]> {
  const { coins } = await deployerCoins(prisma, { chain, take: DEPLOYER_COINS_MAX });
  const wallets = new Map<string, { chain: ChainKey; address: string; coins: DeployerCoinRow[] }>();
  for (const c of coins) {
    const address = deployerKey(c.chain, c.deployerAddress);
    const k = `${c.chain}:${address}`;
    const w = wallets.get(k) ?? { chain: c.chain, address, coins: [] };
    w.coins.push(c);
    wallets.set(k, w);
  }
  return [...wallets.values()].map(w => {
    const list = [...w.coins].sort((a, b) => (b.coinScore ?? -1) - (a.coinScore ?? -1));
    const totals = list.filter(c => c.totalScore != null).map(c => c.totalScore!);
    const last = Math.max(...list.map(c => c.finishedAt.getTime()));
    return {
      chain: w.chain,
      address: w.address,
      checked: list.length,
      real: list.filter(c => c.totalScore != null && checkedOut(c.totalScore, c.coinScore)).length,
      avgTotal: totals.length ? Math.round(totals.reduce((a, b) => a + b, 0) / totals.length) : null,
      lastChecked: Number.isFinite(last) ? new Date(last).toISOString() : null,
      coins: list.map(toDeployerCoinDTO),
    };
  });
}

export function sortDeployers(rows: DeployerRowDTO[], sort: DeployerSort): DeployerRowDTO[] {
  const ratio = (d: DeployerRowDTO) => (d.checked ? d.real / d.checked : -1);
  const at = (d: DeployerRowDTO) => (d.lastChecked ? Date.parse(d.lastChecked) : 0);
  const tie = (a: DeployerRowDTO, b: DeployerRowDTO) => a.address.localeCompare(b.address);
  const cmp: Record<DeployerSort, (a: DeployerRowDTO, b: DeployerRowDTO) => number> = {
    real: (a, b) => ratio(b) - ratio(a) || b.checked - a.checked || tie(a, b),
    checked: (a, b) => b.checked - a.checked || b.real - a.real || tie(a, b),
    recent: (a, b) => at(b) - at(a) || tie(a, b),
  };
  return [...rows].sort(cmp[sort]);
}

interface BandAvg {
  band: string;
  n: number;
  avg: number | null;
}

/** average since-check % per narrative band over latest public coin checks */
async function sinceByBand(prisma: PrismaClient, opts: { since?: Date; bands?: string[] }): Promise<BandAvg[]> {
  const conds = [
    Prisma.sql`c."isLatest" = true`,
    Prisma.sql`c."status" = 'DONE'`,
    Prisma.sql`c."isPrivate" = false`,
    Prisma.sql`c."priceAtCheck" > 0`,
    Prisma.sql`t."lastPrice" IS NOT NULL`,
    Prisma.sql`c."narBand" IS NOT NULL`,
  ];
  // "finishedAt" is a timestamp without time zone holding UTC. A bound Date arrives as timestamptz and Postgres
  // would compare in the session TimeZone (shifting the window by its UTC offset), so bind ISO text and cast.
  if (opts.since) conds.push(Prisma.sql`c."finishedAt" >= ${opts.since.toISOString()}::timestamp`);
  if (opts.bands?.length) conds.push(Prisma.sql`c."narBand" IN (${Prisma.join(opts.bands)})`);
  return prisma.$queryRaw<BandAvg[]>`
    SELECT c."narBand" AS band, COUNT(*)::int AS n,
           AVG((t."lastPrice" / c."priceAtCheck" - 1) * 100)::float8 AS avg
    FROM "Check" c JOIN "Target" t ON t."id" = c."targetId"
    WHERE ${Prisma.join(conds, ' AND ')}
    GROUP BY c."narBand"`;
}

const round1 = (n: number) => Math.round(n * 10) / 10;

export function registerInsightRoutes(app: FastifyInstance, deps: AppDeps) {
  app.get('/v1/deployers', async (request): Promise<DeployersResponse> => {
    const q = DeployersQueryZ.parse(request.query ?? {});
    const chain = q.chain === 'any' || q.chain === 'all' ? null : q.chain;
    const rows = sortDeployers(await deployerRows(deps.prisma, chain), q.sort ?? 'real');
    return { items: rows.slice(0, q.limit) };
  });

  app.get('/v1/insights', async (request): Promise<InsightsDTO> => {
    const { prisma } = deps;
    const now = new Date();
    const today = startOfUtcDay(now);
    const windowStart = new Date(now.getTime() - TUNING.sinceWindowDays * 86400_000);

    const [checked, todayCount, larp, byBand, deployers] = await Promise.all([
      // the two hero numbers count the same thing (finished checks), so "today" is a subset of "checked"
      // private checks (Max) stay out of every public number
      prisma.check.count({ where: { status: 'DONE', isPrivate: false } }),
      prisma.check.count({ where: { status: 'DONE', isPrivate: false, finishedAt: { gte: today } } }),
      sinceByBand(prisma, { bands: ['llarp', 'larp'] }),
      sinceByBand(prisma, { since: windowStart }),
      deployerRows(prisma, null),
    ]);

    const larpN = larp.reduce((a, b) => a + b.n, 0);
    const larpSince = larpN ? round1(larp.reduce((a, b) => a + (b.avg ?? 0) * b.n, 0) / larpN) : null;

    const band = new Map(byBand.map(b => [b.band, b]));
    const sinceByVerdict = NAR_BANDS.flatMap(b => {
      const g = band.get(b.key);
      return g && g.n > 0 && g.avg != null ? [{ key: b.key, name: b.name, n: g.n, avg: round1(g.avg) }] : [];
    });

    const mostChecked = await mostCheckedToday(deps, today, request);

    // builders: deployers with at least one coin that checked real
    const builders = sortDeployers(deployers.filter(d => d.checked >= 1 && d.real >= 1), 'real')
      .slice(0, 4)
      .map(d => ({ address: d.address, chain: d.chain, checked: d.checked, real: d.real }));

    return { stats: { checked, today: todayCount, larpSince }, sinceByVerdict, mostChecked, builders };
  });

  app.get('/v1/bot/stats', async (): Promise<BotStatsDTO> => {
    const { prisma } = deps;
    const today = startOfUtcDay();
    const [replied, accounts] = await Promise.all([
      prisma.botMention.findMany({
        // a reply posted today (repliedAt, M2), or one recorded without a time whose mention came in today
        where: { status: 'REPLIED', OR: [{ repliedAt: { gte: today } }, { repliedAt: null, createdAt: { gte: today } }] },
        select: { createdAt: true, repliedAt: true, check: { select: { finishedAt: true } } },
      }),
      // only authors who typed the bot's handle (BotMention.tagged, set by the worker): the mentions timeline also
      // brings people talking in a thread the bot is in (X's reply prefix, "not_tagged"), untagged replies to the
      // bot's verdict, retweets of someone's tag and the bot's own posts, none of which tagged it
      prisma.botMention.groupBy({ by: ['authorId'], where: { tagged: true } }).then(g => g.length),
    ]);
    // the reply's own time when the bot stored it (M2); else the check finishing, which is when the reply goes out
    const secs = replied
      .map(m => {
        const at = m.repliedAt ?? m.check?.finishedAt ?? null;
        return at ? (at.getTime() - m.createdAt.getTime()) / 1000 : null;
      })
      .filter((s): s is number => s != null && s >= 0)
      .sort((a, b) => a - b);
    let median: number | null = null;
    if (secs.length) {
      const mid = Math.floor(secs.length / 2);
      median = Math.round(secs.length % 2 ? secs[mid] : (secs[mid - 1] + secs[mid]) / 2);
    }
    return { repliesToday: replied.length, medianReplySeconds: median, accounts };
  });
}

/** Top 5 targets by checks started today (topped up from all-time when today is quiet). */
async function mostCheckedToday(deps: AppDeps, today: Date, request: Parameters<typeof viewerOf>[0]): Promise<InsightsDTO['mostChecked']> {
  const { prisma } = deps;
  const N = 5;
  const grouped = await prisma.check.groupBy({
    by: ['targetId'],
    where: { createdAt: { gte: today }, isPrivate: false },
    _count: { _all: true },
    orderBy: { _count: { targetId: 'desc' } },
    take: 50,
  });
  const todayCount = new Map(grouped.map(g => [g.targetId, g._count._all]));

  const latestToday = grouped.length
    ? await prisma.check.findMany({
        where: { isLatest: true, status: 'DONE', isPrivate: false, targetId: { in: grouped.map(g => g.targetId) } },
        include: summaryInclude,
      })
    : [];
  latestToday.sort(
    (a, b) => (todayCount.get(b.targetId) ?? 0) - (todayCount.get(a.targetId) ?? 0) || b.target.checkCount - a.target.checkCount,
  );
  const picked = latestToday.slice(0, N);

  if (picked.length < N) {
    const more = await prisma.check.findMany({
      where: { isLatest: true, status: 'DONE', isPrivate: false, targetId: { notIn: picked.map(p => p.targetId) } },
      include: summaryInclude,
      orderBy: [{ target: { checkCount: 'desc' } }, { finishedAt: 'desc' }],
      take: N - picked.length,
    });
    picked.push(...more);
  }

  const series = await loadSeries(prisma, picked);
  const ctx = { env: deps.env, viewer: viewerOf(request), series };
  return picked.map(c => ({ ...toSummary(c, ctx), checksToday: todayCount.get(c.targetId) ?? 0 }));
}
