/**
 * PLACEHOLDER — the sources build step implements createSources(). Signature is the contract.
 */
import type { Env } from '@apecheck/core';
import type { Sources } from './types';

export * from './types';
export { SsrfError, isBlockedIp, checkUrl, assertPublicUrl, startGuardProxy, type SsrfOptions } from './ssrf';

export function createSources(_env: Env): Sources {
  throw new Error('createSources not implemented yet');
}
