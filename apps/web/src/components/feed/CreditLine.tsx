'use client';
import type { ReactNode } from 'react';
import type { MeDTO } from '@apecheck/core';
import { useMe } from '../Me';

/** The hero line once today's checks are used: Pro and Max already hold, so only Free hears about holding. */
export function outOfChecksText(me: Pick<MeDTO, 'tier' | 'tokenLive'>): string {
  if (me.tier !== 'free') return "You've used today's checks. They reset at 00:00 UTC.";
  return me.tokenLive
    ? "You've used today's free checks. Hold $APECHECK for more, or come back after 00:00 UTC."
    : "You've used today's free checks. Come back after 00:00 UTC.";
}

/** credLine(): checks left today under the hero form. Keeps its height while /v1/me loads (or, after sign-out, reloads). */
export function CreditLine() {
  const { me, creditsKnown } = useMe();
  let body: ReactNode = ' ';
  if (me && creditsKnown) {
    const what = me.tier === 'free' ? 'free check' : 'check';
    body =
      me.credits > 0 ? (
        <>
          <b>
            {me.credits} {what}
            {me.credits === 1 ? '' : 's'}
          </b>{' '}
          left today. Reading verdicts is always free.
        </>
      ) : (
        outOfChecksText(me)
      );
  }
  return (
    <p className="probe-sub" id="credLine">
      {body}
    </p>
  );
}
