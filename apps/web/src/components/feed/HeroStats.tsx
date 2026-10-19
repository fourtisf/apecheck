import { fmtPct, type InsightsDTO } from '@apecheck/core';

/** "21,968 checked · 2,869 today · LARP-stamped coins −42% since their check" (the last part only when there is data). */
export function HeroStats({ stats }: { stats: InsightsDTO['stats'] | null | undefined }) {
  if (!stats) return null;
  return (
    <div className="hero-stats">
      <span>
        <b>{stats.checked.toLocaleString('en-US')}</b> checked
      </span>
      <span>
        <b>{stats.today.toLocaleString('en-US')}</b> today
      </span>
      {stats.larpSince != null ? (
        <span>
          LARP-stamped coins <b className={stats.larpSince < 0 ? 'dn' : undefined}>{fmtPct(stats.larpSince)}</b> since their check
        </span>
      ) : null}
    </div>
  );
}
