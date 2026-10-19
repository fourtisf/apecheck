'use client';
import type { ReactNode } from 'react';
import { useMe } from '../Me';

/** credLine(): checks left today under the hero form. Keeps its height while /v1/me loads. */
export function CreditLine() {
  const { me } = useMe();
  let body: ReactNode = ' ';
  if (me) {
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
      ) : me.tokenLive ? (
        "You've used today's free checks. Hold $APECHECK for more, or come back after 00:00 UTC."
      ) : (
        "You've used today's free checks. Come back after 00:00 UTC."
      );
  }
  return (
    <p className="probe-sub" id="credLine">
      {body}
    </p>
  );
}
