# @apecheck/sources

Every external data source ApeCheck reads, behind the contract in `src/types.ts`, plus the SSRF guard
(HANDOFF §11). Node only (TypeScript source, run with tsx).

```ts
import { loadEnv } from '@apecheck/core/node';
import { createSources, startGuardProxy, captureErrors } from '@apecheck/sources';

const env = loadEnv();
const sources = createSources(env);           // one shared Http client, all adapters
sources.stubbed();                            // e.g. ["x", "etherscan", "rpc-rh"]
const facts = await sources.coinFacts('sol', mint); // never throws; facts.errors / facts.stubbed explain gaps
```

## Rules every adapter follows

- **Missing key or URL → stub.** `configured === false` (where the interface has it), methods resolve
  `null` / `[]` without a request, and one warning is logged per process via `warnOnce()`, e.g.
  `[apecheck] WARN X API not configured (X_BEARER_TOKEN empty): post and account lookups are skipped`.
- **Network / HTTP / shape errors → `null` / `[]`**, never a throw. The reason is kept in `adapter.lastError`
  (`"<adapter>.<method>: <reason>"`) and is also pushed to the current `captureErrors()` scope, which is
  how `coinFacts` (and the worker) get per-call errors without mixing up checks that run concurrently:

  ```ts
  const { value, errors } = await captureErrors(() => sources.github.fromUrl(url));
  ```
- **Every call has a timeout** (8–10 s per request; `coinFacts` adds an 8 s cap per call).
- All responses are validated with zod before they are mapped.

## Adapters

| Adapter | File | Env | Stub / fallback behaviour |
|---|---|---|---|
| DexScreener | `adapters/dexscreener.ts` | `DEXSCREENER_BASE` (default `https://api.dexscreener.com`) | Public API, never stubbed. |
| EVM RPC | `adapters/evm.ts` | `RPC_BASE`, `RPC_ETH`, `RPC_BSC`, `RPC_ARB`, `RPC_ROBINHOOD` | Public fallbacks: Base `https://mainnet.base.org`, Ethereum `https://ethereum-rpc.publicnode.com`, BNB `https://bsc-dataseed.binance.org`, Arbitrum `https://arb1.arbitrum.io/rpc`. Robinhood Chain only from env; without it `rh` is skipped and listed as `rpc-rh`. |
| Etherscan V2 | `adapters/evm.ts` (`creator()`) | `ETHERSCAN_API_KEY` | Without a key `creator()` is `null`, listed as `etherscan`. |
| Solana RPC | `adapters/solana.ts` | `RPC_SOLANA`, `HELIUS_API_KEY` | `RPC_SOLANA`, else `https://mainnet.helius-rpc.com/?api-key=…`, else the public `https://api.mainnet-beta.solana.com` (rate limited, warned once). |
| TronGrid | `adapters/tron.ts` | `TRONGRID_API_KEY` (header `TRON-PRO-API-KEY`) | Works without a key at a low rate. |
| GitHub | `adapters/github.ts` | `GITHUB_TOKEN` | Works unauthenticated at 60 requests/hour (warned once). Rate limits (403 with `x-ratelimit-remaining: 0`, or 429) → `[]` + `lastError`. |
| X API v2 | `adapters/x.ts`, `oauth1.ts` | `X_BEARER_TOKEN` (reads); `X_API_KEY`, `X_API_SECRET`, `X_ACCESS_TOKEN`, `X_ACCESS_SECRET` (`canPost`: the bot); `X_BOT_USER_ID` (optional), `X_BOT_HANDLE` | Without the bearer token every post/account read is `null`, listed as `x`. `renameCount()` is always `null` (needs a third-party source). Without the four user keys `reply()` is `null` and `mentions()` uses the Bearer token, or returns `{ posts: [], newestId: null }` when that is missing too (warned once each). |

### What each one does

- **DexScreener** — `token(chain, a)`: `GET /tokens/v1/{dexChainId}/{a}` (or `/latest/dex/tokens/{a}` when the
  chain is unknown), keeps pairs where the token is the base token on a chain ApeCheck knows, picks the highest
  `liquidity.usd`. Maps price, market cap (fallback FDV), liquidity, 5 m / 24 h volume, 24 h change, pair
  address/URL/DEX, `pairCreatedAt` (ms → ISO), `info.websites[].url`, `info.socials[]` and `info.imageUrl`.
  `tokens(chain, list)`: batches of 30, map keyed by lowercase address. `search(q)`: `/latest/dex/search`.
- **EVM** — read-only JSON-RPC (`eth_getCode`, `eth_getStorageAt`, `eth_call`, `eth_estimateGas`, `eth_chainId`,
  `eth_blockNumber`; anything else is refused before a request is built). `detectChain` asks every chain at once
  and returns the first in `EVM_DETECT_ORDER` with code. A chain whose RPC failed before that answer (or when
  nothing was found) is asked once more after 500 ms (`detectRetryDelayMs`) before a later chain is accepted, and
  only chains that never answered are reported (`evm.getCode <chain>: …`), so the worker can say "Base RPC
  unavailable" next to an Ethereum hit. `tokenBasics` decodes ABI and bytes32 strings, reads
  `owner()` (fallback `getOwner()`), and scans bytecode opcodes for `PUSH4` mint selectors (`0x40c10f19`,
  `0xa0712d68`, `0x4e6ec247`); behind a proxy the implementation is scanned too and returned as `implementation`
  (EIP-1167 target, the EIP-1967 implementation slot, or `implementation()` of the EIP-1967 beacon; both slots are
  read at once). **A read the node did not run is never an answer:** an `eth_call` error counts as "the function
  isn't there" only when the contract ran and failed (code 3, "execution reverted", "invalid opcode", "out of gas",
  Nethermind's -32015 "VM execution error"); HTTP 429 / 5xx, -32005 rate limits, -32603, "header not found",
  "missing trie node", timeouts are failed reads (`isExecutionFailure`). An `owner()`/`getOwner()` failure is reported
  (`evm.tokenBasics owner <chain>`) and leaves `ownerRenounced` `null`; an unread proxy slot (`evm.implementation
  <chain>`) or implementation code leaves `hasMintFunction` `null`, never `false`. Owner
  `0x0` / `0x…dEaD` → `ownerRenounced`. No `owner()`/`getOwner()` counts as renounced only when the bytecode is
  known and shows nothing else that controls the supply: no owner selector, no role-based control (AccessControl
  `hasRole`/`grantRole`/`getRoleAdmin`/`revokeRole`/`MINTER_ROLE()`, AccessManaged `authority()`, MinterRole
  `isMinter`/`addMinter`) and no mint function. Otherwise `ownerRenounced` is `null` (a minter role, bridge or
  anyone may still mint: "Mint function present, owner unknown", authorities unknown → warn). `simulate()` = `eth_call` + `eth_estimateGas` with
  the decoded `Error(string)` / `Panic(uint256)` reason. **Never `eth_sendTransaction` / `eth_sendRawTransaction`.**
- **Solana** — `mintInfo` (`getAccountInfo` jsonParsed, SPL Token and Token-2022; a Token-2022 mint also gets
  `extensions`: each extension with the settings only an authority changes — transfer fee rate and authorities,
  transfer hook program, permanent delegate, pause, default account state, close authority… — never withheld fees
  or other counters), `largestHolders`
  (`getTokenLargestAccounts` + `getTokenSupply` + `getMultipleAccounts` for owners, % of supply),
  `simulate` (`simulateTransaction`, base64, `sigVerify: false`, `replaceRecentBlockhash: true`).
  **Never `sendTransaction`.**

## Wallet reads (M3: tiers and sign-in)

The API reads these for tiers by $APECHECK holding and smart-wallet sign-in; the worker can reuse them (with
`@apecheck/db` `computeTier`). They are optional on the `EvmSource` / `SolanaSource` interfaces (test fakes need not
stub them) and always present on the adapters: `createEvm()` / `createSolana()` / `createSources()` return
`EvmWalletSource` / `SolanaWalletSource`. Like every method they never throw; failures are `null` + `lastError`.

- `sol.tokenBalance(owner, mint)` — whole tokens: one `getTokenAccountsByOwner(owner, { mint }, { encoding:
  'jsonParsed' })` (the RPC resolves the mint's program, SPL Token or Token-2022), keeping the accounts of either token
  program whose `info.mint` is the mint and summing their raw `tokenAmount.amount` (exact BigInt) scaled by
  `decimals`. No account → `0`. The query failing → `null`. Never a `{ programId }` scan of the wallet: the owner sets
  its size (each spam token account adds ~500 bytes), so they could push it past the RPC size cap / timeout and make
  their own read fail at will.
- `evm.tokenBalance(chain, token, owner)` — `balanceOf(owner)` / 10^`decimals()` via `eth_call` on that chain
  (decimals cached per token). No ERC-20 at the address (revert / empty) or no `decimals()` → `null`, never a
  guessed scale.
- `evm.isValidSignature(chain, address, hash, signature, { timeoutMs = 4000 })` — EIP-1271:
  `isValidSignature(bytes32,bytes)` (selector `0x1626ba7e`, ABI-encoded by `encodeIsValidSignature`) via `eth_call`;
  `true` only when the first 32-byte word it returns is the magic value ABI-encoded (`0x1626ba7e` + 28 zero bytes,
  `ERC1271_MAGIC_WORD`, as OpenZeppelin's SignatureChecker requires), `false` for anything else or a revert (an EOA
  answers empty data). Matching only the first 4 bytes would accept any contract that echoes its call data (it starts
  with the same selector), e.g. the identity precompile `0x…04`; addresses below `0x10000` (precompiles) are `false`
  without a request. `null` when the chain didn't answer.
- `walletTokenBalance({ evm, sol }, chain, token, owner)` — picks the reader by chain family (Tron → `null`).
- The $APECHECK quote uses the existing `dex.token(TOKEN_CHAIN, TOKEN_ADDRESS)` (price, 24 h change).
- `base58Encode` / `base58Decode` and `toUnits(raw, decimals)` are exported for the API (Solana public keys).
- **Tron** — `/wallet/getcontract` (creator = `origin_address`, bytecode for the mint scan) and
  `/wallet/triggerconstantcontract` for `name/symbol/decimals/totalSupply/owner` (owner converted to base58check).
  A constant call is "not there" only when the contract answered (`CONTRACT_EXE_ERROR`, a run whose transaction
  `ret` is `FAILED`); an HTTP error (TronGrid's 429 without a key), `SERVER_BUSY` / `OTHER_ERROR` or an answer without
  a result is a failed read. For `owner()` that failure is reported (`tron.tokenInfo owner`) and leaves
  `ownerRenounced` `null`.
- **GitHub** — `fromUrl` accepts `owner/repo`, `github.com/owner[/repo]`, `owner.github.io`; an owner alone
  gives its top 3 non-fork repos by last push. Per repo: commits from `?per_page=100` (recent dates, last
  commit) plus, when there is more than one page, the `rel="last"` page (total = (pages − 1) × 100 + rows on the
  last page, first commit = its oldest row): two requests instead of three, which matters at 60 requests/hour.
  Contributors via `?per_page=1&anon=1` + `rel="last"`. `searchByName` = `/search/repositories?q=<name>+in:name`
  plus `/users/<name>` as an org guess (its repos first), max 3.
- **X** — `GET /2/tweets/:id` with `expansions=author_id,referenced_tweets.id`, the tweet/user fields from the
  spec plus `note_tweet` (full text of posts over 280 characters). URLs are the `unwound_url` / `expanded_url`
  (the post's own photo/video links are dropped), cashtags upper-cased, `replyToId` / `quotedId` from
  `referenced_tweets`. `getUser` / `getUserById` add `expansions=pinned_tweet_id` for `pinnedText`.
  The bot side (`mentions()`, `reply()`) is described in [X bot](#x-bot-m2) below.

## X bot (M2)

The bot (`apps/worker` bot queue) talks to X only through `sources.x.mentions()` and `sources.x.reply()`.
`createX()` and `createSources().x` are typed `XBotSource` (the `XSource` contract with both methods present; they stay
optional on `XSource` itself so read-only fakes need not stub them). Both never throw: failures resolve to empty / `null` and the reason is in `x.lastError` (and the current
`captureErrors()` scope).

**Keys.** All four OAuth 1.0a user keys of the bot account (`X_API_KEY` = consumer key, `X_API_SECRET` = consumer
secret, `X_ACCESS_TOKEN`, `X_ACCESS_SECRET`, from the X developer portal with Read and Write permission) make
`canPost` true. They stay in env only (HANDOFF §11). `X_BOT_USER_ID` is the bot's numeric user id; when it is empty
the adapter looks it up once per process (`GET /2/users/me` with the user keys, else `GET /2/users/by/username/
{X_BOT_HANDLE}` with the Bearer token) and warns once that setting it saves the call.

**Signing** (`src/oauth1.ts`, no dependency). OAuth 1.0a HMAC-SHA1 per RFC 5849: RFC 3986 percent-encoding;
base string = `METHOD&enc(base URL)&enc(sorted params)` where the params are the URL query + the `oauth_*` params
(+ the fields of an `application/x-www-form-urlencoded` body; JSON and multipart bodies are never signed); key =
`enc(consumerSecret)&enc(tokenSecret)`; header `Authorization: OAuth oauth_consumer_key="…", …`. Tested against
the X docs vectors ("Creating a signature" → `hCtSmYh+iHYCEqBWrE7C7hYmtUk=` for the 1.1 URL, "Authorizing a
request" → `tnnArxj06cWHq44gCs1OSKk/jLY=`, which that page computed for the v1 URL), the RFC 5849 §3.4.1 example,
and vectors from Python oauthlib. Signed requests never follow redirects.

**`mentions(sinceId)`** — `GET https://api.x.com/2/users/{id}/mentions`, an **owned read** (the cheapest read type
under pay-per-use) signed with the user keys; Bearer when only `X_BEARER_TOKEN` is set. Params: `since_id` (when
given), `max_results=100`, `expansions=author_id,referenced_tweets.id,referenced_tweets.id.author_id,entities.mentions.username`,
`tweet.fields=created_at,entities,conversation_id,referenced_tweets,author_id,in_reply_to_user_id,display_text_range,note_tweet`,
`user.fields=created_at,username,name,public_metrics,verified,description,entities,url`.

- Follows `meta.next_token` up to 5 pages when `sinceId` is set (more → the oldest are skipped, noted in `lastError`);
  with `sinceId = null` only the newest page is read, so the first poll doesn't answer an old backlog.
- Returns posts **oldest first**. Each `XPost` has `author` (with `createdAt` for the 7-day rule), plus
  `displayTextRange` (`[start, end)` as JS indices into `text`; X puts the auto-added reply @mentions before
  `start`, so a mention typed by the author is at or after it), `inReplyToUserId`, and `repliedTo`: the parent
  post from `includes.tweets` with its author (null when it is not a reply or X didn't include it — deleted or
  protected; use `replyToId` + `getPost()` then). Long posts use `note_tweet` text and entities.
- `mentionUserIds` (every `XPost`, `getPost()` too): the numeric ids of the accounts the post @mentions, X's reply
  prefix included — `entities.mentions[].id`, else the user `entities.mentions.username` expanded into
  `includes.users`; a handle that resolves to neither is left out. The bot stores them (minus the asker) and passes
  them back to `reply()` as `excludeUserIds`.
- `newestId` = `meta.newest_id` of the first page: the next `since_id`. It is `null` when nothing new arrived **or**
  the walk stopped on a later page (429 / error): keep the old `since_id`; the posts that did arrive are returned,
  and reading them again is harmless because `BotMention` is unique on the tweet id.
- 429: `lastError = "x.mentions: rate limited until <x-rate-limit-reset>"`, and calls before that time return
  empty without a request.

**`reply(inReplyToId, text, mediaPng?, { excludeUserIds }?)`** — returns the new post id or `null`.

X fills a v2 reply's "Replying to" list by itself: the author of `inReplyToId` plus every account that post
@mentions (its own reply prefix included), and each of them is notified. `excludeUserIds` takes them out
(`reply.exclude_reply_user_ids`): worker-bot passes everyone the mention names except its author, so a reply
notifies the asker only (HANDOFF §7; a project's account in the reply prefix is no longer notified by the verdict
under its post). Never pass the author of `inReplyToId`: X keeps that leading mention. Non-numeric ids and the bot's
own id (`X_BOT_USER_ID` or the looked-up one) are dropped and duplicates sent once; an empty list sends no key. More
than `X_REPLY_EXCLUDE_MAX` (100; X carries at most 50 accounts into a reply) → nothing is posted (`null`,
`x.reply: not posted: more than 100 accounts to leave out of the reply`, no request): the list is never cut, so
nobody left over gets notified.

1. With a PNG: the v2 chunked upload (the endpoints `twitter-api-v2@1.29.1` uses), all signed, no body params in
   the signature:
   `POST /2/media/upload/initialize` JSON `{ media_type: "image/png", total_bytes, media_category: "tweet_image" }` → `data.id`;
   `POST /2/media/upload/{id}/append` multipart/form-data `segment_index`, `media` (≤ 1 MB per chunk, 30 s timeout);
   `POST /2/media/upload/{id}/finalize`; when `data.processing_info` is set, `GET /2/media/upload?command=STATUS&media_id={id}`
   after `check_after_secs` (clamped 1–10 s, at most 10 polls / 60 s) until `succeeded`.
   **If any of that fails, the text is posted without the card** (`lastError = "x.uploadMedia: …"`, one warning line).
2. `POST /2/tweets` JSON `{ text, reply: { in_reply_to_tweet_id, exclude_reply_user_ids? }, media?: { media_ids: [id] } }` → `data.id`.

Failures → `null` + `lastError`: `x.reply: duplicate content (HTTP 403)`, other 403s with X's reason (e.g. the reply
restriction when the author never mentioned the bot), `x.reply: rate limited until …` (the latest exhausted window
of `x-rate-limit-*`, `x-user-limit-24hour-*`, `x-app-limit-24hour-*`; later replies inside it fail fast), 5xx,
invalid id / empty text (no request). The caller marks the mention FAILED and may retry. The adapter does not
count characters: the caller keeps `text` within 280.

**`findReply(inReplyToId)`** — the id of the bot's own reply to `inReplyToId`, or `null` when it has none:
`GET /2/users/{bot id}/tweets?since_id={inReplyToId}&max_results=100&tweet.fields=referenced_tweets` (OAuth 1.0a,
an owned read; up to `FIND_REPLY_MAX_PAGES` = 3 pages), matching `referenced_tweets` `replied_to` = `inReplyToId`.
A timeout or 5xx on `POST /2/tweets` does not mean X refused the post (it may have created it and the answer was
lost), so worker-bot calls this before posting again. Unlike the other methods it **throws** when the lookup fails
or could not read every post since (`lastError = "x.findReply: …"` too): a failed lookup is never "not posted".

## coinFacts (Stage D for coins)

ApeCheck's own reads only: the chain's RPC, Etherscan, TronGrid and DexScreener, all in parallel, each capped at 8 s
per round of requests. Every section records its `source` (`On-chain` or `DexScreener`). What has no source is `null`
and the worker logs it as "not checked".

| Section | Source |
|---|---|
| deployer | EVM: the Etherscan contract creator; Tron: the contract's `origin_address` (TronGrid `getcontract`); Solana: none (`null`). Only the wallet: `launched` / `dead` are always `null`. Its history (the other coins ApeCheck has checked from it) is read by the worker and the API from ApeCheck's own checks (`@apecheck/db` `coinsByDeployer`). |
| bundle | none (`null`) |
| holders | Solana: top-10 % from the largest accounts, leaving out the DexScreener pair and known AMM vault authorities (Raydium AMM v4 / CPMM / LaunchLab, Meteora DAMM v2) and the incinerator; EVM, Tron: none (`null`). The holder count has no source (`count: null`). |
| lp | none (`null`) |
| authorities | Solana: mint/freeze authority ("Renounced" / "Mint renounced, freeze active" / "Mint still active"); EVM/Tron: mint renounced = no mint function OR owner renounced (an ownerless contract with a mint function is unknown, not renounced) |
| market | DexScreener |

`stubbed` lists the adapters that ran as stubs for this coin (`etherscan` for EVM, `rpc-rh`);
`errors` lists non-fatal failures in call order (`"solana.largestHolders: timeout"`). It never throws.

## HTTP client (`createHttp(env)`)

undici, no global state. `body` may be a string or a `Buffer` (multipart uploads). User-Agent `Mozilla/5.0 (compatible; ApeCheckBot/1.0; +https://apecheck.io/bot)`,
default timeout 10 s (covers redirects and the body), default `maxBytes` 2 MB counted after decompression
(`truncated: true` when cut), gzip/deflate/br decoded. Redirects are followed by hand (max 5); a cross-origin hop
drops `Authorization`/`Cookie`; 303 (and 301/302 after POST) turn into GET. `json()` throws `HttpError`
(status, body, headers) on non-2xx and a clear error on bad JSON.

- `guard: true` — for any URL that came from a user or a page. Each hop is vetted (below) and the socket is
  pinned to the vetted addresses through an undici `Agent` whose `lookup` only returns them.
- `OUTBOUND_PROXY` — all traffic goes through an undici `ProxyAgent` (CONNECT tunnels, also for `http://`).
  Loopback / private-literal / allow-listed targets bypass it. See the limitation below.

## SSRF guard (`src/ssrf.ts`)

- Only `http:` / `https:`.
- IPv4 blocked: `0/8`, `10/8`, `100.64/10`, `127/8`, `169.254/16`, `172.16/12`, `192.0.0/24`, `192.0.2/24`,
  `192.168/16`, `198.18/15`, `198.51.100/24`, `203.0.113/24`, `224/4`, `240/4`, `255.255.255.255`.
- IPv6 blocked: `::`, `::1`, `fc00::/7`, `fe80::/10`, `fec0::/10`, `ff00::/8`, `2001:db8::/32`, `100::/64`,
  Teredo `2001::/32`, local NAT64 `64:ff9b:1::/48`. Addresses that embed IPv4 (`::ffff:a.b.c.d`, NAT64
  `64:ff9b::/96`, `::ffff:0:a.b.c.d`, IPv4-compatible `::a.b.c.d`, 6to4 `2002::/16`) get the IPv4 rules.
- Alternative spellings (`2130706433`, `0177.0.0.1`, `0x7f000001`, `127.1`) are normalised by the WHATWG URL
  parser before the check.
- Names refused without resolving: `metadata.google.internal`, `metadata.goog`, `metadata`, `metadata.azure.com`,
  `instance-data`, `instance-data.ec2.internal`, `localhost`, `*.localhost`, `*.internal`, `*.local`,
  `*.localdomain`, and single-label names (they resolve through search domains to internal hosts).
  `169.254.169.254`, `100.100.100.200` and `fd00:ec2::254` are caught by the address rules.
- Other names are resolved (A + AAAA); **any** blocked address refuses the URL; a DNS failure refuses it ("could not
  resolve").
- Resolution of user/page names is `createDnsLookup()`: c-ares (`dns.Resolver`, 2 s per query, 2 tries per name
  server, both families at once and merged, the queries cancelled at a 5 s deadline), **never `dns.lookup`**.
  `dns.lookup` is getaddrinfo on libuv's threadpool (at most 2 of its 4 threads do DNS) and a timeout only stops the
  waiting, so a webhook or site host whose name servers never answer would hold those threads for 10 s+ and stall
  every other host-name lookup of the process (RPC, DexScreener, X, price tracking). c-ares reads no `/etc/hosts`;
  `SSRF_ALLOW_HOSTS` names (the operator's own dev hosts) keep the system resolver. `opts.lookup` overrides both
  (tests).
- `SSRF_ALLOW_HOSTS` (`host` or `host:port`) lets local fixtures through **only when `NODE_ENV !== 'production'`**
  (both the env passed in and `process.env.NODE_ENV` are checked).

### Guard proxy for Chromium

`startGuardProxy({ allowHosts, upstreamProxy, lookup? })` starts an HTTP forward proxy on `127.0.0.1:<random>`.
Every `CONNECT host:port`, absolute-URI request (`GET http://host/…`) and upgrade (`ws://`) is vetted with the
rules above, then connected to the **vetted IP** (DNS rebinding between check and connect is impossible).
Refusals answer 403 and are recorded in `proxy.blocked` (`{ host, reason }`) for the step log. `close()` closes
the server and every open tunnel.

Launch Chromium with **both** flags. Without the second one Chromium goes direct (bypassing the proxy) for
`localhost`, `127.0.0.0/8`, `[::1]`, `169.254.0.0/16` and `[fe80::]/10`, which includes the cloud metadata
address:

```ts
const guard = await startGuardProxy({ allowHosts: env.SSRF_ALLOW_HOSTS, upstreamProxy: env.OUTBOUND_PROXY });
const browser = await chromium.launch({ args: [`--proxy-server=${guard.url}`, '--proxy-bypass-list=<-loopback>'] });
```

A blocked plain-HTTP navigation renders the guard's 403 page ("Blocked by ApeCheck SSRF guard: …"); a blocked
HTTPS navigation fails with `net::ERR_TUNNEL_CONNECTION_FAILED`. Check `guard.blocked` to tell the two apart from
a site that is really down.

**Limitation with an upstream proxy** (`OUTBOUND_PROXY`, e.g. a sandbox egress proxy that must carry all
traffic): the upstream resolves names itself, so the tunnel is opened to the *name* and pinning becomes the
upstream's job. When local DNS works we still refuse names that resolve to blocked addresses; when it doesn't, we
still refuse blocked IP literals and local/metadata names, and let other names through to the upstream. The same
applies to `createHttp` with `guard: true`. On the production VPS leave `OUTBOUND_PROXY` empty so every
connection is pinned.

## Tests

```sh
cd packages/sources && npx vitest run      # no network: fake Http + local 127.0.0.1 servers
npx tsc -p packages/sources/tsconfig.json  # typecheck
LIVE_TESTS=1 npx vitest run test/github.test.ts   # optional live GitHub call through HTTPS_PROXY (LIVE_GITHUB_REPO=owner/repo)
```

Fixtures in `test/fixtures/` follow the documented response shapes of each API (`x-mentions-page*.json`: two
pages of `GET /2/users/:id/mentions` with `includes.users/tweets`, `display_text_range`, `note_tweet`, a missing
parent in `errors` and `meta.next_token`). `test/x-bot.test.ts` drives the bot side through a fake Http that
records every request and re-verifies each OAuth signature.
