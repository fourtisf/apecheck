import type { CheckSummaryDTO } from '@apecheck/core';
import { FeedHead } from './FeedHead';
import { VerdictRow } from './VerdictRow';

/** `<div class="tbl">FEED_HEAD + rows</div>`: the verdict table (feed list view, "Recent bot replies"). */
export function VerdictTable({ items, fresh }: { items: CheckSummaryDTO[]; fresh?: ReadonlySet<string> }) {
  return (
    <div className="tbl" role="table">
      <FeedHead />
      {items.map(it => (
        <VerdictRow key={it.id} item={it} fresh={fresh?.has(it.id)} />
      ))}
    </div>
  );
}
