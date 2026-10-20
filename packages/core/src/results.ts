/**
 * M4: a finished check in the flat shape of the webhook payload's `check` (WebhookPayload.check) and of the MCP tool
 * run_check. One implementation for the API (apps/api toCheckResult → run_check) and the worker (webhooks/deliver.ts
 * → check.completed), so what a developer gets over MCP and over a webhook is always the same.
 */
import { COIN_BANDS, NAR_BANDS } from './config';
import type { WebhookPayload } from './dto';
import { coinVerdictEnum, narVerdictEnum } from './labels';
import { coinBand, narBand } from './scoring';

export type CheckResult = NonNullable<WebhookPayload['check']>;

/** The Check columns the result is made of (a Prisma row fits). */
export interface CheckResultRow {
  shortId: string;
  /** what was pasted (Check.targetRaw) */
  targetRaw: string;
  narScore: number | null;
  narBand: string | null;
  coinScore: number | null;
  coinBand: string | null;
  totalScore: number | null;
  summary: string | null;
  /** Check.status: a FAILED check has no scores or verdict, and says why in `summary` (Check.error) */
  status?: string;
  error?: string | null;
}

const finite = (n: number | null | undefined): n is number => n != null && Number.isFinite(n);

/**
 * The verdict enum as on the /api page: the narrative's ("PARTLY_REAL", from the stored band, else the score's band),
 * or the coin's ("SKETCHY") for a check with only a coin score; null without either score.
 */
export function checkVerdictEnum(c: Pick<CheckResultRow, 'narScore' | 'narBand' | 'coinScore' | 'coinBand'>): string | null {
  if (finite(c.narScore)) {
    const key = NAR_BANDS.find(b => b.key === c.narBand)?.key ?? narBand(Math.max(0, c.narScore)).key;
    return narVerdictEnum(key);
  }
  if (finite(c.coinScore)) {
    const key = COIN_BANDS.find(b => b.key === c.coinBand)?.key ?? coinBand(Math.max(0, c.coinScore)).key;
    return coinVerdictEnum(key);
  }
  return null;
}

/** WebhookPayload.check / run_check's result for a finished (DONE or FAILED) check; `appUrl` = APP_URL. */
export function checkResultOf(c: CheckResultRow, appUrl: string): CheckResult {
  const failed = c.status === 'FAILED';
  return {
    id: c.shortId,
    target: c.targetRaw,
    narrative: failed ? null : c.narScore,
    coin: failed ? null : c.coinScore,
    total: failed ? null : c.totalScore,
    verdict: failed ? null : checkVerdictEnum(c),
    // a check that couldn't finish says why, in the same plain words the report shows
    summary: failed ? (c.error ?? 'The check could not finish') : c.summary,
    report_url: `${appUrl.replace(/\/+$/, '')}/c/${c.shortId}`,
  };
}
