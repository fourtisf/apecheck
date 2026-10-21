/**
 * DB rows → API DTOs (core dto.ts). The single place the API shapes data: routes load rows
 * with the include shapes below and hand them here.
 */
import path from 'node:path';
import {
  displayStep,
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
  coinBand as coinBandOf,
  coinVerdictEnum,
  deployerHistoryLine,
  fmtAge,
  fmtAmount,
  fmtCount,
  hueOf,
  kindFromDb,
  lpLabel,
  narBand as narBandOf,
  narVerdictEnum,
  scrubRetired,
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
  type CoinVerdictS,
  type DeployerCoinDTO,
  type Env,
  type LiveCheckDTO,
  type MarketDTO,
  type NarKey,
  type NarVerdictS,
  type NoteDTO,
  type PeopleDTO,
  type Signal,
  type StepDTO,
  type TargetKindS,
  type ApiKeyDTO,
  type WebhookDTO,
  type WebhookDeliveryDTO,
  type WebhookEvent,
  type CheckResult,
  checkResultOf,
  LOGO_PATH_RE,
} from '@apecheck/core';
import { num, type ApiKey, type DeployerCoinRow, type Prisma, type PrismaClient, type Webhook, type WebhookDelivery } from '@apecheck/db';

/* ---------------- include shapes ---------------- */

export const summaryInclude = {
  target: true,
  coinFacts: true,
} satisfies Prisma.CheckInclude;

export const reportInclude = {
  target: true,
  coinFacts: true,
  steps: { orderBy: { idx: 'asc' } },
  // Claim.idx is the position the worker wrote (0..n-1); id breaks ties for rows from before the column existed
  claims: { orderBy: [{ idx: 'asc' }, { id: 'asc' }] },
  asks: { orderBy: { createdAt: 'desc' }, include: { asker: { select: { evmAddress: true, solAddress: true } } } },
  notes: {
    where: { hidden: false },
    orderBy: [{ helpful: 'desc' }, { createdAt: 'desc' }],
    include: { author: { select: { xHandle: true, evmAddress: true, solAddress: true, holding: true } } },
  },
  // the first verdict reply the bot posted about this check (M2), for CheckReportDTO.botReply
  mentions: {
    where: { status: 'REPLIED', replyTweetId: { not: null }, repliedAt: { not: null }, OR: [{ kind: 'check' }, { kind: null }] },
    orderBy: [{ repliedAt: 'asc' }, { id: 'asc' }],
    take: 1,
    select: { authorHandle: true, text: true, createdAt: true, inReplyToId: true, replyTweetId: true, repliedAt: true, replyText: true },
  },
} satisfies Prisma.CheckInclude;

export type CheckSummaryRow = Prisma.CheckGetPayload<{ include: typeof summaryInclude }>;
export type CheckReportRow = Prisma.CheckGetPayload<{ include: typeof reportInclude }>;
type TargetRow = CheckSummaryRow['target'];

export interface Viewer {
  sid: string | null;
  /** M3: the signed-in user (or, M4, the owner of the API key the request used) */
  userId?: string | null;
}

/** the viewer started this check: same signed-in user, or the same browser (anonymous cookie) */
export const isMine = (c: { requesterSid: string | null; requesterId?: string | null }, viewer: Viewer) =>
  (!!viewer.sid && c.requesterSid === viewer.sid) || (!!viewer.userId && c.requesterId === viewer.userId);

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
  /** M3: ids of the notes the signed-in viewer marked helpful */
  votes?: Set<string>;
  /** the report's deployer history: the other coins from its deployer wallet that ApeCheck has checked (coinsByDeployer) */
  deployerHistory?: { total: number; coins: DeployerCoinRow[] } | null;
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

/** Target.logo ("logos/<sha256>.<ext>" under SCREENSHOT_DIR) → its public path "/shots/logos/…"; null for anything else. */
export function logoUrl(logo: string | null | undefined): string | null {
  const m = logo ? LOGO_PATH_RE.exec(logo) : null;
  return m ? `/shots/logos/${m[1]}.${m[2]}` : null;
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

/** One coin of a deployer wallet that ApeCheck has checked (packages/db deployerCoins row). */
export function toDeployerCoinDTO(c: Pick<DeployerCoinRow, 'shortId' | 'ticker' | 'name' | 'key' | 'coinScore' | 'coinBand'>): DeployerCoinDTO {
  return { id: c.shortId, ticker: c.ticker, name: c.name, hue: hueOf(c.key), coinScore: c.coinScore, coinBand: coinKeyOf(c.coinBand) };
}

export function toSummary(c: CheckSummaryRow, ctx: MapCtx): CheckSummaryDTO {
  const t = c.target;
  const kind = kindFromDb(t.kind);
  const hasCoin = c.coinScore != null || c.coinFacts != null;
  const priceAtCheck = num(c.priceAtCheck);
  const series = ctx.series?.get(c.id) ?? null;
  const depAddress = c.coinFacts?.deployerAddress ?? null;
  const depChain = chainFromDb(t.chain);
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
    logo: logoUrl(t.logo),
    narScore: c.narScore,
    coinScore: c.coinScore,
    total: c.totalScore,
    narBand: narKey(c.narBand),
    coinBand: coinKeyOf(c.coinBand),
    hasCoin,
    // checks stored before ApeCheck dropped its third-party coin sources may name them: never shown
    summary: scrubRetired(c.summary),
    mc: num(t.lastMc) ?? num(c.mcAtCheck),
    vol5m: num(t.lastVol5m),
    since: roundOrNull(sincePct(priceAtCheck, num(t.lastPrice))),
    spark: series ? series.map(p => p.pct) : null,
    checks: t.checkCount,
    asks: c.asksCount,
    via: viaFromDb(c.via),
    by: c.requesterHandle,
    mine: isMine(c, ctx.viewer),
    createdAt: c.createdAt.toISOString(),
    checkedAt: iso(c.finishedAt),
    deployer: depAddress && depChain ? { address: depAddress, chain: depChain } : null,
  };
}

/**
 * The coin facts as stored, plus the deployer history when the caller read it (the report: `history` from
 * coinsByDeployer; lists leave it out). Stored bundle, LP and holder-count values of older checks still show.
 */
function toCoinFacts(f: NonNullable<CheckSummaryRow['coinFacts']>, history?: MapCtx['deployerHistory']): CoinFactsDTO {
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
    deployerAddress: f.deployerAddress ?? null,
    deployerHistory: f.deployerAddress && history ? { total: history.total, coins: history.coins.map(toDeployerCoinDTO) } : null,
    deployerText: f.deployerAddress && history ? deployerHistoryLine(history) : null,
  };
}

export function toStep(s: CheckReportRow['steps'][number], env: Env): StepDTO {
  // steps stored before ApeCheck dropped its third-party coin sources read in ApeCheck's own words, untagged
  const shown = displayStep({ text: s.text, source: s.source });
  return {
    idx: s.idx,
    t: s.tMs,
    status: stepStatusFromDb(s.status),
    text: shown.text,
    source: shown.source,
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
    result: status,
    label: CLAIM_LABEL[status],
    signal: CLAIM_SIGNAL[status],
    evidence: scrubRetired(c.evidence),
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

/** NoteDTO.by: "@handle" when the author linked X, else the short wallet ("0xabc…ef01"). */
export function authorName(a: { xHandle: string | null; evmAddress: string | null; solAddress: string | null }): string {
  const wallet = a.evmAddress ?? a.solAddress;
  return a.xHandle ? `@${a.xHandle}` : wallet ? short(wallet) : 'holder';
}

/** NoteDTO.hold: "3.1M" while the token is live and the author holds some, else null. */
export function holdText(env: Env, holding: { toString(): string } | number | null | undefined): string | null {
  if (!env.TOKEN_ADDRESS || holding == null) return null;
  const n = typeof holding === 'number' ? holding : Number(holding.toString());
  return Number.isFinite(n) && n > 0 ? fmtAmount(n) : null;
}

type NoteRow = CheckReportRow['notes'][number];
export function toNote(n: Pick<NoteRow, 'id' | 'text' | 'helpful' | 'createdAt' | 'author'>, env: Env, mine: boolean): NoteDTO {
  return {
    id: n.id,
    by: authorName(n.author),
    hold: holdText(env, n.author.holding),
    text: n.text,
    helpful: n.helpful,
    mine,
    createdAt: n.createdAt.toISOString(),
  };
}

type AskRow = CheckReportRow['asks'][number];
/**
 * AskDTO.by: the asker's X handle without "@" (bot asks, and site askers who linked X), else the site asker's short
 * wallet ("0xabc…ef01"), else null.
 */
export function toAsk(a: Pick<AskRow, 'id' | 'question' | 'answer' | 'askerHandle' | 'via' | 'createdAt'> & { asker?: AskRow['asker'] }): AskDTO {
  const wallet = a.asker ? a.asker.evmAddress ?? a.asker.solAddress : null;
  return {
    id: a.id,
    question: a.question,
    answer: scrubRetired(a.answer),
    by: a.askerHandle ?? (wallet ? short(wallet) : null),
    via: a.via === 'BOT' ? 'x' : 'site',
    createdAt: a.createdAt.toISOString(),
  };
}

export function toReport(c: CheckReportRow, ctx: MapCtx): CheckReportDTO {
  const summary = toSummary(c, ctx);
  const ev = evidenceOf(c.evidence);
  const finished = summary.status === 'done' || summary.status === 'failed';
  const stepsExpected = stepsExpectedOf(summary.kind, ev, c.steps.length, finished);
  const series = ctx.series?.get(c.id) ?? null;
  const appUrl = trimSlash(ctx.env.APP_URL);
  const reportUrl = `${appUrl}/c/${c.shortId}`;
  const links = ev.links ?? {};

  const asksList: AskDTO[] = c.asks.map(toAsk);
  const notes: NoteDTO[] = c.notes.map(n => toNote(n, ctx.env, !!ctx.votes?.has(n.id)));

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
    coinSummary: scrubRetired(c.coinSummary),
    claims: c.claims.map(toClaim),
    steps: c.steps.map(s => toStep(s, ctx.env)),
    stepsExpected,
    progress: progressOf(c.status, ctx.progress?.get(c.id), c.steps.length, stepsExpected),
    narrative: narrativeOf(c.narScore, c.narBand),
    // the /api page's `coin: { verdict, score }`; the facts the report's Coin tab reads sit next to them (the same for
    // every viewer: older evidence keys such as the holder clusters are never served)
    coin: c.coinFacts
      ? { verdict: coinVerdictOf(c.coinScore, c.coinBand), score: c.coinScore, ...toCoinFacts(c.coinFacts, ctx.deployerHistory) }
      : null,
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
    // only the plain sentence: rows from before the worker stopped appending "(<exception text>)" must not leak it
    error: c.error ? c.error.replace(/\s*\([\s\S]*$/, '').slice(0, 200) : null,
    isPrivate: c.isPrivate,
    cardUrl: summary.status === 'done' ? `${appUrl}/card/${c.shortId}.png` : null,
    reportUrl,
    report_url: reportUrl,
    post: postOf(ev),
    // only once the bot's reply is really on X; absent otherwise (see the DTO)
    ...botReplyOf(c),
  };
}

/**
 * CheckReportDTO.botReply: the first verdict reply the bot really posted about this check (status REPLIED with the
 * reply's id and time): the mention as written, the reply time and text. Nothing until a reply was posted. A check
 * the bot answered from cache (started on the site or the API) has one too: the reply is real either way.
 */
export function botReplyOf(c: Pick<CheckReportRow, 'mentions'>): Pick<CheckReportDTO, 'botReply'> {
  const m = c.mentions[0];
  if (!m || !m.replyTweetId || !m.repliedAt) return {};
  return {
    botReply: {
      // the post the mention replies to: the /bot page shows the checked post as its parent only when they match
      mention: { author: m.authorHandle.replace(/^@+/, ''), text: m.text, createdAt: m.createdAt.toISOString(), inReplyToId: m.inReplyToId ?? null },
      repliedAt: m.repliedAt.toISOString(),
      replyText: m.replyText ?? null,
    },
  };
}

/**
 * The /api page's `narrative: { verdict: "PARTLY_REAL", score }`. The verdict comes from the stored band
 * (the score's band for a row saved without one); null until there is a narrative score.
 */
export function narrativeOf(score: number | null, band: string | null): CheckReportDTO['narrative'] {
  if (score == null || !Number.isFinite(score)) return null;
  const key = narKey(band) ?? narBandOf(Math.max(0, score)).key;
  return { verdict: narVerdictEnum(key) as NarVerdictS, score };
}

/** The /api page's `coin.verdict` ("SKETCHY") from the stored band, else the score's band; null without either. */
export function coinVerdictOf(score: number | null, band: string | null): CoinVerdictS | null {
  const key = coinKeyOf(band) ?? (score != null && Number.isFinite(score) ? coinBandOf(Math.max(0, score)).key : null);
  return key ? (coinVerdictEnum(key) as CoinVerdictS) : null;
}

/** Check.evidence.post → the post the check read (X id, author handle, text, time); null when there is none. */
export function postOf(ev: CheckEvidence): CheckReportDTO['post'] {
  const p = ev.post;
  if (!p || typeof p !== 'object' || typeof p.text !== 'string') return null;
  const createdAt = typeof p.createdAt === 'string' && Number.isFinite(Date.parse(p.createdAt)) ? new Date(p.createdAt).toISOString() : null;
  const id = typeof p.id === 'string' && /^\d{1,25}$/.test(p.id) ? p.id : null;
  return { id, author: typeof p.author === 'string' ? p.author.replace(/^@+/, '') : '', text: p.text, createdAt };
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
      deployerAddress: facts.deployerAddress ?? null,
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
  requesterId?: string | null;
  evidence: unknown;
  target: Pick<TargetRow, 'kind' | 'name' | 'ticker' | 'chain' | 'key'> & { logo?: string | null };
  _count: { steps: number };
  /** the newest step */
  steps: { text: string; source?: string | null }[];
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
    logo: logoUrl(c.target.logo),
    status: statusFromDb(c.status),
    createdAt: c.createdAt.toISOString(),
    startedAt: iso(c.startedAt),
    elapsedMs: Math.max(0, ctx.now - since),
    step: stepCount,
    stepsExpected,
    progress: progressOf(c.status, ctx.progress?.get(c.id), stepCount, stepsExpected),
    // a step stored before ApeCheck dropped its third-party coin sources reads in ApeCheck's own words
    lastText: c.steps[0] ? displayStep({ text: c.steps[0].text, source: c.steps[0].source ?? null }).text : null,
    mine: isMine(c, ctx.viewer),
  };
}

/* ---------------- M4: developers ---------------- */

export function toApiKeyDTO(k: Pick<ApiKey, 'id' | 'name' | 'prefix' | 'createdAt' | 'lastUsedAt'>): ApiKeyDTO {
  return { id: k.id, name: k.name, prefix: k.prefix, createdAt: k.createdAt.toISOString(), lastUsedAt: iso(k.lastUsedAt) };
}

const WEBHOOK_EVENTS = new Set<string>(['check.completed', 'watch.changed']);

export function toWebhookDTO(w: Pick<Webhook, 'id' | 'url' | 'events' | 'createdAt' | 'lastDeliveryAt' | 'lastStatus' | 'failCount' | 'disabledAt'>): WebhookDTO {
  return {
    id: w.id,
    url: w.url,
    events: w.events.filter((e): e is WebhookEvent => WEBHOOK_EVENTS.has(e)),
    createdAt: w.createdAt.toISOString(),
    lastDeliveryAt: iso(w.lastDeliveryAt),
    lastStatus: w.lastStatus,
    failCount: w.failCount,
    disabled: w.disabledAt != null,
  };
}

const DELIVERY_STATUSES = new Set<string>(['pending', 'ok', 'failed']);

/** `shortIds`: Check.id (or a shortId stored as is) → the check's shortId */
export function toWebhookDeliveryDTO(d: WebhookDelivery, shortIds: Map<string, string>): WebhookDeliveryDTO {
  return {
    id: d.id,
    event: d.event,
    status: (DELIVERY_STATUSES.has(d.status) ? d.status : 'pending') as WebhookDeliveryDTO['status'],
    attempts: d.attempts,
    responseCode: d.responseCode,
    error: d.error,
    createdAt: d.createdAt.toISOString(),
    deliveredAt: iso(d.deliveredAt),
    checkId: d.checkId ? shortIds.get(d.checkId) ?? null : null,
  };
}

export type { CheckResult } from '@apecheck/core';

/**
 * A finished check in the flat shape of the webhook payload's `check` (and the MCP tool run_check): scores as
 * numbers, `verdict` = the narrative verdict enum ("PARTLY_REAL", as on the /api page; the coin verdict for a check
 * with only a coin score), `target` = what was pasted (Check.targetRaw). The worker's check.completed payload is built
 * by the same core function (checkResultOf), so MCP and webhooks always agree.
 */
export function toCheckResult(
  c: Pick<CheckReportRow, 'shortId' | 'targetRaw' | 'narScore' | 'narBand' | 'coinScore' | 'coinBand' | 'totalScore' | 'summary'> & { status?: string; error?: string | null },
  env: Pick<Env, 'APP_URL'>,
): CheckResult {
  return checkResultOf({ ...c, summary: scrubRetired(c.summary) }, env.APP_URL);
}
