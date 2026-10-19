import { CHAINS, KIND_LABEL, narBand, type CheckSummaryDTO } from '@apecheck/core';
import { APP_HOST } from '@/lib/env';
import { Logo } from './icons';
import { MiniMeter } from './MiniMeter';
import { Ring } from './Ring';

/** What the share card needs; a CheckSummaryDTO or CheckReportDTO fits. */
export type VCardItem = Pick<
  CheckSummaryDTO,
  'id' | 'kind' | 'name' | 'handle' | 'domain' | 'chain' | 'total' | 'narScore' | 'coinScore' | 'hasCoin' | 'summary'
>;

/** Where the verdict came from, as the card's top-right line says it. */
export function cardSource(it: VCardItem): string {
  if (it.kind === 'post') return it.handle ? `@${it.handle} on X` : it.name;
  if (it.kind === 'coin') return it.name;
  return it.domain || it.name;
}

/**
 * cardHTML(it): the share card (report side panel, share modal, bot page). The footer names the chain,
 * or the kind ("Site", "Post") when there is no chain.
 */
export function VCard({ item: it }: { item: VCardItem }) {
  const t = it.total != null ? narBand(it.total) : null;
  const b = it.narScore != null ? narBand(it.narScore) : null;
  return (
    <div className="vcard">
      <div className="vcard-top">
        <span className="vcard-brand">
          <Logo />
          apecheck
        </span>
        <span>{cardSource(it)}</span>
      </div>
      <div className="vcard-main">
        <div className={`rv-ring sm${t ? ` n-${t.key}` : ''}`}>
          <Ring value={it.total ?? 0} size={92} />
          <div className="rv-ring-in">
            <b>{it.total ?? '—'}</b>
          </div>
        </div>
        <div style={{ minWidth: 0 }}>
          {b ? <span className={`vlabel n-${b.key}`}>{b.name}</span> : null}
          <div className="vcard-ms">
            {it.narScore != null ? <MiniMeter score={it.narScore} kind="nar" label="Narrative" /> : null}
            {it.hasCoin && it.coinScore != null ? <MiniMeter score={it.coinScore} kind="coin" label="Coin" /> : null}
          </div>
        </div>
      </div>
      {it.summary ? <p>{it.summary}</p> : null}
      <div className="vcard-foot">
        <span>{it.chain && CHAINS[it.chain] ? CHAINS[it.chain].name : KIND_LABEL[it.kind]}</span>
        <span>
          {APP_HOST}/c/{it.id}
        </span>
      </div>
    </div>
  );
}
