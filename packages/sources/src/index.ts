/**
 * @apecheck/sources — every external data source behind the contract in ./types.
 * createSources(env) wires the adapters; missing keys turn an adapter into a stub (see README).
 */
import type { Env } from '@apecheck/core';
import type { Http, Sources } from './types';
import { createHttp } from './http';
import { createDexScreener } from './adapters/dexscreener';
import { createEvm } from './adapters/evm';
import { createSolana } from './adapters/solana';
import { createTron } from './adapters/tron';
import { createGitHub } from './adapters/github';
import { createX } from './adapters/x';
import { createFourtis } from './adapters/fourtis';
import { coinFacts } from './coin-facts';

export * from './types';
export {
  SsrfError, isBlockedIp, ipBlockReason, checkUrl, assertPublicUrl, startGuardProxy, vetHost, vetUrl, isProduction,
  type SsrfOptions, type HostVetting, type UrlVetting,
} from './ssrf';
export { createHttp, HttpError, USER_AGENT, DEFAULT_TIMEOUT_MS, DEFAULT_MAX_BYTES, MAX_REDIRECTS, type HttpEnv, type HttpOptions } from './http';
export { captureErrors, reportError, TimeoutError } from './util';
export { coinFacts, solanaAuthorityText, contractAuthorityText, contractMintRenounced, SOLANA_AMM_AUTHORITIES, type CoinFactsDeps } from './coin-facts';
export { createDexScreener, DexScreenerAdapter } from './adapters/dexscreener';
export { createEvm, EvmAdapter, EVM_READ_METHODS, PUBLIC_EVM_RPC, DETECT_RETRY_DELAY_MS, type EvmOptions } from './adapters/evm';
export { createSolana, SolanaAdapter, SOL_READ_METHODS, solanaRpcUrl } from './adapters/solana';
export { createTron, TronAdapter } from './adapters/tron';
export { createGitHub, GitHubAdapter, parseGitHubRef } from './adapters/github';
export { createX, XAdapter } from './adapters/x';
export { createFourtis, FourtisAdapter, FOURTIS_PATHS } from './adapters/fourtis';

/**
 * Build every adapter from the parsed env. `http` can be injected (tests); by default one shared client
 * honours OUTBOUND_PROXY and SSRF_ALLOW_HOSTS.
 */
export function createSources(env: Env, opts: { http?: Http } = {}): Sources {
  const http = opts.http ?? createHttp(env);
  const dex = createDexScreener(env, http);
  const evm = createEvm(env, http);
  const sol = createSolana(env, http);
  const tron = createTron(env, http);
  const github = createGitHub(env, http);
  const x = createX(env, http);
  const fourtis = createFourtis(env, http);

  const stubbed = (): string[] => {
    const out: string[] = [];
    if (!x.configured) out.push('x');
    if (!fourtis.configured) out.push('fourtis');
    out.push(...evm.stubs());
    return out;
  };

  return {
    env,
    http,
    dex,
    evm,
    sol,
    tron,
    github,
    x,
    fourtis,
    stubbed,
    coinFacts: (chain, address) => coinFacts({ fourtis, dex, evm, sol, tron, stubbed }, chain, address),
  };
}
