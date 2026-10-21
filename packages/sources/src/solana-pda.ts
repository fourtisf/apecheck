/**
 * Solana program-derived addresses without @solana/web3.js: sha256 over the seeds, the bump, the program id and
 * "ProgramDerivedAddress", keeping the first result that is NOT an ed25519 point (same rule as
 * Pubkey::find_program_address). Used for the Metaplex Token Metadata account of a mint.
 */
import { createHash } from 'node:crypto';
import { base58Decode, base58Encode } from './base58';

/** Metaplex Token Metadata program */
export const METAPLEX_METADATA_PROGRAM = 'metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s';

const P = 2n ** 255n - 19n;
/** ed25519 curve constant d = -121665/121666 mod p */
const D = 37095705934669439343138083508754565189542113879843219016388785533085940283555n;

function modPow(base: bigint, exp: bigint): bigint {
  let r = 1n;
  let b = base % P;
  let e = exp;
  while (e > 0n) {
    if (e & 1n) r = (r * b) % P;
    b = (b * b) % P;
    e >>= 1n;
  }
  return r;
}

/**
 * The 32 bytes decompress to an ed25519 point (curve25519-dalek CompressedEdwardsY::decompress().is_some()):
 * x² = (y² − 1) / (d·y² + 1) has a square root mod p.
 */
export function isOnCurve(bytes: Uint8Array): boolean {
  if (bytes.length !== 32) return false;
  let y = 0n;
  for (let i = 31; i >= 0; i--) y = (y << 8n) | BigInt(i === 31 ? bytes[i] & 0x7f : bytes[i]);
  y %= P;
  const y2 = (y * y) % P;
  const u = (y2 - 1n + P) % P;
  const v = (D * y2 + 1n) % P;
  if (v === 0n) return false;
  const x2 = (u * modPow(v, P - 2n)) % P;
  if (x2 === 0n) return true;
  return modPow(x2, (P - 1n) / 2n) === 1n;
}

/** [address, bump] like PublicKey.findProgramAddressSync; null when no bump gives an off-curve address. */
export function findProgramAddress(seeds: Uint8Array[], programId: string): [string, number] | null {
  const program = base58Decode(programId);
  if (!program || program.length !== 32 || seeds.some(s => s.length > 32)) return null;
  for (let bump = 255; bump >= 0; bump--) {
    const h = createHash('sha256');
    for (const s of seeds) h.update(s);
    h.update(Uint8Array.of(bump));
    h.update(program);
    h.update('ProgramDerivedAddress');
    const out = h.digest();
    if (!isOnCurve(out)) return [base58Encode(out), bump];
  }
  return null;
}

/** The Metaplex metadata account of a mint: PDA ["metadata", program, mint]; null for a malformed mint. */
export function metadataPda(mint: string): string | null {
  let m: Uint8Array | null;
  try {
    m = base58Decode(mint);
  } catch {
    return null;
  }
  const program = base58Decode(METAPLEX_METADATA_PROGRAM);
  if (!m || m.length !== 32 || !program) return null;
  return findProgramAddress([Buffer.from('metadata'), program, m], METAPLEX_METADATA_PROGRAM)?.[0] ?? null;
}

export interface MetaplexMetadata {
  mint: string;
  name: string;
  symbol: string;
  uri: string;
}

/**
 * Borsh-decode the start of a Metaplex Metadata account: key (4 = MetadataV1), update authority, mint, then
 * name / symbol / uri as u32-length strings padded with NULs. null for anything else or a cut-off account.
 */
export function decodeMetaplexMetadata(data: Uint8Array): MetaplexMetadata | null {
  const b = Buffer.from(data.buffer, data.byteOffset, data.byteLength);
  if (b.length < 65 + 12 || b[0] !== 4) return null;
  const mint = base58Encode(b.subarray(33, 65));
  let o = 65;
  const str = (max: number): string | null => {
    if (o + 4 > b.length) return null;
    const n = b.readUInt32LE(o);
    o += 4;
    if (n > max || o + n > b.length) return null;
    const s = b.subarray(o, o + n).toString('utf8');
    o += n;
    return s.replace(/\0+$/g, '').trim();
  };
  const name = str(200);
  const symbol = str(100);
  const uri = str(1000);
  if (name == null || symbol == null || uri == null) return null;
  return { mint, name, symbol, uri };
}
