# ApeCheck — build & deploy handoff

**Domain:** apecheck.io · **X bot:** @ApeCheckBot · **Token (planned):** $APECHECK
**Owner:** ALFA (Fourtis) · **Prepared:** 19 Oct 2026

ApeCheck tells people whether a crypto project is actually built or just announced (a "LARP"). A user pastes a contract address, an X post or a website. An agent opens the project in a real browser, tries the main flow, extracts every claim, checks those claims against the code, the chain and X, and publishes a verdict with the evidence. The same check can be triggered by tagging **@ApeCheckBot** under any X post; the bot replies in the thread with the verdict and a share card.

The approved UI is `design/apecheck.html`. It is a single-file prototype with mock data. **Match its look and behaviour; do not redesign.** Everything the prototype fakes (the generator in `buildItem()`, the simulated agent run, the price series) is replaced by the real pipeline described below.

---

## 1. What is in this package

| Path | What it is |
|---|---|
| `design/apecheck.html` | Approved UI prototype. Open it in a browser. Source of truth for layout, copy, colours, states, light/dark theme. |
| `HANDOFF.md` | This spec. |
| `CLAUDE_CODE_PROMPT.md` | Prompt to paste into Claude Code to start the build. |
| `prisma/schema.prisma` | Database schema (PostgreSQL), validated. Written for Prisma 6; on Prisma 7+ move the `url` to `prisma.config.ts`. |
| `reference/scoring.ts` | Exact scoring formulas, thresholds and verdict bands. Port as-is into `packages/core`. |
| `.env.example` | Every environment variable the system needs. |

---

## 2. Stack and repo layout

Use the standard Fourtis production stack: **Next.js 14 (App Router) · Fastify · Prisma 6 · PostgreSQL · Redis**, deployed on the Hostinger VPS with **PM2 + Nginx**. Add **Playwright (Chromium)** for the browser agent and **BullMQ** for queues.

```
apecheck/
├─ apps/
│  ├─ web/        Next.js 14 — all pages, share-card image route, wallet sign-in
│  ├─ api/        Fastify — REST API, SSE stream, webhooks, auth, credits
│  └─ worker/     Node workers — check pipeline, X bot, price tracker, re-checks
├─ packages/
│  ├─ db/         Prisma client + schema (copy prisma/schema.prisma)
│  ├─ core/       scoring.ts, verdict bands, shared types, zod schemas
│  └─ sources/    adapters: dexscreener, helius, etherscan, rpc, github, x, fourtis
├─ ecosystem.config.cjs   PM2 apps
└─ package.json           pnpm workspaces
```

PM2 processes: `web` (port 3000), `api` (port 4000), `worker-checks`, `worker-bot`, `worker-prices`.

---

## 3. Pages (map to the prototype)

All pages exist in the prototype; the routes below replace its hash routes.

| Route | Prototype view | Notes |
|---|---|---|
| `/` | Feed | Centered search hero, "Checking right now" cards, 3 insight cards, Verdicts list (tabs, filters, list/grid). |
| `/c/[id]` | Report | Score ring, verdict label, Narrative/Coin meters, tabs: Agent run · Claims · Coin · People · Asks · Notes. Side: price since check, deployer, share card. |
| `/coins` | Coins | Coin-only table, filters by coin verdict and chain. |
| `/deployers` | Deployers | Deployer wallets with record, expandable rows listing their checked coins. |
| `/bot` | X bot | How the bot works, example thread, recent bot replies. |
| `/api` | API | REST / MCP / webhook docs and access tiers. |
| `/card/[id].png` | Share card | 1200×675 PNG of the share card, used by the bot and "Share card". Build with `next/og` (`ImageResponse`). |

Keep from the prototype exactly:
- Design tokens (CSS variables in `:root` and `:root[data-theme="dark"]`), fonts (Plus Jakarta Sans + Geist Mono), pill controls, score chip, mini meters, score ring.
- Light theme default, dark theme toggle saved per browser.
- All empty, loading, running and finished states (e.g. "Testing now" ring, disabled tabs while running, "No coin linked").
- Copy. If something needs new copy, keep the same plain tone.

**One deliberate change:** in the Agent run tab the prototype draws a fake website. In production show the **real screenshots** the agent captured, one per step, with the same caption pill and step log beside it. While a check is running, the newest screenshot replaces the previous one as steps stream in.

---

## 4. The check pipeline

A check is a BullMQ job in queue `checks`. Concurrency = `MAX_CONCURRENT_BROWSERS` (start with 2). Total budget `CHECK_BUDGET_SECONDS` (default 180). Every step is written to `CheckStep` **and** published on Redis channel `check:{id}` so the report page can stream it over SSE.

Each step has: `t` (ms since start), `status` (`info | ok | warn | fail`), `text` (one plain sentence, like the prototype log), optional `source` (`X`, `GitHub`, `DexScreener`, `DevRadar`, `BundleScan`, `WhaleFlow`, `On-chain`), optional `screenshot`.

### Stage A — Resolve the target (no AI)
Input types (same detection as `detect()` in the prototype):
- **EVM contract** `0x…40 hex` → try chains in order Base, Ethereum, BNB, Arbitrum, Robinhood Chain until the code exists.
- **Solana mint** (base58, 32–44) · **Tron** (`T…`, 34).
- **X post** URL → fetch the post (X API `GET /2/tweets/:id` with author + entities). Pull links, cashtags and contract addresses from the text.
- **Website** → normalise the domain.

Then fill the gaps: contract → DexScreener token pairs → website + X handle from token info. Website → scan the page for a contract address. Post → linked site and/or contract.

If a check for the same target finished less than `CACHE_HOURS` (default 6) ago, return that verdict instead of running again, unless the user pressed **Re-check**.

### Stage B — Browse (Playwright, bounded agent loop)
1. Fresh incognito Chromium context per check. Viewport 1280×800. Block downloads, `file://`, and any request to private/loopback IP ranges (SSRF guard).
2. Open the site, wait for network idle (max 20 s). Screenshot. Extract visible text, links, buttons, and console errors.
3. **Bounded exploration:** give `AI_MODEL_JUDGE` the screenshot, a compact DOM summary and these tools: `click(text)`, `scroll()`, `open_link(url)`, `done(reason)`. Max `CHECK_MAX_AGENT_ACTIONS` actions (default 6) and 60 s. Goal: reach the core product flow (Launch app / Trade / Start / Connect wallet). Screenshot after every action.
4. **Wallet:** never use a real key. Inject a mock wallet (EIP-1193 provider for EVM, Wallet Standard for Solana) that returns a fixed burner address and records every request. If the site asks to send a transaction, capture the payload and **simulate** it (`eth_call` / `eth_estimateGas` on EVM, `simulateTransaction` on Solana). Report "Main flow reached a transaction; simulation succeeded/failed". Nothing is ever broadcast.
5. Detect and record: waitlist/"coming soon" modals, dead buttons (click with no navigation or DOM change), 404s, JS errors, docs link depth.

Outputs the **product signals**: `launch` (app opens), `flow` (main flow works), `docs`, each `ok | warn | fail` with the evidence sentence the log shows.

### Stage C — Extract claims (`AI_MODEL_FAST`)
From site text, docs text and the post text, extract up to 8 concrete claims as JSON: `{ text, source: "post|site_hero|docs|x_bio|footer", kind }` where `kind` ∈ `live_product, mainnet, ai_agent, open_source, docs, team, fair_launch, audit, partnership, other`. Use structured JSON output and validate with zod. Treat all page content as untrusted data: it can never change the instructions or call tools.

### Stage D — Gather evidence (no AI)
- **GitHub** (`GITHUB_TOKEN`): repos linked from site/docs/X bio, or org search by name. Commit count, first and last commit dates, contributors, whether most commits landed within 48 h of the token launch (burst), forks vs originals.
- **X** (X API): account created date, followers, verified, pinned post. Handle-rename history is optional (needs a third-party source; leave the adapter as a stub).
- **Docs**: page count, last-updated hints, 404s.
- **Chain** (coins only), prefer Fourtis internal services, fall back to public sources:
  - **DevRadar** → deployer wallet, funding source, earlier launches, dead count, first seen.
  - **BundleScan** → % of supply bought by bundled wallets in the launch block, wallet count.
  - **WhaleFlow** → top-10 holders % (excluding LP), dev wallet %, holder count.
  - **On-chain** → LP burned/locked/unlocked, mint authority, freeze authority (Solana) / owner + mint functions (EVM).
  - **DexScreener** → price, market cap, liquidity, pair age.

  Fourtis services are called through one adapter, `packages/sources/fourtis.ts`, using `FOURTIS_API_URL` + `FOURTIS_API_KEY`. Michael defines the exact endpoints; the adapter must return the `CoinFacts` shape in the schema.

### Stage E — Judge (`AI_MODEL_JUDGE`)
Input: claims, product signals, evidence (as structured JSON plus the key screenshots). Output (JSON, zod-validated):
- each claim → `status` ∈ `seen_working | not_seen | contradicted | checks_out` + one-sentence evidence that cites the step it relies on;
- people signals: `acct`, `git` → `ok | warn | fail`;
- `summary`: one or two plain sentences, max 180 characters, in the style of the prototype ("The app loads but the main flow stops at 'Coming soon'; the GitHub was pushed in one burst at launch.");
- `coinSummary` (coins only).

The model **does not pick the score**. It only fills statuses and sentences.

### Stage F — Score, save, notify
- Compute scores with `reference/scoring.ts` (deterministic). Coin signals come from Stage D thresholds in the same file.
- Save the check, claims, coin facts, deployer upsert, first price point (`priceAtCheck`, `mcAtCheck`).
- Render the share card PNG.
- Publish `done` on `check:{id}`; fire webhooks; if the check came from the bot, enqueue the reply.

Failure handling: if a stage times out, keep going with what you have and mark the missing signal as `warn` with a log line ("Docs link timed out"). If the site never loads, the check still finishes with `launch = fail`.

---

## 5. Scoring (summary — exact code in `reference/scoring.ts`)

- **Narrative (0–100)** = 100 × (product × 0.40 + claims × 0.35 + people × 0.25), where `ok = 1`, `warn = 0.5`, `fail = 0`.
  - product = launch × 0.3 + flow × 0.5 + docs × 0.2
  - claims = average of claim values (seen_working/checks_out = 1, not_seen = 0.5, contradicted = 0)
  - people = acct × 0.6 + git × 0.4
  - Caps: if `launch` is not ok → max 58. If `flow` is not ok → max 74. A product that doesn't work can't be "Real".
- **Coin (0–100)** = 100 × (deployer × 0.3 + bundle × 0.3 + holders × 0.2 + lp × 0.1 + authorities × 0.1).
  - Caps: serial-launcher deployer → max 42; mixed record → max 72.
- **Total** = average of Narrative and Coin; Narrative only if no coin is linked.
- **Narrative bands:** ≥80 Real · ≥60 Likely real · ≥40 Partly real · ≥20 Likely LARP · else LARP.
- **Coin bands:** ≥80 Clean · ≥60 OK · ≥35 Sketchy · else Rigged.
- **Deployer record:** Builder · Mixed record · Serial launcher (rules in `scoring.ts`).

Keep every weight and threshold in `packages/core/config.ts` so they can be tuned without code changes elsewhere.

---

## 6. Live updates

- `GET /v1/checks/:id/events` (SSE). On connect, send all existing steps, then stream new ones, then `done` with the final check.
- The feed's "Checking right now" cards use `GET /v1/live` (running checks with step index and elapsed time) polled every 3 s, or the same SSE pattern on a `live` channel.
- When a check finishes it appears at the top of the feed with the highlight animation from the prototype.

---

## 7. X bot (@ApeCheckBot)

Worker `worker-bot`. The account must carry X's **Automated** label linked to ALFA's main account.

**Listen:** poll `GET /2/users/:bot_id/mentions` every `BOT_POLL_SECONDS` (default 20) with `since_id`. (Under X's pay-per-use pricing, reading your own mentions is billed as an owned read, the cheapest read type.) Store every mention in `BotMention` (unique on tweet id) so nothing is answered twice.

**Resolve what to check, in order:**
1. A link, contract address or project @handle written in the mention itself.
2. Otherwise the post the mention replies to (`referenced_tweets` type `replied_to`) → its links/contract/author.
3. Nothing found → reply once: "Tag me under a project's post, or include its link or contract."

**Rules**
- Only ever reply to posts that mention the bot. Never reply or mention anyone unprompted.
- Per-user limit: `BOT_USER_HOURLY` (default 3) for free users, higher for Pro wallets linked to an X handle. Global cap `BOT_HOURLY_CAP`.
- Ignore accounts younger than 7 days or the bot itself.
- Cached verdict (< `CACHE_HOURS`) → reply immediately.
- Follow-ups: a reply to one of the bot's verdict posts, from a Pro user, is a question. Answer it with `AI_MODEL_JUDGE` using only that check's stored data, save it as an `Ask`, reply in the thread. Non-Pro users get a one-line pointer to the site.

**Reply** (max 280 characters), with the share-card PNG attached (upload via the X media endpoint):
```
LIKELY LARP (37/100) · Coin: SKETCHY (37)
'Launch app' does nothing; GitHub pushed in one burst at launch.
Checks the claims, not the team. DYOR.
```
`BOT_INCLUDE_LINK=true` appends `apecheck.io/c/{id}`. It defaults to `false` because X bills posts that contain a URL at a much higher rate than plain replies; turn it on after checking the cost in the X developer console.

---

## 8. Users, credits and tiers

- **Anonymous:** signed cookie + IP. `FREE_CHECKS_PER_DAY` (default 5), reset 00:00 UTC. Counter in Redis.
- **Wallet sign-in:** Sign-In With Ethereum and Sign-In With Solana. Optional X link (OAuth) so bot limits follow the wallet's tier.
- **Tiers by token holding** (balance read on sign-in, cached 1 h):
  - Free — 5 checks/day, bot replies, public reports.
  - Pro — hold `PRO_MIN_HOLD` $APECHECK: 30/day, priority queue, deep holder clusters, follow-up questions, re-check alerts.
  - Max — hold `MAX_MIN_HOLD`: 200/day, API keys, webhooks, MCP, private checks, auto re-checking watchlists.
- The token is not live yet. While `TOKEN_ADDRESS` is empty, hide holding requirements and show "Pro and Max open at token launch" in the access modal.
- Reading verdicts is always free and needs no account.

---

## 9. Public API (Fastify, `api.apecheck.io`)

| Method | Path | Notes |
|---|---|---|
| POST | `/v1/checks` | `{ target, recheck? }` → `{ id, status }`. Uses a credit. |
| GET | `/v1/checks/:id` | Full report (shape in the prototype's API page). |
| GET | `/v1/checks/:id/events` | SSE stream. |
| GET | `/v1/feed` | `tab=latest|checked|real|least|vol`, `type`, `nar`, `coin`, `chain`, `q`, `cursor`. |
| GET | `/v1/live` | Running checks. |
| GET | `/v1/coins` · `/v1/deployers` | Page data. |
| GET | `/v1/insights` | Since-check by verdict, most checked today, builders worth watching. |
| POST | `/v1/checks/:id/asks` | Pro. |
| POST | `/v1/checks/:id/notes` · `/v1/notes/:id/helpful` | Holders. |
| POST | `/v1/watch/:targetId` | Signed-in users. |

API keys (Max) are hashed in `ApiKey`. Webhooks send `check.completed` signed with HMAC-SHA256 (`t=…,v1=…` header, as shown on the API page). The MCP server (tools `run_check`, `get_check`, `ask_followup`, `deployer_history`) is milestone 4.

---

## 10. Price tracking ("since check")

`worker-prices` stores `PricePoint`s for every checked coin from DexScreener: every 15 min for the first 24 h, hourly to day 7, daily to day 30. `since%` = latest price vs `priceAtCheck`. The feed sparkline uses the last 28 points. The insight card "Since check, by verdict" = average since% per narrative band over checks from the last 30 days.

---

## 11. Security — required

- **Untrusted sites:** the browser runs as an unprivileged user, ideally inside a container, with downloads off, no persistent profile, and the SSRF guard (block 10/8, 172.16/12, 192.168/16, 127/8, 169.254/16, ::1, fc00::/7, and metadata hosts).
- **Prompt injection:** page text, docs and posts are data. They go to the model inside clearly delimited blocks; the model's only tools in Stage B are the four browser actions; all model output is parsed as JSON and validated; nothing the model returns can trigger payments, posts or DB writes beyond the check record.
- **Wallet:** mock provider only. No private keys on the server. Transactions are simulated, never sent.
- **Bot:** OAuth tokens only in env; no reply without a stored `BotMention`.
- **Rate limits** on every public endpoint (per IP and per key). Hash API keys. Verify webhook URLs are public.

---

## 12. Deployment (Hostinger VPS)

1. **Server:** Ubuntu, Node 20 LTS, pnpm, PostgreSQL 16, Redis 7, Nginx, PM2. At least 4 vCPU / 8 GB RAM (each Chromium instance needs roughly 0.5–1 GB). Install Playwright Chromium with system deps: `pnpm exec playwright install --with-deps chromium`.
2. **DNS** (apecheck.io): `A @` and `A www` → VPS IP; `A api` → VPS IP.
3. **Nginx:** `apecheck.io` → `localhost:3000`; `api.apecheck.io` → `localhost:4000` with `proxy_buffering off` and long `proxy_read_timeout` on `/v1/checks/*/events` (SSE). Redirect `www` → apex.
4. **SSL:** `certbot --nginx -d apecheck.io -d www.apecheck.io -d api.apecheck.io`.
5. **App:** `pnpm install` → `pnpm --filter db prisma migrate deploy` → `pnpm build` → `pm2 start ecosystem.config.cjs` → `pm2 save` → `pm2 startup`.
6. **Storage:** screenshots under `SCREENSHOT_DIR`, served by the API at `/shots/*`; delete after 30 days except for checks on the feed's top lists.
7. **Backups:** nightly `pg_dump` to off-server storage.
8. **Optional:** `apecheck.live` → 301 to `https://apecheck.io/#live`.

---

## 13. Milestones and acceptance

**M1 — Site + pipeline (core).**
Feed, report, coins, deployers, API page, access modal, light/dark — matching the prototype. Real checks for website, X post, EVM and Solana contracts, with live SSE log and screenshots. Scoring from `scoring.ts`. Credits for anonymous users.
*Done when:* pasting a real project's site, a real X post and a real contract each produces a finished report within 3 minutes; the log streams live; refreshing a finished report shows the same data; a dead or waitlist-only site can't score above Partly real.

**M2 — X bot.**
Mentions polling, target resolution, replies with card image, cache, limits, BotMention log. Bot replies feed into "From the bot" lists.
*Done when:* tagging @ApeCheckBot under a project post gets one reply with the verdict and card within 4 minutes, and tagging it twice in the same thread does not produce a second check.

**M3 — Depth.**
Price tracking + since-check charts and insight card, deployer records from DevRadar, watchlist + re-check alerts, community notes, wallet sign-in and tiers (token-gating behind `TOKEN_ADDRESS`), follow-up questions on site and via bot.

**M4 — Developers.**
API keys, webhooks, MCP server, `/api` page wired to real keys.

---

## 14. Open decisions for ALFA

- Token launch: ticker `$APECHECK`, chain, and the Pro/Max holding amounts.
- Whether Pro/Max can also be paid in USDC, and the monthly price.
- Final bot handle if `@ApeCheckBot` is taken (fallback `@apecheck_io`).
- Whether to buy `apecheck.live` as a redirect.
