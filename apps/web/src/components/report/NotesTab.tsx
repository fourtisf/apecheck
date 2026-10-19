'use client';
import { useRef } from 'react';
import type { NoteDTO } from '@apecheck/core';
import { helpful as postHelpful, notes as postNote, NETWORK_ERROR } from '@/lib/api';
import { useToast } from '../Toast';

export interface NotesTabProps {
  checkId: string;
  list: NoteDTO[];
  onChange(next: NoteDTO[]): void;
}

/** NoteDTO.by is an X handle, or a shortened wallet / "holder" when the author has no handle. */
const author = (by: string) => (/^[A-Za-z0-9_]{1,15}$/.test(by) && by !== 'holder' ? `@${by}` : by);

const errText = (e: unknown) => (e instanceof Error && e.message ? e.message : NETWORK_ERROR);

/** renderTab('notes'): community notes from holders, with Helpful votes. */
export function NotesTab({ checkId, list, onChange }: NotesTabProps) {
  const toast = useToast();
  const busy = useRef(new Set<string>());

  const vote = async (n: NoteDTO) => {
    if (busy.current.has(n.id)) return;
    busy.current.add(n.id);
    try {
      const res = await postHelpful(n.id);
      onChange(list.map(x => (x.id === n.id ? { ...x, helpful: res.helpful, mine: res.mine } : x)));
    } catch (e) {
      toast(errText(e));
    } finally {
      busy.current.delete(n.id);
    }
  };

  // M1: holders-only, so the API answers with the message to show; M3 swaps this for a note form
  const add = async () => {
    if (busy.current.has('')) return;
    busy.current.add('');
    try {
      const note = await postNote(checkId, '');
      onChange([note, ...list]);
    } catch (e) {
      toast(errText(e));
    } finally {
      busy.current.delete('');
    }
  };

  return (
    <>
      {list.length ? (
        <ul className="notes">
          {list.map(n => (
            <li key={n.id}>
              <span className="meta">
                <b>{author(n.by)}</b>
                {n.hold ? ` · holds ${n.hold} $APECHECK` : ''}
              </span>
              <p>{n.text}</p>
              <button className="btn sm" type="button" aria-pressed={n.mine} onClick={() => void vote(n)}>
                Helpful <small>{n.helpful}</small>
              </button>
            </li>
          ))}
        </ul>
      ) : (
        <div className="empty" style={{ marginBottom: 14 }}>
          <p>No community notes yet. Notes add context the agent can&apos;t see, like a Space recording or a past project.</p>
        </div>
      )}
      <button className="btn" type="button" onClick={() => void add()}>
        Add a note
      </button>
    </>
  );
}
