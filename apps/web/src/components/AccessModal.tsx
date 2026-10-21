'use client';
import type { MeDTO } from '@apecheck/core';
import { useAccount } from './Account';
import { useMe } from './Me';
import { useModal } from './Modal';
import { Tiers, TiersNote } from './Tiers';

export interface AccessModalProps {
  /** opened because the viewer ran out of checks (402 no_credits) */
  out?: boolean;
}

/** "N of M free checks left today" (Free) / "N of M checks left today" (Pro, Max). */
export function creditsLeftText(me: MeDTO): string {
  return `${me.credits} of ${me.max} ${me.tier === 'free' ? 'free ' : ''}checks left today`;
}

/** The access modal's title (and the dialog's accessible name): "You've used today's (free) checks" when out. */
export function accessTitle(me: MeDTO | null, out: boolean): string {
  if (!out) return 'Checks and access';
  return !me || me.tier === 'free' ? "You've used today's free checks" : "You've used today's checks";
}

/**
 * The line under the title. Out of checks, only Free hears that holders get more (Pro hears about Max). Without
 * `creditsKnown` (right after sign-out) the count is left out.
 */
export function accessSubtitle(me: MeDTO | null, out: boolean, creditsKnown = true): string {
  const live = !!me?.tokenLive;
  const free = !me || me.tier === 'free';
  const reset = free ? 'Free checks reset at 00:00 UTC.' : 'Checks reset at 00:00 UTC.';
  if (out) {
    if (!live) return reset;
    if (free) return `${reset} Holders get more checks a day.`;
    if (me?.tier === 'pro') return `${reset} Max gets ${me.maxChecksPerDay} checks a day.`;
    return reset;
  }
  return me && creditsKnown ? `${creditsLeftText(me)}. ${reset}` : reset;
}

/** openAccess(out) from the prototype. Open it with useActions().openAccess(out). */
export function AccessModal({ out = false }: AccessModalProps) {
  const { me, creditsKnown } = useMe();
  const { close } = useModal();
  const { openWallets } = useAccount();
  const title = accessTitle(me, out);
  const sub = accessSubtitle(me, out, creditsKnown);
  return (
    <>
      <div className="modal-h">
        <div>
          <h2 id="modal-title">{title}</h2>
          <p>{sub}</p>
        </div>
        <button className="x-btn" type="button" aria-label="Close" onClick={close}>
          ✕
        </button>
      </div>
      <Tiers me={me} onFree={close} onWallet={() => openWallets()} />
      <TiersNote me={me} />
    </>
  );
}
