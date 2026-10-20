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

  // M3: wallet sign-in, X link
  badMessage: "The sign-in message doesn't match the one we sent. Try signing in again.",
  nonceExpired: 'This sign-in request expired or was already used. Try signing in again.',
  badSignature: "The signature doesn't match this wallet. Try signing in again.",
  walletTaken: 'This wallet is linked to another ApeCheck account.',
  xUnavailable: 'Linking an X account is not available right now.',
  signInFirst: 'Sign in with a wallet first.',
  // M3: asks, notes, watchlist, alerts
  askLength: 'Ask a question of 3 to 280 characters.',
  askNotReady: 'Wait for the check to finish, then ask.',
  askTimeout: 'The answer is taking longer than usual. Try again in a moment.',
  askFailed: "Couldn't answer that right now. Try again in a moment.",
  askQueueDown: "Couldn't send your question right now. Try again in a moment.",
  noteLength: 'Notes are 10 to 500 characters.',
  noteNotReady: 'Wait for the check to finish, then add a note.',
  noteNotFound: "This note doesn't exist.",
  ownNote: "You can't mark your own note helpful.",
  targetNotFound: "This project hasn't been checked yet.",
  watchlistFull: 'Your watchlist is full. Remove a project to add another.',
  signInForAlerts: 'Sign in with a wallet to see your alerts.',
  // M4: API keys, webhooks, MCP
  signInForKeys: 'Sign in with a wallet to manage API keys and webhooks.',
  keyRequired: 'Add your ApeCheck API key: "Authorization: Bearer ak_live_…". Create one on apecheck.io/api.',
  invalidKey: "This API key isn't valid or was revoked. Create a new one on apecheck.io/api.",
  keyNotForManagement: "API keys can't manage keys or webhooks. Sign in on apecheck.io/api to do that.",
  keyRateLimited: 'Too many requests with this API key. Wait a minute and try again.',
  keyNotFound: "This API key doesn't exist.",
  keyName: 'Give the key a name of up to 40 characters.',
  webhookNotFound: "This webhook doesn't exist.",
  webhookEvents: 'Pick at least one event: check.completed or watch.changed.',
  webhookDisabled: 'This webhook is turned off after failed deliveries. Turn it back on first.',
  webhookUrlBad: 'Enter the full URL of your endpoint, starting with https://.',
  webhookUrlHttps: 'Webhook URLs must start with https://.',
  webhookUrlCredentials: "Webhook URLs can't contain a username or password. Check the signature header instead.",
  webhookUrlPrivate: 'Webhook URLs must point to a public server.',
  webhookUrlUnresolved: "We couldn't find that host name. Check the URL.",
} as const;

export const tooManyKeysMessage = (n: number) => `You have ${n} API keys, the most allowed. Revoke one to create another.`;
export const tooManyWebhooksMessage = (n: number) => `You have ${n} webhooks, the most allowed. Delete one to add another.`;

/** API keys, webhooks and MCP: Max only. While the token isn't live, don't quote a holding. */
export function maxForDevelopersMessage(env: Env): string {
  return tokenLive(env)
    ? `API keys, webhooks and MCP need Max: hold ${amount(env.MAX_MIN_HOLD)} $APECHECK`
    : 'API keys, webhooks and MCP need Max. Pro and Max open at token launch.';
}

/** EVM sign-in: not a key signature, and the message names another chain than the one smart wallets are checked on. */
export const smartWalletChainMessage = (chainName: string) =>
  `The signature doesn't match this wallet. If it's a smart wallet, switch it to ${chainName} and sign in again.`;
/** EVM sign-in: the smart-wallet chain's RPC didn't answer the EIP-1271 call. */
export const smartWalletUnavailableMessage = (chainName: string) =>
  `Couldn't check your smart wallet on ${chainName} right now. Try again in a moment.`;

/** Notes for a signed-in wallet that holds no $APECHECK. */
export function holdersOnlySignedIn(env: Env): string {
  return tokenLive(env) ? 'Notes are open to $APECHECK holders.' : 'Notes are open to $APECHECK holders once the token launches.';
}

export const asksPerHourMessage = (n: number) => `You've asked ${n} follow-ups in the last hour. Try again later.`;
export const notesPerDayMessage = (n: number) => `You've added ${n} notes today. Try again after 00:00 UTC.`;

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
