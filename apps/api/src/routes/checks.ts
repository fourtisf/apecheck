/**
 * POST /v1/checks, GET /v1/checks/:id, and the follow-up / notes / watch endpoints that are
 * gated until M3 (wallet sign-in and tiers).
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AppDeps } from '../context';
import { createCheck, loadReport } from '../checks';
import { ApiError, MSG, proRequiredMessage } from '../errors';
import { SHORT_ID_RE } from '../ids';
import { RATE } from '../plugins/rateLimit';
import { subjectOf, viewerOf } from './util';

const CreateBodyZ = z.object({
  target: z.string().max(2048),
  recheck: z.boolean().optional(),
  private: z.boolean().optional(),
});

const IdParamsZ = z.object({ id: z.string().max(64) });

export function registerCheckRoutes(app: FastifyInstance, deps: AppDeps) {
  app.post(
    '/v1/checks',
    { config: { rateLimit: { max: RATE.createCheckPerMin, timeWindow: '1 minute' } } },
    async (request, reply) => {
      const parsed = CreateBodyZ.safeParse(request.body ?? {});
      if (!parsed.success) {
        const missingTarget = parsed.error.issues.some(i => i.path[0] === 'target');
        if (missingTarget) throw new ApiError(400, 'bad_target', MSG.badTarget);
        throw parsed.error;
      }
      const res = await createCheck(deps, parsed.data, subjectOf(request), request.log);
      return reply.code(res.statusCode).send(res.body);
    },
  );

  app.get('/v1/checks/:id', async request => {
    const { id } = IdParamsZ.parse(request.params);
    if (!SHORT_ID_RE.test(id)) throw new ApiError(404, 'not_found', MSG.notFound);
    const report = await loadReport(deps, { shortId: id }, viewerOf(request));
    if (!report) throw new ApiError(404, 'not_found', MSG.notFound);
    return report;
  });

  // M3: Pro follow-ups, holder notes, signed-in watchlists
  app.post('/v1/checks/:id/asks', async () => {
    throw new ApiError(403, 'pro_required', proRequiredMessage(deps.env));
  });
  app.post('/v1/checks/:id/notes', async () => {
    throw new ApiError(403, 'holders_only', MSG.holdersOnly);
  });
  app.post('/v1/notes/:id/helpful', async () => {
    throw new ApiError(403, 'holders_only', MSG.holdersOnly);
  });
  app.post('/v1/watch/:targetId', async () => {
    throw new ApiError(401, 'sign_in_required', MSG.signInRequired);
  });
}
