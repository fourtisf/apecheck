/**
 * ApeCheck scoring — ported from reference/scoring.ts.
 * Same rules the approved prototype (design/apecheck.html) uses, so verdicts look the way the design shows them.
 * The AI never picks scores: it only fills signal and claim statuses.
 *
 * Only change from the reference: the weights, thresholds and bands moved to ./config.ts
 * (one place to tune) and are re-exported here, so the public surface is identical.
 * test/scoring.reference.test.ts checks this file against the untouched reference for every input.
 */
import { CONFIG, NAR_BANDS, COIN_BANDS, TUNING } from './config';

export { CONFIG, NAR_BANDS, COIN_BANDS };

export type Signal = 'ok' | 'warn' | 'fail';
export type ClaimStatus = 'seen_working' | 'not_seen' | 'contradicted' | 'checks_out';
export type DeployerRecord = 'builder' | 'mixed' | 'serial';

export const SIGNAL_VALUE: Record<Signal, number> = { ok: 1, warn: 0.5, fail: 0 };
export const CLAIM_VALUE: Record<ClaimStatus, number> = { seen_working: 1, checks_out: 1, not_seen: 0.5, contradicted: 0 };

export type NarBand = (typeof NAR_BANDS)[number];
export type CoinBand = (typeof COIN_BANDS)[number];
export type NarKey = NarBand['key'];
export type CoinKey = CoinBand['key'];

export const narBand = (s: number) => NAR_BANDS.find(b => s >= b.min)!;
export const coinBand = (s: number) => COIN_BANDS.find(b => s >= b.min)!;

const clamp = (v: number, a: number, b: number) => Math.max(a, Math.min(b, v));
const avg = (a: number[]) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0.5);

/* ---------- signal helpers (Stage D → signals) ---------- */
export function bandSignal(value: number, t: { ok: number; warn: number }): Signal {
  return value < t.ok ? 'ok' : value <= t.warn ? 'warn' : 'fail';
}

export function deployerRecord(launched: number, dead: number): DeployerRecord {
  const ratio = launched ? dead / launched : 0;
  const d = CONFIG.deployer;
  if (launched >= d.serialMinLaunched && ratio >= d.serialMinDeadRatio) return 'serial';
  if (launched <= d.builderMaxLaunched && ratio <= d.builderMaxDeadRatio) return 'builder';
  return 'mixed';
}

export const deployerSignal = (r: DeployerRecord): Signal => (r === 'builder' ? 'ok' : r === 'mixed' ? 'warn' : 'fail');

/** Holders signal = worse of top-10 concentration and dev wallet share. */
export function holdersSignal(top10Pct: number, devHoldPct: number): Signal {
  const a = bandSignal(top10Pct, CONFIG.top10Pct), b = bandSignal(devHoldPct, CONFIG.devHoldPct);
  return SIGNAL_VALUE[a] <= SIGNAL_VALUE[b] ? a : b;
}

export function lpSignal(lp: 'burned' | 'locked' | 'unlocked', lockedDays = 0): Signal {
  if (lp === 'burned' || (lp === 'locked' && lockedDays >= TUNING.lpLockOkDays)) return 'ok';
  return lp === 'locked' ? 'warn' : 'fail';
}

export function authoritiesSignal(mintRenounced: boolean, freezeActive: boolean): Signal {
  if (!mintRenounced) return 'fail';
  return freezeActive ? 'warn' : 'ok';
}

/* ---------- scores ---------- */
export interface NarrativeInput {
  launch: Signal; flow: Signal; docs: Signal;
  acct: Signal; git: Signal;
  claims: ClaimStatus[];
}
export interface CoinInput {
  deployer: DeployerRecord;
  bundle: Signal; holders: Signal; lp: Signal; authorities: Signal;
}

export function scoreNarrative(i: NarrativeInput) {
  const w = CONFIG;
  // the main flow can only be tested if the app opens
  const flow: Signal = i.launch === 'ok' ? i.flow : i.launch;
  const product = SIGNAL_VALUE[i.launch] * w.product.launch + SIGNAL_VALUE[flow] * w.product.flow + SIGNAL_VALUE[i.docs] * w.product.docs;
  const claims = avg(i.claims.map(c => CLAIM_VALUE[c]));
  const people = SIGNAL_VALUE[i.acct] * w.people.acct + SIGNAL_VALUE[i.git] * w.people.git;
  let score = Math.round(100 * (product * w.narrative.product + claims * w.narrative.claims + people * w.narrative.people));
  if (i.launch !== 'ok') score = Math.min(score, w.caps.launchNotOk);
  else if (flow !== 'ok') score = Math.min(score, w.caps.flowNotOk);
  score = clamp(score, 0, 100);
  return {
    score,
    band: narBand(score),
    areas: { Product: Math.round(product * 100), Claims: Math.round(claims * 100), People: Math.round(people * 100) },
  };
}

export function scoreCoin(i: CoinInput) {
  const w = CONFIG.coin;
  let score = Math.round(100 * (
    SIGNAL_VALUE[deployerSignal(i.deployer)] * w.deployer +
    SIGNAL_VALUE[i.bundle] * w.bundle +
    SIGNAL_VALUE[i.holders] * w.holders +
    SIGNAL_VALUE[i.lp] * w.lp +
    SIGNAL_VALUE[i.authorities] * w.authorities));
  if (i.deployer === 'serial') score = Math.min(score, CONFIG.caps.serialDeployer);
  else if (i.deployer === 'mixed') score = Math.min(score, CONFIG.caps.mixedDeployer);
  score = clamp(score, 0, 100);
  return { score, band: coinBand(score) };
}

export function scoreCheck(n: NarrativeInput, c?: CoinInput) {
  const nar = scoreNarrative(n);
  const coin = c ? scoreCoin(c) : null;
  const total = coin ? Math.round((nar.score + coin.score) / 2) : nar.score;
  return { narrative: nar, coin, total, totalBand: narBand(total) };
}

/** "Checked out" in Deployers / "Builders worth watching" */
export const checkedOut = (total: number, coin: number | null) =>
  total >= TUNING.checkedOutMin && (coin == null || coin >= TUNING.checkedOutMin);
