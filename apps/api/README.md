# @apecheck/api

Fastify REST API for apecheck.io (`api.apecheck.io`, PM2 app `api`, port 4000): checks, the live SSE log,
feed/coins/deployers/insights data, credits and rate limits, and (M3) wallet sign-in, tiers by $APECHECK holding,
the X link, follow-up questions, community notes, the watchlist and re-check alerts, private checks.
Spec: `docs/HANDOFF.md` §6, §8, §9, §11.
Every JSON shape is defined in `packages/core/src/dto.ts`; `src/mappers.ts` is the only place DB rows become DTOs.

## Run

```bash
pnpm --filter @apecheck/api dev        # tsx watch, reads the repo-root .env
pnpm --filter @apecheck/api start      # node --import tsx src/index.ts (what PM2 runs)
pnpm --filter @apecheck/api typecheck
cd apps/api && npx vitest run          # needs local Postgres + Redis (see Tests)
```

Needs PostgreSQL (migrated: `pnpm --filter @apecheck/db prisma migrate deploy`) and Redis. The API only produces
jobs; `apps/worker` consumes queue `checks` (and, M3, `asks`) and publishes progress on `check:{id}`. The API reads a
few outside sources itself (M3) through `@apecheck/sources`: token balances (Solana / EVM RPC), EIP-1271 for smart
wallets, the $APECHECK quote (DexScreener) and X OAuth, all through the shared `createHttp` client (timeouts,
`OUTBOUND_PROXY`).

## Environment

Read from the repo-root `.env` by `loadEnv()` (`packages/core/src/env.ts` has every default; `APECHECK_ENV_FILE=<path>`
selects another file, e.g. a staging config).

### Report notes

- The report carries the shape documented on the web's /api page (HANDOFF §9) next to the fields the web reads:
  `narrative: { verdict, score }` (`"PARTLY_REAL"`-style enum, null until there is a narrative score),
  `coin: { verdict, score, …facts }` (`"SKETCHY"`-style enum next to the `CoinFactsDTO` facts; null without coin facts),
  `claims[].result` (= `status`, e.g. `"not_seen"`) and `report_url` (= `reportUrl`). The camelCase fields
  (`narScore`/`narBand`, `coinScore`/`coinBand`, `claims[].status`, `reportUrl`) stay; the web uses them.
- Claims come in `Claim.idx` order (the order the worker extracted them).
- `post` is `Check.evidence.post` (`{ id, author, text, createdAt }`, `id` the X post id or null) for post checks whose post
  could be read, else `null`.
- `botReply` (`{ mention: { author, text, createdAt, inReplyToId }, repliedAt, replyText }`) is present only once the bot's verdict reply
  about the check is on X: the first `BotMention` of the check with status `REPLIED`, `replyTweetId` and `repliedAt`
  (kind `check`; follow-up answers don't count). `mention.text` is what the author typed, `replyText` the words the bot
  posted. A check can answer several mentions since M2 (re-tags reuse it), and a site/API check the bot answered from
  cache has one too. The /bot page shows a real thread only from it. `mention.inReplyToId` is the X id of the post the
  mention replies to (null for a quote tweet or a post of its own): /bot draws `post` above the mention only when it
  equals `post.id`, so a quoted or linked post is never shown as the post the mention replies to.
- `coin.deployer` is the Deployer row (known launch history only); `coin.deployerAddress` is the wallet whenever it is known.
  The summary's `deployer` is `{ address, chain, record }` with `record: null` when the history is unknown. Feed / coins
  search also matches `CoinFacts.deployerAddress`.

| Variable | Used for |
|---|---|
| `API_HOST`, `API_PORT` | listen address (default `127.0.0.1:4000`, behind Nginx) |
| `APP_URL`, `CORS_ORIGINS` | CORS allow-list (`CORS_ORIGINS` ∪ `APP_URL`, exact match, credentials on; outside production any `http://localhost:<port>` / `http://127.0.0.1:<port>` origin is accepted too, for local dev servers); `cardUrl` / `reportUrl` in reports |
| `SESSION_SECRET` | signs the anonymous cookie `ac_sid` and the session cookie `ac_session` |
| `COOKIE_DOMAIN` | M3: `Domain` of both cookies (`.apecheck.io` in production, so the web server sees them); empty = host-only |
| `DATABASE_URL`, `REDIS_URL` | Postgres (Prisma) and Redis (credits, rate limits, BullMQ, pub/sub) |
| `SCREENSHOT_DIR` | screenshots served at `/shots/*` |
| `FREE_CHECKS_PER_DAY` | anonymous / Free daily credits (default 5) |
| `PRO_CHECKS_PER_DAY`, `MAX_CHECKS_PER_DAY` | M3: daily credits of Pro / Max users (30 / 200), also in `MeDTO` for the tier cards |
| `CACHE_HOURS` | a finished check younger than this is returned instead of a new run (default 6) |
| `CHECK_BUDGET_SECONDS` | how long a running check may take before it counts as dead (2× budget) |
| `TOKEN_ADDRESS`, `TOKEN_CHAIN`, `PRO_MIN_HOLD`, `MAX_MIN_HOLD` | tiers by holding (see Tiers); empty token address = token not live: everyone Free, holding amounts hidden |
| `TIER_OVERRIDES` | M3: `address:pro,address:max` team/test wallets (EVM case-insensitive); they get that tier and count as holders, also before launch; never lower a tier from holdings |
| `ASKS_PER_HOUR`, `NOTES_PER_DAY` | M3: follow-ups per user per hour (sliding), notes per user per UTC day |
| `X_OAUTH2_CLIENT_ID`, `X_OAUTH2_CLIENT_SECRET` | M3: "Link your X" (OAuth 2.0 + PKCE); unset → `xLinkAvailable: false`. Register `API_URL/v1/auth/x/callback` as the callback URL in the X app |
| `API_URL` | the X OAuth `redirect_uri` (`<API_URL>/v1/auth/x/callback`) |
| `DEXSCREENER_BASE`, `RPC_SOLANA`, `HELIUS_API_KEY`, `RPC_BASE`, `RPC_ETH`, … | M3: the $APECHECK quote, balance reads and EIP-1271 checks (see `packages/sources`) |
| `OUTBOUND_PROXY` | outbound proxy for those reads and the X OAuth calls |
| `LOG_LEVEL`, `NODE_ENV` | pino level; `production` makes the cookie `Secure` |

## Routes

All errors are `{ error, code }` (`ApiErrorBody`). Codes: `bad_target`, `bad_request`, `no_credits`, `not_found`,
`rate_limited`, `pro_required`, `holders_only`, `sign_in_required`, `max_required`, `payload_too_large`,
`queue_unavailable`, `forbidden`, `internal`; M3 adds `bad_message`, `nonce_expired`, `bad_signature`, `wallet_taken`,
`x_link_unavailable`, `not_ready`, `ask_timeout`, `ask_failed`, `own_note`, `watchlist_full`,
`wallet_check_unavailable` (503: the smart-wallet chain's RPC didn't answer, sign in again).

| Method | Path | Returns |
|---|---|---|
| GET | `/health` | `{ ok: true }` (not rate limited) |
| GET | `/v1/me` | `MeDTO` (no-store): credits left (`credits`/`max`/`resetsAt`, next 00:00 UTC) for the viewer (see Credits), `tier`, `tokenLive`, `proMinHold`/`maxMinHold` (null while the token isn't live), `user` (`UserDTO` with `holding`, `holder`; null signed out), `proChecksPerDay`, `maxChecksPerDay`, `token` (`{ usd, ch24 }` or null), `xLinkAvailable`, `notificationsUnread` |
| POST | `/v1/checks` | body `{ target, recheck?, private? }` → `CreateCheckResponse`. **201** for a new check, **200** when an existing one is returned (running check, or `cached: true` for a finished one younger than `CACHE_HOURS`). 400 `bad_target`, 402 `no_credits`, 403 `max_required` for `private: true` unless the viewer is Max. Credits and job priority by tier |
| GET | `/v1/checks/:id` | `CheckReportDTO` by short id, including the /api page's `narrative`, `coin.verdict`/`coin.score`, `claims[].result`, `report_url` (see Report notes), and `watching` for a signed-in viewer. Private checks only for the user who asked (any device they are signed in on; signing out ends a browser's access); `Cache-Control: private, no-store` on those |
| GET | `/v1/checks/:id/events` | SSE, see below |
| GET | `/v1/feed` | `FeedResponse`. `tab=latest\|checked\|real\|least\|vol\|watch`, `type=all\|coin\|post\|site`, `nar=<band>\|any`, `coin=<band>\|any`, `chain=<key>\|any`, `q`, `cursor`, `limit` (1–100, default 25), `ids=<shortId,…>`, `via=bot\|web\|api` (`bot`: checks the bot started, and checks it answered on X from cache). `tab=watch` without `ids` for a signed-in viewer: their account's watchlist (M3) |
| GET | `/v1/live` | `LiveResponse`: up to 8 queued/running public checks, newest first |
| GET | `/v1/coins` | `CoinsResponse`. `tab=all\|clean\|ok\|sketchy\|rigged`, `chain`, `q`, `limit` (1–500, default 200) |
| GET | `/v1/deployers` | `DeployersResponse`. `chain=all\|<key>`, `sort=real\|dead\|launched`, `limit` (1–500, default 200). A deployer is listed when a finished public check names it, or when no check names it (known from DevRadar alone); one named only by private checks never is (`publicDeployerWhere`) |
| GET | `/v1/insights` | `InsightsDTO`: header stats (`checked` = finished checks all time, `today` = finished since 00:00 UTC, so never more than `checked`), since-check by verdict (latest public coin verdicts finished in the last 30 days), most checked today, builders worth watching |
| GET | `/v1/bot/stats` | `BotStatsDTO`: replies today, median reply seconds (from `BotMention.repliedAt` when the bot stored it, else the check's `finishedAt`), distinct accounts that typed the bot's handle (`BotMention.tagged`, set by the worker: not X's reply prefix, retweets of a tag or the bot itself) |
| GET | `/v1/auth/nonce?chain=evm\|sol&address=…[&chainId=…]` | `AuthNonceResponse` (no-store): the exact message to sign, see Wallet sign-in |
| POST | `/v1/auth/verify` | `AuthVerifyBody` → `MeDTO` + `ac_session` cookie. 400 `bad_message`, 401 `nonce_expired` / `bad_signature`, 409 `wallet_taken` |
| POST | `/v1/auth/logout` | `{ ok: true }`; deletes the session, clears the cookie |
| GET | `/v1/auth/x/start` | 302 to X (OAuth 2.0 + PKCE). 404 `x_link_unavailable` without `X_OAUTH2_CLIENT_ID`, 401 `sign_in_required` signed out |
| GET | `/v1/auth/x/callback` | links the X account, 302 to `APP_URL/?x=linked`; any failure → `APP_URL/?x=error` (`&reason=denied` when the user said no, `&reason=taken` when that X account is linked to another user) |
| POST | `/v1/auth/x/unlink` | `MeDTO` (401 signed out) |
| POST | `/v1/checks/:id/asks` | `AskBody` → `AskDTO` (201 new, 200 the same question again within 60 s). 403 `pro_required` (anonymous, Free), 400 (3–280 characters), 404, 409 `not_ready` (not finished), 429 over `ASKS_PER_HOUR`, 504 `ask_timeout`, 502 `ask_failed`, 503 `queue_unavailable` |
| POST | `/v1/checks/:id/notes` | `NoteBody` → `NoteDTO` (201; 200 with the first note for an identical one within 60 s). 403 `holders_only`, 400 (10–500 characters), 404, 409 `not_ready`, 429 over `NOTES_PER_DAY` |
| POST | `/v1/notes/:id/helpful` | `HelpfulResponse` (toggles the viewer's vote). 403 `holders_only`, 403 `own_note`, 404 |
| POST, DELETE | `/v1/watch/:targetId` | `WatchResponse` `{ watching: true \| false }`, idempotent. 401 `sign_in_required`, 404 (no check of that target the viewer can see), 409 `watchlist_full` (200 targets) |
| GET | `/v1/watchlist` | `WatchlistResponse`: the newest finished check of every watched target the viewer can see (public, or their own private one), newest first, and every watched `targetIds`. One check per target is picked in SQL (`DISTINCT ON ("targetId")`, `latestVisibleChecks`), as for the check a notification opens |
| GET | `/v1/notifications?limit=` | `NotificationsResponse` (newest first, default 30, max 100): `checkId` is the short id of the re-check the alert points to, else the target's latest check |
| POST | `/v1/notifications/read` | `{ ids?: string[] }` (none = all) → `{ unread }` |
| GET | `/shots/<path>` | screenshot files (`.jpg/.jpeg/.png/.webp` only), 30-day immutable cache, `nosniff` |

### Feed rules

- Rows are `Check` with `isLatest && status = DONE && !isPrivate` (one row per target).
- `ids=` is the watchlist: each id selects its target, and the row shown is that target's latest verdict, so a
  watched project keeps showing after a re-check. Only public ids select a target (a private check's id never
  reveals its project). `tab=watch` without ids is empty, except for a signed-in viewer (their `Watch` rows).
- `q` drops a leading `$`/`@` and matches name, ticker, domain, handle, CA and the coin's deployer address.
- `cursor` is opaque; `total` is the full (live) match count. The first page stores the order it was cut from
  (the first 500 target ids, Redis `feed:snap:<token>`, 30 min, shared by viewers who load the same order;
  `src/feed-snapshot.ts`) and `nextCursor` points into it, so "Load more" continues that order even when rows move
  between pages ("Most checked" counts and "5m volume" change constantly, a re-check replaces a target's row). Each
  row shows the target's current latest verdict. Past those 500 rows, after the snapshot expires, or with a cursor
  from other filters, the feed pages the live order by offset (old `o:<offset>` cursors still work).

### Same target (dedupe and cache)

The rules live in `@apecheck/db` (`packages/db/src/checks.ts`: `findReusableCheck()`, `createCheck()`, `withCreateLock()`),
shared with the X bot, so a site submit and a bot tag of the same project see the same running check or cached verdict
and never start two (both take the `lock:create:<target key>` lock). This file adds the credit and the job. Coins match on the contract address across every chain key (including the preliminary `ca:evm:` one, EVM
case-insensitive), sites on the domain, posts on the tweet id, X profiles on `x:<handle>`. A queued/running check of
the same target is returned even with `recheck: true` (it is already fresh); `recheck` only skips the finished-check
cache. A run older than 2 × `CHECK_BUDGET_SECONDS`, or a job queued for over 2 hours, counts as dead and does not
block a new check.

### SSE: `GET /v1/checks/:id/events`

Headers `Content-Type: text/event-stream`, `Cache-Control: no-cache`, `X-Accel-Buffering: no`. Events
(`SseEvent` in dto.ts):

- `step` — `StepDTO & { progress }`, every stored step first, then live ones (never the same `idx` twice)
- `status` — `{ status, progress }`, sent once after the replay for a queued/running check and whenever the worker publishes one
- `done` — the final `CheckReportDTO`; the server then closes the stream. **Clients must call `EventSource.close()` on `done`**, otherwise the browser reconnects

`: ping` every 15 s. One Redis subscriber connection per process fans out to all open streams.

### Timestamps in raw SQL

Every `DateTime` column is `timestamp(3)` without time zone holding UTC. Prisma binds a JS `Date` in `$queryRaw` as
`timestamptz`, and Postgres then compares in the session `TimeZone` (on a server whose Postgres runs in the OS zone,
that shifts the comparison by the zone's offset). Raw queries therefore bind ISO text and cast:
`${date.toISOString()}::timestamp` (`loadSeries`, `sinceByBand`). The ORM is not affected.

## Credits (`src/credits.ts`)

Anonymous: `FREE_CHECKS_PER_DAY` per UTC day, counted in Redis under both the cookie id and the IP
(`credits:<day>:sid:<sid>`, `credits:<day>:ip:<ip>`). remaining = max − max(used of every key). A Lua script checks
and increments all keys atomically; keys expire at the next 00:00 UTC + 1 h. A credit is refunded if the check
can't be created or queued.

Signed in (M3), by tier: Pro and Max count under `credits:<day>:user:<id>` only, with `PRO_CHECKS_PER_DAY` /
`MAX_CHECKS_PER_DAY`. A Free user counts under the user key **and** the cookie and IP keys with
`FREE_CHECKS_PER_DAY`: wallets are free to make, so signing in with a fresh one (or signing out) never hands out
another day of checks. Job priority by tier (`PRIORITY`: max 1, pro 2, free 5).

## Wallet sign-in (M3, `src/auth/*`, `src/routes/auth.ts`)

1. `GET /v1/auth/nonce?chain=evm&address=0x…[&chainId=8453]` (or `chain=sol`) builds the whole message and stores
   `{ chain, address, message }` under `auth:nonce:<nonce>` for 10 minutes. Nonce: 20 alphanumeric characters.
   - EVM, EIP-4361: `<APP_URL host> wants you to sign in with your Ethereum account:\n<EIP-55 address>\n\nSign in to
     ApeCheck. This doesn't send a transaction or cost anything.\n\nURI: <APP_URL>\nVersion: 1\nChain ID: <chainId,
     default: the smart-wallet chain's id>\nNonce: …\nIssued At: …\nExpiration Time: <+10 min>`.
   - Solana, Sign-In With Solana: the same with `Solana account`, the base58 address and no `Chain ID` line.
2. The wallet signs the message unchanged (`personal_sign` / `signMessage`); `POST /v1/auth/verify
   { chain, address, message, signature }`:
   - the message is parsed strictly (exact EIP-4361 line layout, LF only, no unknown or repeated fields; optional
     `Not Before` / `Request ID` / `Resources` understood) → else 400 `bad_message`;
   - its nonce is taken from Redis with GETDEL (single use, also when the attempt fails) → 401 `nonce_expired`;
   - the message must be byte-for-byte the one issued for that nonce, chain and wallet, and pass every field rule:
     domain = `APP_URL` host, URI = `APP_URL`, version 1, chain id an integer (EVM), address equal (EVM lowercase),
     issued at not in the future (30 s skew), expiration in the future and at most 10 minutes after issue, not before
     reached → 400 `bad_message` (401 `nonce_expired` when only the time ran out);
   - signature: **EVM** `keccak256("\x19Ethereum Signed Message:\n" + byteLength + message)`, 65 bytes r‖s‖v with v
     27/28 or 0/1, recovered with secp256k1 (`@noble/curves`), high-s refused; when the recovered address isn't the
     wallet (smart wallets), EIP-1271 `isValidSignature(hash, signature)` returning the whole ABI word `0x1626ba7e` + 28
     zero bytes (never just its first 4 bytes: a contract echoing its call data would pass) via `eth_call` (4 s) on exactly
     one chain chosen by the server, `contractWalletChain(env)`: `TOKEN_CHAIN` when it is an EVM chain (the chain whose
     balance makes the tier), else Base; an EVM `TOKEN_CHAIN` without a known chain id (Robinhood Chain) turns smart
     wallets off. The message's `Chain ID` must be that chain's id (EIP-4361: contract accounts resolve on it), else 401
     `bad_signature` ("switch it to <chain>") without any RPC call; that chain's RPC failing is 503
     `wallet_check_unavailable`, never a fallback to another chain. A contract address is controlled separately on
     each chain (owners rotated per chain, a replayed factory, nothing deployed yet), so whoever controls it elsewhere
     can't sign in as it. Key wallets (ecrecover) sign in whatever chain their wallet is on. Set `TOKEN_CHAIN` before
     sign-in opens and don't move it to another EVM chain afterwards: the chain a smart wallet was checked on isn't
     stored, and its holdings would then be read on a chain it never signed for. ERC-6492 (undeployed smart wallets)
     is not supported. **Solana** ed25519 over the UTF-8
     message with `node:crypto` (public key = DER SPKI `302a300506032b6570032100` + the 32 address bytes), signature
     base58 or base64 (64 bytes) → else 401 `bad_signature`.
   - Limits are per IP only (verify 20/min): a per-wallet limit would let anyone lock a known wallet out.
3. Who that signs in as (`signInWallet`): signed out → the wallet's user (created on first sign-in; EVM addresses
   stored lowercase). Signed in and the user has no wallet of that chain → the wallet is **linked** to them (409
   `wallet_taken` when another user has it). Signed in with a different wallet of the same chain → a switch to that
   wallet's own user (an account change in the wallet). The balance is read on every sign-in.

**Sessions** (`src/plugins/session.ts`): a random 32-byte id (base64url) in Redis `session:<id>` → `{ userId }` for
`SESSION_DAYS` (30), in the signed cookie `ac_session` (httpOnly, SameSite=Lax, Secure in production, `Domain` =
`COOKIE_DOMAIN`, Max-Age 30 days). The id rotates on every sign-in. A preHandler hook (after the rate limits) resolves
`request.viewer = { sid, sessionId, user }` on every route; an unknown, expired or unsigned session is just signed
out. `User.lastSeenAt` is written at most every 10 minutes. Logout deletes the Redis session and clears the cookie.
A non-GET request that carries `ac_session` and an `Origin` outside the CORS allow-list is refused (403 `forbidden`).

**X link** (`src/auth/x-oauth.ts`): `start` stores `{ userId, verifier }` under `auth:x:<state>` (10 min) and
redirects to `https://x.com/i/oauth2/authorize` (`scope=users.read tweet.read`, S256 challenge, `redirect_uri =
API_URL/v1/auth/x/callback`). The callback takes the state once, requires the **same signed-in user** (an authorize
link started by someone else can't link their X to you), exchanges the code at `https://api.x.com/2/oauth2/token`
(HTTP Basic client id:secret, or the client id alone for a public client), reads `https://api.x.com/2/users/me` and
sets `User.xHandle` / `xUserId`. An X id linked to another user → `?x=error&reason=taken`; a stale `xHandle` held by
another user (different X id) is cleared. No X token is stored.

## Tiers (M3, `packages/db/src/tiers.ts` + `src/accounts.ts`)

`computeTier` / `refreshUserTier` from `@apecheck/db` with the balance reader `walletTokenBalance` from
`@apecheck/sources`: the `TOKEN_ADDRESS` balance on `TOKEN_CHAIN` summed over the user's wallets of that chain's
family, ≥ `MAX_MIN_HOLD` Max, ≥ `PRO_MIN_HOLD` Pro, else Free; holder = holding > 0. Read on sign-in and whenever
`User.tierCheckedAt` is older than 1 h (`/v1/me`, `POST /v1/checks`, asks, notes, helpful); one read per user at a
time per process. A failed read keeps the last `holding` and is retried after 5 minutes, for at most 24 h after the
last successful read (`User.tierReadAt`, `TIER_STALE_MAX_MS`): past that the holding is dropped (Free, not a holder,
unless overridden; logged) until a read succeeds, so failing reads can't keep a paid tier. While `TOKEN_ADDRESS` is
empty nobody is read and everyone is Free, except `TIER_OVERRIDES` wallets (that tier, holders). Stored in
`User.tier`, `holding`, `tierCheckedAt`, `tierReadAt`. `UserDTO.holding` is null while the token isn't live.

`MeDTO.token`: DexScreener `token(TOKEN_CHAIN, TOKEN_ADDRESS)` → `{ usd: priceUsd, ch24 }`, cached 60 s in Redis
(`token:quote:<chain>:<address>`; a missing quote 30 s); null while the token isn't live or has no priced pair.

## Private checks (M3, Max)

`POST /v1/checks { private: true }` from a Max user creates `Check.isPrivate` (not counted in `Target.checkCount`).
A private request reuses the user's own running / cached private check (double submits) and, like any request, a
public running / cached one (already public: nothing to hide); a public request never gets a private check. Private
checks are visible only to their requester user, on any device they are signed in on (`canView`; signing out ends
that browser's access, although its anonymous cookie started the check): everyone else gets 404 on the report, its
SSE stream and so the card; they never appear in the feed (also `ids=`), live, coins, deployers, insights (stats
included), bot lists or other users' watchlists. The worker never lets a private check take or clear the target's
public `isLatest` verdict, `lastCheckedAt` or `checkCount`.

## Follow-ups (M3, `src/asks.ts`)

`POST /v1/checks/:id/asks` (Pro/Max, finished checks): the API puts `AskJob { checkId: <internal Check.id>, question,
userId, askerHandle: <the user's X handle or null>, via: 'web' }` on queue `asks` and waits up to 45 s for the
worker's return value `{ askId }` through one shared `QueueEvents` per process; the worker writes the `Ask` (with
`askerId`) and bumps `Check.asksCount`. The question is trimmed and whitespace-collapsed (3–280 characters).
Double submits: the same user + check + question (case and spacing ignored) within 60 s waits on the same job or
returns its answer (`ask:idem:*`). `ASKS_PER_HOUR` per user is a sliding hour (`rl:user:asks-hour:<id>`), spent
only by new jobs and given back when the job fails or a timed-out job never started (it is then removed from the
queue). `AskDTO.by`: the X handle (no "@") for bot asks and X-linked askers, else the asker's short wallet.

## Notes (M3)

Holders only (holding > 0 or a tier override). Text cleaned (control characters removed, CRLF → LF, at most one blank
line) and 10–500 characters; the same text by the same author on the same check within 60 s returns the first note
(200), also for copies sent at the same moment: the duplicate check, the day's note credit and the insert run under a
per-author-and-check `pg_advisory_xact_lock(hashtext('note:<userId>:<checkId>'))`, so one note and one credit;
`NOTES_PER_DAY` per user per UTC day (`notes:<day>:user:<id>`). `NoteDTO.by` = `@<xHandle>` when linked, else the
short wallet; `hold` = `fmtAmount(holding)` ("3.1M") while the token is live and the author holds some, else null;
`mine` = the viewer marked it helpful. Helpful toggles a `NoteVote` and `Note.helpful` in one transaction (not on
your own note; two clicks at once count once).

## Watchlist and alerts (M3)

`Watch` rows per user (max 200). The change detector in the worker (queue `rechecks`) writes `Notification` rows
(`kind` `changed` / `rechecked`, `checkId` = the internal id of the re-check) for watchers;
`MeDTO.notificationsUnread` counts the unread ones. When a Pro/Max user starts watching a target that has never been
fingerprinted, the API queues its first fingerprint at once (`RecheckJob { targetId }`, job `target`, jobId
`fp-<targetId>`, the worker's own convention) instead of leaving it to the next 15-minute scan, so a change made soon
after is caught.

## Security notes

- Rate limits in Redis: 120 req/min per IP globally, 10/min for `POST /v1/checks`, 600/min for `/shots`.
  Key generator `rateKey()` is where API keys (M4) plug in.
- M3 routes have their own per-IP limits per minute: nonce 30, verify 20, logout 20,
  X start 10, X callback 20, X unlink 10, asks 20, notes 10, helpful 60, watch / unwatch 60, watchlist 60,
  notifications 60, mark read 30. Signed-in routes add a per-user sliding limit per minute (`src/limits.ts`
  `USER_RATE`: asks 10, notes 5, helpful 60, watch 60, watchlist 60, notifications 60, mark read 30, X link 10)
  on top of `ASKS_PER_HOUR` / `NOTES_PER_DAY`.
- No private keys anywhere: the server only verifies signatures. Sign-in nonces are single use; session ids rotate
  on sign-in and live only in Redis.
- `trustProxy` trusts loopback only: Nginx on the same host sets `X-Forwarded-For`; a client can't choose its own IP.
- `/shots` serves images only; traversal, encoded traversal, dotfiles and directory listing are refused.
- The API never fetches user-supplied URLs (the worker does, behind the SSRF guard).
- Nginx: `proxy_buffering off` and a long `proxy_read_timeout` on `/v1/checks/*/events`.

## Tests

`cd apps/api && npx vitest run` runs against real Postgres and Redis, isolated from dev data: database
`apecheck_test_api` (created if missing and migrated by `test/global-setup.ts`) and Redis db 1 (flushed).
Override with `TEST_DATABASE_URL` / `TEST_REDIS_URL`. Files run one at a time.

M3 tests use no network: `FakeSources` (`test/helpers.ts`) stands in for balances, EIP-1271, DexScreener and X
(OAuth token and users/me); `EvmWallet` / `SolWallet` generate real secp256k1 / ed25519 keys per test and sign the
messages the API issues; `test/asks.test.ts` runs a small BullMQ worker on queue `asks` that answers.
