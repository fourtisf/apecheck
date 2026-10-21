/**
 * Shared state of one check run. Each stage reads what earlier stages found and writes its own part;
 * a stage that times out simply leaves its part empty and the later stages carry on.
 */
import type { Redis } from 'ioredis';
import type { PrismaClient } from '@apecheck/db';
import type { ChainKey, Detected, Env, ExtractedClaim, Judged, TargetKindS } from '@apecheck/core';
import type { CoinRawFacts, DexTokenInfo, MergedTokenLinks, Sources, TokenLinks, XPost, XUser } from '@apecheck/sources';
import type { AiAdapter, AiStage, SignalEvidence } from '../ai/types';
import type { BrowserHost, BrowseSession } from '../browser/browser';
import type { Explorer, ExploreResult } from '../browser/agent';
import type { DocsResult } from '../browser/docs';
import type { PageText } from '../browser/page';
import type { Logger } from '../log';
import type { CoinSignals, GitFacts, ProductSignals, SiteFacts } from './signals';
import type { StepLogger } from './steps';

export interface StageLimits {
  resolve: number;
  open: number;
  explore: number;
  docs: number;
  claims: number;
  evidence: number;
  judge: number;
  /** kept free at the end of the budget for scoring and saving */
  reserve: number;
}

/** Per-stage maxima (ms). Each stage also stops at the overall CHECK_BUDGET_SECONDS deadline. */
export const STAGE_LIMITS: StageLimits = {
  resolve: 25_000,
  open: 25_000,
  explore: 60_000,
  docs: 25_000,
  claims: 25_000,
  evidence: 35_000,
  judge: 40_000,
  reserve: 6_000,
};

export interface WorkerHooks {
  /** M2 consumes QUEUES.botReplies */
  enqueueBotReply?(mentionId: string): Promise<void>;
  /**
   * M4: queue WebhookDelivery rows on QUEUES.webhooks (jobId = delivery id). afterFinish writes the check.completed rows
   * of every finished check (webhooks/events.ts) and hands their ids here; without the hook the rows wait for the
   * webhooks worker's sweep.
   */
  enqueueWebhooks?(deliveryIds: string[]): Promise<void>;
}

export interface PipelineDeps {
  env: Env;
  prisma: PrismaClient;
  /** commands + PUBLISH */
  redis: Redis;
  sources: Sources;
  ai: AiAdapter;
  /** the process-wide Chromium (launched on first use); null when it can't start */
  browser: () => Promise<BrowserHost | null>;
  log: Logger;
  hooks?: WorkerHooks;
  /** share card PNG for a finished check; default GET WEB_INTERNAL_URL/card/<shortId>.png */
  fetchCard?: (shortId: string) => Promise<Buffer | null>;
  limits?: Partial<StageLimits>;
}

export interface CheckRow {
  id: string;
  shortId: string;
  targetId: string;
  targetRaw: string;
  postId: string | null;
  /** a Max user's private check: never takes or clears the target's public isLatest, never touches lastCheckedAt or checkCount */
  isPrivate?: boolean;
}

export interface Links {
  site: string | null;
  x: string | null;
  github: string[];
  docs: string | null;
  telegram: string | null;
  discord: string | null;
}

/** What the optional token-link sources answered (null: no answer, nothing known, or not asked). */
export interface LinkReads {
  meta: TokenLinks | null;
  gecko: TokenLinks | null;
  errors: string[];
}

export class CheckRun {
  readonly limits: StageLimits;
  readonly degraded: string[] = [];
  readonly aiFallbacks = new Map<AiStage, string>();
  readonly stubbed = new Set<string>();

  targetId: string;
  detected: Exclude<Detected, { kind: 'bad' }> | null = null;
  kind: TargetKindS = 'site';

  /* Stage A */
  chain: ChainKey | null = null;
  ca: string | null = null;
  domain: string | null = null;
  siteUrl: string | null = null;
  handle: string | null = null;
  ticker: string | null = null;
  tokenName: string | null = null;
  post: XPost | null = null;
  xUser: XUser | null = null;
  market: DexTokenInfo | null = null;
  /** website / X / Telegram / Discord / logo URL merged from DexScreener, the token's own metadata and GeckoTerminal */
  tokenLinks: MergedTokenLinks | null = null;
  /** the token metadata + GeckoTerminal reads for chain/ca (started once in Stage A, never rejects) */
  linkReads: { chain: ChainKey; ca: string; promise: Promise<LinkReads> } | null = null;
  links: Links = { site: null, x: null, github: [], docs: null, telegram: null, discord: null };
  /** the contract was announced in a step already (Stage A or D) */
  coinAnnounced = false;
  /** an address seen on the page / in the post that couldn't be vetted because DexScreener or the RPCs were down */
  unconfirmedCoin: { address: string; why: string } | null = null;

  /* Stage B */
  session: BrowseSession | null = null;
  site: SiteFacts = { hasSite: false, loaded: false, error: null, claimsLive: false, landingBlocked: null, loadStepIdx: null };
  siteInfo: { url: string; finalUrl: string | null; title: string | null; loadMs: number | null; httpStatus: number | null } | null = null;
  landing: PageText | null = null;
  explorer: Explorer | null = null;
  /** the explorer's result as it stood when the explore stage ended (what the verdict uses) */
  explored: ExploreResult | null = null;
  docs: { link: string | null; result: DocsResult | null; timedOut: boolean; stepIdx: number | null } = { link: null, result: null, timedOut: false, stepIdx: null };
  walletSummary: { requested: boolean; connected: boolean; methods: string[] } | null = null;
  /** uncaught page errors first, then console errors */
  consoleErrors: string[] = [];
  landingShot: Buffer | null = null;
  product: ProductSignals | null = null;

  /* Stage C */
  claims: ExtractedClaim[] = [];

  /* Stage D */
  /** `unknown`: why the code is unknown when `signal` is null (null too when Stage D didn't get to it) */
  git: { facts: GitFacts | null; signal: SignalEvidence | null; plain: string | null; found: boolean; unknown?: 'unavailable' | 'nothing-to-look-up' | null } = {
    facts: null, signal: null, plain: null, found: false, unknown: null,
  };
  acct: { signal: SignalEvidence | null; plain: string | null; renamed?: number | null } = { signal: null, plain: null };
  coin: { raw: CoinRawFacts; signals: CoinSignals; evidence: { deployer?: SignalEvidence; bundle?: SignalEvidence; holders?: SignalEvidence } } | null = null;
  /** the coinFacts request for chain/ca (started once, shared by Stage D and the after-timeout path) */
  coinFacts: { chain: ChainKey; ca: string; promise: Promise<CoinRawFacts>; raw: CoinRawFacts | null } | null = null;
  auditLink: { url: string; stepIdx: number | null } | null = null;

  /* Stage E */
  judged: Judged | null = null;

  constructor(
    readonly deps: PipelineDeps,
    readonly check: CheckRow,
    readonly steps: StepLogger,
    readonly startedAt: number,
    readonly deadline: number,
    /** aborts when the overall budget runs out */
    readonly signal: AbortSignal,
  ) {
    this.limits = { ...STAGE_LIMITS, ...deps.limits };
    this.targetId = check.targetId;
  }

  get env(): Env {
    return this.deps.env;
  }
  get sources(): Sources {
    return this.deps.sources;
  }
  get log(): Logger {
    return this.deps.log;
  }

  /** ms left before the scoring reserve */
  left(): number {
    return this.deadline - this.limits.reserve - Date.now();
  }

  hasCoin(): boolean {
    return !!(this.chain && this.ca);
  }

  aiCtx(signal: AbortSignal) {
    return {
      signal,
      onFallback: (stage: AiStage, reason: string) => {
        if (!this.aiFallbacks.has(stage)) this.aiFallbacks.set(stage, reason);
        this.log.warn(`AI ${stage} fell back to the heuristic: ${reason}`);
      },
    };
  }
}
