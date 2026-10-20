/**
 * One webhook delivery (HANDOFF §9, §11): build the WebhookPayload, sign it, POST it, record what happened.
 *
 *  - Payload: rebuilt from the database on every attempt (the row stores the event, not the body), so all attempts
 *    carry the same `id` (the delivery id: receivers dedupe on it; delivery is at least once) and the same `created`.
 *  - Signature: "ApeCheck-Signature: t=<unix seconds>,v1=<hex HMAC-SHA256(secret, `${t}.${rawBody}`)>" (signWebhook from
 *    @apecheck/core/node, the helper the API page documents); `t` is the time of this attempt.
 *  - Transport: sources.http with guard: true (SSRF guard: the URL is resolved and vetted on every attempt and the
 *    socket pinned to the vetted address, so a name that later points at a private address is refused), no redirects,
 *    10 s, at most 64 KB of the answer read. https only in production (the API refuses anything else at creation;
 *    checked again here). Content-Type application/json, User-Agent ApeCheck-Webhooks/1.0.
 *  - 2xx = delivered. Any other answer, a timeout or a connection error = a failed attempt, retried (WEBHOOK_MAX_ATTEMPTS,
 *    events.ts webhookRetryDelayMs); an SSRF refusal (private / loopback / metadata address, a blocked name) or a plain
 *    http URL in production fails at once, without a request. A ping (the API page's "Send test") is tried once.
 *  - Fairness: with DeliverDeps.acquire (the webhooks worker's Redis slots, index.ts) at most one request per webhook is
 *    in flight, at most a few per user, and one test ping per user; a delivery that finds its slot taken comes back
 *    as `busy` without a request (the worker puts its job back for a moment, no attempt used), so an endpoint that
 *    never answers holds one of the shared slots at a time, not all of them.
 *  - Health: every attempt sets Webhook.lastDeliveryAt / lastStatus (null when nothing answered); a delivery that
 *    succeeds resets failCount; one that fails for good adds 1, and WEBHOOK_DISABLE_AFTER in a row set disabledAt (the
 *    webhook then gets no new events and its pending deliveries fail without a request, until the API re-enables it).
 *    Pings never count against a webhook.
 *  - Secrets: the signing secret never leaves this function except inside the HMAC; logs name the host only (a URL can
 *    carry a token in its path or query).
 */
import { WEBHOOK_SIGNATURE_HEADER, checkResultOf, type Env, type WebhookPayload } from '@apecheck/core';
import { signWebhook } from '@apecheck/core/node';
import type { Prisma, PrismaClient } from '@apecheck/db';
import { SsrfError, TimeoutError, type Http } from '@apecheck/sources';
import { errText, type Logger } from '../log';
import { pgText } from '../pipeline/pgsafe';
import { fingerprintKind } from '../watch/fingerprint';
import { EVENT_CHECK_COMPLETED, EVENT_PING, EVENT_WATCH_CHANGED, WEBHOOK_DISABLE_AFTER, WEBHOOK_MAX_ATTEMPTS } from './events';

export const WEBHOOK_USER_AGENT = 'ApeCheck-Webhooks/1.0';
export const WEBHOOK_TIMEOUT_MS = 10_000;
export const WEBHOOK_MAX_RESPONSE_BYTES = 64 * 1024;

export interface DeliverDeps {
  env: Pick<Env, 'NODE_ENV' | 'APP_URL'>;
  prisma: PrismaClient;
  /** sources.http (guarded requests) */
  http: Http;
  log: Logger;
  now?: () => number;
  /**
   * Take the slots one request to this webhook needs (index.ts deliverySlots: the webhook's, its owner's, a ping's);
   * resolves to the function that gives them back, or null when one is taken (the delivery is then `busy`). Without
   * it every delivery is sent at once.
   */
  acquire?: (d: DeliverySlotRequest) => Promise<(() => Promise<void>) | null>;
}

export interface DeliverySlotRequest {
  webhookId: string;
  userId: string;
  ping: boolean;
}

type Db = PrismaClient | Prisma.TransactionClient;

export type DeliveryOutcome =
  | { status: 'ok'; code: number }
  /** a failed attempt that will be tried again (the caller throws so BullMQ schedules the retry) */
  | { status: 'retry'; code: number | null; error: string }
  /** failed for good; `requested`: a request went out (false: refused or skipped before any) */
  | { status: 'failed'; code: number | null; error: string; requested: boolean }
  | { status: 'skipped'; reason: string }
  /** not sent now: another request to the same webhook (or too many of its owner's) is in flight; try again shortly */
  | { status: 'busy' };

/** BullMQ's view of the attempt (the stored WebhookDelivery.attempts counts too: a re-queued job starts at 0) */
export interface AttemptInfo {
  /** failed attempts of this job so far (job.attemptsMade) */
  attemptsMade: number;
  /** job.opts.attempts (1 when the job was queued without retries) */
  maxAttempts: number;
}

const clip = (s: string, n = 300) => pgText(s).slice(0, n);

/** Host of a URL for logs (never the path or query: they may carry a token). */
export function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return 'invalid URL';
  }
}

/** The WebhookPayload of a delivery as of now; null when what it is about is gone (or the event is unknown). */
export async function buildPayload(
  deps: Pick<DeliverDeps, 'prisma' | 'env'>,
  d: { id: string; event: string; checkId: string | null; targetId: string | null; createdAt: Date },
): Promise<WebhookPayload | null> {
  const base = { id: d.id, created: d.createdAt.toISOString() };
  if (d.event === EVENT_PING) return { ...base, event: 'ping' };
  if (d.event === EVENT_CHECK_COMPLETED) {
    if (!d.checkId) return null;
    const c = await deps.prisma.check.findUnique({
      where: { id: d.checkId },
      select: { shortId: true, status: true, targetRaw: true, narScore: true, coinScore: true, totalScore: true, narBand: true, coinBand: true, summary: true, error: true },
    });
    if (!c || (c.status !== 'DONE' && c.status !== 'FAILED')) return null;
    return {
      ...base,
      event: 'check.completed',
      // the same flat shape as the MCP tool run_check (core checkResultOf, also behind apps/api toCheckResult): target =
      // what was pasted, verdict = the narrative verdict enum ("PARTLY_REAL"; the coin's when only the coin was scored);
      // a check that couldn't finish has null scores and verdict and says why in `summary` (Check.error)
      check: checkResultOf(c, deps.env.APP_URL),
    };
  }
  if (d.event === EVENT_WATCH_CHANGED) {
    if (!d.targetId) return null;
    const t = await deps.prisma.target.findUnique({
      where: { id: d.targetId },
      select: { id: true, name: true, kind: true, chain: true, ca: true, domain: true, handle: true },
    });
    if (!t) return null;
    // what changed: "site" (the page's text), "contract" (EVM / Tron code, owner, mint function, proxy implementation),
    // "mint" (a Solana mint's authorities / Token-2022 settings) or "profile" (the X profile)
    const change = fingerprintKind(t) ?? 'site';
    return { ...base, event: 'watch.changed', target: { id: t.id, name: t.name, change } };
  }
  return null;
}

/** What one POST attempt came to. `permanent`: retrying can't help (never sent). */
interface Attempt {
  ok: boolean;
  code: number | null;
  error: string | null;
  requested: boolean;
  permanent: boolean;
}

async function post(deps: DeliverDeps, url: string, secret: string, body: string): Promise<Attempt> {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return { ok: false, code: null, error: 'The webhook URL is not valid', requested: false, permanent: true };
  }
  if (deps.env.NODE_ENV === 'production' && u.protocol !== 'https:') {
    return { ok: false, code: null, error: 'The webhook URL must use https', requested: false, permanent: true };
  }
  const t = Math.floor((deps.now ? deps.now() : Date.now()) / 1000);
  try {
    const res = await deps.http.request(u.href, {
      method: 'POST',
      guard: true,
      redirect: false,
      timeoutMs: WEBHOOK_TIMEOUT_MS,
      maxBytes: WEBHOOK_MAX_RESPONSE_BYTES,
      headers: {
        'content-type': 'application/json',
        'user-agent': WEBHOOK_USER_AGENT,
        [WEBHOOK_SIGNATURE_HEADER]: signWebhook(secret, body, t),
      },
      body,
    });
    if (res.ok) return { ok: true, code: res.status, error: null, requested: true, permanent: false };
    const redirect = res.status >= 300 && res.status < 400 ? ' (redirects are not followed)' : '';
    return { ok: false, code: res.status, error: `HTTP ${res.status}${redirect}`, requested: true, permanent: false };
  } catch (e) {
    if (e instanceof SsrfError) {
      // a name that didn't resolve may be a DNS blip: tried again; a private / loopback / metadata address never is.
      // The guard's reason (what the name resolved to) describes our network, so it goes to the log only.
      const unresolved = /^could not resolve/.test(e.reason);
      deps.log.info(`webhook URL ${hostOf(u.href)} refused by the SSRF guard: ${e.reason}`);
      return {
        ok: false,
        code: null,
        error: unresolved ? 'Not sent: the host name could not be resolved' : 'Not sent: the URL points to a private, local or internal address',
        requested: false,
        permanent: !unresolved,
      };
    }
    if (e instanceof TimeoutError || (e instanceof Error && /timeout/i.test(e.name + ' ' + e.message))) {
      return { ok: false, code: null, error: `No answer within ${WEBHOOK_TIMEOUT_MS / 1000} s`, requested: true, permanent: false };
    }
    const code = (e as { code?: unknown })?.code;
    const why = typeof code === 'string' && /^E[A-Z_]+$/.test(code) ? `Connection failed (${code})` : `Connection failed: ${errText(e)}`;
    return { ok: false, code: null, error: clip(why, 200), requested: true, permanent: false };
  }
}

/**
 * Deliver one WebhookDelivery (see the header). Never throws for a failed delivery: the outcome says whether to retry.
 * A database error does throw (BullMQ retries the job; the receiver may then see the same `id` twice).
 */
export async function processDelivery(deps: DeliverDeps, deliveryId: string, attempt: AttemptInfo): Promise<DeliveryOutcome> {
  const { prisma, log } = deps;
  const d = await prisma.webhookDelivery.findUnique({
    where: { id: deliveryId },
    select: {
      id: true, event: true, checkId: true, targetId: true, status: true, attempts: true, createdAt: true,
      webhook: { select: { id: true, userId: true, url: true, secret: true, disabledAt: true } },
    },
  });
  if (!d) return { status: 'skipped', reason: 'delivery gone (webhook deleted)' };
  if (d.status !== 'pending') return { status: 'skipped', reason: `already ${d.status}` };
  const ping = d.event === EVENT_PING;

  // only this run's view of the row is written (another run of the same job that got here first wins)
  const settle = (
    data: { status: 'pending' | 'ok' | 'failed'; tried: boolean; code?: number | null; error?: string | null; deliveredAt?: Date | null },
    db: Db = prisma,
  ) =>
    db.webhookDelivery.updateMany({
      where: { id: d.id, status: 'pending', attempts: d.attempts },
      data: {
        status: data.status,
        attempts: data.tried ? d.attempts + 1 : d.attempts,
        ...(data.code !== undefined ? { responseCode: data.code } : {}),
        ...(data.error !== undefined ? { error: data.error } : {}),
        ...(data.deliveredAt ? { deliveredAt: data.deliveredAt } : {}),
      },
    });

  if (d.webhook.disabledAt && !ping) {
    await settle({ status: 'failed', tried: false, error: 'Not sent: the webhook was disabled after repeated failures' });
    return { status: 'failed', code: null, error: 'webhook disabled', requested: false };
  }
  const release = deps.acquire ? await deps.acquire({ webhookId: d.webhook.id, userId: d.webhook.userId, ping }) : async () => undefined;
  if (!release) return { status: 'busy' };
  try {
    return await send(deps, d, ping, settle, attempt);
  } finally {
    await release().catch(e => log.warn(`webhook ${d.webhook.id}: could not give its delivery slot back (it expires by itself): ${errText(e)}`));
  }
}

type Loaded = {
  id: string;
  event: string;
  checkId: string | null;
  targetId: string | null;
  attempts: number;
  createdAt: Date;
  webhook: { id: string; url: string; secret: string };
};
type Settle = (
  data: { status: 'pending' | 'ok' | 'failed'; tried: boolean; code?: number | null; error?: string | null; deliveredAt?: Date | null },
  db?: Db,
) => Promise<{ count: number }>;

/** Build, sign and POST one pending delivery, and record what happened (processDelivery, holding its slots). */
async function send(deps: DeliverDeps, d: Loaded, ping: boolean, settle: Settle, attempt: AttemptInfo): Promise<DeliveryOutcome> {
  const { prisma, log } = deps;
  const now = () => new Date(deps.now ? deps.now() : Date.now());
  const payload = await buildPayload(deps, d);
  if (!payload) {
    await settle({ status: 'failed', tried: false, error: 'Not sent: what this event was about no longer exists' });
    return { status: 'failed', code: null, error: 'event data gone', requested: false };
  }

  const body = JSON.stringify(payload);
  const res = await post(deps, d.webhook.url, d.webhook.secret, body);
  const at = now();
  const host = hostOf(d.webhook.url);

  // The delivery row and the webhook's health (lastDeliveryAt / lastStatus / failCount / disabledAt) are written in one
  // transaction: whoever sees the delivery settled (the /api page after "Send test", the API's lists) also sees the
  // webhook as it now is, never half-updated.
  if (res.ok) {
    const recorded = await prisma.$transaction(async tx => {
      const w = await settle({ status: 'ok', tried: true, code: res.code, error: null, deliveredAt: at }, tx);
      if (!w.count) return false;
      await tx.webhook.updateMany({ where: { id: d.webhook.id }, data: { lastDeliveryAt: at, lastStatus: res.code, failCount: 0 } });
      return true;
    });
    if (!recorded) return { status: 'skipped', reason: 'recorded by another run' };
    log.info(`webhook ${d.webhook.id} (${host}): ${d.event} ${d.id} delivered (HTTP ${res.code}, attempt ${d.attempts + 1})`);
    return { status: 'ok', code: res.code! };
  }

  const error = res.error ?? 'Failed';
  const final =
    res.permanent || ping || d.attempts + 1 >= WEBHOOK_MAX_ATTEMPTS || attempt.attemptsMade + 1 >= Math.max(1, attempt.maxAttempts);
  const health = await prisma.$transaction(async tx => {
    const w = await settle({ status: final ? 'failed' : 'pending', tried: true, code: res.code, error }, tx);
    if (!w.count) return null;
    await tx.webhook.updateMany({ where: { id: d.webhook.id }, data: { lastDeliveryAt: at, lastStatus: res.code } });
    // a delivery that failed for good counts once (pings never do); WEBHOOK_DISABLE_AFTER in a row turn the webhook off.
    // The increment holds the webhook's row lock until commit, so concurrent deliveries count one after the other.
    if (!final || ping) return { failCount: null as number | null, disabled: false };
    await tx.webhook.updateMany({ where: { id: d.webhook.id }, data: { failCount: { increment: 1 } } });
    const hook = await tx.webhook.findUnique({ where: { id: d.webhook.id }, select: { failCount: true } });
    // gone: the webhook was deleted meanwhile (nothing to count)
    if (!hook) return { failCount: null, disabled: false };
    const off =
      hook.failCount >= WEBHOOK_DISABLE_AFTER
        ? await tx.webhook.updateMany({ where: { id: d.webhook.id, disabledAt: null }, data: { disabledAt: at } })
        : { count: 0 };
    return { failCount: hook.failCount, disabled: off.count > 0 };
  });
  if (!health) return { status: 'skipped', reason: 'recorded by another run' };
  if (!final) {
    log.info(`webhook ${d.webhook.id} (${host}): ${d.event} ${d.id} attempt ${d.attempts + 1} failed (${error}); retrying`);
    return { status: 'retry', code: res.code, error };
  }
  log.warn(`webhook ${d.webhook.id} (${host}): ${d.event} ${d.id} failed after ${d.attempts + 1} attempt(s): ${error}`);
  if (health.disabled) log.warn(`webhook ${d.webhook.id} (${host}) disabled after ${health.failCount} failed deliveries in a row`);
  return { status: 'failed', code: res.code, error, requested: res.requested };
}
