/** GET /v1/feed, GET /v1/live, GET /v1/coins */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { CoinsResponse, FeedResponse, LiveResponse } from '@apecheck/core';
import type { Prisma } from '@apecheck/db';
import type { AppDeps } from '../context';
import { activeCheckWhere, readProgress } from '../checks';
import { ApiError } from '../errors';
import { SHORT_ID_RE, decodeCursor, encodeCursor } from '../ids';
import { loadSeries, summaryInclude, toCoinRow, toLive, toSummary } from '../mappers';
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

const hasCoinWhere: Prisma.CheckWhereInput = { OR: [{ coinScore: { not: null } }, { coinFacts: { isNot: null } }] };

function searchWhere(term: string, fields: ('name' | 'ticker' | 'domain' | 'handle' | 'ca')[]): Prisma.CheckWhereInput {
  const like = { contains: term, mode: 'insensitive' as const };
  return {
    OR: [
      ...fields.map(f => ({ target: { [f]: like } }) as Prisma.CheckWhereInput),
      { coinFacts: { is: { deployer: { is: { address: like } } } } },
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

export function registerFeedRoutes(app: FastifyInstance, deps: AppDeps) {
  app.get('/v1/feed', async (request): Promise<FeedResponse> => {
    const q = FeedQueryZ.parse(request.query ?? {});
    const offset = decodeCursor(q.cursor);
    if (offset == null) throw new ApiError(400, 'bad_request', 'Invalid cursor');

    const and: Prisma.CheckWhereInput[] = [FEED_BASE];
    const ids = (q.ids ?? '').split(',').map(s => s.trim()).filter(s => SHORT_ID_RE.test(s)).slice(0, IDS_MAX);
    if (q.ids != null || q.tab === 'watch') {
      if (!ids.length) return { items: [], total: 0, nextCursor: null };
      // a watched id keeps matching after a re-check: follow it to its target's latest check
      and.push({ target: { checks: { some: { shortId: { in: ids } } } } });
    }
    if (q.via) and.push({ via: q.via.toUpperCase() as 'BOT' | 'WEB' | 'API' });
    if (q.tab === 'vol') and.push(hasCoinWhere);
    if (q.type !== 'all') and.push({ target: { kind: q.type.toUpperCase() as 'COIN' | 'POST' | 'SITE' } });
    if (q.nar !== 'any') and.push({ narBand: q.nar });
    if (q.coin !== 'any') and.push({ coinBand: q.coin });
    const chain = chainDbOf(q.chain);
    if (chain) and.push({ target: { chain } });
    const term = searchTerm(q.q);
    if (term) and.push(searchWhere(term, ['name', 'ticker', 'domain', 'handle', 'ca']));

    const where: Prisma.CheckWhereInput = { AND: and };
    const [total, rows] = await Promise.all([
      deps.prisma.check.count({ where }),
      deps.prisma.check.findMany({ where, include: summaryInclude, orderBy: FEED_ORDER[q.tab], skip: offset, take: q.limit }),
    ]);
    const series = await loadSeries(deps.prisma, rows);
    const ctx = { env: deps.env, viewer: viewerOf(request), series };
    const next = offset + rows.length;
    return { items: rows.map(r => toSummary(r, ctx)), total, nextCursor: next < total && rows.length ? encodeCursor(next) : null };
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
