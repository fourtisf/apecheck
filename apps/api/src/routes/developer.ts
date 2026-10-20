/**
 * Developers (M4, Max; HANDOFF §9): API keys and webhooks, managed from the /api page with a signed-in session. An API
 * key never works here (403 forbidden, plugins/apiKeys.ts), so a leaked key can't mint keys or redirect webhooks.
 *
 *   GET    /v1/keys                     → { items: ApiKeyDTO[] }            active keys, newest first
 *   POST   /v1/keys { name? }           → 201 CreateApiKeyResponse          the key itself is in this response only;
 *                                                                           409 too_many_keys over API_KEYS_PER_USER
 *   DELETE /v1/keys/:id                 → { ok: true }                      revoke (idempotent)
 *   GET    /v1/webhooks                 → { items: WebhookDTO[] }           newest first
 *   POST   /v1/webhooks { url, events } → 201 CreateWebhookResponse         the signing secret, shown once; 400 bad_url;
 *                                                                           409 too_many_webhooks over WEBHOOKS_PER_USER
 *   DELETE /v1/webhooks/:id             → { ok: true }
 *   POST   /v1/webhooks/:id/enable      → WebhookDTO                        clears disabledAt and failCount
 *   POST   /v1/webhooks/:id/test        → 201 WebhookDeliveryDTO            queues a "ping" delivery (409 webhook_disabled)
 *   GET    /v1/webhooks/:id/deliveries  → { items: WebhookDeliveryDTO[] }   the last 50, newest first
 *
 * Gates in order: signed in (401 sign_in_required) → Max, tier re-read per the M3 rules (403 max_required) → the
 * per-user burst. Revoking a key and deleting a webhook only need the owner signed in: someone whose Max lapsed can
 * still clean up (a key revoked then can't come back to life when they hold Max again).
 */
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { ApiKeyDTO, CreateApiKeyResponse, CreateWebhookResponse, WebhookDTO, WebhookDeliveryDTO, WebhookEvent } from '@apecheck/core';
import type { Prisma, User } from '@apecheck/db';
import { viewerTier } from '../accounts';
import type { AppDeps } from '../context';
import { ApiError, MSG, maxForDevelopersMessage, tooManyKeysMessage, tooManyWebhooksMessage } from '../errors';
import { userBurst } from '../limits';
import { toApiKeyDTO, toWebhookDTO, toWebhookDeliveryDTO } from '../mappers';
import { apiKeyPrefixOf, generateApiKey, hashApiKey } from '../plugins/apiKeys';
import { newWebhookSecret, queuePing, vetWebhookUrl } from '../webhooks';

/** per-IP route limits (per minute) */
export const DEVELOPER_RATE = { list: 60, create: 10, remove: 30, enable: 30, test: 10, deliveries: 60 } as const;
const rate = (max: number) => ({ config: { rateLimit: { max, timeWindow: '1 minute' } } });

export const KEY_NAME_MAX = 40;
export const DELIVERIES_SHOWN = 50;
export const WEBHOOK_EVENTS: readonly WebhookEvent[] = ['check.completed', 'watch.changed'];

const RE_CUID = /^[a-z0-9]{20,32}$/i;
const IdParamsZ = z.object({ id: z.string().max(64) });
const KeyBodyZ = z.object({ name: z.string().max(400).nullish() }).nullish();
const WebhookBodyZ = z.object({
  url: z.string().max(4096),
  events: z.array(z.enum(WEBHOOK_EVENTS as [WebhookEvent, ...WebhookEvent[]])).max(10).optional(),
});

/** control characters out, whitespace collapsed, trimmed */
const cleanName = (s: string) => s.normalize('NFC').replace(/[\u0000-\u001f\u007f​-‏‪-‮⁦-⁩]/g, ' ').replace(/\s+/g, ' ').trim();

const noStore = { 'Cache-Control': 'no-store' };

export function registerDeveloperRoutes(app: FastifyInstance, deps: AppDeps) {
  const { env, prisma, redis } = deps;

  function signedIn(request: FastifyRequest): User {
    const user = request.viewer.user;
    if (!user) throw new ApiError(401, 'sign_in_required', MSG.signInForKeys);
    return user;
  }

  /** a signed-in Max user (tier re-read when the stored one is over an hour old) */
  async function maxUser(request: FastifyRequest): Promise<User> {
    signedIn(request);
    const tier = await viewerTier(deps, request);
    if (tier?.tier !== 'max') throw new ApiError(403, 'max_required', maxForDevelopersMessage(env));
    return request.viewer.user!;
  }

  /** the user's webhook by id (404 for anyone else's) */
  async function ownWebhook(userId: string, id: string) {
    const hook = RE_CUID.test(id) ? await prisma.webhook.findFirst({ where: { id, userId } }) : null;
    if (!hook) throw new ApiError(404, 'not_found', MSG.webhookNotFound);
    return hook;
  }

  /** one user's creates run one at a time (advisory lock), so two at once can't pass the limit together */
  const userLock = (tx: Prisma.TransactionClient, name: string, userId: string) => tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`${name}:${userId}`}))`;

  /* ---------------- API keys ---------------- */

  app.get('/v1/keys', rate(DEVELOPER_RATE.list), async (request, reply): Promise<{ items: ApiKeyDTO[] }> => {
    const user = await maxUser(request);
    await userBurst(redis, 'keys', user.id);
    const keys = await prisma.apiKey.findMany({ where: { userId: user.id, revokedAt: null }, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }] });
    reply.headers(noStore);
    return { items: keys.map(toApiKeyDTO) };
  });

  app.post('/v1/keys', rate(DEVELOPER_RATE.create), async (request, reply): Promise<CreateApiKeyResponse> => {
    const user = await maxUser(request);
    const parsed = KeyBodyZ.safeParse(request.body ?? null);
    const name = parsed.success && parsed.data?.name ? cleanName(parsed.data.name) : '';
    if (!parsed.success || name.length > KEY_NAME_MAX) throw new ApiError(400, 'bad_request', MSG.keyName);
    await userBurst(redis, 'keys', user.id);

    const key = generateApiKey();
    const row = await prisma.$transaction(async tx => {
      await userLock(tx, 'apikeys', user.id);
      const active = await tx.apiKey.count({ where: { userId: user.id, revokedAt: null } });
      if (active >= env.API_KEYS_PER_USER) throw new ApiError(409, 'too_many_keys', tooManyKeysMessage(env.API_KEYS_PER_USER));
      // only the hash and the first 12 characters are stored; the key itself leaves in this response and nowhere else
      return tx.apiKey.create({ data: { userId: user.id, name: name || 'API key', prefix: apiKeyPrefixOf(key), hash: hashApiKey(key) } });
    });
    return reply.code(201).headers(noStore).send({ ...toApiKeyDTO(row), key });
  });

  app.delete('/v1/keys/:id', rate(DEVELOPER_RATE.remove), async (request): Promise<{ ok: true }> => {
    const user = signedIn(request);
    const { id } = IdParamsZ.parse(request.params);
    await userBurst(redis, 'keys', user.id);
    const key = RE_CUID.test(id) ? await prisma.apiKey.findFirst({ where: { id, userId: user.id }, select: { id: true, revokedAt: true } }) : null;
    if (!key) throw new ApiError(404, 'not_found', MSG.keyNotFound);
    if (!key.revokedAt) await prisma.apiKey.updateMany({ where: { id: key.id, revokedAt: null }, data: { revokedAt: new Date() } });
    return { ok: true };
  });

  /* ---------------- webhooks ---------------- */

  app.get('/v1/webhooks', rate(DEVELOPER_RATE.list), async (request, reply): Promise<{ items: WebhookDTO[] }> => {
    const user = await maxUser(request);
    await userBurst(redis, 'webhooks', user.id);
    const hooks = await prisma.webhook.findMany({ where: { userId: user.id }, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }] });
    reply.headers(noStore);
    return { items: hooks.map(toWebhookDTO) };
  });

  app.post('/v1/webhooks', rate(DEVELOPER_RATE.create), async (request, reply): Promise<CreateWebhookResponse> => {
    const user = await maxUser(request);
    const parsed = WebhookBodyZ.safeParse(request.body ?? {});
    if (!parsed.success) {
      const onEvents = parsed.error.issues.some(i => i.path[0] === 'events');
      throw new ApiError(400, onEvents ? 'bad_request' : 'bad_url', onEvents ? MSG.webhookEvents : MSG.webhookUrlBad);
    }
    // no list: the check verdicts; an empty list subscribes to nothing, which is a mistake
    const events = parsed.data.events ? [...new Set(parsed.data.events)] : (['check.completed'] as WebhookEvent[]);
    if (!events.length) throw new ApiError(400, 'bad_request', MSG.webhookEvents);
    await userBurst(redis, 'webhooks', user.id);
    const url = await vetWebhookUrl(deps, parsed.data.url, request.log);

    const secret = newWebhookSecret();
    const row = await prisma.$transaction(async tx => {
      await userLock(tx, 'webhooks', user.id);
      const count = await tx.webhook.count({ where: { userId: user.id } });
      if (count >= env.WEBHOOKS_PER_USER) throw new ApiError(409, 'too_many_webhooks', tooManyWebhooksMessage(env.WEBHOOKS_PER_USER));
      return tx.webhook.create({ data: { userId: user.id, url, secret, events: WEBHOOK_EVENTS.filter(e => events.includes(e)) } });
    });
    return reply.code(201).headers(noStore).send({ ...toWebhookDTO(row), secret });
  });

  app.delete('/v1/webhooks/:id', rate(DEVELOPER_RATE.remove), async (request): Promise<{ ok: true }> => {
    const user = signedIn(request);
    const { id } = IdParamsZ.parse(request.params);
    await userBurst(redis, 'webhooks', user.id);
    const gone = RE_CUID.test(id) ? await prisma.webhook.deleteMany({ where: { id, userId: user.id } }) : { count: 0 };
    if (!gone.count) throw new ApiError(404, 'not_found', MSG.webhookNotFound);
    return { ok: true };
  });

  app.post('/v1/webhooks/:id/enable', rate(DEVELOPER_RATE.enable), async (request): Promise<WebhookDTO> => {
    const user = await maxUser(request);
    const { id } = IdParamsZ.parse(request.params);
    await userBurst(redis, 'webhooks', user.id);
    const hook = await ownWebhook(user.id, id);
    const row = await prisma.webhook.update({ where: { id: hook.id }, data: { disabledAt: null, failCount: 0 } });
    return toWebhookDTO(row);
  });

  app.post('/v1/webhooks/:id/test', rate(DEVELOPER_RATE.test), async (request, reply): Promise<WebhookDeliveryDTO> => {
    const user = await maxUser(request);
    const { id } = IdParamsZ.parse(request.params);
    const hook = await ownWebhook(user.id, id);
    if (hook.disabledAt) throw new ApiError(409, 'webhook_disabled', MSG.webhookDisabled);
    await userBurst(redis, 'webhookTest', user.id);
    const delivery = await queuePing(deps, hook.id, request.log);
    return reply.code(201).send(toWebhookDeliveryDTO(delivery, new Map()));
  });

  app.get('/v1/webhooks/:id/deliveries', rate(DEVELOPER_RATE.deliveries), async (request, reply): Promise<{ items: WebhookDeliveryDTO[] }> => {
    const user = await maxUser(request);
    const { id } = IdParamsZ.parse(request.params);
    await userBurst(redis, 'webhookDeliveries', user.id);
    const hook = await ownWebhook(user.id, id);
    const rows = await prisma.webhookDelivery.findMany({ where: { webhookId: hook.id }, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], take: DELIVERIES_SHOWN });
    // WebhookDelivery.checkId is the internal Check.id; a shortId stored there is shown as is
    const ids = [...new Set(rows.map(r => r.checkId).filter((x): x is string => !!x))];
    const checks = ids.length
      ? await prisma.check.findMany({ where: { OR: [{ id: { in: ids } }, { shortId: { in: ids } }] }, select: { id: true, shortId: true } })
      : [];
    const shortIds = new Map<string, string>();
    for (const c of checks) {
      shortIds.set(c.id, c.shortId);
      shortIds.set(c.shortId, c.shortId);
    }
    reply.headers(noStore);
    return { items: rows.map(r => toWebhookDeliveryDTO(r, shortIds)) };
  });
}
