/**
 * run(checkId): the whole check (HANDOFF §4). Stage A..E run under the CHECK_BUDGET_SECONDS budget,
 * each with its own timeout; Stage F always runs so every check ends DONE (or FAILED on an
 * unrecoverable error) with a final step and a `done` message.
 */
import {
  LIVE_CHANNEL,
  STEPS_EXPECTED,
  checkChannel,
  kindOf,
  detect,
  progressKey,
  type CheckChannelMsg,
  type LiveChannelMsg,
} from '@apecheck/core';
import type { Prisma } from '@apecheck/db';
import { heuristicClaims } from '../ai/heuristic';
import { errText } from '../log';
import { browseStage } from './browse';
import { claimsInput, claimsStage } from './claims';
import { CheckRun, type PipelineDeps } from './context';
import { evidenceStage } from './evidence';
import { judgeStage, scoringStep } from './judge';
import { UnrecoverableError, resolveStage, saveTarget } from './resolve';
import { afterDone, announceEnd, enqueueBotReply, renderCard, saveStage, type SavedCheck } from './save';
import { runStage } from './stage';
import { StepLogger } from './steps';

export { STAGE_LIMITS, type PipelineDeps, type WorkerHooks } from './context';

export class CheckInterrupted extends Error {
  constructor() {
    super('The check was interrupted by a worker restart');
    this.name = 'CheckInterrupted';
  }
}

export interface RunResult {
  status: 'done' | 'failed' | 'skipped';
  checkId: string;
  error?: string;
  saved?: SavedCheck;
}

export interface RunOptions {
  /** aborts the run (worker shutdown); the check is marked FAILED */
  signal?: AbortSignal;
}

export async function runCheck(checkId: string, deps: PipelineDeps, opts: RunOptions = {}): Promise<RunResult> {
  const { prisma, redis, env } = deps;
  const log = deps.log.child(checkId.slice(-7));
  const row = await prisma.check.findUnique({
    where: { id: checkId },
    select: { id: true, shortId: true, targetId: true, targetRaw: true, postId: true, status: true },
  });
  if (!row) {
    log.warn('check not found, job skipped');
    return { status: 'skipped', checkId };
  }
  if (row.status === 'DONE' || row.status === 'FAILED') {
    log.info(`check already ${row.status.toLowerCase()}, job skipped`);
    return { status: 'skipped', checkId };
  }

  const startedAt = Date.now();
  const d = detect(row.targetRaw);
  const kind = d && d.kind !== 'bad' ? kindOf(d) : 'site';
  // a re-run (stalled job picked up again) starts from a clean slate
  await prisma.$transaction([
    prisma.checkStep.deleteMany({ where: { checkId } }),
    prisma.claim.deleteMany({ where: { checkId } }),
    prisma.coinFacts.deleteMany({ where: { checkId } }),
    prisma.check.update({
      where: { id: checkId },
      data: {
        status: 'RUNNING',
        startedAt: new Date(startedAt),
        finishedAt: null,
        error: null,
        evidence: { stepsExpected: STEPS_EXPECTED[kind], ai: { mode: deps.ai.mode, judgeModel: deps.ai.judgeModel, fastModel: deps.ai.fastModel } } as Prisma.InputJsonValue,
      },
    }),
  ]);

  const steps = new StepLogger({ prisma, redis, screenshotDir: env.SCREENSHOT_DIR, log }, row, startedAt);
  await redis.set(progressKey(checkId), '0', 'EX', 3600).catch(() => undefined);
  const live: LiveChannelMsg = { type: 'start', checkId, shortId: row.shortId };
  await redis.publish(LIVE_CHANNEL, JSON.stringify(live)).catch(() => undefined);
  const statusMsg: CheckChannelMsg = { type: 'status', status: 'running', progress: 0 };
  await redis.publish(checkChannel(checkId), JSON.stringify(statusMsg)).catch(() => undefined);

  const budgetMs = Math.max(10, env.CHECK_BUDGET_SECONDS) * 1000;
  const budget = new AbortController();
  const timer = setTimeout(() => budget.abort(new Error('check budget used up')), budgetMs);
  const onExternal = () => budget.abort(new CheckInterrupted());
  opts.signal?.addEventListener('abort', onExternal, { once: true });
  const run = new CheckRun({ ...deps, log }, row, steps, startedAt, startedAt + budgetMs, budget.signal);
  const interrupted = () => {
    if (opts.signal?.aborted) throw new CheckInterrupted();
  };

  try {
    // A — resolve
    const a = await runStage(run, 'resolve', run.limits.resolve, ctx => resolveStage(run, ctx));
    if (!a.ok) {
      if (a.error instanceof UnrecoverableError) throw a.error;
      await steps.step({ status: 'warn', text: a.reason === 'timeout' ? 'Resolving the target timed out; going on with what was found' : 'Resolving the target failed; going on with what was found' });
      await saveTarget(run).catch(e => log.warn('target update failed', e));
    }
    steps.setProgress(0.05);
    interrupted();

    // B — browse
    await browseStage(run);
    interrupted();

    // C — claims
    const c = await runStage(run, 'claims', run.limits.claims, ctx => claimsStage(run, ctx));
    if (!c.ok) {
      // the simple extractor is instant: keep going with its claims
      run.claims = heuristicClaims(claimsInput(run));
      await steps.step({ status: 'warn', text: `Claim extraction ${c.reason === 'timeout' ? 'timed out' : 'failed'}; used the simple extractor (${run.claims.length} claims)` });
    }
    steps.setProgress(0.65);
    interrupted();

    // D — evidence
    const ev = await runStage(run, 'evidence', run.limits.evidence, ctx => evidenceStage(run, ctx));
    if (!ev.ok) await steps.step({ status: 'warn', text: ev.reason === 'timeout' ? 'Gathering evidence timed out; missing parts count as unknown' : 'Gathering evidence failed; missing parts count as unknown' });
    steps.setProgress(0.85);
    interrupted();

    // E — judge
    await scoringStep(run);
    const j = await runStage(run, 'judge', run.limits.judge, ctx => judgeStage(run, ctx));
    if (!j.ok) log.warn(`judge ${j.reason}: the stand-in judged the claims`);
    steps.setProgress(0.95);
    interrupted();

    // F — score, save, notify
    await steps.flush();
    const saved = await saveStage(run);
    steps.setProgress(1);
    await renderCard(deps, row).catch(e => log.warn('share card failed', e));
    await announceEnd(deps, row, 'done');
    await afterDone(deps, checkId);
    log.info(`done in ${Date.now() - startedAt}ms: ${saved.narBand} ${saved.narScore}${saved.coinScore != null ? ` / coin ${saved.coinScore}` : ''}`);
    return { status: 'done', checkId, saved };
  } catch (e) {
    const message = e instanceof CheckInterrupted || e instanceof UnrecoverableError ? e.message : 'The check hit an error and could not finish';
    log.error('check failed', e);
    await failCheck(deps, row, steps, startedAt, message, errText(e));
    await enqueueBotReply(deps, checkId);
    return { status: 'failed', checkId, error: message };
  } finally {
    clearTimeout(timer);
    opts.signal?.removeEventListener('abort', onExternal);
    await run.session?.close().catch(() => undefined);
  }
}

async function failCheck(deps: PipelineDeps, row: { id: string; shortId: string }, steps: StepLogger, startedAt: number, message: string, detail: string) {
  await steps.flush().catch(() => undefined);
  await steps.step({ status: 'fail', text: message }).catch(e => deps.log.warn('could not log the final step', e));
  const finishedAt = new Date();
  await deps.prisma.check
    .update({
      where: { id: row.id },
      data: { status: 'FAILED', error: `${message}${detail && detail !== message ? ` (${detail.slice(0, 300)})` : ''}`, finishedAt, durationMs: finishedAt.getTime() - startedAt },
    })
    .catch(e => deps.log.error('could not mark the check failed', e));
  await announceEnd(deps, row, 'failed');
}

/**
 * On startup: checks left RUNNING by a dead worker (older than twice the budget) are marked FAILED with
 * a final log step, so they leave /v1/live and the report shows what happened.
 */
export async function recoverStaleChecks(deps: Pick<PipelineDeps, 'prisma' | 'redis' | 'env' | 'log'>, now = Date.now()): Promise<number> {
  const cutoff = new Date(now - deps.env.CHECK_BUDGET_SECONDS * 2 * 1000);
  const stale = await deps.prisma.check.findMany({
    where: { status: 'RUNNING', OR: [{ startedAt: { lt: cutoff } }, { startedAt: null, createdAt: { lt: cutoff } }] },
    select: { id: true, shortId: true, startedAt: true, createdAt: true },
    take: 500,
  });
  for (const c of stale) {
    const since = (c.startedAt ?? c.createdAt).getTime();
    const last = await deps.prisma.checkStep.aggregate({ where: { checkId: c.id }, _max: { idx: true } });
    const idx = (last._max.idx ?? -1) + 1;
    const finishedAt = new Date(now);
    await deps.prisma.$transaction([
      deps.prisma.checkStep.create({
        data: { checkId: c.id, idx, tMs: Math.max(0, now - since), status: 'FAIL', text: 'Check stopped: the worker restarted before it finished' },
      }),
      deps.prisma.check.update({
        where: { id: c.id },
        data: { status: 'FAILED', error: 'The worker stopped before the check finished', finishedAt, durationMs: Math.max(0, now - since) },
      }),
    ]);
    await announceEnd(deps, c, 'failed');
  }
  if (stale.length) deps.log.warn(`marked ${stale.length} stuck check(s) as failed`);
  return stale.length;
}
