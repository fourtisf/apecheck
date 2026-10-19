import { randomInt } from 'node:crypto';

const ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789';

/** 7 random [a-z0-9] chars: the public id in /c/[id] and card URLs. */
export function randomShortId(len = 7): string {
  let s = '';
  for (let i = 0; i < len; i++) s += ALPHABET[randomInt(ALPHABET.length)];
  return s;
}

/** What a public check id can look like (anything else is a 404 without a DB query). */
export const SHORT_ID_RE = /^[A-Za-z0-9_-]{4,32}$/;

const b64 = (s: string) => Buffer.from(s, 'utf8').toString('base64url');
const unb64 = (s: string) => Buffer.from(s, 'base64url').toString('utf8');

/**
 * Opaque list cursor: a position in the live order (`o:<offset>`), or a position in a stored snapshot of the
 * order the first page was cut from (`s:<token>:<offset>`, see feed-snapshot.ts).
 */
export interface ListCursor {
  offset: number;
  /** snapshot token; null = page the live order */
  snap: string | null;
}

export const encodeCursor = (offset: number) => b64(`o:${offset}`);
export const encodeSnapCursor = (token: string, offset: number) => b64(`s:${token}:${offset}`);

/** null = malformed (a 400); no cursor = the first page. */
export function decodeCursor(cursor: string | undefined | null): ListCursor | null {
  if (!cursor) return { offset: 0, snap: null };
  const raw = unb64(cursor);
  const o = raw.match(/^o:(\d{1,7})$/);
  if (o) return { offset: Number(o[1]), snap: null };
  const s = raw.match(/^s:([A-Za-z0-9_-]{16,64}):(\d{1,7})$/);
  if (s) return { offset: Number(s[2]), snap: s[1] };
  return null;
}
