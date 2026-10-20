/**
 * The stored data of one finished check, shaped for AiAdapter.answer() (M3 asks on the site, M2 bot
 * follow-ups). Answers only ever see this record, never the live page.
 *
 * Answers are public: every viewer of the report reads its follow-ups (asksList) and the bot posts them on X. So this
 * record holds only what every viewer may see: evidence the API shows to some viewers only (VIEWER_GATED_EVIDENCE,
 * e.g. M4's Pro/Max holder clusters) never reaches the answerer, or a question could read it out to everyone.
 */
import { deployerLine, lpLabel, recordFromDb, sigFromDb, claimStatusFromDb, kindFromDb, type CheckEvidence } from '@apecheck/core';
import type { PrismaClient } from '@apecheck/db';
import type { AnswerData } from './types';

/** Evidence keys the API serves to some viewers only (apps/api mappers: clusters → Pro/Max): never in an answer. */
export const VIEWER_GATED_EVIDENCE = ['clusters'] as const satisfies readonly (keyof CheckEvidence)[];

/** The check's evidence without what only some viewers may see (see the header). */
export function publicEvidence(ev: CheckEvidence | null | undefined): CheckEvidence {
  const out: CheckEvidence = { ...(ev ?? {}) };
  for (const k of VIEWER_GATED_EVIDENCE) delete out[k];
  return out;
}

export async function loadAnswerData(prisma: PrismaClient, checkId: string): Promise<AnswerData | null> {
  const c = await prisma.check.findUnique({
    where: { id: checkId },
    include: { target: true, claims: true, coinFacts: { include: { deployer: true } } },
  });
  if (!c || c.status !== 'DONE') return null;
  const f = c.coinFacts;
  const dep = f?.deployer ?? null;
  return {
    name: c.target.name,
    kind: kindFromDb(c.target.kind),
    narScore: c.narScore,
    narBand: c.narBand,
    coinScore: c.coinScore,
    coinBand: c.coinBand,
    summary: c.summary,
    coinSummary: c.coinSummary,
    signals: { launch: sigFromDb(c.sigLaunch), flow: sigFromDb(c.sigFlow), docs: sigFromDb(c.sigDocs), acct: sigFromDb(c.sigAcct), git: sigFromDb(c.sigGit) },
    evidence: publicEvidence(c.evidence as CheckEvidence | null),
    claims: c.claims.map(x => ({ text: x.text, status: claimStatusFromDb(x.status), evidence: x.evidence })),
    coin: f
      ? {
          deployerLine: dep ? deployerLine({ record: recordFromDb(dep.record), launched: dep.launched, dead: dep.dead, fundedFrom: dep.fundedFrom }) : null,
          fundedFrom: dep?.fundedFrom ?? null,
          bundlePct: f.bundlePct,
          bundleWallets: f.bundleWallets,
          top10Pct: f.top10Pct,
          lp: f.lpStatus ? lpLabel(f.lpStatus) : null,
          authorities: f.authorities,
        }
      : null,
  };
}
