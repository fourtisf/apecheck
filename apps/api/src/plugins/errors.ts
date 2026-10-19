/** Every error leaves the API as ApiErrorBody {error, code}. */
import type { FastifyError, FastifyInstance } from 'fastify';
import { ZodError } from 'zod';
import { ApiError, MSG } from '../errors';

const FASTIFY_CODES: Record<string, { status: number; code: string; error: string }> = {
  FST_ERR_CTP_BODY_TOO_LARGE: { status: 413, code: 'payload_too_large', error: 'Request body is too large.' },
  FST_ERR_CTP_INVALID_MEDIA_TYPE: { status: 415, code: 'unsupported_media_type', error: 'Send JSON (Content-Type: application/json).' },
  FST_ERR_CTP_EMPTY_JSON_BODY: { status: 400, code: 'bad_request', error: 'Request body is empty.' },
  FST_ERR_CTP_INVALID_JSON_BODY: { status: 400, code: 'bad_request', error: 'Request body is not valid JSON.' },
};

export function registerErrorHandler(app: FastifyInstance) {
  app.setErrorHandler((err: FastifyError | ApiError | ZodError | Error, request, reply) => {
    if (err instanceof ApiError) return reply.code(err.statusCode).send(err.body());

    if (err instanceof ZodError) {
      const issue = err.issues[0];
      const where = issue?.path?.length ? `${issue.path.join('.')}: ` : '';
      return reply.code(400).send({ code: 'bad_request', error: `${where}${issue?.message ?? 'Invalid request'}` });
    }

    const fe = err as FastifyError;
    if (fe.code && FASTIFY_CODES[fe.code]) {
      const m = FASTIFY_CODES[fe.code];
      return reply.code(m.status).send({ code: m.code, error: m.error });
    }
    // JSON.parse failures surface as a 400 SyntaxError from the content-type parser
    if (fe.statusCode === 400 && err instanceof SyntaxError) {
      return reply.code(400).send({ code: 'bad_request', error: 'Request body is not valid JSON.' });
    }
    if (fe.validation) return reply.code(400).send({ code: 'bad_request', error: fe.message });
    if (fe.statusCode === 429) return reply.code(429).send({ code: 'rate_limited', error: MSG.rateLimited });
    if (fe.statusCode === 403 && /forbidden/i.test(fe.message)) return reply.code(403).send({ code: 'forbidden', error: 'Forbidden' });

    if (fe.statusCode && fe.statusCode >= 400 && fe.statusCode < 500) {
      return reply.code(fe.statusCode).send({ code: 'bad_request', error: fe.message || 'Bad request' });
    }

    request.log.error({ err }, 'unhandled error');
    return reply.code(500).send({ code: 'internal', error: MSG.internal });
  });
}

/** Call after the rate-limit plugin is registered. */
export function registerNotFound(app: FastifyInstance) {
  app.setNotFoundHandler(
    // unknown URLs are rate limited too, so they can't be used to probe for free
    { preHandler: app.rateLimit ? app.rateLimit() : undefined },
    (_request, reply) => reply.code(404).send({ code: 'not_found', error: MSG.routeNotFound }),
  );
}
