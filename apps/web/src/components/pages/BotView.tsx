import type { ReactNode } from 'react';
import { BOT_DISCLAIMER, COIN_LABEL, NAR_LABEL, coinBand, fmtDur, narBand, type BotStatsDTO, type CheckReportDTO, type FeedResponse } from '@apecheck/core';
import { Logo } from '../icons';
import { Age } from '../Now';
import { VCard } from '../VCard';
import { VerdictTable } from '../VerdictTable';
import { ranWhere, type BotExample, type ExamplePost } from './botExample';

export type { BotExample, ExamplePost } from './botExample';

export interface BotViewProps {
  /** bot handle without "@" */
  handle: string;
  /** null when the API didn't answer */
  stats: BotStatsDTO | null;
  /** GET /v1/feed?via=bot, newest first; null when the API didn't answer */
  recent: FeedResponse | null;
  /** pickBotExample(): a reply the bot really posted, a labelled illustration, or null (no thread) */
  example: BotExample | null;
}

const int = (n: number) => n.toLocaleString('en-US');

function Stats({ stats }: { stats: BotStatsDTO | null }) {
  if (!stats) return null;
  const parts: { k: string; n: string; t: string }[] = [];
  if (stats.repliesToday > 0) parts.push({ k: 'r', n: int(stats.repliesToday), t: stats.repliesToday === 1 ? 'reply today' : 'replies today' });
  if (stats.medianReplySeconds != null) parts.push({ k: 'm', n: fmtDur(stats.medianReplySeconds), t: 'median reply' });
  if (stats.accounts > 0) parts.push({ k: 'a', n: int(stats.accounts), t: stats.accounts === 1 ? 'account has tagged it' : 'accounts have tagged it' });
  if (!parts.length) return null;
  return (
    <div className="bot-stats">
      {parts.map(p => (
        <span key={p.k}>
          <b>{p.n}</b> {p.t}
        </span>
      ))}
    </div>
  );
}

const MENTION_RE = /(@[A-Za-z0-9_]{1,15})/g;

/** Post text with @handles in the mention colour, as X shows them. Plain text, never HTML. */
function PostText({ text }: { text: string }) {
  const parts = text.split(MENTION_RE);
  return (
    <p className="p-text">
      {parts.map((part, i) =>
        i % 2 ? (
          <span key={i} className="tagx">
            {part}
          </span>
        ) : (
          part
        ),
      )}
    </p>
  );
}

const letter = (s: string) => (s.match(/[A-Za-z0-9]/)?.[0] ?? '?').toUpperCase();

/** One post of the thread; `time` is left out when there is no real time to show. */
function Post({ avatar, name, handle, time, children }: { avatar: ReactNode; name: string; handle?: string; time?: string | null; children: ReactNode }) {
  return (
    <div className="post">
      {avatar}
      <div>
        <div className="p-meta">
          <b>{name}</b>
          {handle ? <span>@{handle}</span> : null}
          {time ? <Age ts={time} /> : null}
        </div>
        {children}
      </div>
    </div>
  );
}

/** The project's post, with the text the check read (never words the project didn't write). */
function ProjectPost({ item: it, post, time }: { item: CheckReportDTO; post: ExamplePost; time: boolean }) {
  return (
    <Post
      avatar={
        <div className="pav" style={{ background: `hsl(${it.hue} 72% var(--av-l))`, color: `hsl(${it.hue} 58% var(--av-d))` }}>
          {letter(it.title)}
        </div>
      }
      name={it.title}
      handle={post.author || it.handle || undefined}
      time={time ? post.createdAt : null}
    >
      <PostText text={post.text.trim()} />
    </Post>
  );
}

/**
 * The bot's answer and the share card. A reply that went out shows the words the bot posted (BotMention.replyText);
 * an illustration (or a reply stored without its text) shows the verdict line, coin line and disclaimer.
 */
function BotAnswer({ handle, item: it, repliedAt, text }: { handle: string; item: CheckReportDTO; repliedAt: string | null; text?: string | null }) {
  const nar = it.narScore!;
  const coin = it.hasCoin && it.coinScore != null ? it.coinScore : null;
  const posted = text?.trim() ? text.trim().split('\n') : null;
  return (
    <Post
      avatar={
        <div className="pav" style={{ background: 'var(--panel)', border: '1px solid var(--line2)' }}>
          <Logo />
        </div>
      }
      name="ApeCheck"
      handle={handle}
      time={repliedAt}
    >
      {/* X's automated label belongs to a reply that is on X */}
      {repliedAt ? <span className="p-auto">Automated account</span> : null}
      {posted ? (
        <p className="p-text">
          {posted.map((line, i) => (
            <span key={i}>
              {i ? <br /> : null}
              {line}
            </span>
          ))}
        </p>
      ) : (
        <p className="p-text">
          {NAR_LABEL[narBand(nar).key]} ({nar}/100){it.summary ? `: ${it.summary}` : ''}
          {coin != null ? (
            <>
              <br />
              Coin: {COIN_LABEL[coinBand(coin).key]} ({coin}/100)
            </>
          ) : null}
          <br />
          <br />
          {coin != null ? 'Checks the claims and the coin, not the team. DYOR.' : BOT_DISCLAIMER}
        </p>
      )}
      <VCard item={it} />
    </Post>
  );
}

/**
 * The example thread (the prototype's .thread: the project's post, someone tagging the bot, the bot's reply).
 * - reply: a thread that happened on X: the mention as written by its author and the reply as the bot posted it,
 *   with its real time and X's automated label; above them the post the check read only when the mention replies
 *   to it (a quoted or linked post is never drawn as the post the mention replies to).
 * - example: an illustration made from a check that ran on the site, captioned as one: the project's real post
 *   without a time, "You" tagging the bot (no real account is quoted), and the answer without a time or label.
 */
function Thread({ handle, example: ex }: { handle: string; example: BotExample }) {
  if (ex.mode === 'reply') {
    const m = ex.reply.mention;
    return (
      <div className="thread">
        {ex.parent ? <ProjectPost item={ex.item} post={ex.parent} time /> : null}
        <Post
          avatar={
            <div className="pav" style={{ background: 'var(--panel2)', color: 'var(--mute)' }}>
              {letter(m.author)}
            </div>
          }
          name={m.author}
          handle={m.author}
          time={m.createdAt}
        >
          <PostText text={m.text} />
        </Post>
        <BotAnswer handle={handle} item={ex.item} repliedAt={ex.reply.repliedAt} text={ex.reply.replyText} />
      </div>
    );
  }
  return (
    <div className="thread thread-ex">
      <p className="thread-cap">Example: how the bot would answer this post. The check ran {ranWhere(ex.item)}; nothing was posted on X.</p>
      <ProjectPost item={ex.item} post={ex.post} time={false} />
      <Post
        avatar={
          <div className="pav" style={{ background: 'var(--panel2)', color: 'var(--mute)' }}>
            Y
          </div>
        }
        name="You"
      >
        <p className="p-text">
          <span className="tagx">@{handle}</span> real or larp?
        </p>
      </Post>
      <BotAnswer handle={handle} item={ex.item} repliedAt={null} />
    </div>
  );
}

/** viewBot(): how the bot works, an example thread (a real reply, or a labelled illustration), and the bot's recent replies. */
export function BotView({ handle, stats, recent, example }: BotViewProps) {
  return (
    <section className="wrap page">
      <div className="bot-g">
        <div>
          <h1 className="h-pg">Tag @{handle} under any project post.</h1>
          <p className="sec-sub" style={{ color: 'var(--mute)', fontSize: '17px', margin: 0, maxWidth: '56ch' }}>
            No site visit needed. The bot runs the full check and answers in the thread, where everyone reading the shill can see it.
          </p>
          <Stats stats={stats} />
          <ol className="steps">
            <li>
              <div>
                <b>Tag @{handle}</b>
                <p>Reply to a project&apos;s post with the tag, or tag the bot together with the project&apos;s account.</p>
              </div>
            </li>
            <li>
              <div>
                <b>The agent runs the check</b>
                <p>Same as the site: it opens the product, tests the claims, traces the team and reads the chain.</p>
              </div>
            </li>
            <li>
              <div>
                <b>It replies with the verdict</b>
                <p>Narrative score, coin score, one-line reason and a share card, with the full report on the site.</p>
              </div>
            </li>
          </ol>
          <p className="rules">
            Holders can reply to the bot to ask follow-ups like &quot;is the mint renounced?&quot;. The account carries X&apos;s automated label and only
            answers when someone tags it, so it never shows up uninvited.
          </p>
        </div>
        {example && example.item.narScore != null ? <Thread handle={handle} example={example} /> : null}
      </div>
      <div className="sec2">
        <h2>Recent bot replies</h2>
        {recent && recent.items.length ? (
          <VerdictTable items={recent.items} />
        ) : (
          <div className="tbl">
            <div className="tbl-empty" style={{ borderTop: 0 }}>
              {recent ? 'No bot replies yet.' : "Couldn't load bot replies right now."}
            </div>
          </div>
        )}
      </div>
    </section>
  );
}
