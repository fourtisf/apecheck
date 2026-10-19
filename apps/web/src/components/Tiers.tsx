'use client';
import type { MeDTO, TierS } from '@apecheck/core';
import { useAccount } from './Account';
import { useMe } from './Me';

export interface TiersProps {
  /** GET /v1/me; null while it loads */
  me: MeDTO | null;
  /** "Keep using free" / "Your tier" (in the access modal it closes the modal) */
  onFree?: () => void;
  /** "Connect wallet" (signed out) and "Check my holding" (signed in, token live): the wallet sign-in */
  onWallet?: () => void;
}

const amount = (n: number) => n.toLocaleString('en-US');
const RANK: Record<TierS, number> = { free: 0, pro: 1, max: 2 };

/** The button at the bottom of a tier card, for the viewer as they are. */
function TierButton({ tier, me, primary, onFree, onWallet }: { tier: TierS; me: MeDTO | null; primary: boolean; onFree?: () => void; onWallet?: () => void }) {
  const cls = primary ? 'btn btn-primary' : 'btn';
  if (!me?.user) {
    if (tier === 'free') {
      return (
        <button className="btn" type="button" onClick={onFree}>
          Keep using free
        </button>
      );
    }
    return (
      <button className={cls} type="button" onClick={onWallet} disabled={!onWallet}>
        Connect wallet
      </button>
    );
  }
  const mine = RANK[me.tier];
  const here = RANK[tier];
  if (here === mine) {
    return (
      <button className="btn" type="button" aria-pressed="true" onClick={onFree}>
        Your tier
      </button>
    );
  }
  if (here < mine) {
    return (
      <button className="btn" type="button" disabled>
        Included
      </button>
    );
  }
  // a higher tier: signing in again re-reads the holding (it is cached for an hour)
  if (!me.tokenLive) {
    return (
      <button className="btn" type="button" disabled>
        At token launch
      </button>
    );
  }
  return (
    <button className={cls} type="button" onClick={onWallet} disabled={!onWallet}>
      Check my holding
    </button>
  );
}

/**
 * tiersHTML(): Free / Pro / Max. While the token isn't live (MeDTO.tokenLive false) the holding requirements are
 * hidden and Pro and Max read "Opens at token launch". Daily limits come from MeDTO (PRO_/MAX_CHECKS_PER_DAY).
 * Signed in, the viewer's tier is marked ("Your tier") and lower tiers read "Included".
 */
export function Tiers({ me, onFree, onWallet }: TiersProps) {
  const live = !!me?.tokenLive;
  // (max 0: a placeholder right after a paid viewer signs out, before /v1/me says the Free limit)
  const freeLine = me && me.tier === 'free' && me.max > 0 ? `${me.max} checks a day on the site` : 'Free checks every day on the site';
  const proLine = me?.proChecksPerDay ? `${me.proChecksPerDay} checks a day, ahead of the queue` : 'More checks a day, ahead of the queue';
  const maxLine = me?.maxChecksPerDay ? `${me.maxChecksPerDay} checks a day` : 'The most checks a day';
  const req = (hold: number | null | undefined) =>
    live && hold != null ? (
      <>
        Hold <b>{amount(hold)} $APECHECK</b>
      </>
    ) : (
      'Opens at token launch'
    );
  const btn = { me, onFree, onWallet };
  return (
    <div className="tiers">
      <div className="tier">
        <h3>Free</h3>
        <p className="req">No wallet needed</p>
        <ul>
          <li>{freeLine}</li>
          <li>Bot replies when you tag it</li>
          <li>Every verdict and report is public</li>
          <li>Narrative and coin scores</li>
        </ul>
        <TierButton tier="free" primary={false} {...btn} />
      </div>
      <div className="tier pro">
        <h3>Pro</h3>
        <p className="req">{req(me?.proMinHold)}</p>
        <ul>
          <li>{proLine}</li>
          <li>Deep holder analysis and wallet clusters</li>
          <li>Ask follow-ups on the site and via the bot</li>
          <li>Re-check alerts when a site or contract changes</li>
        </ul>
        <TierButton tier="pro" primary {...btn} />
      </div>
      <div className="tier">
        <h3>Max</h3>
        <p className="req">{req(me?.maxMinHold)}</p>
        <ul>
          <li>{maxLine}</li>
          <li>API, MCP and webhooks</li>
          <li>Watchlists that re-check on their own</li>
          <li>Private checks kept off the public feed</li>
        </ul>
        <TierButton tier="max" primary={false} {...btn} />
      </div>
    </div>
  );
}

/** The line under the tiers: the USDC option only once the token is live; before that, plainly when Pro and Max open. */
export function TiersNote({ me }: { me: MeDTO | null }) {
  return (
    <p className="pay-note">
      {me?.tokenLive ? 'Prefer not to hold? Pro and Max can also be paid monthly in USDC.' : 'Pro and Max open at token launch.'}
    </p>
  );
}

/** Tiers + note for the current viewer (the /api page's "Access" section). */
export function AccessTiers() {
  const { me } = useMe();
  const { openWallets } = useAccount();
  return (
    <>
      <Tiers me={me} onWallet={() => openWallets()} />
      <TiersNote me={me} />
    </>
  );
}
