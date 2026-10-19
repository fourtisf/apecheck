/** API errors: every non-2xx JSON body is ApiErrorBody {error, code} (core dto.ts). */
import type { ApiErrorBody, Env } from '@apecheck/core';
import { tokenLive } from '@apecheck/core';

export class ApiError extends Error {
  constructor(
    readonly statusCode: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }

  body(): ApiErrorBody {
    return { error: this.message, code: this.code };
  }
}

export const MSG = {
  badTarget: 'Paste a contract address, an X post link or a website',
  noCredits: "You've used today's free checks. Hold $APECHECK for more, or come back after 00:00 UTC.",
  notFound: "This check doesn't exist or has expired.",
  routeNotFound: 'Not found',
  rateLimited: 'Too many requests. Wait a minute and try again.',
  holdersOnly: 'Notes are open to $APECHECK holders. Connect a wallet to add one.',
  signInRequired: 'Sign in with a wallet to keep a watchlist.',
  internal: 'Something went wrong on our side. Try again in a moment.',
  queueDown: "Couldn't start the check right now. Your credit was not used. Try again in a moment.",
} as const;

const amount = (n: number) => n.toLocaleString('en-US');

/** Follow-ups (asks): Pro only. While the token isn't live, don't quote a holding. */
export function proRequiredMessage(env: Env): string {
  return tokenLive(env)
    ? `Follow-ups need Pro: hold ${amount(env.PRO_MIN_HOLD)} $APECHECK`
    : 'Follow-ups need Pro. Pro and Max open at token launch.';
}

/** Private checks: Max only. */
export function maxRequiredMessage(env: Env): string {
  return tokenLive(env)
    ? `Private checks need Max: hold ${amount(env.MAX_MIN_HOLD)} $APECHECK`
    : 'Private checks need Max. Pro and Max open at token launch.';
}
