'use client';
import { BOT_DISCLAIMER, COIN_LABEL, NAR_LABEL, coinBand, narBand } from '@apecheck/core';
import { APP_URL, reportPath } from '@/lib/env';
import { useModal } from './Modal';
import { VCard, type VCardItem } from './VCard';

export interface ShareModalProps {
  item: VCardItem;
  /** default: downloads /card/<id>.png from this site */
  onDownload?: () => void;
  /** default: opens an X post with the verdict line and the report link */
  onPost?: () => void;
  /** false: no "Post to X" (a private check: its link opens only for its owner); the image can still be downloaded */
  postable?: boolean;
}

/** Text of a shared verdict, in the bot's format: "LIKELY LARP (37/100) · Coin: SKETCHY (37)", the summary, the disclaimer. */
export function shareText(it: VCardItem): string {
  const lines: string[] = [];
  if (it.narScore != null) {
    let head = `${NAR_LABEL[narBand(it.narScore).key]} (${it.narScore}/100)`;
    if (it.hasCoin && it.coinScore != null) head += ` · Coin: ${COIN_LABEL[coinBand(it.coinScore).key]} (${it.coinScore})`;
    lines.push(head);
  }
  if (it.summary) lines.push(it.summary);
  lines.push(BOT_DISCLAIMER);
  return lines.join('\n');
}

export function downloadCard(id: string) {
  const a = document.createElement('a');
  a.href = `/card/${encodeURIComponent(id)}.png`;
  a.download = `apecheck-${id}.png`;
  document.body.appendChild(a);
  a.click();
  a.remove();
}

export function postToX(it: VCardItem) {
  const url = `${APP_URL}${reportPath(it.id)}`;
  const intent = `https://x.com/intent/post?text=${encodeURIComponent(shareText(it))}&url=${encodeURIComponent(url)}`;
  window.open(intent, '_blank', 'noopener,noreferrer');
}

/** openShare(it): the share card with Close / Download image / Post to X. Open it with useActions().openShare(item). */
export function ShareModal({ item, onDownload, onPost, postable = true }: ShareModalProps) {
  const { close } = useModal();
  return (
    <>
      <VCard item={item} />
      <div className="modal-actions">
        <button className="btn" type="button" onClick={close}>
          Close
        </button>
        <button className="btn" type="button" onClick={onDownload ?? (() => downloadCard(item.id))}>
          Download image
        </button>
        {postable ? (
          <button className="btn btn-primary" type="button" onClick={onPost ?? (() => postToX(item))}>
            Post to X
          </button>
        ) : null}
      </div>
    </>
  );
}
