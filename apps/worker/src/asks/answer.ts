/**
 * One follow-up answer (HANDOFF §7 bot follow-ups, §9 POST /v1/checks/:id/asks): a question about one finished
 * check, answered from that check's stored data only (loadAnswerData), never the live page.
 *
 * The model (AI_MODEL_JUDGE through the AiAdapter, or the heuristic stand-in without ANTHROPIC_API_KEY) gets at most
 * ANSWER_MODEL_TIMEOUT_MS; a model that fails or runs over is replaced by the stand-in's answer, so a question always
 * gets one. The answer is built from untrusted page, docs and post text (HANDOFF §11), so it is made safe before it
 * is stored or posted: no @mention (the "@" is dropped), no link (scheme URLs dropped, other domains defanged to
 * "orbit[.]xyz"), one line, at most ANSWER_MAX characters cut at a sentence (core normaliseAnswer), nothing
 * Postgres refuses.
 */
import { normaliseAnswer } from '@apecheck/core';
import type { PrismaClient } from '@apecheck/db';
import { loadAnswerData } from '../ai/answer-data';
import { heuristicAnswer } from '../ai/heuristic';
import type { AiAdapter, AnswerData } from '../ai/types';
import { NO_ANSWER_TEXT, sanitizeModelText } from '../bot/compose';
import { hasLink } from '../bot/xtext';
import { errText, type Logger } from '../log';
import { pgText } from '../pipeline/pgsafe';

/** longest stored answer (the site shows it whole; the bot cuts it to fit its reply) */
export const ANSWER_MAX = 600;
/** longest question kept (the API caps what it accepts; this is the worker's own bound) */
export const QUESTION_MAX = 1000;
/** the model's share of the API's 45 s wait */
export const ANSWER_MODEL_TIMEOUT_MS = 30_000;

export interface AnswerDeps {
  prisma: PrismaClient;
  ai: AiAdapter;
  log: Logger;
}

/** A question as stored: one line, nothing Postgres refuses, at most QUESTION_MAX characters. */
export function cleanQuestion(q: string): string {
  return pgText(String(q ?? ''))
    .replace(/[\u0000-\u001f\u007f]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, QUESTION_MAX)
    .trim();
}

/**
 * Model-written text made safe to store and show: sanitizeModelText (no mentions, no links), clamped. A text in which
 * anything could still be a link falls back to the stand-in's answer, then to NO_ANSWER_TEXT.
 */
export function safeAnswer(raw: string, question: string, data: AnswerData, max = ANSWER_MAX): string {
  const clean = (s: string) => {
    const t = sanitizeModelText(pgText(String(s ?? '')));
    return t && !hasLink(t) ? normaliseAnswer({ answer: t }, max) : '';
  };
  return clean(raw) || clean(heuristicAnswer(question, data)) || NO_ANSWER_TEXT;
}

/**
 * The answer to `question` from the stored data of check `checkId` (internal id), or null when the check has no
 * report (not found, not finished).
 */
export async function answerFromCheck(
  deps: AnswerDeps,
  checkId: string,
  question: string,
  opts: { max?: number; timeoutMs?: number } = {},
): Promise<{ answer: string; data: AnswerData } | null> {
  const data = await loadAnswerData(deps.prisma, checkId);
  if (!data) return null;
  let raw: string;
  try {
    raw = await deps.ai.answer(question, data, {
      signal: AbortSignal.timeout(opts.timeoutMs ?? ANSWER_MODEL_TIMEOUT_MS),
      onFallback: (_stage, reason) => deps.log.warn(`answer: the model could not answer (${reason}); used the simple rules`),
    });
  } catch (e) {
    deps.log.warn(`answer: the model did not answer in time (${errText(e)}); used the simple rules`);
    raw = heuristicAnswer(question, data);
  }
  return { answer: safeAnswer(raw, question, data, opts.max ?? ANSWER_MAX), data };
}
