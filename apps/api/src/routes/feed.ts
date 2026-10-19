/** GET /v1/feed, GET /v1/live, GET /v1/coins */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { CoinsResponse, FeedResponse, LiveResponse } from '@apecheck/core';
import type { Prisma, PrismaClient } from '@apecheck/db';
import type { AppDeps } from '../context';
import { activeCheckWhere, readProgress } from '../checks';
import { ApiError } from '../errors';
import { SNAPSHOT_MAX, loadSnapshot, querySig, saveSnapshot } from '../feed-snapshot';
import { SHORT_ID_RE, decodeCursor, encodeCursor, encodeSnapCursor } from '../ids';
import { loadSeries, summaryInclude, toCoinRow, toLive, toSummary, type CheckSummaryRow } from '../mappers';
import { ChainFilterZ, CoinBandZ, NarZ, chainDbOf, opt, searchTerm, viewerOf } from './util';

const FeedQueryZ = z.object({
  tab: opt(z.enum(['latest', 'checked', 'real', 'least', 'vol', 'watch']).default('latest')),
  type: opt(z.enum(['all', 'coin', 'post', 'site']).default('all')),
  nar: opt(z.union([NarZ, z.literal('any')]).default('any')),
  coin: opt(z.union([CoinBandZ, z.literal('any')]).default('any')),
  chain: ChainFilterZ,
  q: opt(z.string().max(120).optional()),
  cursor: opt(z.string().max(200).optional()),
  limit: opt(z.coerce.number().int().min(1).max(100).default(25)),
  ids: opt(z.string().max(4000).optional()),
  via: opt(z.enum(['bot', 'web', 'api']).optional()),
});

const CoinsQueryZ = z.object({
  tab: opt(z.union([CoinBandZ, z.literal('all')]).default('all')),
  chain: ChainFilterZ,
  q: opt(z.string().max(120).optional()),
  limit: opt(z.coerce.number().int().min(1).max(500).default(200)),
});

const LIVE_MAX = 8;
const IDS_MAX = 100;

/** The feed shows one row per target: its newest finished, public check. */
const FEED_BASE: Prisma.CheckWhereInput = { isLatest: true, status: 'DONE', isPrivate: false };

/**
 * `via=bot` ("From the bot", /bot "Recent bot replies"): checks the bot started, and checks the bot answered on X
 * from cache (a verdict reply was posted about them, M2). `via=web|api`: who started the check.
 */
export function viaWhere(via: 'bot' | 'web' | 'api'): Prisma.CheckWhereInput {
  if (via !== 'bot') return { via: via.toUpperCase() as 'WEB' | 'API' };
  return { OR: [{ via: 'BOT' }, { mentions: { some: { status: 'REPLIED', OR: [{ kind: 'check' }, { kind: null }] } } }] };
}

const hasCoinWhere: Prisma.CheckWhereInput = { OR: [{ coinScore: { not: null } }, { coinFacts: { isNot: null } }] };

function searchWhere(term: string, fields: ('name' | 'ticker' | 'domain' | 'handle' | 'ca')[]): Prisma.CheckWhereInput {
  const like = { contains: term, mode: 'insensitive' as const };
  return {
    OR: [
      ...fields.map(f => ({ target: { [f]: like } }) as Prisma.CheckWhereInput),
      { coinFacts: { is: { deployer: { is: { address: like } } } } },
      { coinFacts: { is: { deployerAddress: like } } },
    ],
  };
}

const FEED_ORDER: Record<string, Prisma.CheckOrderByWithRelationInput[]> = {
  latest: [{ finishedAt: 'desc' }, { id: 'desc' }],
  watch: [{ finishedAt: 'desc' }, { id: 'desc' }],
  checked: [{ target: { checkCount: 'desc' } }, { finishedAt: 'desc' }, { id: 'desc' }],
  real: [{ totalScore: { sort: 'desc', nulls: 'last' } }, { finishedAt: 'desc' }, { id: 'desc' }],
  least: [{ totalScore: { sort: 'asc', nulls: 'last' } }, { finishedAt: 'desc' }, { id: 'desc' }],
  vol: [{ target: { lastVol5m: { sort: 'desc', nulls: 'last' } } }, { finishedAt: 'desc' }, { id: 'desc' }],
};

/** The feed row of each target (its latest public verdict, if it still matches `where`), in the given order. */
async function rowsOfTargets(prisma: PrismaClient, where: Prisma.CheckWhereInput, targetIds: string[]): Promise<CheckSummaryRow[]> {
  if (!targetIds.length) return [];
  const rows = await prisma.check.findMany({
    where: { AND: [where, { targetId: { in: targetIds } }] },
    include: summaryInclude,
    orderBy: [{ finishedAt: 'desc' }, { id: 'desc' }],
  });
  const byTarget = new Map<string, CheckSummaryRow>();
  for (const r of rows) if (!byTarget.has(r.targetId)) byTarget.set(r.targetId, r);
  return targetIds.flatMap(id => byTarget.get(id) ?? []);
}

export function registerFeedRoutes(app: FastifyInstance, deps: AppDeps) {
  app.get('/v1/feed', async (request): Promise<FeedResponse> => {
    const q = FeedQueryZ.parse(request.query ?? {});
    const cursor = decodeCursor(q.cursor);
    if (!cursor) throw new ApiError(400, 'bad_request', 'Invalid cursor');

    const and: Prisma.CheckWhereInput[] = [FEED_BASE];
    const ids = (q.ids ?? '').split(',').map(s => s.trim()).filter(s => SHORT_ID_RE.test(s)).slice(0, IDS_MAX);
    if (q.ids != null || q.tab === 'watch') {
      if (!ids.length) return { items: [], total: 0, nextCursor: null };
      // a watched id keeps matching after a re-check: follow it to its target's latest check
      and.push({ target: { checks: { some: { shortId: { in: ids } } } } });
    }
    if (q.via) and.push(viaWhere(q.via));
    if (q.tab === 'vol') and.push(hasCoinWhere);
    if (q.type !== 'all') and.push({ target: { kind: q.type.toUpperCase() as 'COIN' | 'POST' | 'SITE' } });
    if (q.nar !== 'any') and.push({ narBand: q.nar });
    if (q.coin !== 'any') and.push({ coinBand: q.coin });
    const chain = chainDbOf(q.chain);
    if (chain) and.push({ target: { chain } });
    const term = searchTerm(q.q);
    if (term) and.push(searchWhere(term, ['name', 'ticker', 'domain', 'handle', 'ca']));

    const where: Prisma.CheckWhereInput = { AND: and };
    const orderBy = FEED_ORDER[q.tab];
    const { prisma, redis } = deps;
    // a snapshot cursor only reads a snapshot of the same query (same tab and filters)
    const sig = querySig({
      tab: q.tab, type: q.type, nar: q.nar, coin: q.coin, chain, term: term ?? null,
      ids: q.ids != null || q.tab === 'watch' ? ids : null, via: q.via ?? null,
    });

    /** the live order from `offset` (old cursors, an expired snapshot, rows past the snapshot) */
    const livePage = async (offset: number, total: Promise<number>) => {
      const rows = await prisma.check.findMany({ where, include: summaryInclude, orderBy, skip: offset, take: q.limit });
      const next = offset + rows.length;
      return { rows, nextCursor: next < (await total) && rows.length ? encodeCursor(next) : null };
    };
    /** after the last snapshot row: the live order goes on when the snapshot was cut at SNAPSHOT_MAX */
    const pastSnapshot = async (len: number, total: Promise<number>) => (len >= SNAPSHOT_MAX && (await total) > len ? encodeCursor(len) : null);

    const page = async (total: Promise<number>): Promise<{ rows: CheckSummaryRow[]; nextCursor: string | null }> => {
      if (cursor.snap) {
        const order = await loadSnapshot(redis, cursor.snap, sig).catch(err => {
          request.log.warn({ err }, 'feed snapshot unreadable; paging the live order');
          return null;
        });
        if (!order) return livePage(cursor.offset, total);
        const end = cursor.offset + q.limit;
        const rows = await rowsOfTargets(prisma, where, order.slice(cursor.offset, end));
        return { rows, nextCursor: end < order.length ? encodeSnapCursor(cursor.snap, end) : await pastSnapshot(order.length, total) };
      }
      if (cursor.offset > 0) return livePage(cursor.offset, total);

      // first page: freeze the order it is cut from, so "Load more" continues that order even when rows move
      const head = await prisma.check.findMany({ where, select: { targetId: true }, orderBy, take: SNAPSHOT_MAX });
      const order = [...new Set(head.map(r => r.targetId))];
      const rows = await rowsOfTargets(prisma, where, order.slice(0, q.limit));
      if (order.length <= q.limit) return { rows, nextCursor: await pastSnapshot(order.length, total) };
      const token = await saveSnapshot(redis, sig, order).catch(err => {
        request.log.warn({ err }, 'feed snapshot not stored; the next page reads the live order');
        return null;
      });
      return { rows, nextCursor: token ? encodeSnapCursor(token, q.limit) : encodeCursor(q.limit) };
    };

    const totalP = prisma.check.count({ where });
    const [total, { rows, nextCursor }] = await Promise.all([totalP, page(totalP)]);
    const series = await loadSeries(prisma, rows);
    const ctx = { env: deps.env, viewer: viewerOf(request), series };
    return { items: rows.map(r => toSummary(r, ctx)), total, nextCursor };
  });

  app.get('/v1/live', async (request): Promise<LiveResponse> => {
    const rows = await deps.prisma.check.findMany({
      where: { AND: [activeCheckWhere(deps.env), { isPrivate: false }] },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: LIVE_MAX,
      select: {
        id: true,
        shortId: true,
        status: true,
        createdAt: true,
        startedAt: true,
        requesterSid: true,
        evidence: true,
        target: { select: { kind: true, name: true, ticker: true, chain: true, key: true } },
        _count: { select: { steps: true } },
        steps: { orderBy: { idx: 'desc' }, take: 1, select: { text: true } },
      },
    });
    const progress = await readProgress(deps, rows.filter(r => r.status === 'RUNNING').map(r => r.id));
    const ctx = { env: deps.env, viewer: viewerOf(request), progress, now: Date.now() };
    return { items: rows.map(r => toLive(r, ctx)) };
  });

  app.get('/v1/coins', async (request): Promise<CoinsResponse> => {
    const q = CoinsQueryZ.parse(request.query ?? {});
    const and: Prisma.CheckWhereInput[] = [FEED_BASE, { coinScore: { not: null } }, { coinFacts: { isNot: null } }];
    if (q.tab !== 'all') and.push({ coinBand: q.tab });
    const chain = chainDbOf(q.chain);
    if (chain) and.push({ target: { chain } });
    const term = searchTerm(q.q);
    if (term) and.push(searchWhere(term, ['name', 'ticker', 'ca']));

    const where: Prisma.CheckWhereInput = { AND: and };
    const [total, rows] = await Promise.all([
      deps.prisma.check.count({ where }),
      deps.prisma.check.findMany({
        where,
        include: summaryInclude,
        orderBy: [{ coinScore: 'desc' }, { finishedAt: 'desc' }, { id: 'desc' }],
        take: q.limit,
      }),
    ]);
    const series = await loadSeries(deps.prisma, rows);
    const ctx = { env: deps.env, viewer: viewerOf(request), series };
    return { items: rows.map(r => toCoinRow(r, ctx)), total };
  });
}
