'use client';
import { useMe } from './Me';
import { useModal } from './Modal';
import { Tiers, TiersNote } from './Tiers';

export interface AccessModalProps {
  /** opened because the viewer ran out of checks (402 no_credits) */
  out?: boolean;
  /** wallet sign-in (M3); without it the Pro/Max buttons stay disabled */
  onWallet?: () => void;
}

/** openAccess(out) from the prototype. Open it with useActions().openAccess(out). */
export function AccessModal({ out = false, onWallet }: AccessModalProps) {
  const { me } = useMe();
  const { close } = useModal();
  const live = !!me?.tokenLive;
  const title = out ? "You've used today's free checks" : 'Checks and access';
  const sub = out
    ? `Free checks reset at 00:00 UTC.${live ? ' Holders get more, plus deeper checks.' : ''}`
    : me
      ? `${me.credits} of ${me.max} free checks left today. Free checks reset at 00:00 UTC.`
      : 'Free checks reset at 00:00 UTC.';
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
      <Tiers me={me} onFree={close} onWallet={onWallet} />
      <TiersNote me={me} />
    </>
  );
}
