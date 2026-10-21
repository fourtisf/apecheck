/**
 * Logos for coins checked before ApeCheck stored them (or whose logo download failed): every LOGOS_EVERY_MS, a few
 * targets with a coin (a coin, or a site or post whose check found one) and no logo get the image a check would pick
 * (DexScreener's token info > the token's own metadata > GeckoTerminal), downloaded and vetted by fetchLogo and stored
 * by storeLogo (pipeline/logo.ts). A target with no usable image is asked again after LOGOS_RETRY_MS (kept in memory:
 * a restart asks again).
 */
import { chainFromDb, type ChainKey } from '@apecheck/core';
import type { PrismaClient } from '@apecheck/db';
import { linksFromDex, mergeTokenLinks, type Sources, type TokenLinks } from '@apecheck/sources';
import type { Logger } from '../log';
import { fetchLogo, storeLogo } from '../pipeline/logo';
import { within } from '../pipeline/stage';

export const LOGOS_JOB = 'logos-backfill';
export const LOGOS_EVERY_MS = 10 * 60_000;
/** targets per run, one after another (a few requests each) */
export const LOGOS_BATCH = 12;
export const LOGOS_RETRY_MS = 24 * 3600_000;
/** cap on each metadata read */
const READ_MS = 15_000;

export interface LogoBackfillResult {
  stored: number;
  missing: number;
}

export async function backfillLogos(opts: {
  prisma: PrismaClient;
  sources: Pick<Sources, 'dex' | 'tokenLinks' | 'http'>;
  screenshotDir: string;
  log: Logger;
  /** targetId → when it last had no usable image */
  tried: Map<string, number>;
  now?: () => number;
}): Promise<LogoBackfillResult> {
  const { prisma, sources, log, tried } = opts;
  const now = opts.now ?? Date.now;
  for (const [id, at] of tried) if (now() - at > LOGOS_RETRY_MS) tried.delete(id);
  const rows = await prisma.target.findMany({
    where: { logo: null, ca: { not: null }, chain: { not: null }, ...(tried.size ? { id: { notIn: [...tried.keys()] } } : {}) },
    orderBy: [{ lastCheckedAt: { sort: 'desc', nulls: 'last' } }, { createdAt: 'desc' }],
    take: LOGOS_BATCH,
    select: { id: true, chain: true, ca: true },
  });
  const out: LogoBackfillResult = { stored: 0, missing: 0 };
  for (const t of rows) {
    const chain = chainFromDb(t.chain);
    const url = chain && t.ca ? await imageFor(sources, chain, t.ca) : null;
    const got = url ? await fetchLogo(sources.http, url) : null;
    if (!got?.ok) {
      tried.set(t.id, now());
      out.missing++;
      if (got) log.info(`logo for ${t.ca} not kept: ${got.reason}`);
      continue;
    }
    const rel = await storeLogo(opts.screenshotDir, got.bytes, got.type);
    // a check that stored one meanwhile wins
    const { count } = await prisma.target.updateMany({ where: { id: t.id, logo: null }, data: { logo: rel } });
    out.stored += count;
  }
  if (rows.length) log.info(`logos: ${out.stored} stored, ${out.missing} without a usable image`);
  return out;
}

/** The image URL a check would use for this coin, or null. */
async function imageFor(sources: Pick<Sources, 'dex' | 'tokenLinks'>, chain: ChainKey, ca: string): Promise<string | null> {
  const safe = <T>(p: Promise<T | null>) => within(p.catch(() => null), READ_MS, null);
  const fromDex = mergeTokenLinks([{ source: 'DexScreener', links: linksFromDex(await safe(sources.dex.token(chain, ca))) }]).image;
  const links = sources.tokenLinks;
  if (fromDex || !links) return fromDex?.url ?? null;
  const [meta, gecko] = await Promise.all([safe<TokenLinks>(links.metadata(chain, ca)), safe<TokenLinks>(links.gecko(chain, ca))]);
  return mergeTokenLinks([
    { source: 'On-chain', links: meta },
    { source: 'GeckoTerminal', links: gecko },
  ]).image?.url ?? null;
}
