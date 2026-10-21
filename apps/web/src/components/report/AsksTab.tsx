'use client';
import { useRef, useState, type FormEvent } from 'react';
import type { AskDTO } from '@apecheck/core';
import { short } from '@apecheck/core';
import { asks as postAsk, isApiError, NETWORK_ERROR } from '@/lib/api';
import { Logo, WalletIcon } from '../icons';
import { useMe } from '../Me';
import { refocusIfLost } from '../Modal';
import { Age } from '../Now';
import { byLabel, isHandle } from './NotesTab';

export interface AsksTabProps {
  checkId: string;
  list: AskDTO[];
  /** all follow-ups ever asked (some only on X) */
  count: number;
  onAsked(a: AskDTO): void;
}

const QUESTION_MIN = 3;
const QUESTION_MAX = 280;

/** The line under the ask box after a failed ask: the API's own words (403 pro_required, 429, 504 ask_timeout, …). */
export function askErrorText(e: unknown): string {
  if (isApiError(e)) return e.message || NETWORK_ERROR;
  return NETWORK_ERROR;
}

/** Who asked, as the meta line shows it: @handle, a shortened wallet in mono, or "Someone". */
const asker = (by: string | null) => (by ? byLabel(by) : 'Someone');

/** The asker's avatar: a handle's first letter; a wallet (or nobody) gets the wallet icon, never "0" from "0x…". */
function AskerAv({ by }: { by: string | null }) {
  return <span className="mini-av">{by && isHandle(by) ? by[0].toUpperCase() : <WalletIcon />}</span>;
}

/**
 * renderTab('asks'): follow-up questions answered from this check's data, and the (Pro) ask box. Asking shows the
 * question at once with "Thinking…" while the API waits for the answer, then the answer in its place.
 */
export function AsksTab({ checkId, list, count, onAsked }: AsksTabProps) {
  const { me } = useMe();
  const [q, setQ] = useState('');
  const [pending, setPending] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const busy = useRef(false);
  const form = useRef<HTMLFormElement>(null);
  const field = useRef<HTMLInputElement>(null);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const question = q.trim().replace(/\s+/g, ' ');
    if (busy.current) return;
    // asked from the keyboard (Enter in the box, or the Ask button): the box keeps focus for the next question
    const hadFocus = !!form.current?.contains(document.activeElement);
    if (question.length < QUESTION_MIN) {
      setMsg('Ask a question of 3 to 280 characters.');
      return;
    }
    busy.current = true;
    setMsg(null);
    setPending(question);
    setQ('');
    try {
      const a = await postAsk(checkId, question);
      onAsked(a);
    } catch (err) {
      setQ(cur => cur || question);
      setMsg(askErrorText(err));
    } finally {
      busy.current = false;
      setPending(null);
      if (hadFocus) refocusIfLost(field);
    }
  };

  const more = count - list.length;
  // the pending question is labelled the way the answered one will be (AskDTO.by: X handle, else the short wallet)
  const u = me?.user;
  const youBy = u?.xHandle ?? (u?.evmAddress || u?.solAddress ? short((u.evmAddress ?? u.solAddress)!) : null);
  return (
    <>
      {list.length || pending ? (
        <>
          <ul className="qa">
            {pending ? (
              <li aria-busy="true">
                <div className="q">
                  <AskerAv by={youBy} />
                  <div>
                    <span className="meta">
                      <b>{youBy ? asker(youBy) : 'You'}</b> asked on the site · now
                    </span>
                    <p>{pending}</p>
                  </div>
                </div>
                <div className="a">
                  <span className="mini-av" style={{ background: 'var(--panel)', border: '1px solid var(--line2)' }}>
                    <Logo />
                  </span>
                  <div>
                    <span className="meta">
                      <b>ApeCheck</b>
                    </span>
                    <p className="muted ask-thinking">Thinking…</p>
                  </div>
                </div>
              </li>
            ) : null}
            {list.map(x => (
              <li key={x.id}>
                <div className="q">
                  <AskerAv by={x.by} />
                  <div>
                    <span className="meta">
                      <b>{asker(x.by)}</b> asked {x.via === 'x' ? 'via X' : 'on the site'} · <Age ts={x.createdAt} long />
                    </span>
                    <p>{x.question}</p>
                  </div>
                </div>
                <div className="a">
                  <span className="mini-av" style={{ background: 'var(--panel)', border: '1px solid var(--line2)' }}>
                    <Logo />
                  </span>
                  <div>
                    <span className="meta">
                      <b>ApeCheck</b> answered from the check
                    </span>
                    <p>{x.answer}</p>
                  </div>
                </div>
              </li>
            ))}
          </ul>
          {more > 0 ? (
            <p className="muted" style={{ margin: '0 0 14px', fontSize: 13.5 }}>
              {more} more question{more === 1 ? ' was' : 's were'} asked on X
            </p>
          ) : null}
        </>
      ) : (
        <div className="empty" style={{ marginBottom: 14 }}>
          <p>No follow-up questions yet.</p>
        </div>
      )}
      <form className="ask" onSubmit={submit} ref={form}>
        <input
          ref={field}
          value={q}
          onChange={e => {
            setQ(e.target.value);
            if (msg) setMsg(null);
          }}
          maxLength={QUESTION_MAX}
          placeholder="Ask about this check, like “is the mint renounced?”"
          aria-label="Ask a follow-up"
          // read-only, not disabled, while the answer is on its way: a disabled field drops keyboard focus to <body>,
          // and the next question is typed in the same place
          readOnly={!!pending}
          aria-busy={pending ? true : undefined}
        />
        <button className="btn btn-primary sm" type="submit" disabled={!!pending}>
          Ask{' '}
          {/* the prototype's white-on-22% in light mode; follows the button's ink so it stays readable in dark mode */}
          <span className="lock" style={{ background: 'color-mix(in srgb, var(--pri-ink) 22%, transparent)', color: 'var(--pri-ink)' }}>
            Pro
          </span>
        </button>
      </form>
      {msg ? (
        <p className="ask-msg" role="alert">
          {msg}
        </p>
      ) : null}
    </>
  );
}
