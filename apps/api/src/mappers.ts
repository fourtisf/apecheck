/**
 * DB rows → API DTOs (core dto.ts). The single place the API shapes data: routes load rows
 * with the include shapes below and hand them here.
 */
import path from 'node:path';
import {
  CLAIM_LABEL,
  CLAIM_SIGNAL,
  CLAIM_SOURCE_LABEL,
  COIN_BANDS,
  NAR_BANDS,
  STEPS_EXPECTED,
  TUNING,
  cap,
  chainFromDb,
  claimStatusFromDb,
  clamp,
  deployerLine,
  fmtAge,
  fmtCount,
  hueOf,
  kindFromDb,
  lpLabel,
  recordFromDb,
  sigFromDb,
  sincePct,
  short,
  statusFromDb,
  stepStatusFromDb,
  viaFromDb,
  type AskDTO,
  type CheckEvidence,
  type CheckReportDTO,
  type CheckSummaryDTO,
  type ClaimDTO,
  type ClaimSource,
  type CoinFactsDTO,
  type CoinKey,
  type CoinRowDTO,
  type DeployerDTO,
  type Env,
  type LiveCheckDTO,
  type MarketDTO,
  type NarKey,
  type NoteDTO,
  type PeopleDTO,
  type Signal,
  type StepDTO,
  type TargetKindS,
} from '@apecheck/core';
import { num, type Prisma, type PrismaClient } from '@apecheck/db';

/* ---------------- include shapes ---------------- */

export const summaryInclude = {
  target: true,
  coinFacts: { include: { deployer: true } },
} satisfies Prisma.CheckInclude;

export const reportInclude = {
  target: true,
  coinFacts: { include: { deployer: true } },
  steps: { orderBy: { idx: 'asc' } },
  // Claim has no position column; cuids sort in insertion order within the worker's write
  claims: { orderBy: { id: 'asc' } },
  asks: { orderBy: { createdAt: 'desc' } },
  notes: {
    where: { hidden: false },
    orderBy: [{ helpful: 'desc' }, { createdAt: 'desc' }],
    include: { author: { select: { xHandle: true, evmAddress: true, solAddress: true } } },
  },
} satisfies Prisma.CheckInclude;

export type CheckSummaryRow = Prisma.CheckGetPayload<{ include: typeof summaryInclude }>;
export type CheckReportRow = Prisma.CheckGetPayload<{ include: typeof reportInclude }>;
type TargetRow = CheckSummaryRow['target'];
type DeployerRow = NonNullable<NonNullable<CheckSummaryRow['coinFacts']>['deployer']>;

export interface Viewer {
  sid: string | null;
}

export interface SeriesPoint {
  t: string;
  pct: number;
}

export interface MapCtx {
  env: Env;
  viewer: Viewer;
  /** since-% series per check id (loadSeries) */
  series?: Map<string, SeriesPoint[] | null>;
  /** 0–1 progress per check id read from Redis while running */
  progress?: Map<string, number | null>;
}

/* ---------------- small helpers ---------------- */

const iso = (d: Date | null | undefined) => (d ? d.toISOString() : null);
const round2 = (n: number) => Math.round(n * 100) / 100;
const roundOrNull = (n: number | null) => (n == null || !Number.isFinite(n) ? null : round2(n));
const trimSlash = (s: string) => s.replace(/\/+$/, '');

const NAR_KEYS = new Set<string>(NAR_BANDS.map(b => b.key));
const COIN_KEYS = new Set<string>(COIN_BANDS.map(b => b.key));
export const narKey = (v: string | null | undefined): NarKey | null => (v && NAR_KEYS.has(v) ? (v as NarKey) : null);
export const coinKeyOf = (v: string | null | undefined): CoinKey | null => (v && COIN_KEYS.has(v) ? (v as CoinKey) : null);

export function evidenceOf(json: unknown): CheckEvidence {
  return json && typeof json === 'object' && !Array.isArray(json) ? (json as CheckEvidence) : {};
}

function areasOf(json: unknown): CheckReportDTO['areas'] {
  if (!json || typeof json !== 'object') return null;
  const a = json as Record<string, unknown>;
  const n = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
  const p = n(a.Product), c = n(a.Claims), pe = n(a.People);
  return p == null || c == null || pe == null ? null : { Product: p, Claims: c, People: pe };
}

/** Same base the prototype derives: "Orbit" for $ORBIT / @orbit_xyz / orbit.xyz. */
export function titleOf(t: Pick<TargetRow, 'kind' | 'ticker' | 'handle' | 'domain' | 'name'>): string {
  const kind = kindFromDb(t.kind);
  if (kind === 'coin') return t.ticker ? cap(t.ticker.toLowerCase()) : t.name;
  if (kind === 'post') {
    if (!t.handle) return t.name;
    const base = t.handle.replace(/_+$/, '').replace(/(labs|hq|_xyz|fi)$/i, '') || t.handle;
    return cap(base);
  }
  return t.domain ? cap(t.domain.split('.')[0]) : t.name;
}

export function renamedText(n: number | null | undefined): string | null {
  if (n == null || !Number.isFinite(n)) return null;
  if (n <= 0) return 'never renamed';
  if (n === 1) return 'renamed once';
  return `renamed ${n} times`;
}

/** CheckStep.screenshot is a path under SCREENSHOT_DIR; the API serves it at /shots/. */
export function shotUrl(p: string | null | undefined, screenshotDir: string): string | null {
  if (!p) return null;
  let rel = p;
  // already a public path (the worker publishes StepDTOs with /shots/… URLs)
  if (rel.startsWith('/shots/')) rel = rel.slice('/shots/'.length);
  else if (path.isAbsolute(rel)) {
    const r = path.relative(screenshotDir, rel);
    if (r.startsWith('..') || path.isAbsolute(r)) return null;
    rel = r;
  }
  rel = rel.split(path.sep).join('/').replace(/^\/+/, '').replace(/^shots\//, '');
  if (!rel || rel.split('/').some(seg => seg === '..' || seg === '.')) return null;
  return '/shots/' + rel;
}

function stepsExpectedOf(kind: TargetKindS, ev: CheckEvidence, stepCount: number, finished: boolean): number {
  const est = ev.stepsExpected && ev.stepsExpected > 0 ? Math.round(ev.stepsExpected) : STEPS_EXPECTED[kind];
  if (finished) return stepCount || est;
  return Math.max(est, stepCount);
}

function progressOf(status: string, redisProgress: number | null | undefined, stepCount: number, stepsExpected: number): number {
  const s = statusFromDb(status);
  if (s === 'done' || s === 'failed') return 1;
  if (s === 'queued') return 0;
  if (redisProgress != null && Number.isFinite(redisProgress)) return clamp(redisProgress, 0, 1);
  return stepsExpected > 0 ? clamp(stepCount / stepsExpected, 0, 0.99) : 0;
}

/* ---------------- price series ---------------- */

/**
 * since-% series for each coin check: 0 at the check, then the newest PricePoints after it
 * (at most TUNING.sparkPoints values in total, oldest first). One query for a whole page.
 */
export async function loadSeries(
  prisma: PrismaClient,
  checks: Pick<CheckSummaryRow, 'id' | 'targetId' | 'finishedAt' | 'priceAtCheck' | 'target'>[],
): Promise<Map<string, SeriesPoint[] | null>> {
  const out = new Map<string, SeriesPoint[] | null>();
  const want = checks.filter(c => c.finishedAt && num(c.priceAtCheck));
  for (const c of checks) out.set(c.id, null);
  if (!want.length) return out;

  const limit = TUNING.sparkPoints - 1;
  const cids = want.map(c => c.id);
  const tids = want.map(c => c.targetId);
  const sinces = want.map(c => c.finishedAt!.toISOString());
  const rows = await prisma.$queryRaw<{ cid: string; ts: Date; price: string }[]>`
    SELECT f.cid, p."ts", p."price"::text AS price
    FROM unnest(${cids}::text[], ${tids}::text[], ${sinces}::text[]) AS f(cid, tid, since)
    CROSS JOIN LATERAL (
      SELECT "ts", "price" FROM "PricePoint"
      WHERE "targetId" = f.tid AND "ts" > f.since::timestamp
      ORDER BY "ts" DESC
      LIMIT ${limit}
    ) p`;

  const byCheck = new Map<string, { ts: Date; price: number }[]>();
  for (const r of rows) {
    const list = byCheck.get(r.cid) ?? [];
    list.push({ ts: new Date(r.ts), price: Number(r.price) });
    byCheck.set(r.cid, list);
  }
  for (const c of want) {
    const pts = (byCheck.get(c.id) ?? []).sort((a, b) => a.ts.getTime() - b.ts.getTime());
    out.set(c.id, buildSeries(num(c.priceAtCheck), c.finishedAt, pts, c.target));
  }
  return out;
}

export function buildSeries(
  priceAtCheck: number | null,
  finishedAt: Date | null,
  points: { ts: Date; price: number }[],
  target: Pick<TargetRow, 'lastPrice' | 'priceUpdatedAt'>,
): SeriesPoint[] | null {
  if (!priceAtCheck || !finishedAt) return null;
  const pts = points.filter(p => p.ts > finishedAt);
  const last = pts[pts.length - 1];
  const lastPrice = num(target.lastPrice);
  // the tracker updates Target.lastPrice with every point; if it is newer, end the line there
  if (lastPrice != null && target.priceUpdatedAt && target.priceUpdatedAt > finishedAt && (!last || target.priceUpdatedAt > last.ts)) {
    pts.push({ ts: target.priceUpdatedAt, price: lastPrice });
  }
  const tail = pts.slice(-(TUNING.sparkPoints - 1));
  const series: SeriesPoint[] = [{ t: finishedAt.toISOString(), pct: 0 }];
  for (const p of tail) {
    const pct = sincePct(priceAtCheck, p.price);
    if (pct != null && Number.isFinite(pct)) series.push({ t: p.ts.toISOString(), pct: round2(pct) });
  }
  return series.length >= 2 ? series : null;
}

/* ---------------- DTOs ---------------- */

export function toDeployerDTO(d: DeployerRow): DeployerDTO {
  return {
    id: d.id,
    chain: chainFromDb(d.chain)!,
    address: d.address,
    record: recordFromDb(d.record),
    launched: d.launched,
    dead: d.dead,
    fundedFrom: d.fundedFrom,
    firstSeen: iso(d.firstSeen),
  };
}

export function toSummary(c: CheckSummaryRow, ctx: MapCtx): CheckSummaryDTO {
  const t = c.target;
  const kind = kindFromDb(t.kind);
  const hasCoin = c.coinScore != null || c.coinFacts != null;
  const priceAtCheck = num(c.priceAtCheck);
  const series = ctx.series?.get(c.id) ?? null;
  const dep = c.coinFacts?.deployer ?? null;
  return {
    id: c.shortId,
    targetId: t.id,
    kind,
    status: statusFromDb(c.status),
    name: t.name,
    title: titleOf(t),
    ticker: t.ticker,
    domain: t.domain,
    handle: t.handle,
    ca: t.ca,
    chain: chainFromDb(t.chain),
    hue: hueOf(t.key),
    narScore: c.narScore,
    coinScore: c.coinScore,
    total: c.totalScore,
    narBand: narKey(c.narBand),
    coinBand: coinKeyOf(c.coinBand),
    hasCoin,
    summary: c.summary,
    mc: num(t.lastMc) ?? num(c.mcAtCheck),
    vol5m: num(t.lastVol5m),
    since: roundOrNull(sincePct(priceAtCheck, num(t.lastPrice))),
    spark: series ? series.map(p => p.pct) : null,
    checks: t.checkCount,
    asks: c.asksCount,
    via: viaFromDb(c.via),
    by: c.requesterHandle,
    mine: !!ctx.viewer.sid && c.requesterSid === ctx.viewer.sid,
    createdAt: c.createdAt.toISOString(),
    checkedAt: iso(c.finishedAt),
    deployer: dep ? { address: dep.address, chain: chainFromDb(dep.chain)!, record: recordFromDb(dep.record) } : null,
  };
}

function toCoinFacts(f: NonNullable<CheckSummaryRow['coinFacts']>): CoinFactsDTO {
  const dep = f.deployer;
  return {
    sig: {
      deployer: sigFromDb(f.sigDeployer)!,
      bundle: sigFromDb(f.sigBundle)!,
      holders: sigFromDb(f.sigHolders)!,
      lp: sigFromDb(f.sigLp)!,
      authorities: sigFromDb(f.sigAuthorities)!,
    },
    bundlePct: f.bundlePct,
    bundleWallets: f.bundleWallets,
    top10Pct: f.top10Pct,
    devHoldPct: f.devHoldPct,
    lpStatus: f.lpStatus,
    lpLabel: lpLabel(f.lpStatus),
    authorities: f.authorities,
    holders: f.holders,
    liquidityUsd: num(f.liquidityUsd),
    pairCreatedAt: iso(f.pairCreatedAt),
    deployer: dep ? toDeployerDTO(dep) : null,
    deployerText: dep
      ? deployerLine({ record: recordFromDb(dep.record), launched: dep.launched, dead: dep.dead, fundedFrom: dep.fundedFrom })
      : null,
  };
}

export function toStep(s: CheckReportRow['steps'][number], env: Env): StepDTO {
  return {
    idx: s.idx,
    t: s.tMs,
    status: stepStatusFromDb(s.status),
    text: s.text,
    source: s.source,
    url: s.url,
    caption: s.caption,
    screenshot: shotUrl(s.screenshot, env.SCREENSHOT_DIR),
  };
}

function toClaim(c: CheckReportRow['claims'][number]): ClaimDTO {
  const status = claimStatusFromDb(c.status);
  const source = c.source as ClaimSource;
  return {
    text: c.text,
    source,
    sourceLabel: CLAIM_SOURCE_LABEL[source] ?? cap(c.source.replace(/_/g, ' ')),
    kind: c.kind,
    status,
    label: CLAIM_LABEL[status],
    signal: CLAIM_SIGNAL[status],
    evidence: c.evidence,
    stepIdx: c.stepIdx,
  };
}

function toPeople(c: CheckReportRow, ev: CheckEvidence): PeopleDTO {
  const p = ev.people ?? {};
  const createdAt = p.createdAt ?? null;
  const teamSignal = p.teamSignal && ['ok', 'warn', 'fail'].includes(p.teamSignal) ? (p.teamSignal as Signal) : null;
  return {
    handle: p.handle ?? c.target.handle ?? null,
    acct: {
      signal: sigFromDb(c.sigAcct),
      createdAt,
      age: fmtAge(createdAt),
      followers: p.followers ?? null,
      followersText: fmtCount(p.followers),
      verified: p.verified ?? null,
      renamed: renamedText(p.renamed),
      quality: p.quality ?? null,
    },
    team: { signal: teamSignal, text: p.team ?? null },
    git: { signal: sigFromDb(c.sigGit), text: ev.git ?? null },
    docs: { signal: sigFromDb(c.sigDocs), text: ev.docs ?? null },
  };
}

function toMarket(c: CheckReportRow, ev: CheckEvidence, summary: CheckSummaryDTO, series: SeriesPoint[] | null): MarketDTO | null {
  const priceAtCheck = num(c.priceAtCheck);
  if (!summary.hasCoin && priceAtCheck == null && summary.kind !== 'coin') return null;
  return {
    priceAtCheck,
    mcAtCheck: num(c.mcAtCheck),
    priceNow: num(c.target.lastPrice),
    mc: summary.mc,
    vol5m: summary.vol5m,
    since: summary.since,
    ch24: c.target.lastCh24 ?? ev.market?.ch24 ?? null,
    spark: summary.spark,
    series,
  };
}

function authorName(a: { xHandle: string | null; evmAddress: string | null; solAddress: string | null }): string {
  const wallet = a.evmAddress ?? a.solAddress;
  return a.xHandle ?? (wallet ? short(wallet) : 'holder');
}

export function toReport(c: CheckReportRow, ctx: MapCtx): CheckReportDTO {
  const summary = toSummary(c, ctx);
  const ev = evidenceOf(c.evidence);
  const finished = summary.status === 'done' || summary.status === 'failed';
  const stepsExpected = stepsExpectedOf(summary.kind, ev, c.steps.length, finished);
  const series = ctx.series?.get(c.id) ?? null;
  const appUrl = trimSlash(ctx.env.APP_URL);
  const links = ev.links ?? {};

  const asksList: AskDTO[] = c.asks.map(a => ({
    id: a.id,
    question: a.question,
    answer: a.answer,
    by: a.askerHandle,
    via: a.via === 'BOT' ? 'x' : 'site',
    createdAt: a.createdAt.toISOString(),
  }));
  const notes: NoteDTO[] = c.notes.map(n => ({
    id: n.id,
    by: authorName(n.author),
    hold: null,
    text: n.text,
    helpful: n.helpful,
    mine: false,
    createdAt: n.createdAt.toISOString(),
  }));

  return {
    ...summary,
    targetRaw: c.targetRaw,
    signals: {
      launch: sigFromDb(c.sigLaunch),
      flow: sigFromDb(c.sigFlow),
      docs: sigFromDb(c.sigDocs),
      acct: sigFromDb(c.sigAcct),
      git: sigFromDb(c.sigGit),
    },
    evidence: pickEvidence(ev),
    areas: areasOf(c.areas),
    coinSummary: c.coinSummary,
    claims: c.claims.map(toClaim),
    steps: c.steps.map(s => toStep(s, ctx.env)),
    stepsExpected,
    progress: progressOf(c.status, ctx.progress?.get(c.id), c.steps.length, stepsExpected),
    coin: c.coinFacts ? toCoinFacts(c.coinFacts) : null,
    market: toMarket(c, ev, summary, series),
    people: toPeople(c, ev),
    asksList,
    notes,
    links: {
      site: links.site ?? (c.target.domain ? `https://${c.target.domain}` : null),
      x: links.x ?? (c.target.handle ? `https://x.com/${c.target.handle}` : null),
      github: Array.isArray(links.github) ? links.github : [],
      docs: links.docs ?? null,
    },
    durationMs: c.durationMs,
    startedAt: iso(c.startedAt),
    finishedAt: iso(c.finishedAt),
    error: c.error,
    isPrivate: c.isPrivate,
    cardUrl: summary.status === 'done' ? `${appUrl}/card/${c.shortId}.png` : null,
    reportUrl: `${appUrl}/c/${c.shortId}`,
  };
}

function pickEvidence(ev: CheckEvidence): CheckReportDTO['evidence'] {
  const out: CheckReportDTO['evidence'] = {};
  for (const k of ['launch', 'flow', 'docs', 'git', 'acct'] as const) {
    const v = ev[k];
    if (typeof v === 'string' && v) out[k] = v;
  }
  return out;
}

export function toCoinRow(c: CheckSummaryRow, ctx: MapCtx): CoinRowDTO {
  const f = c.coinFacts!;
  const facts = toCoinFacts(f);
  return {
    ...toSummary(c, ctx),
    facts: {
      sig: facts.sig,
      bundlePct: facts.bundlePct,
      top10Pct: facts.top10Pct,
      devHoldPct: facts.devHoldPct,
      lpLabel: facts.lpLabel,
      authorities: facts.authorities,
      deployerRecord: f.deployer ? recordFromDb(f.deployer.record) : null,
    },
  };
}

export interface LiveRow {
  id: string;
  shortId: string;
  status: string;
  createdAt: Date;
  startedAt: Date | null;
  requesterSid: string | null;
  evidence: unknown;
  target: Pick<TargetRow, 'kind' | 'name' | 'ticker' | 'chain' | 'key'>;
  _count: { steps: number };
  steps: { text: string }[];
}

export function toLive(c: LiveRow, ctx: MapCtx & { now: number }): LiveCheckDTO {
  const kind = kindFromDb(c.target.kind);
  const ev = evidenceOf(c.evidence);
  const stepCount = c._count.steps;
  const stepsExpected = stepsExpectedOf(kind, ev, stepCount, false);
  const since = (c.startedAt ?? c.createdAt).getTime();
  return {
    id: c.shortId,
    kind,
    name: c.target.name,
    ticker: c.target.ticker,
    chain: chainFromDb(c.target.chain),
    hue: hueOf(c.target.key),
    status: statusFromDb(c.status),
    createdAt: c.createdAt.toISOString(),
    startedAt: iso(c.startedAt),
    elapsedMs: Math.max(0, ctx.now - since),
    step: stepCount,
    stepsExpected,
    progress: progressOf(c.status, ctx.progress?.get(c.id), stepCount, stepsExpected),
    lastText: c.steps[0]?.text ?? null,
    mine: !!ctx.viewer.sid && c.requesterSid === ctx.viewer.sid,
  };
}
