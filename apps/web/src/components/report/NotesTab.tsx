'use client';
import { useRef, useState, type FormEvent, type ReactNode } from 'react';
import type { MeDTO, NoteDTO } from '@apecheck/core';
import { helpful as postHelpful, notes as postNote, NETWORK_ERROR } from '@/lib/api';
import { useMe } from '../Me';
import { refocusIfLost } from '../Modal';
import { useToast } from '../Toast';

export interface NotesTabProps {
  checkId: string;
  list: NoteDTO[];
  /**
   * Change the report's notes from what they are when the answer lands (not from `list` as it was at the click), so
   * two Helpful votes, or a vote and a new note, in flight together don't undo each other.
   */
  onChange(update: (prev: NoteDTO[]) => NoteDTO[]): void;
}

export const NOTE_MIN = 10;
export const NOTE_MAX = 500;

/**
 * NoteDTO.by ("@handle") / AskDTO.by ("handle"): an X handle, else a shortened wallet like "0x19e…ff2a", or "holder".
 * True for a bare handle (which gets its "@").
 */
export const isHandle = (by: string) => /^[A-Za-z0-9_]{1,15}$/.test(by) && by !== 'holder';
/** A shortened wallet ("0x19e…ff2a", "7xKX…sAsU"): shown in mono (the body font draws "0x" as "0×"). */
export const isShortWallet = (by: string) => by.includes('…');

/** Who wrote a note, as the meta line shows it. */
export function byLabel(by: string): ReactNode {
  if (isHandle(by)) return `@${by}`;
  return isShortWallet(by) ? <span className="mono">{by}</span> : by;
}

const errText = (e: unknown) => (e instanceof Error && e.message ? e.message : NETWORK_ERROR);

/** What "Add a note" says to someone who can't write one (the API's holders_only words). */
export function notesClosedText(me: MeDTO | null): string {
  if (!me?.user) return 'Notes are open to $APECHECK holders. Connect a wallet to add one.';
  return me.tokenLive ? 'Notes are open to $APECHECK holders.' : 'Notes are open to $APECHECK holders once the token launches.';
}

/** Characters as the API counts them (trimmed). */
export const noteLength = (t: string) => t.trim().length;

/**
 * renderTab('notes'): community notes from holders, with Helpful votes. Holders (MeDTO.user.holder) get the note
 * form; everyone else keeps the prototype's "Add a note" button and its toast.
 */
export function NotesTab({ checkId, list, onChange }: NotesTabProps) {
  const toast = useToast();
  const { me } = useMe();
  const busy = useRef(new Set<string>());
  const form = useRef<HTMLFormElement>(null);
  const field = useRef<HTMLTextAreaElement>(null);
  const [text, setText] = useState('');
  const [posting, setPosting] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const holder = !!me?.user?.holder;
  const n = noteLength(text);
  const valid = n >= NOTE_MIN && n <= NOTE_MAX;

  const vote = async (note: NoteDTO) => {
    if (busy.current.has(note.id)) return;
    busy.current.add(note.id);
    try {
      const res = await postHelpful(note.id);
      onChange(prev => prev.map(x => (x.id === note.id ? { ...x, helpful: res.helpful, mine: res.mine } : x)));
    } catch (e) {
      toast(errText(e));
    } finally {
      busy.current.delete(note.id);
    }
  };

  const post = async (e: FormEvent) => {
    e.preventDefault();
    if (posting) return;
    if (!valid) {
      setMsg(`Notes are ${NOTE_MIN} to ${NOTE_MAX} characters.`);
      return;
    }
    // posted from the keyboard: "Post note" is disabled while posting (and stays so with the field cleared), so focus
    // goes back to the field instead of <body>
    const hadFocus = !!form.current?.contains(document.activeElement);
    setPosting(true);
    setMsg(null);
    try {
      const note = await postNote(checkId, text.trim());
      onChange(prev => [note, ...prev.filter(x => x.id !== note.id)]);
      setText('');
      toast('Note added');
    } catch (err) {
      setMsg(errText(err));
    } finally {
      setPosting(false);
      if (hadFocus) refocusIfLost(field);
    }
  };

  return (
    <>
      {list.length ? (
        <ul className="notes">
          {list.map(x => (
            <li key={x.id}>
              <span className="meta">
                <b>{byLabel(x.by)}</b>
                {x.hold ? ` · holds ${x.hold} $APECHECK` : ''}
              </span>
              <p style={{ whiteSpace: 'pre-line' }}>{x.text}</p>
              <button className="btn sm" type="button" aria-pressed={x.mine} onClick={() => void vote(x)}>
                Helpful <small>{x.helpful}</small>
              </button>
            </li>
          ))}
        </ul>
      ) : (
        <div className="empty" style={{ marginBottom: 14 }}>
          <p>No community notes yet. Notes add context the agent can&apos;t see, like a Space recording or a past project.</p>
        </div>
      )}
      {holder ? (
        <form className="note-form" onSubmit={post} ref={form}>
          <textarea
            ref={field}
            id="noteText"
            value={text}
            onChange={e => {
              setText(e.target.value);
              if (msg) setMsg(null);
            }}
            rows={3}
            maxLength={NOTE_MAX + 200}
            placeholder="Add context the agent can't see, like a Space recording or a past project"
            aria-label="Your note"
            aria-describedby="noteCount"
            // read-only, not disabled, while posting: a disabled field drops keyboard focus to <body>
            readOnly={posting}
            aria-busy={posting || undefined}
          />
          <div className="note-f">
            {/* read with the field (aria-describedby), not announced on every keystroke */}
            <span id="noteCount" className={`note-n${n > NOTE_MAX ? ' over' : ''}`}>
              {n}/{NOTE_MAX}
            </span>
            {/* said once when the note crosses the limit */}
            <span className="sr-only" aria-live="polite">
              {n > NOTE_MAX ? `Over ${NOTE_MAX} characters` : ''}
            </span>
            <button className="btn btn-primary sm" type="submit" disabled={posting || !valid}>
              {posting ? 'Posting…' : 'Post note'}
            </button>
          </div>
        </form>
      ) : (
        <button className="btn" type="button" onClick={() => toast(notesClosedText(me))}>
          Add a note
        </button>
      )}
      {msg ? (
        <p className="ask-msg" role="alert">
          {msg}
        </p>
      ) : null}
    </>
  );
}
