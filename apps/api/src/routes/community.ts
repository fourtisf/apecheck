/**
 * Follow-ups and community notes (M3).
 *
 *   POST /v1/checks/:id/asks   AskBody  → AskDTO   Pro/Max (403 pro_required), ASKS_PER_HOUR per user (429),
 *                                                  waits up to 45 s for the worker (504 ask_timeout)
 * Gates run in this order: tier (403) → body (400) → the check (404, 409 not_ready while it runs) → limits (429).
 *   POST /v1/checks/:id/notes  NoteBody → NoteDTO  holders (403 holders_only), 10–500 characters, NOTES_PER_DAY
 *   POST /v1/notes/:id/helpful         → HelpfulResponse  holders; toggles the viewer's vote; not on your own note
 */
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { AskDTO, HelpfulResponse, NoteDTO } from '@apecheck/core';
import { Prisma } from '@apecheck/db';
import { viewerTier } from '../accounts';
import { askFollowUp } from '../asks';
import { canView } from '../checks';
import type { AppDeps } from '../context';
import { ApiError, MSG, holdersOnlySignedIn, notesPerDayMessage, proRequiredMessage } from '../errors';
import { SHORT_ID_RE } from '../ids';
import { dailyKey, dailyLimit, userBurst, type LimitHit } from '../limits';
import { toAsk, toNote } from '../mappers';
import { viewerOf } from './util';

/** per-IP route limits (per minute) */
export const COMMUNITY_RATE = { asks: 20, notes: 10, helpful: 60 } as const;
const rate = (max: number) => ({ config: { rateLimit: { max, timeWindow: '1 minute' } } });

const QUESTION_MIN = 3;
const QUESTION_MAX = 280;
export const NOTE_MIN = 10;
export const NOTE_MAX = 500;
/** the same note posted twice within this window returns the first one */
const NOTE_DEDUPE_MS = 60_000;
/** the advisory lock (pg_advisory_xact_lock(hashtext(key))) that serializes one author's notes on one check */
export const noteLockKey = (userId: string, checkId: string) => `note:${userId}:${checkId}`;

const RE_CUID = /^[a-z0-9]{20,32}$/i;
const IdParamsZ = z.object({ id: z.string().max(64) });

/** strip control characters (keeping line breaks), trim, at most one blank line in a row */
export function cleanNoteText(t: string): string {
  return t
    .normalize('NFC')
    .replace(/\r\n?/g, '\n')
    .replace(/[\u0000-\u0009\u000b-\u001f\u007f​-‏‪-‮⁦-⁩]/g, '')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
const cleanQuestion = (q: string) => q.normalize('NFC').replace(/[\u0000-\u001f\u007f​-‏‪-‮⁦-⁩]/g, ' ').replace(/\s+/g, ' ').trim();

/** The check by short id as far as the viewer may see it (404 otherwise). */
async function viewableCheck(deps: AppDeps, request: FastifyRequest) {
  const { id } = IdParamsZ.parse(request.params);
  if (!SHORT_ID_RE.test(id)) throw new ApiError(404, 'not_found', MSG.notFound);
  const check = await deps.prisma.check.findUnique({
    where: { shortId: id },
    select: { id: true, status: true, isPrivate: true, requesterSid: true, requesterId: true },
  });
  if (!check || !canView(check, viewerOf(request))) throw new ApiError(404, 'not_found', MSG.notFound);
  return check;
}

export function registerCommunityRoutes(app: FastifyInstance, deps: AppDeps) {
  const { env, prisma, redis } = deps;

  app.post('/v1/checks/:id/asks', rate(COMMUNITY_RATE.asks), async (request, reply): Promise<AskDTO> => {
    const raw = (request.body as { question?: unknown } | null)?.question;
    const question = typeof raw === 'string' ? cleanQuestion(raw) : '';
    const user = request.viewer.user;
    const tier = user ? await viewerTier(deps, request) : null;
    if (!user || !tier || tier.tier === 'free') throw new ApiError(403, 'pro_required', proRequiredMessage(env));
    if (question.length < QUESTION_MIN || question.length > QUESTION_MAX) throw new ApiError(400, 'bad_request', MSG.askLength);
    const check = await viewableCheck(deps, request);
    if (check.status !== 'DONE') throw new ApiError(409, 'not_ready', MSG.askNotReady);
    await userBurst(redis, 'asks', user.id);

    const { askId, created } = await askFollowUp(deps, {
      checkId: check.id,
      question,
      userId: user.id,
      askerHandle: request.viewer.user?.xHandle ?? null,
    });
    const ask = await prisma.ask.findUnique({ where: { id: askId }, include: { asker: { select: { evmAddress: true, solAddress: true } } } });
    if (!ask || ask.checkId !== check.id) throw new ApiError(502, 'ask_failed', MSG.askFailed);
    return reply.code(created ? 201 : 200).send(toAsk(ask));
  });

  app.post('/v1/checks/:id/notes', rate(COMMUNITY_RATE.notes), async (request, reply): Promise<NoteDTO> => {
    const raw = (request.body as { text?: unknown } | null)?.text;
    const text = typeof raw === 'string' ? cleanNoteText(raw) : '';
    const user = request.viewer.user;
    if (!user) throw new ApiError(403, 'holders_only', MSG.holdersOnly);
    const tier = await viewerTier(deps, request);
    if (!tier?.holder) throw new ApiError(403, 'holders_only', holdersOnlySignedIn(env));
    if (text.length < NOTE_MIN || text.length > NOTE_MAX) throw new ApiError(400, 'bad_request', MSG.noteLength);
    const check = await viewableCheck(deps, request);
    if (check.status !== 'DONE') throw new ApiError(409, 'not_ready', MSG.noteNotReady);
    await userBurst(redis, 'notes', user.id);

    const author = { select: { xHandle: true, evmAddress: true, solAddress: true, holding: true } } as const;
    // A double submit (a double tap, a retried fetch) returns the note it already made. The duplicate check, the
    // day's note credit and the insert are one critical section per author and check: a transaction-scoped advisory
    // lock makes a concurrent copy wait for the first to commit, so its read (READ COMMITTED) then sees that note.
    const spent: { hit?: LimitHit } = {};
    let result;
    try {
      result = await prisma.$transaction(async tx => {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${noteLockKey(user.id, check.id)}))`;
        const dupe = await tx.note.findFirst({
          where: { checkId: check.id, authorId: user.id, text, createdAt: { gte: new Date(Date.now() - NOTE_DEDUPE_MS) } },
          include: { author },
        });
        if (dupe) return { note: dupe, created: false };
        // spent only by the request that writes the note
        const hit = (spent.hit = await dailyLimit(redis, dailyKey('notes', user.id), env.NOTES_PER_DAY));
        if (!hit.ok) throw new ApiError(429, 'rate_limited', notesPerDayMessage(env.NOTES_PER_DAY));
        return { note: await tx.note.create({ data: { checkId: check.id, authorId: user.id, text }, include: { author } }), created: true };
      });
    } catch (err) {
      // no note was written (refused, or the insert / commit failed): give the day's credit back
      if (spent.hit?.ok) await spent.hit.release();
      throw err;
    }
    return reply.code(result.created ? 201 : 200).send(toNote(result.note, env, false));
  });

  app.post('/v1/notes/:id/helpful', rate(COMMUNITY_RATE.helpful), async (request): Promise<HelpfulResponse> => {
    const { id } = IdParamsZ.parse(request.params);
    const user = request.viewer.user;
    if (!user) throw new ApiError(403, 'holders_only', MSG.holdersOnly);
    const tier = await viewerTier(deps, request);
    if (!tier?.holder) throw new ApiError(403, 'holders_only', holdersOnlySignedIn(env));
    const note = RE_CUID.test(id)
      ? await prisma.note.findUnique({
          where: { id },
          select: { id: true, authorId: true, hidden: true, check: { select: { isPrivate: true, requesterSid: true, requesterId: true } } },
        })
      : null;
    if (!note || note.hidden || !canView(note.check, viewerOf(request))) throw new ApiError(404, 'not_found', MSG.noteNotFound);
    if (note.authorId === user.id) throw new ApiError(403, 'own_note', MSG.ownNote);
    await userBurst(redis, 'helpful', user.id);

    try {
      return await prisma.$transaction(async tx => {
        const removed = await tx.noteVote.deleteMany({ where: { noteId: note.id, userId: user.id } });
        if (removed.count) {
          const n = await tx.note.update({ where: { id: note.id }, data: { helpful: { decrement: removed.count } }, select: { helpful: true } });
          return { helpful: Math.max(0, n.helpful), mine: false };
        }
        await tx.noteVote.create({ data: { noteId: note.id, userId: user.id } });
        const n = await tx.note.update({ where: { id: note.id }, data: { helpful: { increment: 1 } }, select: { helpful: true } });
        return { helpful: n.helpful, mine: true };
      });
    } catch (err) {
      // two clicks at once: the other request added the vote; report the state as it is
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        const n = await prisma.note.findUniqueOrThrow({ where: { id: note.id }, select: { helpful: true } });
        return { helpful: n.helpful, mine: true };
      }
      throw err;
    }
  });
}
