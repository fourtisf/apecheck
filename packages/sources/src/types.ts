/**
 * Contract for every external data source (HANDOFF §2 packages/sources, §4 Stage A/D).
 * The worker pipeline and the bot code against these interfaces only.
 * Implementations: one file per adapter in src/adapters/*, assembled by createSources() in src/index.ts.
 *
 * Rules every adapter follows:
 *  - Missing key/URL → the adapter is a stub: `configured === false`, methods resolve to null/[]
 *    (never throw for "not configured"), and it logs one clear warning via warnOnce().
 *  - Network/HTTP errors → resolve null/[] and record the reason in `lastError` (never crash a check).
 *  - Every call has a timeout. No call follows a URL the user controls without the SSRF guard.
 *
 * Change this file only additively (new optional fields / new methods).
 */
import type { ChainKey, Env } from '@apecheck/core';

/* ---------------- HTTP ---------------- */

export interface HttpRequest {
  method?: 'GET' | 'POST' | 'HEAD';
  headers?: Record<string, string>;
  /** a string (JSON, form) or raw bytes (multipart uploads); ignored for GET/HEAD */
  body?: string | Buffer;
  /** default 10 000 */
  timeoutMs?: number;
  /** stop reading after this many bytes (default 2 MB) */
  maxBytes?: number;
  /**
   * true for URLs that come from users or from scraped pages: DNS is resolved and pinned,
   * private/loopback/link-local/metadata targets are refused (SsrfError), redirects are re-checked.
   * Adapters calling fixed public APIs (DexScreener, GitHub…) may leave it false.
   */
  guard?: boolean;
  /** follow redirects (default true, max 5, each hop re-checked when guard is on) */
  redirect?: boolean;
}
export interface HttpResponse {
  status: number;
  ok: boolean;
  url: string;
  finalUrl: string;
  headers: Record<string, string>;
  text: string;
  /** set when the body was cut at maxBytes */
  truncated: boolean;
  ms: number;
}
export interface Http {
  request(url: string, req?: HttpRequest): Promise<HttpResponse>;
  /** GET + JSON.parse; throws on non-2xx or bad JSON */
  json<T = unknown>(url: string, req?: HttpRequest): Promise<T>;
}

/* ---------------- SSRF guard (src/ssrf.ts, src/guard-proxy.ts) ---------------- */

export interface SsrfCheck {
  ok: boolean;
  url?: URL;
  /** resolved, vetted addresses */
  addresses?: string[];
  /** e.g. "private address 10.0.0.5", "blocked scheme file:", "metadata host" */
  reason?: string;
}

/**
 * Local forward proxy Chromium is pointed at (--proxy-server). For every CONNECT / absolute-URI request it
 * resolves the host itself, refuses private/loopback/link-local/ULA/metadata addresses, and connects to the
 * vetted IP (so DNS rebinding between check and connect is impossible). Chains to OUTBOUND_PROXY when set.
 */
export interface GuardProxy {
  /** e.g. "http://127.0.0.1:38211" */
  url: string;
  /** hosts refused so far, with the reason (for the step log) */
  blocked: { host: string; reason: string }[];
  close(): Promise<void>;
}

/* ---------------- DexScreener ---------------- */

export interface DexTokenInfo {
  chain: ChainKey;
  address: string;
  name: string | null;
  symbol: string | null;
  priceUsd: number | null;
  mc: number | null;
  fdv: number | null;
  liquidityUsd: number | null;
  vol5m: number | null;
  vol24h: number | null;
  /** 24h price change % */
  ch24: number | null;
  pairAddress: string | null;
  pairUrl: string | null;
  dex: string | null;
  pairCreatedAt: string | null;
  /** project websites from token info */
  websites: string[];
  /** socials from token info: { type: "twitter" | "telegram" | ..., url } */
  socials: { type: string; url: string }[];
  imageUrl: string | null;
}
export interface DexScreenerSource {
  configured: boolean;
  /** last non-fatal error (also reported to the current captureErrors() scope) */
  readonly lastError?: string | null;
  /** Best (most liquid) pair for a token. chain=null searches every chain. */
  token(chain: ChainKey | null, address: string): Promise<DexTokenInfo | null>;
  /** Many tokens at once (price tracker). Returns a map keyed by lowercase address. */
  tokens(chain: ChainKey, addresses: string[]): Promise<Map<string, DexTokenInfo>>;
  search(query: string): Promise<DexTokenInfo[]>;
}

/* ---------------- Chains ---------------- */

export interface EvmTxRequest { from: string; to?: string | null; data?: string | null; value?: string | null; gas?: string | null }
export interface SimResult { ok: boolean; error?: string | null; gas?: string | null; logs?: string[] }

export interface EvmTokenBasics {
  name: string | null;
  symbol: string | null;
  decimals: number | null;
  totalSupply: string | null;
  /** owner() result, null if no owner() */
  owner: string | null;
  /**
   * owner is 0x0 / dead, or no owner function and nothing else that controls the supply (no role-based
   * access control, no mint function); null when who controls the token is unknown
   */
  ownerRenounced: boolean | null;
  /**
   * bytecode exposes a mint-like selector (mint(address,uint256) etc.), the logic behind a proxy included; null when
   * unknown (no code, or the proxy's implementation couldn't be read)
   */
  hasMintFunction: boolean | null;
  /**
   * The logic contract behind a proxy (EIP-1167 target, EIP-1967 implementation slot or beacon), lowercase; null when
   * the token is not such a proxy, or when it couldn't be read (the failure is reported). Optional so test fakes need
   * not set it.
   */
  implementation?: string | null;
}
export interface EvmSource {
  /** last non-fatal error (also reported to the current captureErrors() scope) */
  readonly lastError?: string | null;
  /** chains with an RPC available (env RPC_* or a public fallback) */
  chains(): ChainKey[];
  /**
   * HANDOFF Stage A: try Base, Ethereum, BNB, Arbitrum, Robinhood Chain in order until code exists. A chain
   * whose RPC fails before the answer is retried once; chains that still didn't answer (and come before the
   * returned chain, or all of them when it is null) are reported as `evm.getCode <chain>: …` errors.
   */
  detectChain(address: string): Promise<ChainKey | null>;
  getCode(chain: ChainKey, address: string): Promise<string | null>;
  tokenBasics(chain: ChainKey, address: string): Promise<EvmTokenBasics | null>;
  /** eth_call + eth_estimateGas, never eth_sendTransaction */
  simulate(chain: ChainKey, tx: EvmTxRequest): Promise<SimResult>;
  /** contract creator (Etherscan V2 getcontractcreation); null when unavailable */
  creator(chain: ChainKey, address: string): Promise<{ creator: string; txHash: string | null; createdAt: string | null } | null>;
  /**
   * M3 (tiers): ERC-20 balance of `owner` in whole tokens (`balanceOf(owner)` / 10^`decimals()`, both via eth_call).
   * null when it couldn't be read (no RPC, transport error, no ERC-20 at `token`, no decimals()); the reason is in
   * lastError. Never 0 for "unknown". Optional on the interface so test fakes need not stub it (see EvmWalletSource).
   */
  tokenBalance?(chain: ChainKey, token: string, owner: string): Promise<number | null>;
  /**
   * M3 (wallet sign-in, smart wallets): EIP-1271 `isValidSignature(bytes32 hash, bytes signature)` on the contract
   * at `address` via eth_call. true only when its first 32-byte return word is the magic value 0x1626ba7e ABI-encoded
   * (left-aligned, zero-padded: ERC1271_MAGIC_WORD); false when it returns anything else (a shorter answer, call data
   * echoed back) or reverts (also: no contract there, a precompile); null when the chain didn't answer (no RPC,
   * timeout, HTTP error).
   */
  isValidSignature?(chain: ChainKey, address: string, hash: string, signature: string, opts?: { timeoutMs?: number }): Promise<boolean | null>;
}
/** The EVM source with the M3 wallet methods present (what createEvm() and createSources().evm return). */
export type EvmWalletSource = EvmSource & Required<Pick<EvmSource, 'tokenBalance' | 'isValidSignature'>>;

export interface SolMintInfo {
  exists: boolean;
  decimals: number | null;
  supply: string | null;
  mintAuthority: string | null;
  freezeAuthority: string | null;
  /** token-2022 program? */
  token2022: boolean;
  /**
   * Token-2022 only: its extensions, each with the settings that only change when an authority acts (transfer fee
   * and its authorities, transfer hook program, permanent delegate, pause, default account state, close authority…),
   * as sorted "<extension> <field>=<value> …" strings; balances and other counters are left out.
   */
  extensions?: string[];
}
export interface SolanaSource {
  configured: boolean;
  /** last non-fatal error (also reported to the current captureErrors() scope) */
  readonly lastError?: string | null;
  mintInfo(mint: string): Promise<SolMintInfo | null>;
  /** top accounts by balance with % of supply (getTokenLargestAccounts + owners) */
  largestHolders(mint: string): Promise<{ owner: string | null; account: string; amount: string; pct: number }[]>;
  /** simulateTransaction (sigVerify false). Never sendTransaction. */
  simulate(txBase64: string): Promise<SimResult>;
  /**
   * M3 (tiers): how many `mint` tokens `owner` holds, in whole tokens: getTokenAccountsByOwner (jsonParsed) filtered
   * by the mint (the RPC resolves SPL Token or Token-2022), the accounts summed. null when it couldn't be read (the
   * query failed, bad address); 0 when the wallet has no account of the mint. Optional on the interface so test
   * fakes need not stub it (see SolanaWalletSource).
   */
  tokenBalance?(owner: string, mint: string): Promise<number | null>;
}
/** The Solana source with the M3 wallet method present (what createSolana() and createSources().sol return). */
export type SolanaWalletSource = SolanaSource & Required<Pick<SolanaSource, 'tokenBalance'>>;

export interface TronSource {
  configured: boolean;
  /** last non-fatal error (also reported to the current captureErrors() scope) */
  readonly lastError?: string | null;
  tokenInfo(address: string): Promise<{
    name: string | null; symbol: string | null; decimals: number | null; totalSupply: string | null; owner: string | null; creator: string | null;
    /** bytecode exposes a mint-like selector (same scan as EVM) */
    hasMintFunction?: boolean | null;
    /** owner is the zero address, or no owner function and nothing else that controls the supply (see EvmTokenBasics) */
    ownerRenounced?: boolean | null;
  } | null>;
}

/* ---------------- GitHub ---------------- */

export interface RepoFacts {
  fullName: string;
  url: string;
  fork: boolean;
  stars: number;
  createdAt: string | null;
  pushedAt: string | null;
  /** total commits on the default branch (from the Link header pagination trick) */
  commits: number;
  contributors: number;
  firstCommit: string | null;
  lastCommit: string | null;
  /** ISO dates of up to the last 100 commits (for burst detection) */
  recentCommitDates: string[];
  description: string | null;
}
export interface GitHubSource {
  configured: boolean;
  /** last non-fatal error (also reported to the current captureErrors() scope) */
  readonly lastError?: string | null;
  /** owner/repo or https://github.com/owner[/repo] → facts for that repo or the owner's top repos */
  fromUrl(url: string): Promise<RepoFacts[]>;
  /** fallback: search orgs/repos by project name; returns the best matches (max 3) */
  searchByName(name: string): Promise<RepoFacts[]>;
}

/* ---------------- X (free embed reads for checks; API v2 for the bot in M2) ---------------- */

export interface XUser {
  id: string;
  handle: string;
  name: string;
  createdAt: string | null;
  followers: number | null;
  following: number | null;
  verified: boolean | null;
  description: string | null;
  /** expanded profile URL (entities.url) */
  url: string | null;
  /** expanded URLs in the bio */
  bioUrls: string[];
  pinnedTweetId: string | null;
  pinnedText: string | null;
}
export interface XPost {
  id: string;
  text: string;
  authorId: string;
  authorHandle: string | null;
  authorName: string | null;
  createdAt: string | null;
  conversationId: string | null;
  /** expanded URLs from entities (t.co resolved) */
  urls: string[];
  mentions: string[];
  /**
   * Numeric user ids of the accounts this post @mentions (entities.mentions[].id, else looked up by username in the
   * response's includes.users), X's reply prefix included. Unresolvable handles are left out. The bot passes them,
   * minus the asker, as `XReplyOptions.excludeUserIds` so a reply notifies only the asker.
   */
  mentionUserIds?: string[];
  cashtags: string[];
  /** referenced_tweets type replied_to */
  replyToId: string | null;
  quotedId: string | null;
  author?: XUser | null;
  /**
   * mentions() and the syndication read of getPost(): [start, end) of the part the author typed, as JS string indices into `text`. For a reply,
   * X puts the auto-added @mentions of the thread before `start`; a mention the author typed is at or after it.
   * null when X sent no range.
   */
  displayTextRange?: [number, number] | null;
  /** mentions() and the syndication read of getPost(): the author of the post this one replies to (in_reply_to_user_id) */
  inReplyToUserId?: string | null;
  /**
   * mentions() only: the post this one replies to, taken from the same response (includes.tweets, with its
   * author). null when it is not a reply, or X didn't include the parent (deleted, protected, no access):
   * then use `replyToId` + getPost(). getPost() fills it too when the embed payload carries the parent.
   */
  repliedTo?: XPost | null;
}
export interface XSource {
  /** X_BEARER_TOKEN is set (paid app-only reads: the bot's fallbacks only; checks never need it) */
  configured: boolean;
  /** last non-fatal error (also reported to the current captureErrors() scope) */
  readonly lastError?: string | null;
  /** posting/media need the OAuth 1.0a user keys (bot, M2) */
  canPost: boolean;
  /**
   * A post through X's free embed endpoints (syndication, then oEmbed): no key and no X API credits, so checks can
   * call it. No account data (`author` has handle and name only). `handle` only helps the oEmbed fallback.
   */
  getPost(id: string, handle?: string | null): Promise<XPost | null>;
  /** Paid X API account read (Bearer). The bot only (its own id, a mention author's age); checks never call it. */
  getUser(handle: string): Promise<XUser | null>;
  /** Paid X API account read (Bearer). The bot only; checks never call it. */
  getUserById(id: string): Promise<XUser | null>;
  /** Handle-rename history needs a third-party source: stub, always null for now (HANDOFF §4 Stage D). */
  renameCount(handle: string): Promise<number | null>;
  /**
   * M2: mentions of the bot newer than `sinceId` (GET /2/users/:id/mentions, OAuth 1.0a owned read; Bearer when
   * only X_BEARER_TOKEN is set), oldest first, each with `author` (incl. createdAt), `displayTextRange`,
   * `inReplyToUserId` and `repliedTo`. `newestId` is the next since_id; it is null when nothing new arrived OR
   * the walk was cut short (rate limit / error on a later page): keep the old since_id then — the posts that did
   * arrive are still returned, and re-reading them is harmless because BotMention is unique on the tweet id.
   * Never throws; reasons go to lastError. A stub (no keys / no bot user id) returns { posts: [], newestId: null }.
   */
  mentions?(sinceId: string | null): Promise<{ posts: XPost[]; newestId: string | null }>;
  /**
   * M2: reply to `inReplyToId` (POST /2/tweets, OAuth 1.0a) with the PNG attached when given (v2 chunked media
   * upload; if the upload fails the text is posted alone). Returns the new post id, or null (not configured,
   * duplicate content, rate limit, 4xx/5xx — the reason is in lastError). Never throws.
   * X fills a v2 reply's "Replying to" list by itself (the replied-to post's author plus every account it mentions):
   * pass `opts.excludeUserIds` to take everyone but that author out (reply.exclude_reply_user_ids).
   */
  reply?(inReplyToId: string, text: string, mediaPng?: Buffer | null, opts?: XReplyOptions): Promise<string | null>;
  /**
   * M2: the id of the bot's own reply to `inReplyToId`, or null when it posted none (GET /2/users/:id/tweets since
   * that post, OAuth 1.0a owned read). Used before posting again after a reply whose outcome is unknown (timeout,
   * 5xx). THROWS when the lookup fails: a failed lookup is never "not posted".
   */
  findReply?(inReplyToId: string): Promise<string | null>;
}
export interface XReplyOptions {
  /**
   * User ids X must leave out of the reply's auto-filled mentions (reply.exclude_reply_user_ids): everyone the
   * replied-to post names except its own author, whom X always keeps (the leading @mention; never pass that id).
   * Non-numeric ids and the bot's own id are dropped; duplicates are sent once. More than X_REPLY_EXCLUDE_MAX ids:
   * nothing is posted (null, lastError) rather than a reply that notifies the ones left over.
   */
  excludeUserIds?: readonly string[] | null;
}
/**
 * The X source with the bot methods present: what createX() and createSources().x return (worker-bot calls
 * mentions() and reply() on it). They stay optional on XSource so test fakes of the read side need not stub them.
 */
export type XBotSource = XSource & Required<Pick<XSource, 'mentions' | 'reply'>>;

/* ---------------- Fourtis internal (DevRadar, BundleScan, WhaleFlow) ---------------- */

export interface DevRadarFacts {
  deployer: string;
  fundedFrom: string | null;
  launched: number;
  dead: number;
  firstSeen: string | null;
  launches?: { address: string; chain: ChainKey | null; createdAt: string | null; dead: boolean }[];
}
export interface BundleScanFacts { bundlePct: number; wallets: number; launchBlock?: string | null }
export interface WhaleFlowFacts {
  /** % of supply in the top 10 holders, excluding LP */
  top10Pct: number;
  devHoldPct: number;
  holders: number | null;
  lp?: { status: 'burned' | 'locked' | 'unlocked'; lockedDays?: number | null } | null;
  /** M4: wallet clusters (groups funded from one source), when WhaleFlow provides them */
  clusters?: HolderCluster[] | null;
}
/**
 * M4 (Pro/Max "deep holder clusters"): one group of holder wallets WhaleFlow ties together (funded from the same
 * source). `pct` = % of supply the group holds, `wallets` = how many wallets. Placeholder shape until the real
 * WhaleFlow feed lands (adapters/fourtis.ts WhaleClusterZ).
 */
export interface HolderCluster { label: string; wallets: number; pct: number; fundedFrom: string | null }
export interface FourtisSource {
  configured: boolean;
  /** last non-fatal error (also reported to the current captureErrors() scope) */
  readonly lastError?: string | null;
  devRadar(chain: ChainKey, address: string): Promise<DevRadarFacts | null>;
  bundleScan(chain: ChainKey, address: string): Promise<BundleScanFacts | null>;
  whaleFlow(chain: ChainKey, address: string): Promise<WhaleFlowFacts | null>;
}

/* ---------------- Assembled coin facts (Stage D, coins only) ---------------- */

export type FactSource = 'DevRadar' | 'BundleScan' | 'WhaleFlow' | 'On-chain' | 'DexScreener';

/**
 * Raw facts for one coin, Fourtis first, public fallbacks second. Signals are NOT computed here:
 * the worker maps these to ok/warn/fail with the thresholds in @apecheck/core (config.ts / scoring.ts).
 * A null section means "unknown" (the worker scores it as warn and logs why).
 */
export interface CoinRawFacts {
  chain: ChainKey;
  address: string;
  token: { name: string | null; symbol: string | null; decimals: number | null; supply: string | null } | null;
  deployer: {
    address: string;
    fundedFrom: string | null;
    /** null = unknown launch history (no DevRadar) */
    launched: number | null;
    dead: number | null;
    firstSeen: string | null;
    source: FactSource;
  } | null;
  bundle: { pct: number; wallets: number | null; source: FactSource } | null;
  holders: { top10Pct: number | null; devHoldPct: number | null; count: number | null; source: FactSource } | null;
  lp: { status: 'burned' | 'locked' | 'unlocked'; lockedDays: number | null; source: FactSource } | null;
  authorities: {
    /** Solana: mint authority null; EVM: no mint function or owner renounced */
    mintRenounced: boolean | null;
    /** Solana freeze authority set (EVM: blacklist/pause functions present when detectable) */
    freezeActive: boolean | null;
    owner: string | null;
    /** "Mint renounced, freeze active" style sentence */
    text: string;
    source: FactSource;
  } | null;
  market: DexTokenInfo | null;
  /**
   * M4: WhaleFlow's holder clusters, largest first. Only present when WhaleFlow answered with at least one valid
   * cluster: never filled from a fallback, never empty (nothing to store), never invented.
   */
  clusters?: HolderCluster[];
  /** adapters that ran as stubs for this coin, e.g. ["fourtis", "helius"] */
  stubbed: string[];
  /** non-fatal errors, e.g. ["bundleScan: timeout"] */
  errors: string[];
}

/* ---------------- Aggregate ---------------- */

export interface Sources {
  env: Env;
  http: Http;
  dex: DexScreenerSource;
  evm: EvmSource;
  sol: SolanaSource;
  tron: TronSource;
  github: GitHubSource;
  x: XSource;
  fourtis: FourtisSource;
  /** Stage D for coins: Fourtis first, then on-chain/DexScreener fallbacks. Never throws. */
  coinFacts(chain: ChainKey, address: string): Promise<CoinRawFacts>;
  /** names of adapters currently running as stubs (missing keys), e.g. ["x", "fourtis", "etherscan"] */
  stubbed(): string[];
}
