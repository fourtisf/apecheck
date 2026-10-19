/**
 * Claude API adapter. Structured output for claims / judge / answers (messages.parse + zodOutputFormat,
 * then the core normalise* helpers); a manual tool loop for the browser agent with the four browser
 * actions only. Every model output is validated before it is used. Errors bubble up as exceptions and
 * the ResilientAi wrapper (./index.ts) falls back to the heuristic for that stage.
 */
import Anthropic from '@anthropic-ai/sdk';
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';
import {
  AnswerOutZ,
  ClaimsOutZ,
  ClickInputZ,
  DoneInputZ,
  JudgeOutZ,
  OpenLinkInputZ,
  ScrollInputZ,
  normaliseAnswer,
  normaliseClaims,
  normaliseJudge,
  type Env,
  type ExtractedClaim,
  type Judged,
} from '@apecheck/core';
import type { z } from 'zod';
import {
  ANSWER_SYSTEM,
  CLAIMS_SYSTEM,
  EXPLORE_SYSTEM,
  JUDGE_SYSTEM,
  answerUserText,
  claimsUserText,
  exploreTurnText,
  judgeUserText,
} from './prompts';
import type { AiAdapter, AiCallCtx, AnswerData, BrowserAction, ClaimsInput, ExploreObservation, ExploreState, JudgeInput } from './types';

/** The two SDK calls the adapter uses; tests inject a fake with the same shape. */
export interface AnthropicClientLike {
  messages: {
    create(params: Anthropic.MessageCreateParamsNonStreaming, options?: { signal?: AbortSignal; timeout?: number }): Promise<Anthropic.Message>;
    parse(
      params: Anthropic.MessageCreateParamsNonStreaming,
      options?: { signal?: AbortSignal; timeout?: number },
    ): Promise<Anthropic.Message & { parsed_output?: unknown }>;
  };
}

/** The model stopped without a usable answer (refusal, max_tokens, no tool call, invalid output). */
export class AiOutputError extends Error {
  constructor(public readonly reason: string) {
    super(reason);
    this.name = 'AiOutputError';
  }
}

export function describeAiError(e: unknown): string {
  if (e instanceof Anthropic.RateLimitError) return 'rate limited';
  if (e instanceof Anthropic.APIConnectionTimeoutError) return 'request timed out';
  if (e instanceof Anthropic.APIUserAbortError) return 'aborted';
  if (e instanceof Anthropic.APIConnectionError) return 'could not reach the API';
  if (e instanceof Anthropic.APIError) return `API error ${e.status ?? ''}`.trim();
  if (e instanceof AiOutputError) return e.reason;
  if (e instanceof Error && e.name === 'ZodError') return 'model output failed validation';
  return e instanceof Error ? e.message.slice(0, 120) : 'unknown error';
}

const IMAGE = (data: Buffer): Anthropic.ImageBlockParam => ({
  type: 'image',
  source: { type: 'base64', media_type: 'image/jpeg', data: data.toString('base64') },
});

export const BROWSER_TOOLS: Anthropic.Tool[] = [
  {
    name: 'click',
    description: 'Click a visible button or link, by its visible text exactly as listed (or its number, like "#4").',
    strict: true,
    input_schema: { type: 'object', properties: { text: { type: 'string', description: 'Visible text of the button or link' } }, required: ['text'], additionalProperties: false },
  },
  {
    name: 'scroll',
    description: 'Scroll the page to reveal more content.',
    strict: true,
    input_schema: { type: 'object', properties: { direction: { type: 'string', enum: ['down', 'up'] } }, required: [], additionalProperties: false },
  },
  {
    name: 'open_link',
    description: 'Open a URL that appears in the list of links on the current page.',
    strict: true,
    input_schema: { type: 'object', properties: { url: { type: 'string', description: 'A URL from the list' } }, required: ['url'], additionalProperties: false },
  },
  {
    name: 'done',
    description: 'Stop exploring, with a short reason (main flow reached and tried, blocked, or nothing left to try).',
    strict: true,
    input_schema: { type: 'object', properties: { reason: { type: 'string' } }, required: ['reason'], additionalProperties: false },
  },
];

/** Validate one tool_use block with the core zod schemas. */
export function toBrowserAction(name: string, input: unknown): BrowserAction {
  switch (name) {
    case 'click':
      return { tool: 'click', text: ClickInputZ.parse(input).text };
    case 'scroll':
      return { tool: 'scroll', direction: ScrollInputZ.parse(input ?? {}).direction ?? 'down' };
    case 'open_link':
      return { tool: 'open_link', url: OpenLinkInputZ.parse(input).url };
    case 'done':
      return { tool: 'done', reason: DoneInputZ.parse(input).reason };
    default:
      throw new AiOutputError(`unknown tool ${name.slice(0, 40)}`);
  }
}

interface ExploreMemory {
  messages: Anthropic.MessageParam[];
  pending: string[];
}

/** Only the newest screenshots stay in the conversation; older ones become a short note. */
export function pruneImages(messages: Anthropic.MessageParam[], keep = 2) {
  let seen = 0;
  const visit = (arr: unknown[]) => {
    for (let i = arr.length - 1; i >= 0; i--) {
      const b = arr[i] as { type: string; content?: unknown };
      if (b.type === 'tool_result' && Array.isArray(b.content)) visit(b.content);
      else if (b.type === 'image' && ++seen > keep) arr[i] = { type: 'text', text: '[earlier screenshot omitted]' };
    }
  };
  for (let m = messages.length - 1; m >= 0; m--) {
    const c = messages[m].content;
    if (Array.isArray(c)) visit(c);
  }
}

export interface AnthropicAiOptions {
  client?: AnthropicClientLike;
  /** per-request timeout, ms */
  timeoutMs?: number;
}

export class AnthropicAi implements AiAdapter {
  readonly mode = 'anthropic' as const;
  readonly judgeModel: string;
  readonly fastModel: string;
  private readonly client: AnthropicClientLike;
  private readonly timeoutMs: number;
  private readonly formats: {
    claims: ReturnType<typeof zodOutputFormat<typeof ClaimsOutZ>> | null;
    judge: ReturnType<typeof zodOutputFormat<typeof JudgeOutZ>> | null;
    answer: ReturnType<typeof zodOutputFormat<typeof AnswerOutZ>> | null;
  };

  constructor(env: Env, opts: AnthropicAiOptions = {}) {
    this.judgeModel = env.AI_MODEL_JUDGE;
    this.fastModel = env.AI_MODEL_FAST;
    this.timeoutMs = opts.timeoutMs ?? 45_000;
    this.client =
      opts.client ??
      (new Anthropic({
        apiKey: env.ANTHROPIC_API_KEY,
        // always explicit: the environment may set ANTHROPIC_BASE_URL for something else
        baseURL: env.AI_BASE_URL ?? 'https://api.anthropic.com',
        maxRetries: 1,
      }) satisfies AnthropicClientLike);
    const fmt = <S extends z.ZodType>(s: S) => {
      try {
        return zodOutputFormat(s);
      } catch {
        return null;
      }
    };
    this.formats = { claims: fmt(ClaimsOutZ), judge: fmt(JudgeOutZ), answer: fmt(AnswerOutZ) };
  }

  /* ---------- structured output with a JSON-prompt fallback ---------- */

  private async structured<S extends z.ZodType>(
    schema: S,
    format: ReturnType<typeof zodOutputFormat<S>> | null,
    model: string,
    system: string,
    content: Anthropic.ContentBlockParam[],
    ctx?: AiCallCtx,
  ): Promise<z.infer<S>> {
    const opts = { signal: ctx?.signal, timeout: this.timeoutMs };
    if (format) {
      const res = await this.client.messages.parse(
        { model, max_tokens: 4000, system, messages: [{ role: 'user', content }], output_config: { format, effort: 'low' } },
        opts,
      );
      if (res.stop_reason === 'refusal' || res.stop_reason === 'max_tokens') throw new AiOutputError(`model stopped: ${res.stop_reason}`);
      if (res.parsed_output == null) throw new AiOutputError('no structured output');
      return schema.parse(res.parsed_output);
    }
    const res = await this.client.messages.create(
      {
        model,
        max_tokens: 4000,
        system: `${system}\nRespond with one JSON object only, no prose and no code fences.`,
        messages: [{ role: 'user', content }],
        output_config: { effort: 'low' },
      },
      opts,
    );
    if (res.stop_reason === 'refusal' || res.stop_reason === 'max_tokens') throw new AiOutputError(`model stopped: ${res.stop_reason}`);
    const text = res.content.map(b => (b.type === 'text' ? b.text : '')).join('').trim();
    const json = text.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '');
    let parsed: unknown;
    try {
      parsed = JSON.parse(json);
    } catch {
      throw new AiOutputError('model output is not JSON');
    }
    return schema.parse(parsed);
  }

  /* ---------- Stage B ---------- */

  newExplore(siteUrl: string): ExploreState {
    const memory: ExploreMemory = { messages: [], pending: [] };
    return { siteUrl, memory: memory as unknown as Record<string, unknown> };
  }

  async exploreStep(state: ExploreState, obs: ExploreObservation, ctx?: AiCallCtx): Promise<BrowserAction> {
    const mem = state.memory as unknown as ExploreMemory;
    const first = mem.messages.length === 0;
    const turn: Anthropic.ContentBlockParam[] = [{ type: 'text', text: exploreTurnText(obs, first) }];
    if (obs.screenshot) turn.push(IMAGE(obs.screenshot));

    if (mem.pending.length) {
      // every tool_use gets its tool_result in one user message; only the first call was executed
      const results: Anthropic.ToolResultBlockParam[] = mem.pending.map((id, i) =>
        i === 0
          ? { type: 'tool_result', tool_use_id: id, content: turn as Anthropic.ToolResultBlockParam['content'] }
          : { type: 'tool_result', tool_use_id: id, content: 'Not executed: only one action per turn.', is_error: true },
      );
      mem.messages.push({ role: 'user', content: results });
    } else {
      mem.messages.push({ role: 'user', content: turn });
    }
    mem.pending = [];
    pruneImages(mem.messages);

    const res = await this.client.messages.create(
      {
        model: this.judgeModel,
        max_tokens: 2000,
        system: EXPLORE_SYSTEM,
        tools: BROWSER_TOOLS,
        // forced tool_choice is rejected by this model; the system prompt asks for exactly one call
        tool_choice: { type: 'auto' },
        output_config: { effort: 'low' },
        messages: mem.messages,
      },
      { signal: ctx?.signal, timeout: this.timeoutMs },
    );
    if (res.stop_reason === 'refusal' || res.stop_reason === 'max_tokens') throw new AiOutputError(`model stopped: ${res.stop_reason}`);
    mem.messages.push({ role: 'assistant', content: res.content as Anthropic.ContentBlockParam[] });
    const uses = res.content.filter((b): b is Anthropic.ToolUseBlock => b.type === 'tool_use');
    if (!uses.length) {
      mem.messages.pop();
      throw new AiOutputError('no tool call');
    }
    mem.pending = uses.map(u => u.id);
    return toBrowserAction(uses[0].name, uses[0].input);
  }

  /* ---------- Stage C ---------- */

  async extractClaims(input: ClaimsInput, ctx?: AiCallCtx): Promise<ExtractedClaim[]> {
    const out = await this.structured(ClaimsOutZ, this.formats.claims, this.fastModel, CLAIMS_SYSTEM, [{ type: 'text', text: claimsUserText(input) }], ctx);
    return normaliseClaims(out);
  }

  /* ---------- Stage E ---------- */

  async judge(input: JudgeInput, ctx?: AiCallCtx): Promise<Judged> {
    const content: Anthropic.ContentBlockParam[] = [{ type: 'text', text: judgeUserText(input) }];
    for (const shot of input.screenshots.slice(0, 3)) content.push(IMAGE(shot));
    const out = await this.structured(JudgeOutZ, this.formats.judge, this.judgeModel, JUDGE_SYSTEM, content, ctx);
    const stepCount = input.steps.length ? Math.max(...input.steps.map(s => s.idx)) + 1 : 0;
    return normaliseJudge(out, input.claims.length, stepCount);
  }

  /* ---------- follow-ups ---------- */

  async answer(question: string, data: AnswerData, ctx?: AiCallCtx): Promise<string> {
    const out = await this.structured(AnswerOutZ, this.formats.answer, this.judgeModel, ANSWER_SYSTEM, [{ type: 'text', text: answerUserText(question, data) }], ctx);
    const a = normaliseAnswer(out);
    if (!a) throw new AiOutputError('empty answer');
    return a;
  }
}
