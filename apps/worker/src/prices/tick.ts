/**
 * worker-prices tick: pick tracked coins that are due, fetch them from DexScreener in batches, store a
 * PricePoint each and refresh Target.last*. Coins are tracked from their first finished check for 30 days.
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

export async function runPriceTick(deps: PriceTickDeps, now = Date.now()): Promise<PriceTickResult> {
  const { prisma, dex, log } = deps;
  const since = new Date(now - TRACK_DAYS * 86_400_000);
  const firsts = await prisma.check.groupBy({
    by: ['targetId'],
    where: { status: 'DONE', finishedAt: { not: null } },
    _min: { finishedAt: true },
    having: { finishedAt: { _min: { gte: since } } },
  });
  if (!firsts.length) return { tracked: 0, due: 0, written: 0 };
  const anchors = new Map(firsts.map(f => [f.targetId, f._min.finishedAt!]));
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
        await prisma.$transaction([
          prisma.pricePoint.create({ data: { targetId: t.id, ts, price, mc, vol5m } }),
          prisma.target.update({
            where: { id: t.id },
            data: { lastPrice: price, lastMc: mc, lastVol5m: vol5m, lastCh24: finite(m.ch24), priceUpdatedAt: ts },
          }),
        ]);
        written++;
      }
    }
  }
  if (due.length) log.info(`prices: ${written}/${due.length} due coins updated (${targets.length} tracked)`);
  if (written < due.length && dex.lastError) log.warn(`DexScreener: ${dex.lastError}`);
  return { tracked: targets.length, due: due.length, written };
}
