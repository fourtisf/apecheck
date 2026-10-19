# @apecheck/api

Fastify REST API for apecheck.io (`api.apecheck.io`, PM2 app `api`, port 4000): checks, the live SSE log,
feed/coins/deployers/insights data, anonymous credits and rate limits. Spec: `docs/HANDOFF.md` §6, §8, §9, §11.
Every JSON shape is defined in `packages/core/src/dto.ts`; `src/mappers.ts` is the only place DB rows become DTOs.

## Run

```bash
pnpm --filter @apecheck/api dev        # tsx watch, reads the repo-root .env
pnpm --filter @apecheck/api start      # node --import tsx src/index.ts (what PM2 runs)
pnpm --filter @apecheck/api typecheck
cd apps/api && npx vitest run          # needs local Postgres + Redis (see Tests)
```

Needs PostgreSQL (migrated: `pnpm --filter @apecheck/db prisma migrate deploy`) and Redis. The API only produces
jobs; `apps/worker` consumes queue `checks` and publishes progress on `check:{id}`.

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
| `SESSION_SECRET` | signs the anonymous session cookie `ac_sid` |
| `DATABASE_URL`, `REDIS_URL` | Postgres (Prisma) and Redis (credits, rate limits, BullMQ, pub/sub) |
| `SCREENSHOT_DIR` | screenshots served at `/shots/*` |
| `FREE_CHECKS_PER_DAY` | anonymous daily credits (default 5) |
| `CACHE_HOURS` | a finished check younger than this is returned instead of a new run (default 6) |
| `CHECK_BUDGET_SECONDS` | how long a running check may take before it counts as dead (2× budget) |
| `TOKEN_ADDRESS`, `PRO_MIN_HOLD`, `MAX_MIN_HOLD` | `/v1/me` tier info; empty token address = holding amounts hidden |
| `LOG_LEVEL`, `NODE_ENV` | pino level; `production` makes the cookie `Secure` |

## Routes

All errors are `{ error, code }` (`ApiErrorBody`). Codes: `bad_target`, `bad_request`, `no_credits`, `not_found`,
`rate_limited`, `pro_required`, `holders_only`, `sign_in_required`, `max_required`, `payload_too_large`,
`queue_unavailable`, `forbidden`, `internal`.

| Method | Path | Returns |
|---|---|---|
| GET | `/health` | `{ ok: true }` (not rate limited) |
| GET | `/v1/me` | `MeDTO`: credits left for this cookie + IP, `max`, `resetsAt` (next 00:00 UTC), tier, token info |
| POST | `/v1/checks` | body `{ target, recheck? }` → `CreateCheckResponse`. **201** for a new check, **200** when an existing one is returned (running check, or `cached: true` for a finished one younger than `CACHE_HOURS`). 400 `bad_target`, 402 `no_credits`, 403 `max_required` for `private: true` |
| GET | `/v1/checks/:id` | `CheckReportDTO` by short id, including the /api page's `narrative`, `coin.verdict`/`coin.score`, `claims[].result`, `report_url` (see Report notes). Private checks only for the cookie that started them |
| GET | `/v1/checks/:id/events` | SSE, see below |
| GET | `/v1/feed` | `FeedResponse`. `tab=latest\|checked\|real\|least\|vol\|watch`, `type=all\|coin\|post\|site`, `nar=<band>\|any`, `coin=<band>\|any`, `chain=<key>\|any`, `q`, `cursor`, `limit` (1–100, default 25), `ids=<shortId,…>`, `via=bot\|web\|api` (`bot`: checks the bot started, and checks it answered on X from cache) |
| GET | `/v1/live` | `LiveResponse`: up to 8 queued/running public checks, newest first |
| GET | `/v1/coins` | `CoinsResponse`. `tab=all\|clean\|ok\|sketchy\|rigged`, `chain`, `q`, `limit` (1–500, default 200) |
| GET | `/v1/deployers` | `DeployersResponse`. `chain=all\|<key>`, `sort=real\|dead\|launched`, `limit` (1–500, default 200) |
| GET | `/v1/insights` | `InsightsDTO`: header stats (`checked` = finished checks all time, `today` = finished since 00:00 UTC, so never more than `checked`), since-check by verdict (latest public coin verdicts finished in the last 30 days), most checked today, builders worth watching |
| GET | `/v1/bot/stats` | `BotStatsDTO`: replies today, median reply seconds (from `BotMention.repliedAt` when the bot stored it, else the check's `finishedAt`), distinct accounts that typed the bot's handle (`BotMention.tagged`, set by the worker: not X's reply prefix, retweets of a tag or the bot itself) |
| POST | `/v1/checks/:id/asks` | 403 `pro_required` (M3) |
| POST | `/v1/checks/:id/notes`, `/v1/notes/:id/helpful` | 403 `holders_only` (M3) |
| POST | `/v1/watch/:targetId` | 401 `sign_in_required` (M3) |
| GET | `/shots/<path>` | screenshot files (`.jpg/.jpeg/.png/.webp` only), 30-day immutable cache, `nosniff` |

### Feed rules

- Rows are `Check` with `isLatest && status = DONE && !isPrivate` (one row per target).
- `ids=` is the watchlist: each id selects its target, and the row shown is that target's latest verdict, so a
  watched project keeps showing after a re-check. `tab=watch` without ids is empty.
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
(`credits:<day>:sid:<sid>`, `credits:<day>:ip:<ip>`). remaining = max − max(usedSid, usedIp). A Lua script checks
and increments both keys atomically; keys expire at the next 00:00 UTC + 1 h. A credit is refunded if the check
can't be created or queued. Signed-in users (M3) pass `userId` + `tier` in the `CreditSubject` and count under
`credits:<day>:user:<id>` with the tier's limit.

## Security notes

- Rate limits in Redis: 120 req/min per IP globally, 10/min for `POST /v1/checks`, 600/min for `/shots`.
  Key generator `rateKey()` is where API keys (M4) plug in.
- `trustProxy` trusts loopback only: Nginx on the same host sets `X-Forwarded-For`; a client can't choose its own IP.
- `/shots` serves images only; traversal, encoded traversal, dotfiles and directory listing are refused.
- The API never fetches user-supplied URLs (the worker does, behind the SSRF guard).
- Nginx: `proxy_buffering off` and a long `proxy_read_timeout` on `/v1/checks/*/events`.

## Tests

`cd apps/api && npx vitest run` runs against real Postgres and Redis, isolated from dev data: database
`apecheck_test_api` (created if missing and migrated by `test/global-setup.ts`) and Redis db 1 (flushed).
Override with `TEST_DATABASE_URL` / `TEST_REDIS_URL`. Files run one at a time.
