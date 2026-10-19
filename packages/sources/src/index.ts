/**
 * @apecheck/sources — every external data source behind the contract in ./types.
 * createSources(env) wires the adapters; missing keys turn an adapter into a stub (see README).
 */
import { CHAINS, type ChainKey, type Env } from '@apecheck/core';
import type { EvmWalletSource, Http, SolanaWalletSource, Sources, XBotSource } from './types';
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
export {
  createEvm, EvmAdapter, EVM_READ_METHODS, PUBLIC_EVM_RPC, DETECT_RETRY_DELAY_MS, ERC1271_MAGIC, ERC1271_MAGIC_WORD, ERC1271_TIMEOUT_MS, encodeIsValidSignature,
  type EvmOptions,
} from './adapters/evm';
export { createSolana, SolanaAdapter, SOL_READ_METHODS, SPL_TOKEN_PROGRAM, TOKEN_2022_PROGRAM, solanaRpcUrl } from './adapters/solana';
export { toUnits } from './util';
export { base58Decode, base58Encode } from './base58';
export { createTron, TronAdapter } from './adapters/tron';
export { createGitHub, GitHubAdapter, parseGitHubRef } from './adapters/github';
export { createX, XAdapter, X_REPLY_EXCLUDE_MAX, type XOptions } from './adapters/x';
export { signRequest, oauth1Header, percentEncode, type OAuth1Credentials, type OAuth1Request } from './oauth1';
export { createFourtis, FourtisAdapter, FOURTIS_PATHS } from './adapters/fourtis';

/**
 * Build every adapter from the parsed env. `http` can be injected (tests); by default one shared client
 * honours OUTBOUND_PROXY and SSRF_ALLOW_HOSTS. `x` is the full X adapter, bot methods included (mentions() / reply(),
 * which need the OAuth 1.0a user keys: see `x.canPost`).
 */
export function createSources(env: Env, opts: { http?: Http } = {}): Sources & { x: XBotSource; evm: EvmWalletSource; sol: SolanaWalletSource } {
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

/**
 * M3 (tiers): whole `token` tokens held by `owner` on `chain`: Solana → sol.tokenBalance(owner, mint), an EVM chain →
 * evm.tokenBalance(chain, token, owner). null when it couldn't be read, or for a chain without a balance reader (Tron).
 */
export function walletTokenBalance(
  src: { evm: Pick<EvmWalletSource, 'tokenBalance'>; sol: Pick<SolanaWalletSource, 'tokenBalance'> },
  chain: ChainKey,
  token: string,
  owner: string,
): Promise<number | null> {
  const family = CHAINS[chain]?.family;
  if (family === 'sol') return src.sol.tokenBalance(owner, token);
  if (family === 'evm') return src.evm.tokenBalance(chain, token, owner);
  return Promise.resolve(null);
}
