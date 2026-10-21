/** Copy shared by web, API, worker and bot. Same words as the prototype. */
import { NAR_BANDS, COIN_BANDS } from './config';
import type { ClaimStatus, DeployerRecord, Signal } from './scoring';
import type { TargetKindS } from './detect';

/** Upper-case labels the bot and the "Testing now"/verdict copy use, e.g. "LIKELY LARP". */
export const NAR_LABEL: Record<(typeof NAR_BANDS)[number]['key'], string> = {
  real: 'REAL', likely: 'LIKELY REAL', partly: 'PARTLY REAL', llarp: 'LIKELY LARP', larp: 'LARP',
};
export const COIN_LABEL: Record<(typeof COIN_BANDS)[number]['key'], string> = {
  clean: 'CLEAN', ok: 'OK', sketchy: 'SKETCHY', rigged: 'RIGGED',
};
/** API verdict enums as shown on the /api page: "PARTLY_REAL", "SKETCHY" */
export const narVerdictEnum = (key: keyof typeof NAR_LABEL) => NAR_LABEL[key].replace(/ /g, '_');
export const coinVerdictEnum = (key: keyof typeof COIN_LABEL) => COIN_LABEL[key];

export const KIND_LABEL: Record<TargetKindS, string> = { coin: 'Coin', post: 'Post', site: 'Site' };

export const REP: Record<DeployerRecord, string> = { builder: 'Builder', mixed: 'Mixed record', serial: 'Serial launcher' };

export const CLAIM_LABEL: Record<ClaimStatus, string> = {
  seen_working: 'Seen working', checks_out: 'Checks out', not_seen: 'Not seen', contradicted: 'Contradicted',
};
/** Pill colour per claim status (ok = green, warn = amber, fail = red). */
export const CLAIM_SIGNAL: Record<ClaimStatus, Signal> = {
  seen_working: 'ok', checks_out: 'ok', not_seen: 'warn', contradicted: 'fail',
};

export type ClaimSource = 'post' | 'site_hero' | 'docs' | 'x_bio' | 'footer';
export const CLAIM_SOURCES: ClaimSource[] = ['post', 'site_hero', 'docs', 'x_bio', 'footer'];
export const CLAIM_SOURCE_LABEL: Record<ClaimSource, string> = {
  post: 'From the post', site_hero: 'From the site hero', docs: 'From the docs', x_bio: 'From the X bio', footer: 'From the site footer',
};

export type ClaimKind = 'live_product' | 'mainnet' | 'ai_agent' | 'open_source' | 'docs' | 'team' | 'fair_launch' | 'audit' | 'partnership' | 'other';
export const CLAIM_KINDS: ClaimKind[] = ['live_product', 'mainnet', 'ai_agent', 'open_source', 'docs', 'team', 'fair_launch', 'audit', 'partnership', 'other'];

export type StepSource = 'X' | 'GitHub' | 'DexScreener' | 'DevRadar' | 'BundleScan' | 'WhaleFlow' | 'On-chain';
export const STEP_SOURCES: StepSource[] = ['X', 'GitHub', 'DexScreener', 'DevRadar', 'BundleScan', 'WhaleFlow', 'On-chain'];

/** Third-party coin sources ApeCheck no longer uses: steps stored before then still name them. */
const RETIRED_SOURCES = new Set(['DevRadar', 'BundleScan', 'WhaleFlow']);
const RETIRED_TEXT: [RegExp, string][] = [
  [/^DevRadar unavailable, deployer history unknown/, 'Deployer history not checked'],
  [/^BundleScan unavailable, bundle share unknown/, 'Bundle share not checked'],
  [/^WhaleFlow unavailable, holder share unknown/, 'Holder share not checked'],
  [/holder share unknown \(WhaleFlow unavailable\)/, 'holder share not checked'],
];

/** A stored step as ApeCheck shows it today: no retired third-party source tag, its "unavailable" lines as "not checked". */
export function displayStep<T extends { text: string; source?: string | null }>(s: T): T {
  if (!s.source || !RETIRED_SOURCES.has(s.source)) return s;
  let text = s.text;
  for (const [re, to] of RETIRED_TEXT) text = text.replace(re, to);
  return { ...s, text, source: null };
}

/** Deployer history line used in the log, the Coin tab ("Earlier launches") and asks. Same wording as the prototype. */
export function deployerLine(d: { record: DeployerRecord; launched: number; dead: number; fundedFrom?: string | null }): string {
  if (d.record === 'builder') {
    return d.launched <= 1
      ? `first launch${d.fundedFrom ? `, funded from ${d.fundedFrom}` : ''}`
      : `${d.launched - 1} earlier launches, all still trading`;
  }
  if (d.record === 'mixed') return `${d.launched} earlier tokens, ${d.dead} dead`;
  return `${d.launched} earlier tokens, ${d.dead} dead within a day`;
}

/** LP status column value → label ("burned" | "locked:<days>" | "unlocked" → "Burned" | "Locked 30 days" | "Unlocked") */
export function lpLabel(lpStatus: string | null | undefined): string {
  if (!lpStatus) return 'Unknown';
  if (lpStatus === 'burned') return 'Burned';
  if (lpStatus === 'unlocked') return 'Unlocked';
  const m = lpStatus.match(/^locked(?::(\d+))?$/);
  if (m) return m[1] ? `Locked ${m[1]} days` : 'Locked';
  return lpStatus;
}

export const BOT_DISCLAIMER = 'Checks the claims, not the team. DYOR.';
export const REPORT_DISCLAIMER = "Checks the claims and the coin, not anyone's intentions. Real products can still rug. DYOR.";
export const FOOTER_DISCLAIMER = 'Verdicts are automated opinions based on what the agent could see at the time of the check. Not financial advice.';
