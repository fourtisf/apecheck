/**
 * GET /v1/checks/:id/events — live log of one check over SSE (HANDOFF §6).
 *
 * Order matters to avoid losing steps: subscribe to check:{id} first, then read status and
 * stored steps from the DB, then forward live messages (skipping idx already sent). A check
 * that finished before we looked gets its steps and `done` straight away.
 */
import type { FastifyInstance } from 'fastify';
import {
  STEPS_EXPECTED,
  checkChannel,
  clamp,
  displayStep,
  kindFromDb,
  statusFromDb,
  type CheckChannelMsg,
  type CheckStatusS,
  type StepDTO,
} from '@apecheck/core';
import type { AppDeps } from '../context';
import { canView, loadReport, readProgress } from '../checks';
import { ApiError, MSG } from '../errors';
import { SHORT_ID_RE } from '../ids';
import { evidenceOf, shotUrl, toStep, type Viewer } from '../mappers';
import { sidSetCookieHeader } from '../plugins/session';
import { openSse, type SseRegistry, type SseStream } from '../sse';
import { viewerOf } from './util';

/** A queued check can wait a while; past this the client's EventSource simply reconnects. */
const extraLifetimeMs = 10 * 60_000;

function parseMsg(raw: string): CheckChannelMsg | null {
  let m: unknown;
  try {
    m = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!m || typeof m !== 'object') return null;
  const msg = m as Record<string, unknown>;
  if (msg.type === 'step') {
    const step = msg.step as Record<string, unknown> | undefined;
    if (!step || typeof step.idx !== 'number' || typeof step.text !== 'string') return null;
    return msg as unknown as CheckChannelMsg;
  }
  if (msg.type === 'status' && typeof msg.status === 'string') return msg as unknown as CheckChannelMsg;
  if (msg.type === 'done') return msg as unknown as CheckChannelMsg;
  return null;
}

const STEP_STATUSES = new Set<string>(['info', 'ok', 'warn', 'fail']);
const CHECK_STATUSES = new Set<string>(['queued', 'running', 'done', 'failed']);

const num01 = (v: unknown, fallback: number) => (typeof v === 'number' && Number.isFinite(v) ? clamp(v, 0, 1) : fallback);

export function registerEventRoutes(app: FastifyInstance, deps: AppDeps, registry: SseRegistry) {
  // no HEAD twin: a HEAD request would hold a body-less stream open
  app.get('/v1/checks/:id/events', { exposeHeadRoute: false }, async (request, reply) => {
    const { id: shortId } = (request.params ?? {}) as { id?: string };
    if (!shortId || !SHORT_ID_RE.test(shortId)) throw new ApiError(404, 'not_found', MSG.notFound);
    const viewer = viewerOf(request);
    const head = await deps.prisma.check.findUnique({
      where: { shortId },
      select: { id: true, isPrivate: true, requesterSid: true, requesterId: true },
    });
    if (!head || !canView(head, viewer)) throw new ApiError(404, 'not_found', MSG.notFound);

    const cookie = sidSetCookieHeader(app, request, deps.env);
    const stream = openSse(request, reply, registry, cookie ? { 'Set-Cookie': cookie } : {});
    const lifetime = setTimeout(() => stream.end(), deps.env.CHECK_BUDGET_SECONDS * 1000 + extraLifetimeMs);
    lifetime.unref?.();
    stream.onClose(() => clearTimeout(lifetime));

    pump(deps, stream, head.id, viewer).catch(err => {
      request.log.error({ err, checkId: head.id }, 'sse stream failed');
      stream.end();
    });
    return reply;
  });
}

async function pump(deps: AppDeps, stream: SseStream, checkId: string, viewer: Viewer) {
  const buffered: CheckChannelMsg[] = [];
  let live = false;
  let finishing = false;
  let lastIdx = -1;

  const sendDone = async () => {
    if (finishing) return;
    finishing = true;
    const report = await loadReport(deps, { id: checkId }, viewer);
    if (report) stream.send('done', report);
    stream.end();
  };

  const handle = (msg: CheckChannelMsg) => {
    if (finishing || stream.closed) return;
    if (msg.type === 'step') {
      if (msg.step.idx <= lastIdx) return;
      lastIdx = msg.step.idx;
      // forward only the StepDTO fields, whatever else a publisher put on the message; a step in the words of an
      // older worker (a retired third-party source tag) reads like a stored one (toStep)
      const s = displayStep(msg.step);
      const step: StepDTO = {
        idx: s.idx,
        t: typeof s.t === 'number' ? s.t : 0,
        status: STEP_STATUSES.has(s.status) ? s.status : 'info',
        text: s.text,
        source: s.source ?? null,
        url: s.url ?? null,
        caption: s.caption ?? null,
        screenshot: shotUrl(s.screenshot, deps.env.SCREENSHOT_DIR),
      };
      stream.send('step', { ...step, progress: num01(msg.progress, 0) });
    } else if (msg.type === 'status') {
      if (!CHECK_STATUSES.has(msg.status)) return;
      stream.send('status', { status: msg.status, progress: num01(msg.progress, 0) });
    } else if (msg.type === 'done') {
      void sendDone().catch(() => stream.end());
    }
  };

  const unsubscribe = await deps.hub.subscribe(checkChannel(checkId), raw => {
    const msg = parseMsg(raw);
    if (!msg) return;
    if (live) handle(msg);
    else buffered.push(msg);
  });
  stream.onClose(() => void unsubscribe());
  if (stream.closed) return;

  const row = await deps.prisma.check.findUnique({
    where: { id: checkId },
    select: { status: true, evidence: true, target: { select: { kind: true } }, steps: { orderBy: { idx: 'asc' } } },
  });
  if (!row) return stream.end();

  const status: CheckStatusS = statusFromDb(row.status);
  const finished = status === 'done' || status === 'failed';
  let progress = finished ? 1 : 0;
  if (status === 'running') {
    const ev = evidenceOf(row.evidence);
    const expected = Math.max(ev.stepsExpected ?? STEPS_EXPECTED[kindFromDb(row.target.kind)], row.steps.length);
    const p = (await readProgress(deps, [checkId])).get(checkId);
    progress = p != null ? clamp(p, 0, 1) : clamp(row.steps.length / expected, 0, 0.99);
  }

  for (const s of row.steps) {
    stream.send('step', { ...toStep(s, deps.env), progress });
    lastIdx = Math.max(lastIdx, s.idx);
  }
  if (finished) return sendDone();

  stream.send('status', { status, progress });
  live = true;
  for (const msg of buffered.splice(0)) handle(msg);
}
