/**
 * The AI probes: one real call per model on the exact code path the worker uses (AnthropicAi: messages.parse with a
 * zod output format, effort low), never through createAi / ResilientAi, which turn every API error into a silent
 * heuristic fallback (and the worker still logs "AI: anthropic"). The fast model extracts claims from one sentence,
 * the judge model answers one question: together well under one US cent.
 */
import Anthropic from '@anthropic-ai/sdk';
import type { Env } from '@apecheck/core';
import { AiOutputError, AnthropicAi, KEY_UNUSABLE_TEXT, describeAiError, keyUnusable } from '../ai/anthropic';
import type { AnswerData, ClaimsInput } from '../ai/types';
import { hostOf } from './redact';
import { fail, outcome, type ProbeOutcome } from './result';

/** per-request timeout of the doctor's calls (the worker allows 45 s, with one retry) */
export const AI_REQUEST_TIMEOUT_MS = 30_000;
export const AI_KEY_REMEDY = 'set ANTHROPIC_API_KEY (platform.claude.com > API keys; pay-as-you-go, add prepaid credit first)';

export type AiRole = 'judge' | 'fast';
type AiPart = Pick<AnthropicAi, 'extractClaims' | 'answer'>;

/** What worker-checks logs at startup ("AI: anthropic" / "AI: heuristic") and what that means. */
export function aiModeText(env: Env): string {
  return env.ANTHROPIC_API_KEY
    ? `claude (judge ${env.AI_MODEL_JUDGE}, fast ${env.AI_MODEL_FAST}; worker-checks logs "AI: anthropic" even when the key is refused: see the AI rows)`
    : 'heuristic (ANTHROPIC_API_KEY empty; worker-checks logs "AI: heuristic": claims, judging and answers use the rule-based stand-in)';
}

/** The worker's adapter with a client configured as the worker's (base URL, key), but without retries. */
export function doctorAi(env: Env): AnthropicAi {
  const client = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY, baseURL: env.AI_BASE_URL ?? 'https://api.anthropic.com', maxRetries: 0 });
  return new AnthropicAi(env, { client, timeoutMs: AI_REQUEST_TIMEOUT_MS });
}

const CLAIMS_PROBE: ClaimsInput = {
  name: 'ApeCheck doctor',
  siteUrl: null,
  hero: 'Live on Base mainnet. Audited by CertiK.',
  footer: '',
  docs: '',
  post: '',
  bio: '',
};

const ANSWER_PROBE: AnswerData = {
  name: 'ApeCheck doctor',
  kind: 'site',
  narScore: null,
  narBand: null,
  coinScore: null,
  coinBand: null,
  summary: 'The site loads.',
  coinSummary: null,
  signals: {},
  evidence: {},
  claims: [],
  coin: null,
};

/**
 * describeAiError plus the API's own message (e.g. "model: … not found", "credit balance is too low"). Any other error
 * keeps its whole message: describeAiError cuts at 120 characters, which could cut a secret before the Redactor saw it.
 */
export function aiErrorText(e: unknown): string {
  if (!(e instanceof Anthropic.APIError)) return e instanceof Error && !(e instanceof AiOutputError) ? e.message : describeAiError(e);
  const base = describeAiError(e);
  const body = e.error as { error?: { message?: unknown } } | undefined;
  const msg = typeof body?.error?.message === 'string' ? body.error.message.slice(0, 160) : '';
  return msg ? `${base}: ${msg}` : base;
}

/** The one line that fixes it, by the API's answer. */
export function aiRemedy(e: unknown, modelVar: 'AI_MODEL_JUDGE' | 'AI_MODEL_FAST', model: string): string {
  const status = (e as { status?: unknown } | null)?.status;
  if (e instanceof Anthropic.APIConnectionError) return 'the VPS cannot reach the Anthropic API: allow outbound HTTPS to api.anthropic.com:443 (the SDK does not use OUTBOUND_PROXY)';
  if (status === 401) return `ANTHROPIC_API_KEY is rejected: create a new key at platform.claude.com > API keys`;
  if (status === 403) return `the key's workspace may not use ${model}: check the workspace's model access in the Console`;
  if (status === 404) return `${modelVar}=${model} is not a model id this key can use: leave ${modelVar} empty for the default`;
  if (status === 400 && /credit/i.test(aiErrorText(e))) return 'no credit: add prepaid credit at platform.claude.com > Billing';
  if (status === 429) return 'rate limited: check the rate limits of the key\'s tier in the Console';
  if (typeof status === 'number' && status >= 500) return 'the API had an error: run the doctor again in a minute';
  return AI_KEY_REMEDY;
}

/**
 * One model, one call on its pipeline path: the fast model extracts claims (Stage C), the judge model answers a
 * follow-up (the judge and the browser agent use the same model). A refusal or unusable output still proves the key
 * and the model id, so it is a WARN; any API error is a FAIL with its fix.
 */
export async function probeAi(role: AiRole, deps: { env: Env; ai?: AiPart; now?: () => number }): Promise<ProbeOutcome> {
  const { env } = deps;
  const now = deps.now ?? Date.now;
  const modelVar = role === 'judge' ? 'AI_MODEL_JUDGE' : 'AI_MODEL_FAST';
  const model = role === 'judge' ? env.AI_MODEL_JUDGE : env.AI_MODEL_FAST;
  const host = hostOf(env.AI_BASE_URL ?? 'https://api.anthropic.com');
  if (!env.ANTHROPIC_API_KEY) {
    return outcome(
      { ok: null, configured: false, importance: 'recommended' },
      'not called: ANTHROPIC_API_KEY empty, so checks run "AI: heuristic" (rule-based claims, verdict summary and follow-up answers)',
      AI_KEY_REMEDY,
    );
  }
  if (keyUnusable(env.ANTHROPIC_API_KEY)) return fail(`not called: ${KEY_UNUSABLE_TEXT}`, AI_KEY_REMEDY);
  const ai = deps.ai ?? doctorAi(env);
  const started = now();
  try {
    const what =
      role === 'fast'
        ? `extracted ${(await ai.extractClaims(CLAIMS_PROBE)).length} claim(s)`
        : `answered (${(await ai.answer('Is the app live?', ANSWER_PROBE)).length} chars)`;
    return outcome({ ok: true, configured: true, importance: 'recommended' }, `${host}: ${model} ${what} via structured output in ${now() - started} ms`);
  } catch (e) {
    if (e instanceof AiOutputError || (e instanceof Error && e.name === 'ZodError')) {
      return outcome(
        { ok: true, configured: true, importance: 'recommended', degraded: true },
        `${host}: ${model} answered, but the output was unusable (${describeAiError(e)}): the key and the model work`,
        'a refusal or odd output on the probe text is rare: run the doctor again; if it repeats, that stage falls back to the heuristic in checks',
      );
    }
    return fail(`${host}: ${model}: ${aiErrorText(e)}`, aiRemedy(e, modelVar, model));
  }
}
