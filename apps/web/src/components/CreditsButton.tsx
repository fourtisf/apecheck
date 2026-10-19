'use client';
import { creditsLeftText } from './AccessModal';
import { useActions } from './Actions';
import { useMe } from './Me';

const C = 2 * Math.PI * 8;

/**
 * renderCredits(): ring + "4/5" of the viewer's daily limit (Free, or the signed-in tier's: MeDTO.max); opens the
 * access modal. Shows "–/–" until GET /v1/me answers (and right after sign-out, until it says what this browser has).
 */
export function CreditsButton() {
  const { me: m, creditsKnown } = useMe();
  const { openAccess } = useActions();
  const me = creditsKnown ? m : null;
  const f = me && me.max > 0 ? Math.max(0, Math.min(1, me.credits / me.max)) : 0;
  const color = !me || me.credits ? 'var(--acc)' : 'var(--dn)';
  return (
    <button
      className="credits"
      id="credBtn"
      type="button"
      onClick={() => openAccess(false)}
      aria-label={me ? creditsLeftText(me) : 'Checks and access'}
    >
      <svg width="22" height="22" viewBox="0 0 22 22" aria-hidden="true">
        <circle cx="11" cy="11" r="8" fill="none" style={{ stroke: 'var(--line2)' }} strokeWidth="3" />
        <circle
          cx="11"
          cy="11"
          r="8"
          fill="none"
          style={{ stroke: color }}
          strokeWidth="3"
          strokeLinecap="round"
          strokeDasharray={`${(C * f).toFixed(1)} ${C.toFixed(1)}`}
        />
      </svg>
      {me ? `${me.credits}/${me.max}` : '–/–'}
    </button>
  );
}
