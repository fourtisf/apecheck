/** GET /v1/deployers, GET /v1/insights, GET /v1/bot/stats */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  NAR_BANDS,
  TUNING,
  checkedOut,
  hueOf,
  type BotStatsDTO,
  type DeployerRowDTO,
  type DeployersResponse,
  type ChainDb,
  type InsightsDTO,
} from '@apecheck/core';
import { Prisma, type PrismaClient } from '@apecheck/db';
import type { AppDeps } from '../context';
import { coinKeyOf, loadSeries, summaryInclude, toDeployerDTO, toSummary } from '../mappers';
import { ChainFilterZ, chainDbOf, opt, startOfUtcDay, viewerOf } from './util';

const DeployersQueryZ = z.object({
  chain: ChainFilterZ,
  sort: opt(z.enum(['real', 'dead', 'launched']).default('real')),
  limit: opt(z.coerce.number().int().min(1).max(500).default(200)),
});

type DeployerSort = 'real' | 'dead' | 'launched';

/** Every deployer with the coins of theirs that are on the feed (latest public finished checks). */
export async function deployerRows(prisma: PrismaClient, chain: ChainDb | null): Promise<DeployerRowDTO[]> {
  const rows = await prisma.deployer.findMany({
    where: chain ? { chain } : {},
    include: {
      coins: {
        where: { check: { isLatest: true, status: 'DONE', isPrivate: false } },
        select: {
          check: {
            select: {
              shortId: true,
              totalScore: true,
              coinScore: true,
              coinBand: true,
              target: { select: { ticker: true, name: true, key: true } },
            },
          },
        },
      },
    },
  });
  return rows.map(d => {
    const coins = d.coins
      .map(c => c.check)
      .sort((a, b) => (b.coinScore ?? -1) - (a.coinScore ?? -1));
    const totals = coins.filter(c => c.totalScore != null).map(c => c.totalScore!);
    return {
      ...toDeployerDTO(d),
      checked: coins.length,
      real: coins.filter(c => c.totalScore != null && checkedOut(c.totalScore, c.coinScore)).length,
      avgTotal: totals.length ? Math.round(totals.reduce((a, b) => a + b, 0) / totals.length) : null,
      coins: coins.map(c => ({
        id: c.shortId,
        ticker: c.target.ticker,
        name: c.target.name,
        hue: hueOf(c.target.key),
        coinScore: c.coinScore,
        coinBand: coinKeyOf(c.coinBand),
      })),
    };
  });
}

export function sortDeployers(rows: DeployerRowDTO[], sort: DeployerSort): DeployerRowDTO[] {
  const ratio = (d: DeployerRowDTO) => (d.checked ? d.real / d.checked : -1);
  const tie = (a: DeployerRowDTO, b: DeployerRowDTO) => a.address.localeCompare(b.address);
  const cmp: Record<DeployerSort, (a: DeployerRowDTO, b: DeployerRowDTO) => number> = {
    real: (a, b) => ratio(b) - ratio(a) || b.checked - a.checked || tie(a, b),
    dead: (a, b) => b.dead - a.dead || b.launched - a.launched || tie(a, b),
    launched: (a, b) => b.launched - a.launched || b.dead - a.dead || tie(a, b),
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
    const rows = sortDeployers(await deployerRows(deps.prisma, chainDbOf(q.chain)), q.sort);
    return { items: rows.slice(0, q.limit) };
  });

  app.get('/v1/insights', async (request): Promise<InsightsDTO> => {
    const { prisma } = deps;
    const now = new Date();
    const today = startOfUtcDay(now);
    const windowStart = new Date(now.getTime() - TUNING.sinceWindowDays * 86400_000);

    const [checked, todayCount, larp, byBand, deployers] = await Promise.all([
      // the two hero numbers count the same thing (finished checks), so "today" is a subset of "checked"
      prisma.check.count({ where: { status: 'DONE' } }),
      prisma.check.count({ where: { status: 'DONE', finishedAt: { gte: today } } }),
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

    const builders = sortDeployers(deployers.filter(d => d.checked >= 1), 'real')
      .slice(0, 4)
      .map(d => ({ address: d.address, chain: d.chain, record: d.record, checked: d.checked, real: d.real }));

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
