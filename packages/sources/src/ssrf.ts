/**
 * PLACEHOLDER — the sources build step replaces the bodies. Signatures are the contract.
 * SSRF guard (HANDOFF §11): block 10/8, 172.16/12, 192.168/16, 127/8, 169.254/16, 0/8, 100.64/10,
 * ::1, fc00::/7, fe80::/10, IPv4-mapped IPv6 of all of those, and metadata hosts. Non-http(s) schemes refused.
 */
import type { GuardProxy, SsrfCheck } from './types';

export class SsrfError extends Error {
  constructor(public readonly reason: string) {
    super(`Blocked by SSRF guard: ${reason}`);
    this.name = 'SsrfError';
  }
}

export interface SsrfOptions {
  /** DEV/TEST ONLY host[:port] allow-list (env SSRF_ALLOW_HOSTS); ignored when NODE_ENV=production */
  allowHosts?: string[];
  /** custom resolver for tests */
  lookup?: (host: string) => Promise<string[]>;
}

export function isBlockedIp(_ip: string): boolean {
  throw new Error('not implemented');
}
export async function checkUrl(_url: string, _opts?: SsrfOptions): Promise<SsrfCheck> {
  throw new Error('not implemented');
}
export async function assertPublicUrl(_url: string, _opts?: SsrfOptions): Promise<URL> {
  throw new Error('not implemented');
}
export async function startGuardProxy(_opts: SsrfOptions & { upstreamProxy?: string | null }): Promise<GuardProxy> {
  throw new Error('not implemented');
}
