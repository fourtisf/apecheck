'use client';
import { useRef, useState, type FormEvent } from 'react';
import type { AskDTO } from '@apecheck/core';
import { asks as postAsk, NETWORK_ERROR } from '@/lib/api';
import { Logo } from '../icons';
import { Age } from '../Now';
import { useToast } from '../Toast';

export interface AsksTabProps {
  checkId: string;
  list: AskDTO[];
  /** all follow-ups ever asked (some only on X) */
  count: number;
  onAsked(a: AskDTO): void;
}

/** renderTab('asks'): follow-up questions answered from this check's data, and the (Pro) ask box. */
export function AsksTab({ checkId, list, count, onAsked }: AsksTabProps) {
  const toast = useToast();
  const [q, setQ] = useState('');
  const busy = useRef(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (busy.current) return;
    busy.current = true;
    try {
      const a = await postAsk(checkId, q.trim());
      onAsked(a);
      setQ('');
    } catch (err) {
      toast(err instanceof Error && err.message ? err.message : NETWORK_ERROR);
    } finally {
      busy.current = false;
    }
  };

  const more = count - list.length;
  return (
    <>
      {list.length ? (
        <>
          <ul className="qa">
            {list.map(x => (
              <li key={x.id}>
                <div className="q">
                  <span className="mini-av">{(x.by?.[0] ?? '?').toUpperCase()}</span>
                  <div>
                    <span className="meta">
                      <b>{x.by ? `@${x.by}` : 'Someone'}</b> asked {x.via === 'x' ? 'via X' : 'on the site'} · <Age ts={x.createdAt} long />
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
      <form className="ask" onSubmit={submit}>
        <input
          value={q}
          onChange={e => setQ(e.target.value)}
          maxLength={280}
          placeholder="Ask about this check, like “who funded the deployer?”"
          aria-label="Ask a follow-up"
        />
        <button className="btn btn-primary sm" type="submit">
          Ask{' '}
          <span className="lock" style={{ background: 'rgba(255,255,255,.22)', color: '#fff' }}>
            Pro
          </span>
        </button>
      </form>
    </>
  );
}
