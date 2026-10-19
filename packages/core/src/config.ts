/**
 * Every scoring weight and threshold lives here so it can be tuned without
 * touching code anywhere else. Values are the reference values from
 * reference/scoring.ts (the approved prototype's rules).
 */

/* ---------- tunable config ---------- */
export const CONFIG = {
  narrative: { product: 0.40, claims: 0.35, people: 0.25 },
  product:   { launch: 0.3, flow: 0.5, docs: 0.2 },
  people:    { acct: 0.6, git: 0.4 },
  coin:      { deployer: 0.3, bundle: 0.3, holders: 0.2, lp: 0.1, authorities: 0.1 },
  caps: {
    launchNotOk: 58,   // app button dead / waitlist → can't be above Partly real
    flowNotOk: 74,     // app opens but main flow doesn't work → can't be Real
    serialDeployer: 42,
    mixedDeployer: 72,
  },
  // Stage D thresholds → coin signals
  bundlePct:  { ok: 8, warn: 20 },   // <8 ok, 8–20 warn, >20 fail
  top10Pct:   { ok: 25, warn: 40 },  // excludes LP
  devHoldPct: { ok: 3, warn: 8 },    // folded into holders signal
  // deployer record
  deployer: { builderMaxLaunched: 5, builderMaxDeadRatio: 0.2, serialMinLaunched: 8, serialMinDeadRatio: 0.7 },
  // people
  acctAgeDays: { ok: 180, warn: 30 }, // X account age
  gitBurstHours: 48,                  // most commits inside this window before launch → warn
};

export const NAR_BANDS = [
  { min: 80, key: 'real',   name: 'Real' },
  { min: 60, key: 'likely', name: 'Likely real' },
  { min: 40, key: 'partly', name: 'Partly real' },
  { min: 20, key: 'llarp',  name: 'Likely LARP' },
  { min: 0,  key: 'larp',   name: 'LARP' },
] as const;

export const COIN_BANDS = [
  { min: 80, key: 'clean',   name: 'Clean' },
  { min: 60, key: 'ok',      name: 'OK' },
  { min: 35, key: 'sketchy', name: 'Sketchy' },
  { min: 0,  key: 'rigged',  name: 'Rigged' },
] as const;

/**
 * Thresholds outside the score formulas. Kept here for the same reason:
 * one place to tune.
 */
export const TUNING = {
  /** Locked LP needs at least this many days to count as "ok" (see lpSignal). */
  lpLockOkDays: 180,
  /** A "Checked out" / "Real" coin in Deployers and "Builders worth watching". */
  checkedOutMin: 60,
  /** GitHub: fewer commits than this in total counts as thin history. */
  gitThinCommits: 10,
  /** GitHub: a repo with no push for this many days counts as stale. */
  gitStaleDays: 120,
  /** GitHub: a share of commits strictly above this inside CONFIG.gitBurstHours of the anchor counts as a launch burst. */
  gitBurstShare: 0.5,
  /** GitHub: no burst is flagged with fewer commits than this. */
  gitBurstMinCommits: 3,
  /** X: followers below this with a young account adds to the warn case. */
  acctLowFollowers: 500,
  /** Docs: fewer pages than this counts as thin docs (warn). */
  docsMinPages: 3,
  /** Claims extracted per check (Stage C). */
  maxClaims: 8,
  /** Sparkline length on the feed. */
  sparkPoints: 28,
  /** Insight card "Since check, by verdict" window. */
  sinceWindowDays: 30,
  /** Bot: ignore accounts younger than this. */
  botMinAccountAgeDays: 7,
  /** Bot: a mention older than this when the bot first reads it (a backlog after downtime, tags from before launch) gets no reply. */
  botMaxMentionAgeHours: 12,
  /** Screenshots and saved share cards of checks finished longer ago than this are deleted (HANDOFF §12.6)... */
  shotsKeepDays: 30,
  /** ...except for checks in the top this-many of the feed's Most checked, Most real and Least real lists. */
  shotsKeepTop: 50,
} as const;
