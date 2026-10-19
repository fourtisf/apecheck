import { BOT_DISCLAIMER, CHAINS, COIN_LABEL, NAR_LABEL, coinBand, fmtDur, narBand, type BotStatsDTO, type CheckReportDTO, type CheckSummaryDTO, type FeedResponse } from '@apecheck/core';
import { Logo } from '../icons';
import { Age } from '../Now';
import { VCard } from '../VCard';
import { VerdictTable } from '../VerdictTable';

/** The X post behind the example thread, when the check could read it. */
export type ExamplePost = NonNullable<CheckReportDTO['post']>;

export interface BotViewProps {
  /** bot handle without "@" */
  handle: string;
  /** null when the API didn't answer */
  stats: BotStatsDTO | null;
  /** GET /v1/feed?via=bot, newest first; null when the API didn't answer */
  recent: FeedResponse | null;
  /** the most recent finished post check (a bot one when there is one); no thread without it */
  example: { item: CheckSummaryDTO; post: ExamplePost | null } | null;
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

/** What the project's post says: the real text when the check read it, else the prototype's generic launch line. */
function postText(it: CheckSummaryDTO, post: ExamplePost | null): string {
  const text = post?.text.trim();
  if (text) return text;
  return it.chain && CHAINS[it.chain]
    ? `${it.title} is live on ${CHAINS[it.chain].name} mainnet today. Contract and app in bio.`
    : `${it.title} is live today. App and docs in bio.`;
}

/** The example thread: the project's post, someone tagging the bot under it, and the bot's reply with the card. */
function Thread({ handle, item: it, post }: { handle: string; item: CheckSummaryDTO; post: ExamplePost | null }) {
  const nar = it.narScore!;
  const coin = it.hasCoin && it.coinScore != null ? it.coinScore : null;
  const author = post?.author || it.handle;
  const initial = (it.title.match(/[A-Za-z0-9]/)?.[0] ?? '?').toUpperCase();
  return (
    <div className="thread">
      <div className="post">
        <div className="pav" style={{ background: `hsl(${it.hue} 72% var(--av-l))`, color: `hsl(${it.hue} 58% var(--av-d))` }}>
          {initial}
        </div>
        <div>
          <div className="p-meta">
            <b>{it.title}</b>
            {author ? <span>@{author}</span> : null}
            {post?.createdAt ? <Age ts={post.createdAt} /> : null}
          </div>
          <p className="p-text">{postText(it, post)}</p>
        </div>
      </div>
      {it.by ? (
        <div className="post">
          <div className="pav" style={{ background: 'var(--panel2)', color: 'var(--mute)' }}>
            {it.by[0].toUpperCase()}
          </div>
          <div>
            <div className="p-meta">
              <b>{it.by}</b>
              <span>@{it.by}</span>
              <Age ts={it.createdAt} />
            </div>
            <p className="p-text">
              <span className="tagx">@{handle}</span> real or larp?
            </p>
          </div>
        </div>
      ) : null}
      <div className="post">
        <div className="pav" style={{ background: 'var(--panel)', border: '1px solid var(--line2)' }}>
          <Logo />
        </div>
        <div>
          <div className="p-meta">
            <b>ApeCheck</b>
            <span>@{handle}</span>
            <Age ts={it.checkedAt ?? it.createdAt} />
          </div>
          <span className="p-auto">Automated account</span>
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
          <VCard item={it} />
        </div>
      </div>
    </div>
  );
}

/** viewBot(): how the bot works, an example thread from a real check, and the bot's recent replies. */
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
            Holders can reply to the bot to ask follow-ups like &quot;who funded the deployer?&quot;. The account carries X&apos;s automated label and only
            answers when someone tags it, so it never shows up uninvited.
          </p>
        </div>
        {example && example.item.narScore != null ? <Thread handle={handle} item={example.item} post={example.post} /> : null}
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
