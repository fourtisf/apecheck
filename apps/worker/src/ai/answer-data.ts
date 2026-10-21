/**
 * The stored data of one finished check, shaped for AiAdapter.answer() (M3 asks on the site, M2 bot
 * follow-ups). Answers only ever see this record, never the live page.
 *
 * Answers are public: every viewer of the report reads its follow-ups (asksList) and the bot posts them on X. So this
 * record holds only what every viewer may see, in ApeCheck's own words: evidence keys older checks stored that the
 * report no longer shows (LEGACY_EVIDENCE_KEYS) never reach the answerer, nor the stub entry of a retired adapter, and
 * free text written about an old check is read through scrubRetired().
 */
import {
  chainFromDb,
  currentStubs,
  deployerHistoryLine,
  lpLabel,
  scrubRetired,
  short,
  sigFromDb,
  claimStatusFromDb,
  kindFromDb,
  type CheckEvidence,
} from '@apecheck/core';
import { coinsByDeployer, type PrismaClient } from '@apecheck/db';
import type { AnswerData } from './types';

/** Evidence keys older checks stored that no report shows any more (the holder clusters): never in an answer. */
export const LEGACY_EVIDENCE_KEYS = ['clusters'] as const;

/** The check's evidence without what the report no longer shows (see the header). */
export function publicEvidence(ev: CheckEvidence | null | undefined): CheckEvidence {
  const out = { ...(ev ?? {}) } as CheckEvidence & Record<string, unknown>;
  for (const k of LEGACY_EVIDENCE_KEYS) delete out[k];
  if (Array.isArray(out.stubbed)) out.stubbed = currentStubs(out.stubbed);
  return out;
}

export async function loadAnswerData(prisma: PrismaClient, checkId: string): Promise<AnswerData | null> {
  const c = await prisma.check.findUnique({
    where: { id: checkId },
    include: { target: true, claims: true, coinFacts: true },
  });
  if (!c || c.status !== 'DONE') return null;
  const f = c.coinFacts;
  const chain = chainFromDb(c.target.chain);
  // the deployer history as the report shows it: the other coins from the wallet ApeCheck has checked (public checks)
  const history =
    f?.deployerAddress && chain
      ? await coinsByDeployer(prisma, { chain, address: f.deployerAddress, excludeCa: c.target.ca, take: 10 }).catch(() => null)
      : null;
  return {
    name: c.target.name,
    kind: kindFromDb(c.target.kind),
    narScore: c.narScore,
    narBand: c.narBand,
    coinScore: c.coinScore,
    coinBand: c.coinBand,
    summary: scrubRetired(c.summary),
    coinSummary: scrubRetired(c.coinSummary),
    signals: { launch: sigFromDb(c.sigLaunch), flow: sigFromDb(c.sigFlow), docs: sigFromDb(c.sigDocs), acct: sigFromDb(c.sigAcct), git: sigFromDb(c.sigGit) },
    evidence: publicEvidence(c.evidence as CheckEvidence | null),
    claims: c.claims.map(x => ({ text: x.text, status: claimStatusFromDb(x.status), evidence: scrubRetired(x.evidence) })),
    coin: f
      ? {
          deployerLine: f.deployerAddress
            ? `Deployer history: ${history ? deployerHistoryLine(history) : 'not checked'} (${short(f.deployerAddress)})`
            : null,
          bundlePct: f.bundlePct,
          bundleWallets: f.bundleWallets,
          top10Pct: f.top10Pct,
          lp: f.lpStatus ? lpLabel(f.lpStatus) : null,
          authorities: f.authorities,
        }
      : null,
  };
}
