/**
 * Stage C — claims (AI_MODEL_FAST, or the heuristic). Inputs are the site hero/footer, docs, post and
 * X bio; output is validated with ClaimsOutZ + normaliseClaims inside the adapter.
 */
import type { ClaimsInput } from '../ai/types';
import type { CheckRun } from './context';
import type { StageCtx } from './stage';
import { plural } from './text';

export function claimsInput(run: CheckRun): ClaimsInput {
  const bio = run.xUser?.description ?? run.post?.author?.description ?? '';
  return {
    name: run.ticker ? `$${run.ticker}` : run.domain ?? (run.handle ? `@${run.handle}` : 'the project'),
    siteUrl: run.siteUrl,
    hero: run.landing?.hero ?? '',
    footer: run.landing?.footer ?? '',
    docs: run.docs.result?.text ?? '',
    post: run.post?.text ?? '',
    bio,
  };
}

export async function claimsStage(run: CheckRun, ctx: StageCtx): Promise<void> {
  const input = claimsInput(run);
  if (!input.hero && !input.footer && !input.docs && !input.post && !input.bio) {
    run.claims = [];
    await run.steps.scoped(ctx.signal).step({ status: 'info', text: 'No copy to pull claims from' });
    return;
  }
  run.claims = await run.deps.ai.extractClaims(input, run.aiCtx(ctx.signal));
  const where = [input.hero || input.footer ? 'the site' : null, input.docs ? 'the docs' : null, input.post ? 'the post' : null, input.bio ? 'the X bio' : null]
    .filter(Boolean)
    .join(', ')
    .replace(/, ([^,]*)$/, ' and $1');
  await run.steps.scoped(ctx.signal).step({
    status: 'info',
    text: run.claims.length ? `Pulled ${plural(run.claims.length, 'claim')} from ${where}` : `No checkable claims in ${where}`,
  });
}
