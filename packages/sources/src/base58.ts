import { createHash } from 'node:crypto';

const ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

export function base58Encode(bytes: Uint8Array): string {
  let n = 0n;
  for (const b of bytes) n = (n << 8n) | BigInt(b);
  let out = '';
  while (n > 0n) {
    out = ALPHABET[Number(n % 58n)] + out;
    n /= 58n;
  }
  for (const b of bytes) {
    if (b !== 0) break;
    out = '1' + out;
  }
  return out;
}

export function base58Decode(s: string): Buffer | null {
  let n = 0n;
  for (const ch of s) {
    const i = ALPHABET.indexOf(ch);
    if (i < 0) return null;
    n = n * 58n + BigInt(i);
  }
  const bytes: number[] = [];
  while (n > 0n) {
    bytes.unshift(Number(n & 255n));
    n >>= 8n;
  }
  for (const ch of s) {
    if (ch !== '1') break;
    bytes.unshift(0);
  }
  return Buffer.from(bytes);
}

const sha256 = (b: Uint8Array) => createHash('sha256').update(b).digest();

/** 20-byte EVM-style hex (or 21-byte with the 0x41 prefix) → Tron base58check address "T…". */
export function tronFromHex(hex: string): string | null {
  let h = hex.replace(/^0x/i, '').toLowerCase();
  if (h.length === 40) h = '41' + h;
  if (!/^41[0-9a-f]{40}$/.test(h)) return null;
  const body = Buffer.from(h, 'hex');
  const check = sha256(sha256(body)).subarray(0, 4);
  return base58Encode(Buffer.concat([body, check]));
}

/** Tron "T…" address → 21-byte hex with the 41 prefix, or null when the checksum is wrong. */
export function tronToHex(address: string): string | null {
  const raw = base58Decode(address);
  if (!raw || raw.length !== 25) return null;
  const body = raw.subarray(0, 21);
  const check = sha256(sha256(body)).subarray(0, 4);
  if (!check.equals(raw.subarray(21))) return null;
  return body.toString('hex');
}
