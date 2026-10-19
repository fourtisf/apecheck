'use client';
import type { MeDTO } from '@apecheck/core';
import { useMe } from './Me';

export interface TiersProps {
  /** GET /v1/me; null while it loads */
  me: MeDTO | null;
  /** "Keep using free" (in the access modal it closes the modal) */
  onFree?: () => void;
  /** Pro/Max "Connect wallet"; leave unset until wallet sign-in exists (M3) and the buttons stay disabled */
  onWallet?: () => void;
  /** daily checks for Pro / Max (PRO_CHECKS_PER_DAY / MAX_CHECKS_PER_DAY; MeDTO doesn't carry them yet) */
  proPerDay?: number;
  maxPerDay?: number;
}

const amount = (n: number) => n.toLocaleString('en-US');

/**
 * tiersHTML(): Free / Pro / Max. While the token isn't live (MeDTO.tokenLive false) the holding
 * requirements are hidden and Pro and Max read "Opens at token launch".
 */
export function Tiers({ me, onFree, onWallet, proPerDay = 30, maxPerDay = 200 }: TiersProps) {
  const live = !!me?.tokenLive;
  const freeLine = me && me.tier === 'free' ? `${me.max} checks a day on the site` : 'Free checks every day on the site';
  const walletDisabled = !live || !onWallet;
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
        <button className="btn" type="button" onClick={onFree}>
          Keep using free
        </button>
      </div>
      <div className="tier pro">
        <h3>Pro</h3>
        <p className="req">
          {live && me?.proMinHold != null ? (
            <>
              Hold <b>{amount(me.proMinHold)} $APECHECK</b>
            </>
          ) : (
            'Opens at token launch'
          )}
        </p>
        <ul>
          <li>{proPerDay} checks a day, ahead of the queue</li>
          <li>Deep holder analysis and wallet clusters</li>
          <li>Ask follow-ups on the site and via the bot</li>
          <li>Re-check alerts when a site or contract changes</li>
        </ul>
        <button className="btn btn-primary" type="button" onClick={onWallet} disabled={walletDisabled}>
          Connect wallet
        </button>
      </div>
      <div className="tier">
        <h3>Max</h3>
        <p className="req">
          {live && me?.maxMinHold != null ? (
            <>
              Hold <b>{amount(me.maxMinHold)} $APECHECK</b>
            </>
          ) : (
            'Opens at token launch'
          )}
        </p>
        <ul>
          <li>{maxPerDay} checks a day</li>
          <li>API, MCP and webhooks</li>
          <li>Watchlists that re-check on their own</li>
          <li>Private checks kept off the public feed</li>
        </ul>
        <button className="btn" type="button" onClick={onWallet} disabled={walletDisabled}>
          Connect wallet
        </button>
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
  return (
    <>
      <Tiers me={me} />
      <TiersNote me={me} />
    </>
  );
}
