/**
 * "Since check" price tracking cadence (HANDOFF §10): every 15 min for the first 24 h after the check,
 * hourly to day 7, daily to day 30, then stop.
 */
export const PRICE_TICK_MS = 5 * 60_000;
export const TRACK_DAYS = 30;

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

/** Interval between points for a coin first checked at `anchor`; null once tracking has ended. */
export function priceInterval(anchor: Date, now: number): number | null {
  const age = now - anchor.getTime();
  if (age < 0) return 15 * MIN;
  if (age < DAY) return 15 * MIN;
  if (age < 7 * DAY) return HOUR;
  if (age < TRACK_DAYS * DAY) return DAY;
  return null;
}

/**
 * Due when the newest point is at least one interval old. A minute of slack keeps a 15-minute cadence on a
 * 5-minute tick from slipping to 20 minutes.
 */
export function isDue(anchor: Date, lastPoint: Date | null, now: number, slackMs = MIN): boolean {
  const every = priceInterval(anchor, now);
  if (every == null) return false;
  if (!lastPoint) return true;
  return now - lastPoint.getTime() >= every - slackMs;
}
