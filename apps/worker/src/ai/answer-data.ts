/**
 * The stored data of one finished check, shaped for AiAdapter.answer() (M3 asks on the site, M2 bot
 * follow-ups). Answers only ever see this record, never the live page.
 */
import { deployerLine, lpLabel, recordFromDb, sigFromDb, claimStatusFromDb, kindFromDb, type CheckEvidence } from '@apecheck/core';
import type { PrismaClient } from '@apecheck/db';
import type { AnswerData } from './types';

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
    evidence: (c.evidence ?? {}) as CheckEvidence,
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
