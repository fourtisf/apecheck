import Link from 'next/link';
import { KIND_LABEL, fmtUsd, type CheckSummaryDTO } from '@apecheck/core';
import { reportPath } from '@/lib/env';
import { Avatar } from './Avatar';
import { Pct, ScoreChip } from './Badges';
import { ChainTag } from './ChainTag';
import { MiniMeter } from './MiniMeter';
import { Age } from './Now';
import { Spark } from './Spark';

export interface VerdictItemProps {
  item: CheckSummaryDTO;
  /** play the .fresh highlight (a verdict that just landed at the top) */
  fresh?: boolean;
}

/** Coin cell shared by the row and the grid card. */
export function CoinCell({ item }: { item: CheckSummaryDTO }) {
  if (!item.hasCoin) return <span className="mm-nil">No coin linked</span>;
  if (item.coinScore == null) return <span className="mm-nil">—</span>;
  return <MiniMeter score={item.coinScore} kind="coin" label="Coin" />;
}

const whenOf = (it: CheckSummaryDTO) => it.checkedAt ?? it.createdAt;

/** rowHTML(it): one verdict in the table. Wrap rows in <div className="tbl" role="table"><FeedHead/>…</div> (or use VerdictTable). */
export function VerdictRow({ item: it, fresh }: VerdictItemProps) {
  return (
    <Link className={`tr${fresh ? ' fresh' : ''}`} href={reportPath(it.id)} prefetch={false}>
      <span className="td c-score">
        <ScoreChip score={it.total} />
      </span>
      <span className="td c-nm">
        <Avatar item={it} size={36} />
        <span className="nm">
          <span className="nm1">
            <b>{it.name}</b>
            <span className="tag">{KIND_LABEL[it.kind]}</span>
            <ChainTag chain={it.chain} />
          </span>
          <span className="nm2" title={it.summary ?? undefined}>
            {it.summary}
          </span>
        </span>
      </span>
      <span className="td c-nar">{it.narScore != null ? <MiniMeter score={it.narScore} kind="nar" label="Narrative" /> : <span className="mm-nil">—</span>}</span>
      <span className="td c-coin">
        <CoinCell item={it} />
      </span>
      <span className="td num c-mc">{it.mc ? fmtUsd(it.mc) : <span className="nil">—</span>}</span>
      <span className="td num c-since">
        <Spark data={it.spark} />
        <Pct value={it.since} />
      </span>
      <Age ts={whenOf(it)} className="td num c-age muted" />
      <span className="c-mob">
        {it.mc ? (
          <>
            <span>MC {fmtUsd(it.mc)}</span>
            <span>
              Since check <Pct value={it.since} />
            </span>
          </>
        ) : null}
        <Age ts={whenOf(it)} long />
      </span>
    </Link>
  );
}
