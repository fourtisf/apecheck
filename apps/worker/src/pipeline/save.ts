/**
 * Stage F — score (deterministic, @apecheck/core scoreCheck), save everything in one transaction, render
 * the share card, notify (check:{id} done, live end, bot reply job, check.completed webhooks).
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import type { Prisma } from '@apecheck/db';
import {
  LIVE_CHANNEL,
  checkChannel,
  type CheckChannelMsg,
  claimStatusToDb,
  clipSentence,
  deployerKey,
  progressKey,
  scoreCheck,
  sigToDb,
  type ClaimStatus,
  type LiveChannelMsg,
  type Signal,
} from '@apecheck/core';
import type { CheckRun, PipelineDeps } from './context';
import { heuristicJudge } from '../ai/heuristic';
import { finalJudgement, judgeInput } from './judge';
import { saveTarget } from './resolve';
import { buildEvidence } from './record';
import { pgSafe } from './pgsafe';
import { scoredSignals } from './signals';
import { RunSuperseded } from './steps';
import { completeAutoRechecks } from '../watch/notify';
import { checkCompletedDeliveries, readJoiners } from '../webhooks/events';
import type { CheckEvidence } from '@apecheck/core';

export interface SavedCheck {
  narScore: number;
  coinScore: number | null;
  total: number;
  narBand: string;
  coinBand: string | null;
  /** acct is null: the X account is not checked (left out of the score, see scoredSignals) */
  signals: { launch: Signal; flow: Signal; docs: Signal; acct: Signal | null; git: Signal };
  claims: { text: string; status: ClaimStatus }[];
}

const finite = (n: number | null | undefined): number | null => (n != null && Number.isFinite(n) ? n : null);
const asDate = (s: string | null | undefined) => {
  if (!s) return null;
  const d = new Date(s);
  return Number.isFinite(d.getTime()) ? d : null;
};

export async function saveStage(run: CheckRun): Promise<SavedCheck> {
  const { prisma } = run.deps;
  const { judged, acct, git } = finalJudgement(run);
  const p = run.product!;
  const claims = run.claims.map((c, i) => {
    const j = judged.claims.find(x => x.index === i);
    return {
      ...c,
      status: (j?.status ?? 'not_seen') as ClaimStatus,
      evidence: j?.evidence || 'Nothing the agent saw confirms or contradicts this',
      // -1 is a step that was dropped (its stage had ended): never cite it
      stepIdx: j?.stepIdx != null && j.stepIdx >= 0 ? j.stepIdx : null,
    };
  });
  const signals = { launch: p.launch.signal, flow: p.flow.signal, docs: p.docs.signal, acct, git };
  const s = run.coin?.signals;
  const scores = scoreCheck(
    { ...scoredSignals(signals), claims: claims.map(c => c.status) },
    s ? { deployer: s.record, bundle: s.bundle, holders: s.holders, lp: s.lp, authorities: s.authorities } : undefined,
  );
  const evidence = buildEvidence(run);
  const finishedAt = new Date();
  const durationMs = finishedAt.getTime() - run.startedAt;
  const m = run.market;
  const price = finite(m?.priceUsd) && m!.priceUsd! > 0 ? m!.priceUsd! : null;
  const mc = finite(m?.mc) ?? finite(m?.fdv);
  // an empty sentence from the model falls back to the stand-in's wording
  const standIn = !judged.summary || (run.coin && !judged.coinSummary) ? heuristicJudge(judgeInput(run)) : null;
  const summary = judged.summary || standIn?.summary || null;
  const coinSummary = run.coin ? judged.coinSummary || standIn?.coinSummary || null : null;
  const checkId = run.check.id;
  const isPrivate = !!run.check.isPrivate;
  const owner = new Date(run.startedAt);

  await saveTarget(run).catch(e => run.log.warn('target update failed', e));
  // everything below can hold page / third-party text: pgSafe() strips what Postgres refuses (U+0000, lone surrogates)
  const write = (ev: CheckEvidence) => prisma.$transaction(async tx => {
    // one finisher per target at a time, so exactly one check ends up isLatest
    await tx.$executeRaw`SELECT 1 FROM "Target" WHERE "id" = ${run.targetId} FOR UPDATE`;
    // still this run's check (a re-run of the job may have taken it over): lock the row and make sure
    const mine = await tx.check.updateMany({ where: { id: checkId, startedAt: owner, status: 'RUNNING' }, data: { status: 'RUNNING' } });
    if (!mine.count) throw new RunSuperseded();
    // the deployer wallet when it is known: the deployer history (the other coins ApeCheck has checked from it) is read
    // from these rows (packages/db coinsByDeployer), public checks only
    const d = run.coin && run.chain ? run.coin.raw.deployer : null;
    const deployerAddress = d?.address && run.chain ? deployerKey(run.chain, d.address) : null;

    await tx.claim.deleteMany({ where: { checkId } });
    if (claims.length) {
      await tx.claim.createMany({
        data: pgSafe(claims).map((c, idx) => ({
          checkId,
          idx,
          text: c.text,
          source: c.source,
          kind: c.kind,
          status: claimStatusToDb(c.status),
          evidence: c.evidence,
          stepIdx: c.stepIdx,
        })),
      });
    }

    if (run.coin && s) {
      const raw = run.coin.raw;
      const data = {
        deployerAddress,
        sigDeployer: sigToDb(s.deployer)!,
        sigBundle: sigToDb(s.bundle)!,
        sigHolders: sigToDb(s.holders)!,
        sigLp: sigToDb(s.lp)!,
        sigAuthorities: sigToDb(s.authorities)!,
        bundlePct: finite(raw.bundle?.pct),
        bundleWallets: raw.bundle?.wallets ?? null,
        top10Pct: finite(raw.holders?.top10Pct),
        devHoldPct: finite(raw.holders?.devHoldPct),
        lpStatus: s.lpStatus,
        authorities: raw.authorities?.text ?? null,
        holders: raw.holders?.count ?? null,
        liquidityUsd: finite(m?.liquidityUsd),
        pairCreatedAt: asDate(m?.pairCreatedAt),
      };
      await tx.coinFacts.upsert({ where: { checkId }, create: pgSafe({ checkId, ...data }), update: pgSafe(data) });
    }

    // a private check (Max) is the requester's alone: the target's public latest verdict (feed, coins, deployers,
    // insights) and its public fields stay as they were
    if (!isPrivate) await tx.check.updateMany({ where: { targetId: run.targetId, isLatest: true, id: { not: checkId } }, data: { isLatest: false } });
    await tx.check.update({
      where: { id: checkId },
      data: pgSafe({
        targetId: run.targetId,
        status: 'DONE',
        sigLaunch: sigToDb(signals.launch),
        sigFlow: sigToDb(signals.flow),
        sigDocs: sigToDb(signals.docs),
        sigAcct: sigToDb(signals.acct),
        sigGit: sigToDb(signals.git),
        evidence: ev as Prisma.InputJsonValue,
        narScore: scores.narrative.score,
        coinScore: scores.coin?.score ?? null,
        totalScore: scores.total,
        narBand: scores.narrative.band.key,
        coinBand: scores.coin?.band.key ?? null,
        areas: scores.narrative.areas,
        summary: summary ? clipSentence(summary, 180) : null,
        coinSummary,
        durationMs,
        finishedAt,
        isLatest: !isPrivate,
        error: null,
        priceAtCheck: price,
        mcAtCheck: mc,
      }),
    });
    if (price != null) {
      await tx.pricePoint.create({ data: { targetId: run.targetId, ts: finishedAt, price, mc, vol5m: finite(m?.vol5m) } });
    }
    await tx.target.update({
      where: { id: run.targetId },
      data: {
        ...(isPrivate ? {} : { lastCheckedAt: finishedAt }),
        ...(price != null
          ? { lastPrice: price, lastMc: mc, lastVol5m: finite(m?.vol5m), lastCh24: finite(m?.ch24), priceUpdatedAt: finishedAt }
          : {}),
      },
    });
  });

  try {
    await write(pgSafe(evidence));
  } catch (e) {
    if (e instanceof RunSuperseded) {
      run.steps.supersede();
      throw e;
    }
    // one odd value must not cost the verdict: save again with the evidence reduced to its sentences
    run.log.error('saving the check failed; saving again with minimal evidence', e);
    run.degraded.push('save:retry');
    await write(pgSafe(minimalEvidence(evidence, run.degraded)));
  }

  return {
    narScore: scores.narrative.score,
    coinScore: scores.coin?.score ?? null,
    total: scores.total,
    narBand: scores.narrative.band.key,
    coinBand: scores.coin?.band.key ?? null,
    signals,
    claims: claims.map(c => ({ text: c.text, status: c.status })),
  };
}

/** The evidence a check keeps when the full object could not be saved: the signal sentences and the AI mode. */
export function minimalEvidence(ev: CheckEvidence, degraded: string[]): CheckEvidence {
  const s = (v: string | undefined) => (typeof v === 'string' ? v.slice(0, 300) : undefined);
  return {
    stepsExpected: ev.stepsExpected,
    ai: ev.ai,
    launch: s(ev.launch),
    flow: s(ev.flow),
    docs: s(ev.docs),
    git: s(ev.git),
    acct: s(ev.acct),
    stubbed: ev.stubbed,
    degraded: [...degraded],
  };
}

/** GET WEB_INTERNAL_URL/card/<shortId>.png (5 s). */
export function webCardFetcher(webInternalUrl: string) {
  return async (shortId: string): Promise<Buffer | null> => {
    const res = await fetch(`${webInternalUrl.replace(/\/+$/, '')}/card/${encodeURIComponent(shortId)}.png`, { signal: AbortSignal.timeout(5000) });
    if (!res.ok || !/image\/png/i.test(res.headers.get('content-type') ?? '')) return null;
    return Buffer.from(await res.arrayBuffer());
  };
}

export async function renderCard(deps: PipelineDeps, check: { id: string; shortId: string }): Promise<string | null> {
  const fetchCard = deps.fetchCard ?? webCardFetcher(deps.env.WEB_INTERNAL_URL);
  let png: Buffer | null = null;
  try {
    png = await fetchCard(check.shortId);
  } catch (e) {
    deps.log.info(`share card skipped (web not reachable): ${e instanceof Error ? e.message : String(e)}`);
    return null;
  }
  if (!png) {
    deps.log.info('share card skipped (no PNG from the web app)');
    return null;
  }
  const rel = `cards/${check.shortId}.png`;
  await fs.mkdir(path.join(deps.env.SCREENSHOT_DIR, 'cards'), { recursive: true });
  await fs.writeFile(path.join(deps.env.SCREENSHOT_DIR, rel), png);
  await deps.prisma.check.update({ where: { id: check.id }, data: { cardPath: rel } });
  return rel;
}

export async function announceEnd(deps: Pick<PipelineDeps, 'redis' | 'log'>, check: { id: string; shortId: string }, status: 'done' | 'failed') {
  const { redis, log } = deps;
  const msg: LiveChannelMsg = { type: 'end', checkId: check.id, shortId: check.shortId };
  const done: CheckChannelMsg = { type: 'done', status };
  await redis.set(progressKey(check.id), '1', 'EX', 3600).catch(e => log.warn('progress write failed', e));
  await redis.publish(checkChannel(check.id), JSON.stringify(done)).catch(e => log.warn('publish failed', e));
  await redis.publish(LIVE_CHANNEL, JSON.stringify(msg)).catch(e => log.warn('publish failed', e));
}

/**
 * Every X mention linked to the check that still waits for its reply (BotMention.status QUEUED: the first tag, a
 * re-tag in the thread, another user's tag of the same project) gets its reply job, done or failed. worker-bot
 * consumes QUEUES.botReplies; the job id is the mention id, so a second enqueue of the same mention is a no-op.
 */
export async function enqueueBotReply(deps: Pick<PipelineDeps, 'prisma' | 'log' | 'hooks'>, checkId: string) {
  if (!deps.hooks?.enqueueBotReply) return;
  const mentions = await deps.prisma.botMention
    .findMany({ where: { checkId, status: 'QUEUED' }, select: { id: true }, orderBy: { createdAt: 'asc' } })
    .catch(e => {
      deps.log.warn('could not read the bot mentions of the check', e);
      return [];
    });
  for (const m of mentions) await deps.hooks.enqueueBotReply(m.id).catch(e => deps.log.warn('could not enqueue the bot reply', e));
}

/**
 * M4: the check.completed webhooks of a finished check (webhooks/events.ts: its requester's, those of Max users whose
 * request joined it while it ran, and those of the Max watchers it ran for as their automatic re-check; enabled
 * webhooks, Max only). Idempotent: the delivery ids are derived from webhook + check, so a second call makes no second
 * delivery. Rows this could not write (a database error) are written by the webhooks sweep's catch-up.
 */
export async function fireCheckWebhooks(deps: FinishDeps, checkId: string) {
  const joiners = await readJoiners(deps.redis, checkId, deps.log);
  const ids = await checkCompletedDeliveries(deps.prisma, checkId, { joiners });
  if (ids.length && deps.hooks?.enqueueWebhooks) await deps.hooks.enqueueWebhooks(ids);
}

/** What afterFinish needs (redis: who joined the check, for its webhooks; without it only the requester and watchers) */
export type FinishDeps = Pick<PipelineDeps, 'prisma' | 'log' | 'hooks'> & { redis?: Pick<PipelineDeps['redis'], 'smembers'> };

/**
 * Every finished check (done or failed, also one ended by the stuck-check recovery or found finished by a re-run of
 * its job): the bot replies still waiting on it, the "rechecked" notifications of the watchers whose automatic
 * re-check it is (watch/notify.ts; idempotent, a no-op for checks nobody watches) and its check.completed webhooks
 * (M4; idempotent, a no-op for checks nobody with a webhook asked for).
 */
export async function afterFinish(deps: FinishDeps, checkId: string) {
  await enqueueBotReply(deps, checkId);
  await completeAutoRechecks(deps, checkId).catch(e => deps.log.warn('could not complete the re-check notifications', e));
  await fireCheckWebhooks(deps, checkId).catch(e => deps.log.warn('could not queue the check.completed webhooks (the webhooks sweep catches up)', e));
}

/** After a check finished DONE: everything afterFinish does (bot reply, re-check notifications, webhooks). */
export async function afterDone(deps: PipelineDeps, checkId: string) {
  await afterFinish(deps, checkId);
}
