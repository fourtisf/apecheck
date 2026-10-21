/**
 * The bot's reply texts (HANDOFF §7). Pure functions; every text stays within X's 280 (counted the X way, xtext.ts).
 *
 *   LIKELY LARP (37/100) · Coin: SKETCHY (37)
 *   'Launch app' does nothing; GitHub pushed in one burst at launch.
 *   Checks the claims, not the team. DYOR.
 *
 * No "· Coin: …" without a coin. The summary (model-written) is cut at a word boundary with "…" when the reply would
 * go over 280. BOT_INCLUDE_LINK appends "apecheck.io/c/<id>" (APP_URL's host); off by default because X bills posts
 * with a URL at a much higher rate.
 *
 * Model-written text (the judge's summary, a follow-up answer) is built from untrusted page, docs and post content,
 * so it is made safe before it is posted (sanitizeModelText, HANDOFF §11): it never mentions anyone (its @handles
 * lose their "@") and never carries a link (scheme URLs are dropped, every other domain is defanged to
 * "orbit[.]xyz"). A model line in which xtext still finds anything X might link is left out of the reply. The only
 * link a reply can hold is the opt-in report link (onlyReportLink checks the final text).
 */
import { BOT_DISCLAIMER, COIN_BANDS, COIN_LABEL, NAR_BANDS, NAR_LABEL, coinBand, narBand, scrubRetired } from '@apecheck/core';
import { X_MAX_LENGTH, fitPart, hasLink, urlSpans, xLength } from './xtext';

export const HELP_TEXT = "Tag me under a project's post, or include its link or contract.";
export const FAILED_TEXT = "Couldn't finish this check. Try again in a few minutes.";
export const PRO_POINTER_TEXT = 'Follow-up answers here are for Pro holders. The full report is on the ApeCheck site.';
export const NO_ANSWER_TEXT = 'This check has no answer for that.';

export interface ComposeOpts {
  /** BOT_INCLUDE_LINK */
  includeLink: boolean;
  /** APP_URL (its host is used for the link) */
  appUrl: string;
}

export interface ReplyCheck {
  status: 'QUEUED' | 'RUNNING' | 'DONE' | 'FAILED';
  shortId: string;
  narScore: number | null;
  narBand: string | null;
  coinScore: number | null;
  coinBand: string | null;
  summary: string | null;
  /**
   * The coin is on a chain ApeCheck can't read yet (Check.evidence.otherChain, see otherChainOf): `chain` is its name,
   * `site` the website from its token info that the check moved to (null when it didn't). The reply says so.
   */
  otherChain?: { chain: string; site?: string | null } | null;
}

const NAR_KEYS = new Set<string>(NAR_BANDS.map(b => b.key));
const COIN_KEYS = new Set<string>(COIN_BANDS.map(b => b.key));

/** "apecheck.io/c/<shortId>": the report link without a scheme (X links it and counts it as 23). */
export function reportLink(appUrl: string, shortId: string): string {
  let host = 'apecheck.io';
  try {
    host = new URL(appUrl).host || host;
  } catch {
    /* keep the default */
  }
  return `${host}/c/${shortId}`;
}

/**
 * Model-written text made safe to post: no mention can notify anyone (the "@" / "＠" before a handle is dropped),
 * one line, collapsed spaces.
 */
export function stripMentions(text: string): string {
  return text
    .replace(/[@＠]+(?=[A-Za-z0-9_])/g, '')
    .replace(/[@＠]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// a URL with a scheme: dropped whole (the classic shape of a planted link)
const RE_SCHEME_URL = /https?:\/\/\S+/giu;
// a "." between a name and something that could be a TLD (2+ letters, any script, punycode included): X could link
// it, under any of its TLDs, so it is broken up. "node.js" and "e.g.Next" lose their dot too; that only reads oddly.
const RE_DOMAIN_DOT = /(?<=[\p{L}\p{N}\p{M}_-])\.(?=[\p{L}\p{M}]{2})/gu;

/**
 * Model-written text without anything X would link: scheme URLs are dropped, and every other domain is defanged
 * ("wallet-verify.xyz" → "wallet-verify[.]xyz", "app.orbit.market/swap" → "app[.]orbit[.]market/swap"), whatever
 * its TLD. One line, collapsed spaces.
 */
export function stripLinks(text: string): string {
  return text
    .normalize('NFC')
    .replace(RE_SCHEME_URL, ' ')
    .replace(RE_DOMAIN_DOT, '[.]')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Model-written text made safe to post: no mention can notify anyone, and nothing in it is a link. */
export function sanitizeModelText(text: string): string {
  return stripLinks(stripMentions(text));
}

/**
 * The final text holds no link but the opt-in report link (`allowed`, reportLink()); with links off (`allowed`
 * null), none at all. Checked right before posting.
 */
export function onlyReportLink(text: string, allowed: string | null): boolean {
  const t = text.normalize('NFC');
  return urlSpans(t).every(([a, b]) => allowed != null && t.slice(a, b) === allowed);
}

/** Lines → text; `fit` is the line that gets cut when the whole would be over 280 (dropped when nothing fits). */
function fitLines(lines: (string | null)[], fitIdx: number | null): string {
  const keep = (part: string | null) => lines.map((l, i) => (i === fitIdx ? part : l)).filter((l): l is string => !!l).join('\n');
  if (fitIdx == null || !lines[fitIdx]) return keep(null);
  const part = fitPart(lines[fitIdx]!, p => keep(p), X_MAX_LENGTH);
  return keep(part === '…' ? null : part);
}

/**
 * Longest site (defanged) and chain names the other-chain line names; longer ones are left out ("the website",
 * "another chain"), so that line, a verdict head with a coin, the disclaimer and the report link always fit in 280.
 */
const OTHER_SITE_MAX = 60;
const OTHER_CHAIN_MAX = 24;

/**
 * The fixed line of a check whose coin is on a chain ApeCheck can't read (ReplyCheck.otherChain): the verdict is for
 * the website from the token's info (defanged: never a link) and the coin wasn't checked. At most 167 characters.
 */
export function otherChainLine(o: NonNullable<ReplyCheck['otherChain']>): string | null {
  const named = stripLinks(stripMentions(o.chain));
  const chain = named.length > OTHER_CHAIN_MAX ? 'another chain' : named;
  if (!chain || hasLink(chain)) return null;
  const site = o.site ? stripLinks(o.site) : '';
  if (site && site.length <= OTHER_SITE_MAX && !hasLink(site)) return `This verdict is for ${site}, the website in the token's info; the coin on ${chain} wasn't checked.`;
  if (o.site) return `This verdict is for the website in the token's info; the coin on ${chain} wasn't checked.`;
  return `The coin on ${chain} wasn't checked: ApeCheck can't read that chain yet.`;
}

/** The verdict reply for a finished check, or the failure line for a check that didn't finish. */
export function composeReply(check: ReplyCheck, opts: ComposeOpts): string {
  if (check.status !== 'DONE' || check.narScore == null || !Number.isFinite(check.narScore)) return FAILED_TEXT;
  const nar = Math.round(check.narScore);
  const narKey = (check.narBand && NAR_KEYS.has(check.narBand) ? check.narBand : narBand(Math.max(0, nar)).key) as keyof typeof NAR_LABEL;
  let head = `${NAR_LABEL[narKey]} (${nar}/100)`;
  if (check.coinScore != null && Number.isFinite(check.coinScore)) {
    const coin = Math.round(check.coinScore);
    const coinKey = (check.coinBand && COIN_KEYS.has(check.coinBand) ? check.coinBand : coinBand(Math.max(0, coin)).key) as keyof typeof COIN_LABEL;
    head += ` · Coin: ${COIN_LABEL[coinKey]} (${coin})`;
  }
  let summary = check.summary ? sanitizeModelText(scrubRetired(check.summary)) : '';
  // last guard: a summary in which anything could still be a link is left out (the verdict stands without it)
  if (summary && hasLink(summary)) summary = '';
  const link = opts.includeLink ? reportLink(opts.appUrl, check.shortId) : null;
  // a coin ApeCheck couldn't check: one fixed line right under the verdict (the summary is what gets cut to fit)
  const other = check.otherChain ? otherChainLine(check.otherChain) : null;
  return fitLines([head, other, summary || null, BOT_DISCLAIMER, link], 2);
}

/** A Pro follow-up: the model's answer (from the check's stored data only), made safe and cut to fit. */
export function composeFollowUp(answer: string, shortId: string, opts: ComposeOpts): string {
  let text = sanitizeModelText(answer);
  if (!text || hasLink(text)) text = NO_ANSWER_TEXT;
  const link = opts.includeLink ? reportLink(opts.appUrl, shortId) : null;
  return fitLines([text, link], 0);
}

/** A follow-up from someone who isn't Pro: one line pointing to the site (the link only with BOT_INCLUDE_LINK). */
export function composePointer(shortId: string, opts: ComposeOpts): string {
  return opts.includeLink ? `${PRO_POINTER_TEXT}\n${reportLink(opts.appUrl, shortId)}` : PRO_POINTER_TEXT;
}

/** Defensive last check before posting. */
export function fitsX(text: string): boolean {
  return text.length > 0 && xLength(text) <= X_MAX_LENGTH;
}
