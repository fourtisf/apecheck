/**
 * createAi(env): the Claude adapter when ANTHROPIC_API_KEY is set, the heuristic stand-in otherwise.
 * ResilientAi wraps the model so any failure in one stage (API error, rate limit, refusal, invalid output)
 * falls back to the heuristic for that stage only and is reported through ctx.onFallback.
 */
import { warnOnce } from '@apecheck/core/node';
import type { Env, ExtractedClaim, Judged } from '@apecheck/core';
import { AnthropicAi, KEY_UNUSABLE_TEXT, describeAiError, keyUnusable, type AnthropicClientLike } from './anthropic';
import { HeuristicAi } from './heuristic';
import type { AiAdapter, AiCallCtx, AiStage, AnswerData, BrowserAction, ClaimsInput, ExploreObservation, ExploreState, JudgeInput } from './types';

export * from './types';
export { HeuristicAi } from './heuristic';
export { AnthropicAi, describeAiError, type AnthropicClientLike } from './anthropic';
export { loadAnswerData } from './answer-data';

interface ResilientExploreMemory {
  primary: ExploreState | null;
  backup: ExploreState;
  useBackup: boolean;
}

export class ResilientAi implements AiAdapter {
  readonly mode: AiAdapter['mode'];
  readonly judgeModel: string | null;
  readonly fastModel: string | null;
  private readonly backup = new HeuristicAi();

  constructor(private readonly primary: AiAdapter | null) {
    this.mode = primary ? primary.mode : 'heuristic';
    this.judgeModel = primary?.judgeModel ?? null;
    this.fastModel = primary?.fastModel ?? null;
  }

  private async attempt<T>(stage: AiStage, ctx: AiCallCtx | undefined, run: (a: AiAdapter) => Promise<T>, fallback: () => Promise<T>): Promise<T> {
    if (this.primary) {
      try {
        return await run(this.primary);
      } catch (e) {
        if (ctx?.signal?.aborted) throw e;
        ctx?.onFallback?.(stage, describeAiError(e));
      }
    }
    return fallback();
  }

  newExplore(siteUrl: string): ExploreState {
    const memory: ResilientExploreMemory = {
      primary: this.primary ? this.primary.newExplore(siteUrl) : null,
      backup: this.backup.newExplore(siteUrl),
      useBackup: !this.primary,
    };
    return { siteUrl, memory: memory as unknown as Record<string, unknown> };
  }

  async exploreStep(state: ExploreState, obs: ExploreObservation, ctx?: AiCallCtx): Promise<BrowserAction> {
    const m = state.memory as unknown as ResilientExploreMemory;
    if (!m.useBackup && this.primary && m.primary) {
      try {
        return await this.primary.exploreStep(m.primary, obs, ctx);
      } catch (e) {
        if (ctx?.signal?.aborted) throw e;
        // a broken conversation can't be resumed: the heuristic drives the rest of this exploration
        m.useBackup = true;
        ctx?.onFallback?.('explore', describeAiError(e));
      }
    }
    return this.backup.exploreStep(m.backup, obs);
  }

  extractClaims(input: ClaimsInput, ctx?: AiCallCtx): Promise<ExtractedClaim[]> {
    return this.attempt('claims', ctx, a => a.extractClaims(input, ctx), () => this.backup.extractClaims(input));
  }

  async judge(input: JudgeInput, ctx?: AiCallCtx): Promise<Judged> {
    const backup = () => this.backup.judge(input);
    const out = await this.attempt('judge', ctx, a => a.judge(input, ctx), backup);
    if (out.claims.length >= input.claims.length) return out;
    // the model skipped some claims: the stand-in fills exactly those
    const filled = await backup();
    const have = new Set(out.claims.map(c => c.index));
    return { ...out, claims: [...out.claims, ...filled.claims.filter(c => !have.has(c.index))].sort((a, b) => a.index - b.index) };
  }

  answer(question: string, data: AnswerData, ctx?: AiCallCtx): Promise<string> {
    return this.attempt('answer', ctx, a => a.answer(question, data, ctx), () => this.backup.answer(question, data));
  }
}

export function createAi(env: Env, opts: { client?: AnthropicClientLike } = {}): ResilientAi {
  if (!env.ANTHROPIC_API_KEY && !opts.client) {
    warnOnce('ai-heuristic', 'ANTHROPIC_API_KEY empty: AI stages use the heuristic stand-in');
    return new ResilientAi(null);
  }
  if (env.ANTHROPIC_API_KEY && !opts.client && keyUnusable(env.ANTHROPIC_API_KEY)) {
    warnOnce('ai-key-unusable', `${KEY_UNUSABLE_TEXT}; AI stages use the heuristic stand-in`);
    return new ResilientAi(null);
  }
  return new ResilientAi(new AnthropicAi(env, { client: opts.client }));
}
