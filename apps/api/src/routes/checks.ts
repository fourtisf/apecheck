/** POST /v1/checks, GET /v1/checks/:id */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { creditSubject, viewerTier } from '../accounts';
import type { AppDeps } from '../context';
import { createCheck, loadReport } from '../checks';
import { ApiError, MSG } from '../errors';
import { SHORT_ID_RE } from '../ids';
import { userBurst } from '../limits';
import { isProViewer } from '../mappers';
import { viaKey } from '../plugins/apiKeys';
import { RATE } from '../plugins/rateLimit';
import { viewerOf } from './util';

const CreateBodyZ = z.object({
  target: z.string().max(2048),
  recheck: z.boolean().optional(),
  private: z.boolean().optional(),
});

const IdParamsZ = z.object({ id: z.string().max(64) });

export function registerCheckRoutes(app: FastifyInstance, deps: AppDeps) {
  /**
   * Credits by tier: anonymous visitors per cookie + IP (FREE_CHECKS_PER_DAY); signed-in users per user with their
   * tier's limit (a Free user keeps counting per cookie + IP as well). Job priority by tier. `private: true` is Max only.
   * With an API key (M4) the owner also has RATE.createCheckPerMin a minute across all their keys and IPs, a bucket
   * shared with the MCP tool run_check (USER_RATE.apiChecks).
   */
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
      const keyed = viaKey(request);
      if (keyed && request.viewer.user) await userBurst(deps.redis, 'apiChecks', request.viewer.user.id, MSG.apiChecksRateLimited);
      const tier = await viewerTier(deps, request);
      const via = keyed ? 'API' : 'WEB';
      const res = await createCheck(deps, { ...parsed.data, via }, creditSubject(request, tier?.tier ?? 'free'), request.log);
      return reply.code(res.statusCode).send(res.body);
    },
  );

  /**
   * Private checks only for the user (or browser) that asked for them; everyone else gets the same 404 as a missing id.
   * Pro/Max viewers (M4) also get the deep holder clusters, so their copy is never cached either.
   */
  app.get('/v1/checks/:id', async (request, reply) => {
    const { id } = IdParamsZ.parse(request.params);
    if (!SHORT_ID_RE.test(id)) throw new ApiError(404, 'not_found', MSG.notFound);
    if (request.viewer.user && !viaKey(request)) await viewerTier(deps, request);
    const viewer = viewerOf(request);
    const report = await loadReport(deps, { shortId: id }, viewer);
    if (!report) throw new ApiError(404, 'not_found', MSG.notFound);
    if (report.isPrivate || isProViewer(viewer)) reply.header('Cache-Control', 'private, no-store');
    return report;
  });
}
