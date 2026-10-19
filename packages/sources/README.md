# @apecheck/sources

Every external data source ApeCheck reads, behind the contract in `src/types.ts`, plus the SSRF guard
(HANDOFF §11). Node only (TypeScript source, run with tsx).

```ts
import { loadEnv } from '@apecheck/core/node';
import { createSources, startGuardProxy, captureErrors } from '@apecheck/sources';

const env = loadEnv();
const sources = createSources(env);           // one shared Http client, all adapters
sources.stubbed();                            // e.g. ["x", "fourtis", "etherscan", "rpc-rh"]
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
| X API v2 | `adapters/x.ts` | `X_BEARER_TOKEN` (reads); `X_API_KEY`, `X_API_SECRET`, `X_ACCESS_TOKEN`, `X_ACCESS_SECRET` (`canPost`) | Without the bearer token every read is `null`, listed as `x`. `renameCount()` is always `null` (needs a third-party source). `mentions()` / `reply()` arrive in M2. |
| Fourtis | `adapters/fourtis.ts` | `FOURTIS_API_URL`, `FOURTIS_API_KEY` | Without both, `null`, listed as `fourtis`; `coinFacts` uses the public fallbacks. |

### What each one does

- **DexScreener** — `token(chain, a)`: `GET /tokens/v1/{dexChainId}/{a}` (or `/latest/dex/tokens/{a}` when the
  chain is unknown), keeps pairs where the token is the base token on a chain ApeCheck knows, picks the highest
  `liquidity.usd`. Maps price, market cap (fallback FDV), liquidity, 5 m / 24 h volume, 24 h change, pair
  address/URL/DEX, `pairCreatedAt` (ms → ISO), `info.websites[].url`, `info.socials[]` and `info.imageUrl`.
  `tokens(chain, list)`: batches of 30, map keyed by lowercase address. `search(q)`: `/latest/dex/search`.
- **EVM** — read-only JSON-RPC (`eth_getCode`, `eth_getStorageAt`, `eth_call`, `eth_estimateGas`, `eth_chainId`,
  `eth_blockNumber`; anything else is refused before a request is built). `detectChain` asks every chain at once
  and returns the first in `EVM_DETECT_ORDER` with code. `tokenBasics` decodes ABI and bytes32 strings, reads
  `owner()` (fallback `getOwner()`), and scans bytecode opcodes for `PUSH4` mint selectors (`0x40c10f19`,
  `0xa0712d68`, `0x4e6ec247`); behind EIP-1167 / EIP-1967 proxies the implementation is scanned too. Owner
  `0x0` / `0x…dEaD` or no owner function → `ownerRenounced`. `simulate()` = `eth_call` + `eth_estimateGas` with
  the decoded `Error(string)` / `Panic(uint256)` reason. **Never `eth_sendTransaction` / `eth_sendRawTransaction`.**
- **Solana** — `mintInfo` (`getAccountInfo` jsonParsed, SPL Token and Token-2022), `largestHolders`
  (`getTokenLargestAccounts` + `getTokenSupply` + `getMultipleAccounts` for owners, % of supply),
  `simulate` (`simulateTransaction`, base64, `sigVerify: false`, `replaceRecentBlockhash: true`).
  **Never `sendTransaction`.**
- **Tron** — `/wallet/getcontract` (creator = `origin_address`, bytecode for the mint scan) and
  `/wallet/triggerconstantcontract` for `name/symbol/decimals/totalSupply/owner` (owner converted to base58check).
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

### Fourtis endpoints (placeholders)

Michael defines the real endpoints. Until then the adapter calls, with `Authorization: Bearer FOURTIS_API_KEY`:

| Method | Placeholder path | Expected JSON (bare or wrapped in `{ "data": … }`) |
|---|---|---|
| `devRadar` | `GET {FOURTIS_API_URL}/devradar/{chain}/{address}` | `{ deployer, fundedFrom?, launched, dead, firstSeen?, launches?: [{ address, chain?, createdAt?, dead }] }` |
| `bundleScan` | `GET {FOURTIS_API_URL}/bundlescan/{chain}/{address}` | `{ bundlePct, wallets, launchBlock? }` |
| `whaleFlow` | `GET {FOURTIS_API_URL}/whaleflow/{chain}/{address}` | `{ top10Pct, devHoldPct, holders?, lp?: { status: "burned" \| "locked" \| "unlocked", lockedDays? } }` |

`{chain}` is the ApeCheck chain key (`sol`, `base`, `eth`, `bnb`, `arb`, `rh`, `trx`). Paths live in
`FOURTIS_PATHS` and the shapes in the zod schemas at the top of `adapters/fourtis.ts`; change both there when
the real API lands. A 404 means "no data for this coin" (not an error); a shape mismatch is recorded in `lastError`.

## coinFacts (Stage D for coins)

All calls run in parallel, each capped at 8 s: Fourtis DevRadar / BundleScan / WhaleFlow, DexScreener, and the
chain's public fallbacks. **Fourtis values win**; every section records its `source`.

| Section | Fourtis | Fallback |
|---|---|---|
| deployer | DevRadar | EVM: Etherscan creator; Tron: contract `origin_address` (launch history `null` = unknown) |
| bundle | BundleScan | none (`null`) |
| holders | WhaleFlow | Solana: top-10 % from the largest accounts, leaving out the DexScreener pair and known AMM vault authorities (Raydium AMM v4 / CPMM / LaunchLab, Meteora DAMM v2) and the incinerator |
| lp | WhaleFlow | none (`null`) |
| authorities | — | Solana: mint/freeze authority ("Renounced" / "Mint renounced, freeze active" / "Mint still active"); EVM/Tron: mint renounced = no mint function OR owner renounced |
| market | DexScreener | — |

`stubbed` lists the adapters that ran as stubs for this coin (`fourtis`, `etherscan` for EVM, `rpc-rh`);
`errors` lists non-fatal failures in call order (`"fourtis.bundleScan: timeout"`). It never throws.

## HTTP client (`createHttp(env)`)

undici, no global state. User-Agent `Mozilla/5.0 (compatible; ApeCheckBot/1.0; +https://apecheck.io/bot)`,
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
- Other names are resolved (A + AAAA, `dns.lookup all`); **any** blocked address refuses the URL; a DNS failure
  refuses it ("could not resolve").
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

Fixtures in `test/fixtures/` follow the documented response shapes of each API.
