/**
 * Sign-in messages (M3): EIP-4361 "Sign-In with Ethereum" for EVM wallets and the Sign-In-With-Solana text for
 * Solana wallets. The API builds the exact message (GET /v1/auth/nonce), the wallet signs it unchanged, and
 * POST /v1/auth/verify parses it strictly and checks every field before the signature is even looked at.
 *
 * EVM (EIP-4361):
 *   <domain> wants you to sign in with your Ethereum account:
 *   <EIP-55 address>
 *
 *   <statement>
 *
 *   URI: <uri>
 *   Version: 1
 *   Chain ID: <chain id>
 *   Nonce: <nonce>
 *   Issued At: <RFC 3339>
 *   Expiration Time: <RFC 3339>
 *
 * Solana: the same without "Chain ID", "Solana account" in the first line and the base58 address.
 * Optional EIP-4361 fields (Not Before, Request ID, Resources) are parsed but never produced.
 */
import { keccak_256 } from '@noble/hashes/sha3';
import type { WalletChain } from '@apecheck/core';

export const SIGN_IN_STATEMENT = "Sign in to ApeCheck. This doesn't send a transaction or cost anything.";
/** how long a nonce (and the message it is in) stays valid */
export const NONCE_TTL_MS = 10 * 60_000;
/** clock skew tolerated between API processes for "Issued At" / "Not Before" */
export const CLOCK_SKEW_MS = 30_000;

export const RE_EVM_ADDRESS = /^0x[0-9a-fA-F]{40}$/;
export const RE_SOL_ADDRESS = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
/** EIP-4361: nonce = at least 8 alphanumeric characters */
const RE_NONCE = /^[A-Za-z0-9]{8,64}$/;
/** RFC 3339 date-time as produced by Date#toISOString (and other offsets wallets might keep) */
const RE_DATETIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/;

const ACCOUNT_LINE: Record<WalletChain, string> = { evm: 'Ethereum', sol: 'Solana' };

/** EIP-55 mixed-case checksum of an EVM address. */
export function toChecksumAddress(address: string): string {
  const lower = address.toLowerCase().replace(/^0x/, '');
  const hash = Buffer.from(keccak_256(new TextEncoder().encode(lower))).toString('hex');
  let out = '0x';
  for (let i = 0; i < lower.length; i++) out += parseInt(hash[i], 16) >= 8 ? lower[i].toUpperCase() : lower[i];
  return out;
}

export interface SignInFields {
  chain: WalletChain;
  domain: string;
  address: string;
  statement: string | null;
  uri: string;
  version: string;
  /** EVM only (required there) */
  chainId: number | null;
  nonce: string;
  issuedAt: string;
  expirationTime: string | null;
  notBefore: string | null;
  requestId: string | null;
  resources: string[];
}

/** `APP_URL` → what goes into the message: domain = its host (with a non-default port), uri = the URL without a trailing slash. */
export function appIdentity(appUrl: string): { domain: string; uri: string } {
  const u = new URL(appUrl);
  return { domain: u.host, uri: appUrl.replace(/\/+$/, '') };
}

export function buildSignInMessage(f: {
  chain: WalletChain;
  domain: string;
  uri: string;
  address: string;
  chainId?: number | null;
  nonce: string;
  issuedAt: Date;
  expirationTime: Date;
}): string {
  const address = f.chain === 'evm' ? toChecksumAddress(f.address) : f.address;
  const lines = [
    `${f.domain} wants you to sign in with your ${ACCOUNT_LINE[f.chain]} account:`,
    address,
    '',
    SIGN_IN_STATEMENT,
    '',
    `URI: ${f.uri}`,
    'Version: 1',
  ];
  if (f.chain === 'evm') lines.push(`Chain ID: ${f.chainId ?? 1}`);
  lines.push(`Nonce: ${f.nonce}`, `Issued At: ${f.issuedAt.toISOString()}`, `Expiration Time: ${f.expirationTime.toISOString()}`);
  return lines.join('\n');
}

export class MessageError extends Error {
  constructor(readonly reason: string) {
    super(reason);
    this.name = 'MessageError';
  }
}

const fail = (reason: string): never => {
  throw new MessageError(reason);
};

/**
 * Strict parser: the exact line layout of EIP-4361 (and its Solana twin), LF line endings, no unknown or repeated
 * fields, no trailing newline. Throws MessageError with the reason.
 */
export function parseSignInMessage(chain: WalletChain, message: string): SignInFields {
  if (typeof message !== 'string' || message.length > 4000) fail('message too long');
  if (message.includes('\r')) fail('CR in message');
  const lines = message.split('\n');
  let i = 0;
  const next = () => (i < lines.length ? lines[i++] : fail('message ends early'));

  const head = next();
  const suffix = ` wants you to sign in with your ${ACCOUNT_LINE[chain]} account:`;
  if (!head.endsWith(suffix)) fail('first line');
  const domain = head.slice(0, -suffix.length);
  if (!domain || /\s/.test(domain)) fail('domain');

  const address = next();
  if (chain === 'evm' ? !RE_EVM_ADDRESS.test(address) : !RE_SOL_ADDRESS.test(address)) fail('address');
  if (next() !== '') fail('blank line after the address');

  let statement: string | null = null;
  if (lines[i] !== undefined && lines[i] !== '' && !lines[i].startsWith('URI: ')) {
    statement = next();
    if (statement.includes('\n')) fail('statement');
  }
  // EIP-4361: address LF LF [statement LF] LF "URI: …" (no statement: the blank line stands alone)
  if (next() !== '') fail('blank line before URI');

  const field = (name: string, optional = false): string | null => {
    const line = lines[i];
    if (line !== undefined && line.startsWith(`${name}: `)) {
      i++;
      const v = line.slice(name.length + 2);
      if (!v || /\s/.test(v)) fail(name);
      return v;
    }
    return optional ? null : fail(`missing ${name}`);
  };

  const uri = field('URI')!;
  const version = field('Version')!;
  const chainIdRaw = field('Chain ID', chain === 'sol');
  const nonce = field('Nonce')!;
  const issuedAt = field('Issued At')!;
  const expirationTime = field('Expiration Time', true);
  const notBefore = field('Not Before', true);
  const requestId = field('Request ID', true);
  const resources: string[] = [];
  if (lines[i] === 'Resources:') {
    i++;
    while (i < lines.length && lines[i].startsWith('- ')) resources.push(lines[i++].slice(2));
    if (!resources.length) fail('Resources');
  }
  if (i !== lines.length) fail('unexpected text after the fields');

  let chainId: number | null = null;
  if (chainIdRaw != null) {
    if (!/^[1-9]\d{0,15}$/.test(chainIdRaw)) fail('Chain ID');
    chainId = Number(chainIdRaw);
    if (!Number.isSafeInteger(chainId)) fail('Chain ID');
  }
  if (!RE_NONCE.test(nonce)) fail('Nonce');
  for (const [name, v] of [['Issued At', issuedAt], ['Expiration Time', expirationTime], ['Not Before', notBefore]] as const) {
    if (v != null && (!RE_DATETIME.test(v) || !Number.isFinite(Date.parse(v)))) fail(name);
  }
  return { chain, domain, address, statement, uri, version, chainId, nonce, issuedAt, expirationTime, notBefore, requestId, resources };
}

export interface ExpectedSignIn {
  chain: WalletChain;
  domain: string;
  uri: string;
  /** the address the client says it signs with */
  address: string;
  nonce: string;
  now?: Date;
}

/** Every field rule of a sign-in message. Throws MessageError with the first rule broken. */
export function validateSignInFields(f: SignInFields, exp: ExpectedSignIn): void {
  const now = (exp.now ?? new Date()).getTime();
  if (f.chain !== exp.chain) fail('chain');
  if (f.domain !== exp.domain) fail('domain');
  if (f.uri !== exp.uri) fail('uri');
  if (f.version !== '1') fail('version');
  if (f.chain === 'evm' && (f.chainId == null || !Number.isSafeInteger(f.chainId) || f.chainId <= 0)) fail('chain id');
  if (f.nonce !== exp.nonce) fail('nonce');
  const same = f.chain === 'evm' ? f.address.toLowerCase() === exp.address.toLowerCase() : f.address === exp.address;
  if (!same) fail('address');

  const issued = Date.parse(f.issuedAt);
  if (!Number.isFinite(issued) || issued > now + CLOCK_SKEW_MS) fail('issued in the future');
  if (!f.expirationTime) fail('no expiration time');
  const expires = Date.parse(f.expirationTime!);
  if (!Number.isFinite(expires) || expires <= now) fail('expired');
  if (expires - issued > NONCE_TTL_MS + CLOCK_SKEW_MS) fail('expiration too far out');
  if (f.notBefore && Date.parse(f.notBefore) > now + CLOCK_SKEW_MS) fail('not valid yet');
}
