/** GET /health, GET /v1/me */
import type { FastifyInstance } from 'fastify';
import { tokenLive, type MeDTO } from '@apecheck/core';
import type { AppDeps } from '../context';
import { getCredits } from '../credits';
import { subjectOf } from './util';

export function registerMetaRoutes(app: FastifyInstance, deps: AppDeps) {
  app.get('/health', { config: { rateLimit: false } }, async () => ({ ok: true }));

  app.get('/v1/me', async (request): Promise<MeDTO> => {
    const { env, redis } = deps;
    const c = await getCredits(redis, env, subjectOf(request));
    const live = tokenLive(env);
    return {
      credits: c.credits,
      max: c.max,
      resetsAt: c.resetsAt.toISOString(),
      tier: 'free',
      tokenLive: live,
      proMinHold: live ? env.PRO_MIN_HOLD : null,
      maxMinHold: live ? env.MAX_MIN_HOLD : null,
      user: null,
    };
  });
}
