/**
 * Which example thread the /bot page shows. Never a reply the bot didn't post, never words someone didn't write:
 * - `reply`: one of the bot's own recent checks whose reply really went out on X (CheckReportDTO.botReply), shown
 *   as the thread it was: the project's post when the check read it, the mention as it was written, the reply;
 * - `example`: no such reply yet (always the case before the bot ships in M2), so a recent post check whose post
 *   text the check read is shown as a labelled illustration of how the bot would answer it, with no handle or time
 *   that would make it read as something that happened on X;
 * - null: neither exists, and the page shows no thread.
 */
import type { CheckReportDTO, FeedResponse } from '@apecheck/core';

/** The X post behind the example thread, when the check could read it. */
export type ExamplePost = NonNullable<CheckReportDTO['post']>;
export type BotReply = NonNullable<CheckReportDTO['botReply']>;

export type BotExample =
  | { mode: 'reply'; item: CheckReportDTO; post: ExamplePost | null; reply: BotReply }
  | { mode: 'example'; item: CheckReportDTO; post: ExamplePost };

export interface BotExampleDeps {
  /** GET /v1/feed?type=post (null when the API didn't answer) */
  postChecks(limit: number): Promise<FeedResponse | null>;
  /** GET /v1/checks/:id (null when the API didn't answer) */
  report(id: string): Promise<CheckReportDTO | null>;
}

/** How many recent checks to read for a thread. */
export const CANDIDATES = 3;

/** Where an illustrated check ran, for its caption. */
export const ranWhere = (it: Pick<CheckReportDTO, 'via'>) => (it.via === 'api' ? 'through the API' : 'on the site');

/** The post the check read, when it has text; null otherwise. */
export const readPost = (r: CheckReportDTO | null): ExamplePost | null => (r?.post && r.post.text.trim() ? r.post : null);

/** `recent` is the bot's recent replies (GET /v1/feed?via=bot, newest first); null when the API didn't answer. */
export async function pickBotExample(recent: FeedResponse | null, deps: BotExampleDeps): Promise<BotExample | null> {
  if (!recent) return null; // API down or limiting us: don't stack more slow calls

  const botChecks = recent.items.filter(i => i.via === 'bot' && i.status === 'done' && i.narScore != null).slice(0, CANDIDATES);
  for (const r of await Promise.all(botChecks.map(i => deps.report(i.id)))) {
    if (r && r.via === 'bot' && r.narScore != null && r.botReply) return { mode: 'reply', item: r, post: readPost(r), reply: r.botReply };
  }

  // a bot check whose reply isn't on X is neither a reply nor an illustration of a site/API check: skip it
  const posts = (await deps.postChecks(CANDIDATES))?.items.filter(i => i.kind === 'post' && i.via !== 'bot' && i.narScore != null) ?? [];
  for (const r of await Promise.all(posts.map(i => deps.report(i.id)))) {
    const post = readPost(r);
    if (r && r.via !== 'bot' && r.narScore != null && post) return { mode: 'example', item: r, post };
  }
  return null;
}
