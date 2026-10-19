/**
 * Public API shapes (Fastify → web, bot, API users). JSON only: dates are ISO strings,
 * decimals are numbers, enums are the lowercase API values.
 *
 * Contract owners: apps/api builds these from the DB (src/mappers.ts); apps/web renders them.
 * Change them only additively.
 */
import type { ChainKey } from './chains';
import type { ClaimKind, ClaimSource, StepSource } from './labels';
import type { ClaimStatus, CoinKey, DeployerRecord, NarKey, Signal } from './scoring';
import type { TargetKindS } from './detect';

export type CheckStatusS = 'queued' | 'running' | 'done' | 'failed';
export type StepStatusS = 'info' | 'ok' | 'warn' | 'fail';
export type ViaS = 'web' | 'bot' | 'api';
export type TierS = 'free' | 'pro' | 'max';
/** Verdict enums of the public API, as on the /api page (labels.ts narVerdictEnum / coinVerdictEnum). */
export type NarVerdictS = 'REAL' | 'LIKELY_REAL' | 'PARTLY_REAL' | 'LIKELY_LARP' | 'LARP';
export type CoinVerdictS = 'CLEAN' | 'OK' | 'SKETCHY' | 'RIGGED';

export interface StepDTO {
  idx: number;
  /** ms since the check started */
  t: number;
  status: StepStatusS;
  /** one plain sentence, like the prototype log */
  text: string;
  source?: StepSource | string | null;
  /** URL shown in the camera bar for this step */
  url?: string | null;
  /** caption pill on the screenshot, e.g. "Clicking 'Launch app'" */
  caption?: string | null;
  /** Path on the API origin, e.g. "/shots/<checkId>/3.jpg". Prefix with the public API URL. */
  screenshot?: string | null;
}

export interface ClaimDTO {
  text: string;
  source: ClaimSource;
  /** "From the site hero" */
  sourceLabel: string;
  kind: ClaimKind | string;
  status: ClaimStatus;
  /** same value as `status`: the key the /api page documents (`claims[].result`) */
  result: ClaimStatus;
  /** "Seen working" | "Not seen" | "Contradicted" | "Checks out" */
  label: string;
  /** pill colour */
  signal: Signal;
  evidence: string;
  stepIdx?: number | null;
}

export interface DeployerDTO {
  id: string;
  chain: ChainKey;
  address: string;
  record: DeployerRecord;
  launched: number;
  dead: number;
  fundedFrom: string | null;
  firstSeen: string | null;
}

export interface CoinFactsDTO {
  sig: { deployer: Signal; bundle: Signal; holders: Signal; lp: Signal; authorities: Signal };
  bundlePct: number | null;
  bundleWallets: number | null;
  top10Pct: number | null;
  devHoldPct: number | null;
  /** "burned" | "locked:<days>" | "unlocked" | null */
  lpStatus: string | null;
  /** "Burned" | "Locked 30 days" | "Unlocked" | "Unknown" */
  lpLabel: string;
  /** e.g. "Mint renounced, freeze active" */
  authorities: string | null;
  holders: number | null;
  liquidityUsd: number | null;
  pairCreatedAt: string | null;
  /** the deployer's record; null while its launch history is unknown (no DevRadar), even when the address is known */
  deployer: DeployerDTO | null;
  /**
   * The deployer wallet whenever it is known (Etherscan creator, Tron origin address, DevRadar), also when its
   * launch history isn't: then `deployer` is null and the UI shows the address with "Launch history unavailable".
   */
  deployerAddress?: string | null;
  /** "3 earlier tokens, 2 dead" — deployerLine() */
  deployerText: string | null;
}

/** CheckReportDTO.coin: the coin verdict as on the /api page (`coin: { verdict, score }`) plus the coin facts. */
export interface ReportCoinDTO extends CoinFactsDTO {
  /** "SKETCHY"; null when the coin couldn't be scored */
  verdict: CoinVerdictS | null;
  /** same as CheckSummaryDTO.coinScore */
  score: number | null;
}

export interface MarketDTO {
  priceAtCheck: number | null;
  mcAtCheck: number | null;
  priceNow: number | null;
  mc: number | null;
  vol5m: number | null;
  /** % change since the check (latest price vs priceAtCheck) */
  since: number | null;
  ch24: number | null;
  /** since-% series, oldest first, at most 28 points; first point is 0 (at check) */
  spark: number[] | null;
  /** same series with timestamps, for the report chart tooltip */
  series: { t: string; pct: number }[] | null;
}

export interface PeopleDTO {
  handle: string | null;
  acct: {
    signal: Signal | null;
    createdAt: string | null;
    /** "1y 3m" | "7 months" | "12 days" (fmtAge) */
    age: string | null;
    followers: number | null;
    /** "12.4k" (fmtCount) */
    followersText: string | null;
    verified: boolean | null;
    /** "never renamed" | "renamed once" | "renamed 3 times" | null when unknown */
    renamed: string | null;
    /** "Mostly real accounts" etc., null when unknown */
    quality: string | null;
  };
  team: { signal: Signal | null; text: string | null };
  git: { signal: Signal | null; text: string | null };
  docs: { signal: Signal | null; text: string | null };
}

export interface AskDTO {
  id: string;
  question: string;
  answer: string;
  by: string | null;
  via: 'x' | 'site';
  createdAt: string;
}

export interface NoteDTO {
  id: string;
  by: string;
  /** "3.1M" — holding shown next to the author, null when unknown */
  hold: string | null;
  text: string;
  helpful: number;
  /** current viewer marked it helpful */
  mine: boolean;
  createdAt: string;
}

/** One row of the feed / coins list / bot replies (one per target: its latest finished check). */
export interface CheckSummaryDTO {
  /** shortId, used in /c/[id] */
  id: string;
  targetId: string;
  kind: TargetKindS;
  status: CheckStatusS;
  /** "$ORBIT" | "@kairolabs" | "orbitswap.xyz" */
  name: string;
  /** "Orbit" */
  title: string;
  ticker: string | null;
  domain: string | null;
  handle: string | null;
  ca: string | null;
  chain: ChainKey | null;
  /** avatar hue 0–359 */
  hue: number;
  narScore: number | null;
  coinScore: number | null;
  total: number | null;
  narBand: NarKey | null;
  coinBand: CoinKey | null;
  hasCoin: boolean;
  summary: string | null;
  mc: number | null;
  vol5m: number | null;
  since: number | null;
  spark: number[] | null;
  /** times this target was checked (Target.checkCount) */
  checks: number;
  asks: number;
  via: ViaS;
  /** requester's X handle (bot) or null */
  by: string | null;
  /** the current viewer started this check */
  mine: boolean;
  createdAt: string;
  checkedAt: string | null;
  /** the coin's deployer wallet; `record` is null when its launch history is unknown */
  deployer: { address: string; chain: ChainKey; record: DeployerRecord | null } | null;
}

export interface CheckReportDTO extends CheckSummaryDTO {
  targetRaw: string;
  signals: { launch: Signal | null; flow: Signal | null; docs: Signal | null; acct: Signal | null; git: Signal | null };
  evidence: { launch?: string; flow?: string; docs?: string; git?: string; acct?: string };
  areas: { Product: number; Claims: number; People: number } | null;
  coinSummary: string | null;
  claims: ClaimDTO[];
  steps: StepDTO[];
  /** rough number of steps this kind of check takes, for "Step 3 of 12" while running */
  stepsExpected: number;
  /** 0–1 while running */
  progress: number;
  /**
   * The narrative verdict as on the /api page: `{ verdict: "PARTLY_REAL", score: 48 }`
   * (same values as narBand / narScore). null until the check has a narrative score.
   */
  narrative: { verdict: NarVerdictS; score: number } | null;
  /**
   * The coin verdict as on the /api page (`verdict: "SKETCHY"`, `score`) together with the coin facts.
   * null when the check has no coin facts (no coin, or the coin couldn't be read).
   */
  coin: ReportCoinDTO | null;
  market: MarketDTO | null;
  people: PeopleDTO;
  asksList: AskDTO[];
  notes: NoteDTO[];
  links: { site: string | null; x: string | null; github: string[]; docs: string | null };
  durationMs: number | null;
  startedAt: string | null;
  finishedAt: string | null;
  error: string | null;
  isPrivate: boolean;
  /** /card/<id>.png on the web origin */
  cardUrl: string | null;
  reportUrl: string;
  /** same as reportUrl: the key the /api page documents */
  report_url: string;
  /**
   * The X post a post check read (Check.evidence.post), for the /bot page's example thread: its X id (null for a
   * post stored without one), author handle, text and time. Absent or null for other kinds, or when the post couldn't
   * be fetched.
   */
  post?: { id?: string | null; author: string; text: string; createdAt: string | null } | null;
  /**
   * The bot's verdict reply on X about this check, once that reply was actually posted: the mention that asked for it
   * as it was posted (BotMention author handle, text, time, and the X id of the post it replies to: null when it
   * replies to nothing), when the reply went out and the words the bot posted
   * (BotMention.replyText; null for a reply stored without them). The first such reply when several tags reused the
   * check. A check the bot answered from cache (started on the site) carries it too. Absent until then, and for every
   * check the bot never answered, so the /bot page never shows a reply that wasn't posted or words someone didn't write.
   */
  botReply?: {
    mention: { author: string; text: string; createdAt: string; inReplyToId?: string | null };
    repliedAt: string;
    replyText?: string | null;
  } | null;
}

export interface LiveCheckDTO {
  id: string;
  kind: TargetKindS;
  name: string;
  ticker: string | null;
  chain: ChainKey | null;
  hue: number;
  status: CheckStatusS;
  createdAt: string;
  startedAt: string | null;
  elapsedMs: number;
  /** steps logged so far */
  step: number;
  stepsExpected: number;
  /** 0–1 */
  progress: number;
  lastText: string | null;
  mine: boolean;
}

export interface FeedResponse { items: CheckSummaryDTO[]; total: number; nextCursor: string | null }
export interface LiveResponse { items: LiveCheckDTO[] }

export interface InsightsDTO {
  /**
   * checked: finished checks, all time. today: finished checks since 00:00 UTC (a subset of `checked`, so never more).
   * larpSince: average since-check % of the latest public LIKELY LARP / LARP coin verdicts.
   */
  stats: { checked: number; today: number; larpSince: number | null };
  sinceByVerdict: { key: NarKey; name: string; n: number; avg: number }[];
  mostChecked: (CheckSummaryDTO & { checksToday: number })[];
  builders: { address: string; chain: ChainKey; record: DeployerRecord; checked: number; real: number }[];
}

export interface CoinRowDTO extends CheckSummaryDTO {
  facts: Pick<CoinFactsDTO, 'sig' | 'bundlePct' | 'top10Pct' | 'devHoldPct' | 'lpLabel' | 'authorities' | 'deployerAddress'> & {
    deployerRecord: DeployerRecord | null;
  };
}
export interface CoinsResponse { items: CoinRowDTO[]; total: number }

export interface DeployerRowDTO extends DeployerDTO {
  checked: number;
  /** checked coins that "checked out" (checkedOut()) */
  real: number;
  avgTotal: number | null;
  coins: { id: string; ticker: string | null; name: string; hue: number; coinScore: number | null; coinBand: CoinKey | null }[];
}
export interface DeployersResponse { items: DeployerRowDTO[] }

/** GET /v1/bot/stats — the numbers on the /bot page */
export interface BotStatsDTO {
  /** bot replies posted since 00:00 UTC */
  repliesToday: number;
  /** median seconds from the mention to the finished check (the reply), today; null when none */
  medianReplySeconds: number | null;
  /** distinct X accounts that have ever tagged the bot */
  accounts: number;
}

export interface UserDTO { id: string; evmAddress: string | null; solAddress: string | null; xHandle: string | null; tier: TierS }

export interface MeDTO {
  credits: number;
  max: number;
  /** next 00:00 UTC */
  resetsAt: string;
  tier: TierS;
  /** false while TOKEN_ADDRESS is empty: hide holding requirements */
  tokenLive: boolean;
  proMinHold: number | null;
  maxMinHold: number | null;
  user: UserDTO | null;
}

export interface CreateCheckBody { target: string; recheck?: boolean; private?: boolean }
export interface CreateCheckResponse {
  id: string;
  status: CheckStatusS;
  /** true when a finished check younger than CACHE_HOURS was returned instead of a new run */
  cached: boolean;
  credits: number;
}

export interface ApiErrorBody {
  error: string;
  /** stable machine code: bad_target | no_credits | not_found | rate_limited | pro_required | holders_only | sign_in_required | ... */
  code: string;
}

/** Server-sent events on GET /v1/checks/:id/events */
export type SseEvent =
  | { event: 'step'; data: StepDTO & { progress: number } }
  | { event: 'status'; data: { status: CheckStatusS; progress: number } }
  | { event: 'done'; data: CheckReportDTO };
