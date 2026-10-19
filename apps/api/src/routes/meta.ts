/** GET /health, GET /v1/me */
import type { FastifyInstance } from 'fastify';
import type { MeDTO } from '@apecheck/core';
import { buildMe } from '../accounts';
import type { AppDeps } from '../context';

export function registerMetaRoutes(app: FastifyInstance, deps: AppDeps) {
  app.get('/health', { config: { rateLimit: false } }, async () => ({ ok: true }));

  /**
   * Credits, tier and account of the viewer. Signed in: the tier is re-read from the wallets when the stored holding
   * is older than an hour (a failed read keeps the last value), credits count per user with the tier's limit.
   */
  app.get('/v1/me', async (request, reply): Promise<MeDTO> => {
    reply.header('Cache-Control', 'no-store');
    return buildMe(deps, request);
  });
}
