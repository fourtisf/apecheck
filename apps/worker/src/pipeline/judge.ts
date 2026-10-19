/**
 * Stage E — judge (AI_MODEL_JUDGE, or the heuristic). The model fills claim statuses, evidence
 * sentences and the summary; it never picks scores. Deterministic acct/git signals win over the judge's.
 */
import { scoreCoin } from '@apecheck/core';
import { heuristicJudge } from '../ai/heuristic';
import type { CoinJudgeFacts, JudgeInput, SignalEvidence } from '../ai/types';
import type { CheckRun } from './context';
import { buildEvidence } from './record';
import { worst } from './signals';
import type { StageCtx } from './stage';
import { plural } from './text';

export function judgeInput(run: CheckRun): JudgeInput {
  const p = run.product!;
  const g = run.git.facts;
  let coin: CoinJudgeFacts | null = null;
  if (run.coin) {
    const { raw, signals: s, evidence } = run.coin;
    coin = {
      record: s.record,
      historyKnown: s.historyKnown,
      launched: raw.deployer?.launched ?? null,
      dead: raw.deployer?.dead ?? null,
      fundedFrom: raw.deployer?.fundedFrom ?? null,
      bundlePct: raw.bundle?.pct ?? null,
      bundleWallets: raw.bundle?.wallets ?? null,
      top10Pct: raw.holders?.top10Pct ?? null,
      devHoldPct: raw.holders?.devHoldPct ?? null,
      lpText: s.lpText,
      authoritiesText: raw.authorities?.text ?? null,
      score: scoreCoin({ deployer: s.record, bundle: s.bundle, holders: s.holders, lp: s.lp, authorities: s.authorities }).score,
      signals: { deployer: s.deployer, bundle: s.bundle, holders: s.holders, lp: s.lp, authorities: s.authorities },
      evidence,
    };
  }
  const shots = [run.landingShot, ...(run.explored?.keyShots ?? [])].filter((b): b is Buffer => !!b).slice(0, 3);
  return {
    name: run.ticker ? `$${run.ticker}` : run.domain ?? (run.handle ? `@${run.handle}` : 'the project'),
    kind: run.kind,
    claims: run.claims,
    product: { launch: p.launch, flow: p.flow, docs: p.docs },
    causes: p.causes,
    people: { acct: run.acct.signal, git: run.git.signal },
    git: {
      found: run.git.found,
      burst: g?.burst ?? false,
      totalCommits: g?.totalCommits ?? 0,
      stale: g?.stale ?? false,
      thin: g?.thin ?? false,
      onlyForks: g?.onlyForks ?? false,
      unchecked: !run.git.signal,
    },
    coin,
    auditLink: run.auditLink,
    steps: run.steps.rows.map(r => ({ idx: r.idx, status: r.status, text: r.text })),
    evidence: buildEvidence(run),
    screenshots: shots,
  };
}

export async function scoringStep(run: CheckRun): Promise<void> {
  const n = run.claims.length;
  await run.steps.step({ status: 'info', text: `Scoring ${n ? plural(n, 'claim') : 'the product'}${run.coin ? ' and the coin' : ''}` });
}

export async function judgeStage(run: CheckRun, ctx: StageCtx): Promise<void> {
  run.judged = await run.deps.ai.judge(judgeInput(run), run.aiCtx(ctx.signal));
}

/**
 * Judge output, or the stand-in when the judge stage didn't finish. The deterministic acct / git signals win.
 * When one is unknown the judge may only lower it: an unknown is never `ok` (the model has no X or GitHub
 * data, and page copy claiming "a doxxed team" is no evidence). When the source itself was unavailable (X not
 * readable, GitHub down, Stage D cut short) it is `warn`; only when there was nothing to look up (no X account,
 * no repo link or name) may the judge's `fail` stand.
 */
export function finalJudgement(run: CheckRun) {
  const judged = run.judged ?? heuristicJudge(judgeInput(run));
  const acct: SignalEvidence['signal'] = run.acct.signal?.signal ?? (run.handle ? 'warn' : worst(judged.acct, 'warn'));
  const git: SignalEvidence['signal'] = run.git.signal?.signal ?? (run.git.unknown === 'nothing-to-look-up' ? worst(judged.git, 'warn') : 'warn');
  return { judged, acct, git };
}
