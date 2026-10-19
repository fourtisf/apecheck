/**
 * Stage F — score (deterministic, @apecheck/core scoreCheck), save everything in one transaction, render
 * the share card, notify (check:{id} done, live end, bot reply job, webhooks hook).
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import type { Prisma } from '@apecheck/db';
import {
  LIVE_CHANNEL,
  checkChannel,
  type CheckChannelMsg,
  chainToDb,
  claimStatusToDb,
  clipSentence,
  progressKey,
  recordToDb,
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
import { RunSuperseded } from './steps';
import type { CheckEvidence } from '@apecheck/core';

export interface SavedCheck {
  narScore: number;
  coinScore: number | null;
  total: number;
  narBand: string;
  coinBand: string | null;
  signals: { launch: Signal; flow: Signal; docs: Signal; acct: Signal; git: Signal };
  claims: { text: string; status: ClaimStatus }[];
}

const finite = (n: number | null | undefined): number | null => (n != null && Number.isFinite(n) ? n : null);
const addrKey = (chain: string, a: string) => (chain === 'sol' || chain === 'trx' ? a : a.toLowerCase());
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
    { ...signals, claims: claims.map(c => c.status) },
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
  const owner = new Date(run.startedAt);

  await saveTarget(run).catch(e => run.log.warn('target update failed', e));
  // everything below can hold page / third-party text: pgSafe() strips what Postgres refuses (U+0000, lone surrogates)
  const write = (ev: CheckEvidence) => prisma.$transaction(async tx => {
    // one finisher per target at a time, so exactly one check ends up isLatest
    await tx.$executeRaw`SELECT 1 FROM "Target" WHERE "id" = ${run.targetId} FOR UPDATE`;
    // still this run's check (a re-run of the job may have taken it over): lock the row and make sure
    const mine = await tx.check.updateMany({ where: { id: checkId, startedAt: owner, status: 'RUNNING' }, data: { status: 'RUNNING' } });
    if (!mine.count) throw new RunSuperseded();
    let deployerId: string | null = null;
    // the wallet is shown whenever it is known; a Deployer row (record, counts) only when its history is
    let deployerAddress: string | null = null;
    if (run.coin && run.chain) {
      const d = run.coin.raw.deployer;
      const chain = chainToDb(run.chain)!;
      if (d?.address) deployerAddress = addrKey(run.chain, d.address);
      if (d && run.coin.signals.historyKnown) {
        const address = addrKey(run.chain, d.address);
        const fields = {
          record: recordToDb(run.coin.signals.record),
          launched: Math.max(0, Math.round(d.launched!)),
          dead: Math.max(0, Math.round(d.dead!)),
          fundedFrom: d.fundedFrom,
          firstSeen: asDate(d.firstSeen),
        };
        const dep = await tx.deployer.upsert({
          where: { chain_address: { chain, address } },
          create: pgSafe({ chain, address, ...fields }),
          update: pgSafe(fields),
          select: { id: true },
        });
        deployerId = dep.id;
      } else if (d) {
        // history unknown: link a deployer we already know, never write made-up counts
        const dep = await tx.deployer.findUnique({ where: { chain_address: { chain, address: addrKey(run.chain, d.address) } }, select: { id: true } });
        deployerId = dep?.id ?? null;
      }
    }

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
        deployerId,
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

    await tx.check.updateMany({ where: { targetId: run.targetId, isLatest: true, id: { not: checkId } }, data: { isLatest: false } });
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
        isLatest: true,
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
        lastCheckedAt: finishedAt,
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

/** A bot-triggered check (BotMention.checkId) gets its reply job, done or failed; M2 consumes QUEUES.botReplies. */
export async function enqueueBotReply(deps: PipelineDeps, checkId: string) {
  if (!deps.hooks?.enqueueBotReply) return;
  const mention = await deps.prisma.botMention.findUnique({ where: { checkId }, select: { id: true } }).catch(() => null);
  if (mention) await deps.hooks.enqueueBotReply(mention.id).catch(e => deps.log.warn('could not enqueue the bot reply', e));
}

/** After a finished check: the bot reply job and the webhooks hook (M4). */
export async function afterDone(deps: PipelineDeps, checkId: string) {
  await enqueueBotReply(deps, checkId);
  await (deps.hooks?.fireWebhooks ?? fireWebhooksNoop)(checkId).catch(e => deps.log.warn('webhooks failed', e));
}

/** Webhooks (check.completed) arrive in M4; this hook is where they will be queued. */
export async function fireWebhooksNoop(_checkId: string): Promise<void> {}
