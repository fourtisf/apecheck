/**
 * Fingerprints of watched targets (re-check alerts, HANDOFF §8): a short hash of what can change about a project, so
 * the scan (recheck.ts) can tell "changed" from "the same" without keeping the content.
 *
 *  - site  → the site's root page fetched with the SSRF guard (sources.http, guard: true), its visible text normalised
 *            (normalise.ts: scripts/styles/tags out, numbers, dates and relative times out) → sha256;
 *  - coin  → EVM: sha256(eth_getCode + owner() + whether a mint function exists + the implementation behind a proxy
 *            and its code: EIP-1167 target, EIP-1967 slot or beacon, so an upgrade to new logic is a change); Solana:
 *            sha256(mint authority + freeze authority + token program + the Token-2022 extension settings an authority
 *            changes: transfer fee, transfer hook, permanent delegate, pause…); Tron: owner + mint function;
 *  - X post / profile → the profile's name, bio and link (only when the X API is configured; skipped otherwise).
 *
 * A fingerprint is only ever produced from a read that worked: any error (HTTP status, SSRF refusal, timeout, a bot
 * challenge page, an RPC failure, an account X can't find) is `{ ok: false }` and never compared. On chain that means
 * every part was read definitively: a throttled owner() call, an unread proxy slot or implementation is a failed read
 * reported by the adapter (captureErrors), never "no owner" / "no proxy". Values are versioned ("site:v2:<hex>"): a
 * stored value from another method or version is replaced silently, never an alert (v2: proxy implementation,
 * Token-2022 extensions, more volatile page values normalised).
 */
import { createHash } from 'node:crypto';
import { chainFromDb, detect, type ChainKey } from '@apecheck/core';
import type { Chain, TargetKind } from '@apecheck/db';
import { captureErrors, type Sources } from '@apecheck/sources';
import { detectBotWall } from '../browser/page';
import { errText } from '../log';
import { siteFingerprintText } from './normalise';

export type FingerprintKind = 'site' | 'contract' | 'mint' | 'profile';
export const FINGERPRINT_VERSION = 'v2';

export type Fingerprint =
  | { ok: true; kind: FingerprintKind; value: string }
  /** the read failed: nothing is compared or stored (`retry`: worth another try within the hour) */
  | { ok: false; kind: FingerprintKind | null; reason: string; retry: boolean };

export interface WatchedTarget {
  id: string;
  kind: TargetKind;
  chain: Chain | null;
  ca: string | null;
  domain: string | null;
  handle: string | null;
  name: string;
}

/** a root page larger than this is compared on its first 1.5 MB */
const SITE_MAX_BYTES = 1_500_000;
const SITE_TIMEOUT_MS = 15_000;

const sha256 = (s: string) => createHash('sha256').update(s, 'utf8').digest('hex');
const stamp = (kind: FingerprintKind, parts: string) => `${kind}:${FINGERPRINT_VERSION}:${sha256(parts)}`;
const failed = (kind: FingerprintKind | null, reason: string, retry = true): Fingerprint => ({ ok: false, kind, reason, retry });

/** "site:v2:…" → "site:v2" (method + version of a stored fingerprint), null for anything else. */
export function fingerprintScheme(value: string | null | undefined): string | null {
  const m = /^([a-z]+:v\d+):[0-9a-f]{64}$/.exec(value ?? '');
  return m ? m[1] : null;
}

/** What kind of fingerprint a target gets (null: not watched for changes, e.g. a coin whose chain is unknown). */
export function fingerprintKind(t: Pick<WatchedTarget, 'kind' | 'chain' | 'ca' | 'domain' | 'handle'>): FingerprintKind | null {
  if (t.kind === 'SITE') return t.domain ? 'site' : null;
  if (t.kind === 'COIN') {
    const chain = chainFromDb(t.chain);
    if (!chain || !t.ca) return null;
    return chain === 'sol' ? 'mint' : 'contract';
  }
  if (t.kind === 'POST') return t.handle ? 'profile' : null;
  return null;
}

/**
 * The page a site target is fingerprinted from: the origin of the address people checked (its scheme and port, as
 * the latest check's input gave them), else https://<domain>/. Always the root page, whatever deep link was pasted.
 */
export function siteUrl(domain: string, targetRaw: string | null): string {
  const d = targetRaw ? detect(targetRaw) : null;
  if (d && d.kind === 'site' && d.domain === domain) {
    try {
      return new URL('/', d.url).toString();
    } catch {
      /* fall through */
    }
  }
  return `https://${domain}/`;
}

export async function siteFingerprint(sources: Pick<Sources, 'http'>, url: string): Promise<Fingerprint> {
  try {
    const res = await sources.http.request(url, {
      guard: true,
      timeoutMs: SITE_TIMEOUT_MS,
      maxBytes: SITE_MAX_BYTES,
      headers: { accept: 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.5', 'accept-language': 'en' },
    });
    if (!res.ok) return failed('site', `HTTP ${res.status}`);
    const type = res.headers['content-type'] ?? '';
    if (type && !/html|xml|text\/plain/i.test(type)) return failed('site', `not a page (${type.split(';')[0]})`, false);
    const title = /<title\b[^>]*>([\s\S]*?)<\/title\s*>/i.exec(res.text)?.[1] ?? null;
    // a 200 bot challenge ("Just a moment...") is not the site: never compare it
    const wall = detectBotWall(res.status, res.headers, title) ?? detectBotWall(403, null, title);
    if (wall) return failed('site', wall);
    const text = siteFingerprintText(res.text);
    if (!text) return failed('site', 'the page has no text');
    return { ok: true, kind: 'site', value: stamp('site', text) };
  } catch (e) {
    return failed('site', errText(e));
  }
}

/**
 * EVM contract: code, owner(), the mint selector scan, and the logic behind a proxy (its address and code: a proxy's
 * own bytecode never changes on an upgrade). Any RPC error → not compared.
 */
export async function evmFingerprint(sources: Pick<Sources, 'evm'>, chain: ChainKey, ca: string): Promise<Fingerprint> {
  if (!sources.evm.chains().includes(chain)) return failed('contract', `no RPC for ${chain}`, false);
  const { value, errors } = await captureErrors(async () => {
    const [code, basics] = await Promise.all([sources.evm.getCode(chain, ca), sources.evm.tokenBasics(chain, ca)]);
    const impl = basics?.implementation?.toLowerCase() ?? null;
    const implCode = impl ? await sources.evm.getCode(chain, impl) : null;
    return { code, basics, impl, implCode };
  });
  if (errors.length) return failed('contract', errors[0]);
  const { code, basics, impl, implCode } = value;
  if (code == null) return failed('contract', 'code could not be read');
  if (code === '0x') return failed('contract', 'no contract at the address');
  if (!basics) return failed('contract', 'token could not be read');
  if (impl && implCode == null) return failed('contract', 'the implementation behind the proxy could not be read');
  const parts = [
    `code:${sha256(code.toLowerCase())}`,
    `owner:${basics.owner?.toLowerCase() ?? 'none'}`,
    `mint:${String(basics.hasMintFunction)}`,
    `impl:${impl ?? 'none'}`,
    `implcode:${implCode ? sha256(implCode.toLowerCase()) : 'none'}`,
  ];
  return { ok: true, kind: 'contract', value: stamp('contract', parts.join('|')) };
}

/** Solana mint: mint authority, freeze authority, token program, Token-2022 extension settings. */
export async function solFingerprint(sources: Pick<Sources, 'sol'>, mint: string): Promise<Fingerprint> {
  const { value: info, errors } = await captureErrors(() => sources.sol.mintInfo(mint));
  if (errors.length) return failed('mint', errors[0]);
  if (!info) return failed('mint', 'mint could not be read');
  if (!info.exists) return failed('mint', 'mint account not found');
  const parts = [`mint:${info.mintAuthority ?? 'none'}`, `freeze:${info.freezeAuthority ?? 'none'}`, `program:${info.token2022 ? 'token-2022' : 'spl-token'}`];
  if (info.token2022) parts.push(`ext:${(info.extensions ?? []).join(';')}`);
  return { ok: true, kind: 'mint', value: stamp('mint', parts.join('|')) };
}

/** Tron (TRC-20): owner and the mint selector scan (TronGrid has no plain code read here). */
export async function tronFingerprint(sources: Pick<Sources, 'tron'>, ca: string): Promise<Fingerprint> {
  const { value: info, errors } = await captureErrors(() => sources.tron.tokenInfo(ca));
  if (errors.length) return failed('contract', errors[0]);
  if (!info) return failed('contract', 'token could not be read');
  const parts = [`owner:${info.owner ?? 'none'}`, `mint:${String(info.hasMintFunction ?? null)}`];
  return { ok: true, kind: 'contract', value: stamp('contract', parts.join('|')) };
}

/** X profile: display name, bio and profile link (only with the X API configured). */
export async function profileFingerprint(sources: Pick<Sources, 'x'>, handle: string): Promise<Fingerprint> {
  if (!sources.x.configured) return failed('profile', 'X API not configured', false);
  const { value: user, errors } = await captureErrors(() => sources.x.getUser(handle));
  if (errors.length) return failed('profile', errors[0]);
  if (!user) return failed('profile', 'account could not be read');
  const norm = (s: string | null | undefined) => (s ?? '').replace(/\s+/g, ' ').trim();
  const parts = [`name:${norm(user.name)}`, `bio:${norm(user.description)}`, `url:${norm(user.url)}`];
  return { ok: true, kind: 'profile', value: stamp('profile', parts.join('|')) };
}

/** The target's fingerprint now. `targetRaw` (the latest check's input) gives a site's scheme and port. */
export async function fingerprintTarget(sources: Sources, t: WatchedTarget, targetRaw: string | null): Promise<Fingerprint> {
  const kind = fingerprintKind(t);
  if (!kind) return failed(null, 'not watched for changes', false);
  if (kind === 'site') return siteFingerprint(sources, siteUrl(t.domain!, targetRaw));
  if (kind === 'profile') return profileFingerprint(sources, t.handle!);
  const chain = chainFromDb(t.chain)!;
  if (kind === 'mint') return solFingerprint(sources, t.ca!);
  if (chain === 'trx') return tronFingerprint(sources, t.ca!);
  return evmFingerprint(sources, chain, t.ca!);
}
