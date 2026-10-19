/**
 * The AI boundary of the pipeline. Two implementations share it: anthropic.ts (Claude API) and
 * heuristic.ts (deterministic stand-in used without ANTHROPIC_API_KEY and as the fallback on AI errors).
 * Nothing returned through this interface can do more than pick one of the four browser actions or
 * fill claim statuses and sentences: scores are always computed by @apecheck/core.
 */
import type { CheckEvidence, ExtractedClaim, Judged, Signal, TargetKindS, DeployerRecord } from '@apecheck/core';

export type AiMode = 'anthropic' | 'heuristic';
export type AiStage = 'explore' | 'claims' | 'judge' | 'answer';

/* ---------------- Stage B: bounded exploration ---------------- */

export interface DomElement {
  /** number shown to the model; also the data-apecheck-id on the element */
  id: number;
  kind: 'button' | 'link';
  text: string;
  href: string | null;
  disabled: boolean;
  inViewport: boolean;
  /** inside an open dialog / modal */
  inModal: boolean;
}
export interface DomInput {
  id: number;
  type: string;
  label: string;
}
export interface DomSummary {
  url: string;
  title: string;
  headings: string[];
  elements: DomElement[];
  inputs: DomInput[];
  /** visible text of an open dialog / modal, if any */
  modalText: string | null;
  /** visible text above the fold, clipped */
  textSample: string;
}
export interface ExploreFlags {
  appReached: boolean;
  walletRequested: boolean;
  walletConnected: boolean;
  txCaptured: boolean;
  waitlist: boolean;
  comingSoon: boolean;
  errorScreen: boolean;
}
export interface ExploreObservation {
  /** 0-based index of the action about to be chosen */
  step: number;
  maxSteps: number;
  summary: DomSummary;
  screenshot: Buffer | null;
  /** what the previous action did, one sentence; null before the first action */
  lastResult: string | null;
  flags: ExploreFlags;
  /** actions taken so far (label + outcome) */
  history: { action: string; result: string }[];
}
export type BrowserAction =
  | { tool: 'click'; text: string }
  | { tool: 'scroll'; direction: 'down' | 'up' }
  | { tool: 'open_link'; url: string }
  | { tool: 'done'; reason: string };

/** Per-session exploration state; `memory` belongs to the adapter that created it. */
export interface ExploreState {
  siteUrl: string;
  memory: Record<string, unknown>;
}

/* ---------------- Stage C: claims ---------------- */

export interface ClaimsInput {
  name: string;
  siteUrl: string | null;
  hero: string;
  footer: string;
  docs: string;
  post: string;
  bio: string;
}

/* ---------------- Stage E: judge ---------------- */

export interface SignalEvidence {
  signal: Signal;
  text: string;
  stepIdx: number | null;
}

/** Why the product signals came out the way they did (drives the summary wording). */
export interface ProductCauses {
  /** our browser failed: nothing can be said about the product */
  unchecked?: boolean;
  notLoaded: boolean;
  noSite: boolean;
  noEntry: boolean;
  waitlist: boolean;
  comingSoon: boolean;
  deadLaunch: boolean;
  launch404: boolean;
  appReached: boolean;
  walletConnected: boolean;
  txReached: boolean;
  txSimulated: 'ok' | 'fail' | 'skipped' | null;
  needsFunds: boolean;
  errorScreen: string | null;
  jsError: string | null;
  nothingToTry: boolean;
  /** the main action asked the wallet to sign (a transaction is txReached) */
  mainSigned?: boolean;
  /** the main action only opened a dialog / changed the page: the flow wasn't completed */
  mainPartial?: boolean;
}

export interface CoinJudgeFacts {
  record: DeployerRecord;
  historyKnown: boolean;
  launched: number | null;
  dead: number | null;
  fundedFrom: string | null;
  bundlePct: number | null;
  bundleWallets: number | null;
  top10Pct: number | null;
  devHoldPct: number | null;
  lpText: string | null;
  authoritiesText: string | null;
  /** deterministic coin score (scoreCoin of the signals below) */
  score: number;
  signals: { deployer: Signal; bundle: Signal; holders: Signal; lp: Signal; authorities: Signal };
  evidence: { deployer?: SignalEvidence; bundle?: SignalEvidence; holders?: SignalEvidence };
}

export interface JudgeInput {
  name: string;
  kind: TargetKindS;
  claims: ExtractedClaim[];
  product: { launch: SignalEvidence; flow: SignalEvidence; docs: SignalEvidence };
  causes: ProductCauses;
  /** deterministic people signals; null = unknown (the judge decides) */
  people: { acct: SignalEvidence | null; git: SignalEvidence | null };
  /** `unchecked`: GitHub was unavailable or timed out, so nothing is known about the code */
  git: { found: boolean; burst: boolean; totalCommits: number; stale: boolean; thin: boolean; onlyForks: boolean; unchecked?: boolean };
  coin: CoinJudgeFacts | null;
  auditLink: { url: string; stepIdx: number | null } | null;
  steps: { idx: number; status: string; text: string }[];
  evidence: CheckEvidence;
  /** up to 3 key screenshots (JPEG) */
  screenshots: Buffer[];
}

/* ---------------- follow-up answers (M3 asks, bot follow-ups) ---------------- */

export interface AnswerData {
  name: string;
  kind: TargetKindS;
  narScore: number | null;
  narBand: string | null;
  coinScore: number | null;
  coinBand: string | null;
  summary: string | null;
  coinSummary: string | null;
  signals: Partial<Record<'launch' | 'flow' | 'docs' | 'acct' | 'git', Signal | null>>;
  evidence: CheckEvidence;
  claims: { text: string; status: string; evidence: string }[];
  coin: {
    deployerLine: string | null;
    fundedFrom: string | null;
    bundlePct: number | null;
    bundleWallets: number | null;
    top10Pct: number | null;
    lp: string | null;
    authorities: string | null;
  } | null;
}

/* ---------------- adapter ---------------- */

export interface AiCallCtx {
  signal?: AbortSignal;
  /** called when the model could not be used for this stage and the heuristic took over */
  onFallback?: (stage: AiStage, reason: string) => void;
}

export interface AiAdapter {
  readonly mode: AiMode;
  readonly judgeModel: string | null;
  readonly fastModel: string | null;
  newExplore(siteUrl: string): ExploreState;
  /** one browser tool call */
  exploreStep(state: ExploreState, obs: ExploreObservation, ctx?: AiCallCtx): Promise<BrowserAction>;
  extractClaims(input: ClaimsInput, ctx?: AiCallCtx): Promise<ExtractedClaim[]>;
  judge(input: JudgeInput, ctx?: AiCallCtx): Promise<Judged>;
  answer(question: string, data: AnswerData, ctx?: AiCallCtx): Promise<string>;
}
