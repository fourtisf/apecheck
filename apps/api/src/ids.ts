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

/** Opaque offset cursor for list endpoints. */
export const encodeCursor = (offset: number) => b64(`o:${offset}`);
export function decodeCursor(cursor: string | undefined | null): number | null {
  if (!cursor) return 0;
  const m = unb64(cursor).match(/^o:(\d{1,7})$/);
  return m ? Number(m[1]) : null;
}
