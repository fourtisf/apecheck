import Link from 'next/link';
import { CHAINS, KIND_LABEL, fmtUsd, type CheckSummaryDTO } from '@apecheck/core';
import { reportPath } from '@/lib/env';
import { Avatar } from './Avatar';
import { Pct, ScoreChip } from './Badges';
import { MiniMeter } from './MiniMeter';
import { Age } from './Now';
import { Spark } from './Spark';
import { CoinCell, type VerdictItemProps } from './VerdictRow';

/** gridHTML(it): one verdict as a card in the grid view (.gview). */
export function VerdictCard({ item: it, fresh }: VerdictItemProps) {
  const where = it.chain && CHAINS[it.chain] ? `${KIND_LABEL[it.kind]} · ${CHAINS[it.chain].name}` : KIND_LABEL[it.kind];
  return (
    <Link className={`gc${fresh ? ' fresh' : ''}`} href={reportPath(it.id)} prefetch={false}>
      <div className="gc-top">
        <ScoreChip score={it.total} />
        <span className="nm">
          <span className="nm1">
            <b>{it.name}</b>
          </span>
          <span className="nm2">{where}</span>
        </span>
        <Avatar item={it} size={30} />
      </div>
      <div className="gc-ms">
        {it.narScore != null ? <MiniMeter score={it.narScore} kind="nar" label="Narrative" /> : <span className="mm-nil">—</span>}
        <CoinCell item={it} />
      </div>
      <p>{it.summary}</p>
      <div className="gc-ft">
        <span>{it.mc ? `MC ${fmtUsd(it.mc)}` : it.hasCoin ? 'MC —' : 'No coin'}</span>
        <span>
          {it.spark ? (
            <>
              <Spark data={it.spark} /> <Pct value={it.since} />
            </>
          ) : null}
        </span>
        <Age ts={it.checkedAt ?? it.createdAt} />
      </div>
    </Link>
  );
}
