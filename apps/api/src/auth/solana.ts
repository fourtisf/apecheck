/**
 * Solana wallet signatures for Sign-In With Solana (M3): ed25519 over the UTF-8 message bytes, checked with
 * node:crypto. The public key is the 32 bytes behind the base58 address, wrapped in a DER SPKI header
 * (302a300506032b6570032100 ‖ key). Wallets hand the 64-byte signature back as bytes; the web client sends it
 * base58 or base64 encoded, and both readings are tried.
 */
import { createPublicKey, verify, type KeyObject } from 'node:crypto';
import { base58Decode } from '@apecheck/sources';

const SPKI_ED25519_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');
const RE_BASE58 = /^[1-9A-HJ-NP-Za-km-z]+$/;
const RE_BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

export function solanaPublicKey(address: string): KeyObject | null {
  if (!RE_BASE58.test(address) || address.length < 32 || address.length > 44) return null;
  const raw = base58Decode(address);
  if (!raw || raw.length !== 32) return null;
  try {
    return createPublicKey({ key: Buffer.concat([SPKI_ED25519_PREFIX, raw]), format: 'der', type: 'spki' });
  } catch {
    return null;
  }
}

/** The 64-byte readings of a signature string: base58 and/or base64 (only those that decode to 64 bytes). */
export function signatureCandidates(signature: string): Buffer[] {
  const out: Buffer[] = [];
  if (typeof signature !== 'string' || !signature || signature.length > 200) return out;
  if (RE_BASE58.test(signature)) {
    const b = base58Decode(signature);
    if (b && b.length === 64) out.push(b);
  }
  if (RE_BASE64.test(signature)) {
    const b = Buffer.from(signature, 'base64');
    if (b.length === 64 && !out.some(o => o.equals(b))) out.push(b);
  }
  return out;
}

export function verifySolanaSignature(address: string, message: string, signature: string): boolean {
  const key = solanaPublicKey(address);
  if (!key) return false;
  const data = Buffer.from(message, 'utf8');
  for (const sig of signatureCandidates(signature)) {
    try {
      if (verify(null, data, key, sig)) return true;
    } catch {
      // malformed signature bytes: try the other reading
    }
  }
  return false;
}
