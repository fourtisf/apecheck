/**
 * Webhooks on the API side (M4, Max): the URL check when one is added, the signing secret, and the test ping. The
 * worker queues the real events (check.completed, watch.changed) and delivers every job on queue "webhooks"
 * (WebhookJob { deliveryId }, jobId = deliveryId): it signs the WebhookPayload with the secret
 * (`ApeCheck-Signature: t=…,v1=…`, core/node signWebhook) and POSTs it through the SSRF-guarded client.
 *
 * URL rules (HANDOFF §11 "verify webhook URLs are public"): an absolute http(s) URL of at most 2048 characters, https
 * only in production, no username/password, and the sources SSRF guard (`checkUrl`) with the same options the worker's
 * client uses (`createHttp`): private, loopback, link-local and metadata addresses or names are refused, the name must
 * resolve (unless OUTBOUND_PROXY resolves names), and SSRF_ALLOW_HOSTS lets local test servers through outside
 * production only. The guard runs again on every delivery (DNS can change).
 */
import { QUEUES, isProd, type Env, type WebhookJob } from '@apecheck/core';
import { checkUrl } from '@apecheck/sources';
import type { FastifyBaseLogger } from 'fastify';
import type { AppDeps } from './context';
import { ApiError, MSG } from './errors';
import { randomBase62 } from './plugins/apiKeys';

export const WEBHOOK_URL_MAX = 2048;
export const WEBHOOK_SECRET_PREFIX = 'whsec_';
export const newWebhookSecret = () => WEBHOOK_SECRET_PREFIX + randomBase62(32);

/**
 * Options of the test-ping job: one attempt, so the deliveries list shows the result within seconds (the worker's
 * event jobs retry with backoff instead).
 */
export const PING_JOB_OPTIONS = {
  attempts: 1,
  removeOnComplete: { age: 24 * 3600, count: 1000 },
  removeOnFail: { age: 7 * 24 * 3600, count: 1000 },
};

/** The webhook URL to store (no fragment), or ApiError 400 bad_url. */
export async function vetWebhookUrl(deps: Pick<AppDeps, 'env' | 'sources'>, raw: string, log?: FastifyBaseLogger): Promise<string> {
  const { env } = deps;
  const text = raw.trim();
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    throw new ApiError(400, 'bad_url', MSG.webhookUrlBad);
  }
  if (text.length > WEBHOOK_URL_MAX || (url.protocol !== 'https:' && url.protocol !== 'http:')) throw new ApiError(400, 'bad_url', MSG.webhookUrlBad);
  if (isProd(env) && url.protocol !== 'https:') throw new ApiError(400, 'bad_url', MSG.webhookUrlHttps);
  if (url.username || url.password) throw new ApiError(400, 'bad_url', MSG.webhookUrlCredentials);
  url.hash = '';
  const check = await checkUrl(url.toString(), ssrfOptions(env, deps.sources.lookup));
  if (!check.ok) {
    // the reason (e.g. what a name resolves to) stays in the log: it describes our network, not theirs
    log?.info({ reason: check.reason }, 'webhook URL refused');
    throw new ApiError(400, 'bad_url', check.reason?.startsWith('could not resolve') ? MSG.webhookUrlUnresolved : MSG.webhookUrlPrivate);
  }
  return url.toString();
}

/** The SSRF options of the worker's delivery client (sources createHttp), so what is accepted here can be delivered. */
function ssrfOptions(env: Env, lookup: AppDeps['sources']['lookup']) {
  const production = isProd(env);
  return { production, allowHosts: production ? [] : env.SSRF_ALLOW_HOSTS, allowUnresolved: !!env.OUTBOUND_PROXY, ...(lookup ? { lookup } : {}) };
}

/**
 * Queue a "ping" delivery to the webhook: a WebhookDelivery row (pending) and its job. The row is removed again when
 * the queue is down (503 queue_unavailable).
 */
export async function queuePing(deps: Pick<AppDeps, 'prisma' | 'webhooks'>, webhookId: string, log?: FastifyBaseLogger) {
  const delivery = await deps.prisma.webhookDelivery.create({ data: { webhookId, event: 'ping' } });
  try {
    if (!deps.webhooks) throw new Error(`no producer for ${QUEUES.webhooks}`);
    const job: WebhookJob = { deliveryId: delivery.id };
    await deps.webhooks.add('deliver', job, { jobId: delivery.id, ...PING_JOB_OPTIONS });
  } catch (err) {
    log?.error({ err, deliveryId: delivery.id }, `could not enqueue on ${QUEUES.webhooks}`);
    await deps.prisma.webhookDelivery.delete({ where: { id: delivery.id } }).catch(() => undefined);
    throw new ApiError(503, 'queue_unavailable', "Couldn't send the test right now. Try again in a moment.");
  }
  return delivery;
}
