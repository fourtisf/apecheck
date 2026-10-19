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
import { browseStage } from './browse';
import { claimsInput, claimsStage } from './claims';
import { CheckRun, type PipelineDeps } from './context';
import { coinAfterStage, coinFactsFor, evidenceStage } from './evidence';
import { judgeStage, scoringStep } from './judge';
import { UnrecoverableError, finishResolve, resolveStage, saveTarget } from './resolve';
import { afterDone, announceEnd, enqueueBotReply, renderCard, saveStage, type SavedCheck } from './save';
import { runStage } from './stage';
import { RunSuperseded, StepLogger } from './steps';

export { STAGE_LIMITS, type PipelineDeps, type WorkerHooks } from './context';
export { RunSuperseded } from './steps';

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

/** Prisma errors worth a job retry: the database was briefly unreachable or the pool was exhausted. */
export function isTransientDbError(e: unknown): boolean {
  const code = (e as { code?: string } | null)?.code;
  if (code && ['P1001', 'P1002', 'P1008', 'P1017', 'P2024', 'P2034'].includes(code)) return true;
  const name = (e as { name?: string } | null)?.name;
  return name === 'PrismaClientInitializationError' || name === 'PrismaClientRustPanicError';
}

export async function runCheck(checkId: string, deps: PipelineDeps, opts: RunOptions = {}): Promise<RunResult> {
  const { prisma, redis, env } = deps;
  const log = deps.log.child(checkId.slice(-7));
  const startedAt = Date.now();
  const owner = new Date(startedAt);

  // claim the check for this run; anything failing here must still end the check (or let the job retry)
  let row: { id: string; shortId: string; targetId: string; targetRaw: string; postId: string | null; status: string } | null = null;
  let firstIdx = 0;
  try {
    row = await prisma.check.findUnique({
      where: { id: checkId },
      select: { id: true, shortId: true, targetId: true, targetRaw: true, postId: true, status: true },
    });
    if (!row) {
      log.warn('check not found, job skipped');
      return { status: 'skipped', checkId };
    }
    if (row.status === 'DONE' || row.status === 'FAILED') {
      log.info(`check already ${row.status.toLowerCase()}, job skipped`);
      // a run that died between saving the check and enqueueing its bot replies: enqueue them now (a no-op for
      // mentions already answered or already queued: jobId = mention id, and only QUEUED mentions are picked)
      await enqueueBotReply(deps, checkId);
      return { status: 'skipped', checkId };
    }
    const d = detect(row.targetRaw);
    const kind = d && d.kind !== 'bad' ? kindOf(d) : 'site';
    // a re-run (stalled job picked up again) starts from a clean slate, but never reuses a step idx: open SSE
    // streams keep what they already showed, and screenshot paths (<checkId>/<idx>.jpg) stay unique
    const claimed = await prisma.$transaction(async tx => {
      const c = await tx.check.updateMany({
        where: { id: checkId, status: { in: ['QUEUED', 'RUNNING'] } },
        data: {
          status: 'RUNNING',
          startedAt: owner,
          finishedAt: null,
          error: null,
          evidence: { stepsExpected: STEPS_EXPECTED[kind], ai: { mode: deps.ai.mode, judgeModel: deps.ai.judgeModel, fastModel: deps.ai.fastModel } } as Prisma.InputJsonValue,
        },
      });
      if (!c.count) return null;
      const last = await tx.checkStep.aggregate({ where: { checkId }, _max: { idx: true } });
      await tx.checkStep.deleteMany({ where: { checkId } });
      await tx.claim.deleteMany({ where: { checkId } });
      await tx.coinFacts.deleteMany({ where: { checkId } });
      return { firstIdx: (last._max.idx ?? -1) + 1 };
    });
    if (!claimed) {
      log.info('check finished in the meantime, job skipped');
      return { status: 'skipped', checkId };
    }
    firstIdx = claimed.firstIdx;
  } catch (e) {
    // the database hiccuped: let BullMQ retry the job (its final failure marks the check FAILED, worker.ts)
    if (isTransientDbError(e) || !row) throw e;
    log.error('check could not start', e);
    const last = await prisma.checkStep.aggregate({ where: { checkId }, _max: { idx: true } }).catch(() => null);
    const steps = new StepLogger({ prisma, redis, screenshotDir: env.SCREENSHOT_DIR, log }, row, startedAt, { firstIdx: (last?._max.idx ?? -1) + 1 });
    await failCheck(deps, row, steps, startedAt, 'The check hit an error and could not finish', null);
    await enqueueBotReply(deps, checkId);
    return { status: 'failed', checkId, error: 'The check hit an error and could not finish' };
  }

  const budgetMs = Math.max(10, env.CHECK_BUDGET_SECONDS) * 1000;
  const budget = new AbortController();
  const steps = new StepLogger({ prisma, redis, screenshotDir: env.SCREENSHOT_DIR, log }, row, startedAt, {
    firstIdx,
    owner,
    // another run of this job took the check over: stop at once, and leave the check to it
    onSuperseded: () => budget.abort(new RunSuperseded()),
  });
  await redis.set(progressKey(checkId), '0', 'EX', 3600).catch(() => undefined);
  const live: LiveChannelMsg = { type: 'start', checkId, shortId: row.shortId };
  await redis.publish(LIVE_CHANNEL, JSON.stringify(live)).catch(() => undefined);
  const statusMsg: CheckChannelMsg = { type: 'status', status: 'running', progress: 0 };
  await redis.publish(checkChannel(checkId), JSON.stringify(statusMsg)).catch(() => undefined);

  const timer = setTimeout(() => budget.abort(new Error('check budget used up')), budgetMs);
  const onExternal = () => budget.abort(opts.signal?.reason instanceof RunSuperseded ? opts.signal.reason : new CheckInterrupted());
  opts.signal?.addEventListener('abort', onExternal, { once: true });
  const run = new CheckRun({ ...deps, log }, row, steps, startedAt, startedAt + budgetMs, budget.signal);
  const interrupted = () => {
    if (steps.superseded) throw new RunSuperseded();
    if (opts.signal?.aborted) throw opts.signal.reason instanceof RunSuperseded ? opts.signal.reason : new CheckInterrupted();
  };
  const modelUsed = deps.ai.mode === 'anthropic';

  try {
    if (firstIdx > 0) await steps.step({ status: 'info', text: 'Check restarted: the worker stopped before it finished, so it runs again from the start' });

    // A — resolve
    const a = await runStage(run, 'resolve', run.limits.resolve, ctx => resolveStage(run, ctx));
    if (!a.ok) {
      if (a.error instanceof UnrecoverableError) throw a.error;
      await steps.step({ status: 'warn', text: a.reason === 'timeout' ? 'Resolving the target timed out; going on with what was found' : 'Resolving the target failed; going on with what was found' });
    }
    finishResolve(run);
    // the Target's canonical key and fields, once, from what Stage A established (an abandoned Stage A writes nothing)
    await saveTarget(run).catch(e => {
      if (e instanceof UnrecoverableError) throw e;
      log.warn('target update failed', e);
    });
    // the coin's on-chain facts take the longest: ask now, alongside the browser (Stage D waits for the answer)
    if (run.hasCoin()) coinFactsFor(run).catch(() => undefined);
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
      await steps.step({ status: 'warn', text: `Claim extraction ${c.reason === 'timeout' ? 'timed out' : c.reason === 'skipped' ? 'ran out of time' : 'failed'}; used the simple extractor (${run.claims.length} claims)` });
    } else if (modelUsed && run.aiFallbacks.has('claims')) {
      await steps.step({ status: 'warn', text: 'The AI model could not read the claims; used the simple extractor' });
    }
    steps.setProgress(0.65);
    interrupted();

    // D — evidence
    const ev = await runStage(run, 'evidence', run.limits.evidence, ctx => evidenceStage(run, ctx));
    if (!ev.ok) await steps.step({ status: 'warn', text: ev.reason === 'timeout' ? 'Gathering evidence timed out; missing parts count as unknown' : ev.reason === 'skipped' ? 'No time left to gather evidence; missing parts count as unknown' : 'Gathering evidence failed; missing parts count as unknown' });
    // a coin is never dropped because Stage D ran short: its facts (or unknowns) are scored
    await coinAfterStage(run);
    steps.setProgress(0.85);
    interrupted();

    // E — judge
    await scoringStep(run);
    const j = await runStage(run, 'judge', run.limits.judge, ctx => judgeStage(run, ctx));
    if (!j.ok) {
      log.warn(`judge ${j.reason}: the stand-in judged the claims`);
      await steps.step({ status: 'warn', text: `Claim review ${j.reason === 'timeout' ? 'timed out' : j.reason === 'skipped' ? 'ran out of time' : 'failed'}; used the simple rules` });
    } else if (modelUsed && run.aiFallbacks.has('judge')) {
      await steps.step({ status: 'warn', text: 'The AI model could not review the claims; used the simple rules' });
    }
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
    if (e instanceof RunSuperseded || steps.superseded) {
      // the other run owns the check: nothing to mark, publish or reply here
      log.warn('run stopped: another run of this check took over');
      return { status: 'skipped', checkId };
    }
    const message = e instanceof CheckInterrupted || e instanceof UnrecoverableError ? e.message : 'The check hit an error and could not finish';
    // the raw error (paths, code frames, database messages) goes to the log only, never into the public Check.error
    log.error('check failed', e);
    const marked = await failCheck(deps, row, steps, startedAt, message, owner);
    if (marked) await enqueueBotReply(deps, checkId);
    return { status: 'failed', checkId, error: message };
  } finally {
    clearTimeout(timer);
    opts.signal?.removeEventListener('abort', onExternal);
    await run.session?.close().catch(() => undefined);
  }
}

/**
 * Mark the check FAILED with a final fail step and announce it. `message` is the public sentence (shown by
 * the API as Check.error); no exception text is ever stored. With `owner`, only while this run still owns the
 * check. Resolves to false when another run had taken it over (nothing was written or announced).
 */
async function failCheck(deps: PipelineDeps, row: { id: string; shortId: string }, steps: StepLogger, startedAt: number, message: string, owner: Date | null): Promise<boolean> {
  await steps.flush().catch(() => undefined);
  if (steps.superseded) return false;
  await steps.step({ status: 'fail', text: message }).catch(e => deps.log.warn('could not log the final step', e));
  if (steps.superseded) return false;
  const finishedAt = new Date();
  const res = await deps.prisma.check
    .updateMany({
      where: { id: row.id, ...(owner ? { startedAt: owner } : {}), status: { in: ['QUEUED', 'RUNNING'] } },
      data: { status: 'FAILED', error: message, finishedAt, durationMs: finishedAt.getTime() - startedAt },
    })
    .catch(e => {
      deps.log.error('could not mark the check failed', e);
      return null;
    });
  if (res && res.count === 0) return false;
  await announceEnd(deps, row, 'failed');
  return true;
}

type RecoveryDeps = Pick<PipelineDeps, 'prisma' | 'redis' | 'env' | 'log'> & { hooks?: PipelineDeps['hooks'] };

/** BullMQ state of a check's job (jobId = check id); null when the job no longer exists. */
export type JobStateLookup = (checkId: string) => Promise<string | null>;

/** A job in one of these states will never run its check again. */
const DEAD_JOB = new Set([null, 'failed', 'completed', 'unknown']);
/** QUEUED this long with a dead job: the API's enqueue or the job itself was lost. */
export const QUEUED_DEAD_MS = 10 * 60_000;
/** RUNNING this long with a dead job: nothing is running it any more. */
export const RUNNING_DEAD_MS = 2 * 60_000;

/**
 * End a check that will never finish by itself: FAILED with a final log step, `done` on its channel, `end`
 * on live, the bot reply job (which tells the user / refunds). Only while it is still QUEUED or RUNNING.
 */
export async function endStuckCheck(
  deps: RecoveryDeps,
  c: { id: string; shortId: string; startedAt: Date | null; createdAt: Date },
  why: 'restart' | 'not-run',
  now = Date.now(),
): Promise<boolean> {
  const since = (c.startedAt ?? c.createdAt).getTime();
  const text = why === 'restart' ? 'Check stopped: the worker restarted before it finished' : 'Check stopped: it could not be run';
  const error = why === 'restart' ? 'The worker stopped before the check finished' : 'The check could not be run';
  const finishedAt = new Date(now);
  const ended = await deps.prisma.$transaction(async tx => {
    const r = await tx.check.updateMany({
      where: { id: c.id, status: { in: ['QUEUED', 'RUNNING'] } },
      data: { status: 'FAILED', error, finishedAt, durationMs: Math.max(0, now - since) },
    });
    if (!r.count) return false;
    const last = await tx.checkStep.aggregate({ where: { checkId: c.id }, _max: { idx: true } });
    await tx.checkStep.create({ data: { checkId: c.id, idx: (last._max.idx ?? -1) + 1, tMs: Math.max(0, now - since), status: 'FAIL', text } });
    return true;
  });
  if (!ended) return false;
  await announceEnd(deps, c, 'failed');
  if (deps.hooks?.enqueueBotReply) await enqueueBotReply(deps as PipelineDeps, c.id);
  return true;
}

/**
 * Checks that will never finish: RUNNING for more than twice the budget (a dead worker), and, when `jobState`
 * is given, QUEUED or RUNNING checks whose BullMQ job is gone, failed or completed (lost enqueue, a job that
 * stalled past its limit, a start-up error). Runs at start-up and every few minutes (worker.ts).
 */
export async function recoverStaleChecks(deps: RecoveryDeps, now = Date.now(), jobState?: JobStateLookup): Promise<number> {
  const cutoff = new Date(now - deps.env.CHECK_BUDGET_SECONDS * 2 * 1000);
  const select = { id: true, shortId: true, status: true, startedAt: true, createdAt: true } as const;
  const stale = await deps.prisma.check.findMany({
    where: { status: 'RUNNING', OR: [{ startedAt: { lt: cutoff } }, { startedAt: null, createdAt: { lt: cutoff } }] },
    select,
    take: 500,
  });
  const stuck: { c: (typeof stale)[number]; why: 'restart' | 'not-run' }[] = stale.map(c => ({ c, why: 'restart' }));
  if (jobState) {
    const seen = new Set(stale.map(c => c.id));
    const maybe = await deps.prisma.check.findMany({
      where: {
        OR: [
          { status: 'QUEUED', createdAt: { lt: new Date(now - QUEUED_DEAD_MS) } },
          { status: 'RUNNING', OR: [{ startedAt: { lt: new Date(now - RUNNING_DEAD_MS) } }, { startedAt: null, createdAt: { lt: new Date(now - RUNNING_DEAD_MS) } }] },
        ],
      },
      select,
      take: 500,
    });
    for (const c of maybe) {
      if (seen.has(c.id)) continue;
      const state = await jobState(c.id).catch(() => 'unknown-error');
      if (DEAD_JOB.has(state)) stuck.push({ c, why: c.status === 'RUNNING' ? 'restart' : 'not-run' });
    }
  }
  let n = 0;
  for (const { c, why } of stuck) {
    try {
      if (await endStuckCheck(deps, c, why, now)) n++;
    } catch (e) {
      deps.log.error(`could not end stuck check ${c.id}`, e);
    }
  }
  if (n) deps.log.warn(`marked ${n} stuck check(s) as failed`);
  return n;
}
