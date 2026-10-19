/**
 * worker-prices tick: pick tracked coins that are due, fetch them from DexScreener in batches, store a
 * PricePoint each and refresh Target.last*. A coin is tracked for 30 days after its latest finished check, on
 * that check's cadence (every new check — a Re-check included — starts the 15 min / 1 h / 1 day schedule
 * again), because "since check" compares the latest price with the latest check's priceAtCheck. The latest *public*
 * check anchors it: a private (Max) check never moves a public coin's schedule (that would squeeze its public "since
 * check" chart and feed sparkline into the last few hours); a coin only private checks looked at is tracked on the
 * newest of them.
 *
 * A check that finished while DexScreener didn't answer has no priceAtCheck, so it could never show a "since check"
 * move nor count in the "Since check, by verdict" card. The first price the tracker reads within
 * PRICE_AT_CHECK_BACKFILL_MS of such a check finishing becomes its price at check (and market cap at check). A price
 * read later than that is not the price at check: it is never backfilled (a pair created hours after the check).
 */
import type { PrismaClient } from '@apecheck/db';
import { chainFromDb, type ChainKey } from '@apecheck/core';
import type { DexScreenerSource, DexTokenInfo } from '@apecheck/sources';
import type { Logger } from '../log';
import { TRACK_DAYS, isDue } from './schedule';

export interface PriceTickDeps {
  prisma: PrismaClient;
  dex: DexScreenerSource;
  log: Logger;
  /** addresses per DexScreener request */
  batchSize?: number;
}

export interface PriceTickResult {
  tracked: number;
  due: number;
  written: number;
}

const finite = (n: number | null | undefined) => (n != null && Number.isFinite(n) ? n : null);

/** how long after a check a price still counts as its price at check (when the check itself got none) */
export const PRICE_AT_CHECK_BACKFILL_MS = 30 * 60_000;

export async function runPriceTick(deps: PriceTickDeps, now = Date.now()): Promise<PriceTickResult> {
  const { prisma, dex, log } = deps;
  const since = new Date(now - TRACK_DAYS * 86_400_000);
  // the newest finished public check of each target (the one the feed and report show) anchors its schedule; a
  // target with only private checks, the newest of those
  const newest = (isPrivate: boolean) =>
    prisma.check.groupBy({
      by: ['targetId'],
      where: { status: 'DONE', isPrivate, finishedAt: { not: null } },
      _max: { finishedAt: true },
      having: { finishedAt: { _max: { gte: since } } },
    });
  const [pub, priv] = await Promise.all([newest(false), newest(true)]);
  const anchors = new Map<string, Date>();
  const privateAnchor = new Set<string>();
  for (const f of priv) {
    anchors.set(f.targetId, f._max.finishedAt!);
    privateAnchor.add(f.targetId);
  }
  for (const f of pub) {
    anchors.set(f.targetId, f._max.finishedAt!);
    privateAnchor.delete(f.targetId);
  }
  if (!anchors.size) return { tracked: 0, due: 0, written: 0 };
  const ids = [...anchors.keys()];
  const targets = await prisma.target.findMany({
    where: { id: { in: ids }, ca: { not: null }, chain: { not: null } },
    select: { id: true, ca: true, chain: true },
  });
  const lasts = await prisma.pricePoint.groupBy({ by: ['targetId'], where: { targetId: { in: targets.map(t => t.id) } }, _max: { ts: true } });
  const lastBy = new Map(lasts.map(l => [l.targetId, l._max.ts]));

  const due = targets.filter(t => isDue(anchors.get(t.id)!, lastBy.get(t.id) ?? null, now));
  const byChain = new Map<ChainKey, { id: string; ca: string }[]>();
  for (const t of due) {
    const chain = chainFromDb(t.chain);
    if (!chain || !t.ca) continue;
    const list = byChain.get(chain) ?? [];
    list.push({ id: t.id, ca: t.ca });
    byChain.set(chain, list);
  }

  let written = 0;
  const size = deps.batchSize ?? 30;
  const ts = new Date(now);
  for (const [chain, list] of byChain) {
    for (let i = 0; i < list.length; i += size) {
      const batch = list.slice(i, i + size);
      let info: Map<string, DexTokenInfo>;
      try {
        info = await dex.tokens(chain, batch.map(b => b.ca));
      } catch (e) {
        log.warn(`price batch failed on ${chain}`, e);
        continue;
      }
      for (const t of batch) {
        const m = info.get(t.ca.toLowerCase()) ?? info.get(t.ca);
        const price = finite(m?.priceUsd);
        if (!m || price == null || price <= 0) continue;
        const mc = finite(m.mc) ?? finite(m.fdv);
        const vol5m = finite(m.vol5m);
        const anchor = anchors.get(t.id)!;
        const backfill = now - anchor.getTime() <= PRICE_AT_CHECK_BACKFILL_MS;
        await prisma.$transaction([
          prisma.pricePoint.create({ data: { targetId: t.id, ts, price, mc, vol5m } }),
          prisma.target.update({
            where: { id: t.id },
            data: { lastPrice: price, lastMc: mc, lastVol5m: vol5m, lastCh24: finite(m.ch24), priceUpdatedAt: ts },
          }),
          // the latest check got no price (DexScreener down during the check): this one, minutes later, is its price at check
          ...(backfill
            ? [prisma.check.updateMany({ where: { targetId: t.id, status: 'DONE', isPrivate: privateAnchor.has(t.id), finishedAt: anchor, priceAtCheck: null }, data: { priceAtCheck: price, mcAtCheck: mc } })]
            : []),
        ]);
        written++;
      }
    }
  }
  if (due.length) log.info(`prices: ${written}/${due.length} due coins updated (${targets.length} tracked)`);
  if (written < due.length && dex.lastError) log.warn(`DexScreener: ${dex.lastError}`);
  return { tracked: targets.length, due: due.length, written };
}
