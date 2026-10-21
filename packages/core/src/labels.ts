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

export type StepSource = 'X' | 'GitHub' | 'DexScreener' | 'On-chain' | 'ApeCheck';
export const STEP_SOURCES: StepSource[] = ['X', 'GitHub', 'DexScreener', 'On-chain', 'ApeCheck'];

/*
 * Data stored before ApeCheck dropped the third-party coin services it was once wired to. The rows stay as they are;
 * the helpers below map what they hold when it is shown or read. This block is the only place in the source that
 * names those services (packages/core/test/no-third-party.test.ts allows it between the two markers).
 */
// retired-names:begin
/** source tags of old steps */
const RETIRED_SOURCES = new Set(['DevRadar', 'BundleScan', 'WhaleFlow']);
/** the "unavailable" lines those services wrote when they had no answer (a trailing " (…)" is kept) */
const RETIRED_TEXT: [RegExp, string][] = [
  [/^DevRadar unavailable, deployer history unknown/, 'Deployer history: not checked'],
  [/^BundleScan unavailable, bundle share unknown/, 'Bundle share: not checked'],
  [/^WhaleFlow unavailable, holder share unknown/, 'Holder share: not checked'],
  [/holder share unknown \(WhaleFlow unavailable\)/, 'holder share: not checked'],
];
/** the names in free text written about old checks (AI summaries, claim evidence, answers) */
const RETIRED_NAMES: [RegExp, string][] = [
  [/\bFourtis data\b/gi, 'coin data'],
  [/\bDevRadar\b/gi, 'the deployer lookup'],
  [/\bBundleScan\b/gi, 'the bundle lookup'],
  [/\bWhaleFlow\b/gi, 'the holder lookup'],
  [/\bFourtis\b/gi, 'the coin data lookup'],
];
/** Check.evidence.stubbed entry old checks hold for the retired adapter */
const RETIRED_STUBS = new Set(['fourtis']);
// retired-names:end

/**
 * A stored step as ApeCheck shows it today: no retired source tag, and the retired services' "unavailable" lines in
 * ApeCheck's own "not checked" wording. A result line one of them wrote keeps its text and only loses the tag. Every
 * other step is returned as it is.
 */
export function displayStep<T extends { text: string; source?: string | null }>(s: T): T {
  if (!s.source || !RETIRED_SOURCES.has(s.source)) return s;
  let text = s.text;
  for (const [re, to] of RETIRED_TEXT) text = text.replace(re, to);
  return { ...s, text: scrubRetired(text), source: null };
}

/**
 * Free text stored about an old check (a summary, a claim's evidence, a follow-up answer) without the retired service
 * names: each becomes a neutral phrase ("the deployer lookup"), capitalised at the start of a sentence. Text that
 * names none of them is returned as it is.
 */
export function scrubRetired<T extends string | null | undefined>(text: T): T {
  if (!text) return text;
  let out: string = text;
  for (const [re, to] of RETIRED_NAMES) {
    out = out.replace(re, (_m, offset: number, all: string) => (/(^|[.!?]\s+)$/.test(all.slice(0, offset)) ? to[0].toUpperCase() + to.slice(1) : to));
  }
  return out as T;
}

/** Check.evidence.stubbed without the retired adapter's entry (old checks list it). */
export const currentStubs = (stubbed: readonly string[] | null | undefined): string[] => (stubbed ?? []).filter(s => !RETIRED_STUBS.has(s));

/** Deployer history line for a known launch record (no source fills one today; kept for when one does). */
export function deployerLine(d: { record: DeployerRecord; launched: number; dead: number }): string {
  if (d.record === 'builder') return d.launched <= 1 ? 'first launch' : `${d.launched - 1} earlier launches, all still trading`;
  if (d.record === 'mixed') return `${d.launched} earlier tokens, ${d.dead} dead`;
  return `${d.launched} earlier tokens, ${d.dead} dead within a day`;
}

/** At most this many coin names in deployerHistoryLine(); the rest read "and N more". */
export const DEPLOYER_HISTORY_NAMES = 3;

/**
 * The deployer's history as ApeCheck knows it: the other coins from the same wallet that ApeCheck has checked
 * (packages/db coinsByDeployer). Used in the log ("Deployer history: …"), the Coin tab, the side card and answers.
 *   0 → "no earlier launches seen by ApeCheck"
 *   2 → "2 other coins from this wallet checked by ApeCheck, $FOO and $BAR"
 *   5 → "5 other coins from this wallet checked by ApeCheck, $A, $B, $C and 2 more"
 */
export function deployerHistoryLine(h: { total: number; coins: { ticker: string | null; name: string }[] }): string {
  const total = Math.max(0, Math.round(h.total));
  if (!total) return 'no earlier launches seen by ApeCheck';
  const names = h.coins.slice(0, Math.min(DEPLOYER_HISTORY_NAMES, total)).map(c => (c.ticker ? `$${c.ticker}` : c.name));
  const more = total - names.length;
  let list = '';
  if (names.length && more > 0) list = `${names.join(', ')} and ${more} more`;
  else if (names.length > 1) list = `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
  else if (names.length) list = names[0];
  return `${total} other ${total === 1 ? 'coin' : 'coins'} from this wallet checked by ApeCheck${list ? `, ${list}` : ''}`;
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
