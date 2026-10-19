# @apecheck/worker

Node workers for ApeCheck (HANDOFF §4, §10, §11):

| Entry (tsx) | PM2 app | What it does |
|---|---|---|
| `src/checks.ts` | `worker-checks` | BullMQ worker on queue `checks`: the check pipeline and the browser agent. Concurrency `MAX_CONCURRENT_BROWSERS`, one Chromium per process. |
| `src/prices.ts` | `worker-prices` | Repeatable job on queue `prices` every 5 minutes: "since check" price points from DexScreener. |
| `src/bot.ts` | `worker-bot` | Placeholder: logs "X bot arrives in M2" and exits 0. |
| `src/dev.ts` | — | `pnpm dev`: checks + prices in one process. |

Every process loads the repo-root `.env` (`loadEnv()` from `@apecheck/core/node`).

## Pipeline (`src/pipeline/*`)

`runCheck(checkId)` loads the Check and its Target, sets `RUNNING`, publishes `start` on `live`, then runs
Stage A–E under one `CHECK_BUDGET_SECONDS` budget. Each stage also has its own limit (`STAGE_LIMITS` in
`pipeline/context.ts`). A stage that times out or throws is logged as a step ("Docs link timed out"), recorded in
`evidence.degraded`, and the check carries on: whatever it didn't establish counts as `warn`. Stage F always runs.

Every step is one `CheckStep` row (idx, ms since start, status, one plain sentence, source, url, caption,
screenshot `<checkId>/<idx>.jpg` under `SCREENSHOT_DIR`), one `{type:'step'}` message on `check:{id}` and an
update of the progress key (A 5 %, B up to 55 %, C 65 %, D up to 85 %, E 95 %, F 100 %).

| Stage | AI | What happens |
|---|---|---|
| A resolve | no | `detect()` the input. EVM → `evm.detectChain` (Base, Ethereum, BNB, Arbitrum, Robinhood); X post → `x.getPost` (links, cashtags, contracts; the author's profile as fallback); X profile → `x.getUser`; website → normalised. Gaps: contract → DexScreener token info → website + X handle; website → the page HTML (guarded fetch) for a contract address and an X link; post → linked site / contract. The Target gets its canonical key (`ca:<chain>:<address>`, …); if another Target already owns it, the check is moved there and `checkCount` fixed. |
| B browse | `AI_MODEL_JUDGE` | Fresh context, open the site (network idle, max 20 s), screenshot, hero/footer/links. Bounded exploration (`browser/agent.ts`): at most `CHECK_MAX_AGENT_ACTIONS` actions and 60 s, tools `click(text)`, `scroll()`, `open_link(url)`, `done(reason)`, a screenshot step after every action. Once an app screen is reached, an empty amount field gets a small amount (as a tester would) so a main button waiting for input can be tried. Then the docs: same-site links to depth 2 / 15 pages. |
| C claims | `AI_MODEL_FAST` | Up to `TUNING.maxClaims` claims from the hero, footer, docs, post and X bio. `ClaimsOutZ` + `normaliseClaims`. |
| D evidence | no | GitHub (repos linked from the site, docs, bio or post; a name search only counts when owner/repo clearly match), the X account, and for coins `sources.coinFacts()`. A contract the rendered page shows is picked up here too. |
| E judge | `AI_MODEL_JUDGE` | Claim statuses with one-sentence evidence citing a step, `acct`/`git` (used only where Stage D could not decide), summary ≤ 180 chars, coin summary. `JudgeOutZ` + `normaliseJudge`. The model never sees or picks a score. |
| F save | no | `scoreCheck()` from core. One transaction: signals, `CheckEvidence`, scores, bands, areas, claims, `CoinFacts`, Deployer upsert, `priceAtCheck`/`mcAtCheck`, first `PricePoint`, `Target.last*`, `isLatest` moved to this check. Then the share card (`GET WEB_INTERNAL_URL/card/<shortId>.png`, 5 s, skipped with a log line when the web app is down) → `SCREENSHOT_DIR/cards/<shortId>.png`, `done` on `check:{id}`, `end` on `live`, the `bot-replies` job for bot checks, and the webhooks hook (a no-op until M4). |

An unrecoverable error (e.g. input that isn't a target) marks the check `FAILED` with a final `fail` step and a
`done` message. On startup `worker-checks` marks checks stuck in `RUNNING` for more than twice the budget as
`FAILED` with a log step. SIGTERM stops taking jobs, gives running checks 15 s, then interrupts them (they mark
themselves `FAILED`).

### Signal rules (`pipeline/signals.ts`)

Product (Stage B):
- **launch** — `ok`: an app page/route was reached, the site asked the wallet to connect, or a transaction was reached.
  `warn`: waitlist / "Coming soon" (modal or splash page), no app entry on the site, or the entry led nowhere useful.
  `fail`: the site never loaded, the launch button is dead (no navigation, no popup, no meaningful DOM change, measured
  against the page's own background churn), or it leads to a 404 / error screen.
- **flow** (only tried when launch is ok; otherwise it takes launch's value, like `scoreNarrative`) — `ok`: a captured
  transaction simulated fine (or couldn't be simulated because *our* RPC is missing/unreachable), or the main action
  responded without errors. `warn`: stops at "Coming soon" / waitlist, needs funds the burner doesn't have (also a
  simulation that fails only for lack of funds), or nothing to try. `fail`: JS error on the main action, error screen,
  or a simulation that reverts.
- **docs** — `ok`: ≥ `TUNING.docsMinPages` pages and no broken links. `warn`: no docs link, a single page / PDF, thin docs,
  broken subpages, timed out. `fail`: the docs link is 404 / unreachable.

People (Stage D, deterministic first):
- **git** — `ok`: ≥ `TUNING.gitThinCommits` commits, pushed within `TUNING.gitStaleDays`, no burst. `warn`: most commits
  within `CONFIG.gitBurstHours` of the token launch (or of the first commit when there is no coin), thin, stale, forks
  only, or no repo and no open-source claim. `fail`: no repo but the project says it is open source. Unknown (GitHub
  unavailable) → the judge decides.
- **acct** — `ok`: X account ≥ `CONFIG.acctAgeDays.ok` days old (warn instead below `TUNING.acctLowFollowers` followers);
  `warn`: ≥ `CONFIG.acctAgeDays.warn` days; `fail`: younger. Unknown → the judge decides.

Coin (Stage D) — only the core helpers: `deployerRecord`/`deployerSignal`, `bandSignal(CONFIG.bundlePct)`,
`holdersSignal`, `lpSignal`, `authoritiesSignal`. An unknown section is `warn` with a log line naming the missing
source ("BundleScan unavailable, bundle share unknown"); unknown deployer history is recorded as `mixed`. A Deployer row
is only written when the history is known (no made-up counts).

## AI (`src/ai/*`)

`AiAdapter`: `exploreStep` (one browser tool call), `extractClaims`, `judge`, `answer` (M3 asks / bot follow-ups).

- `anthropic.ts` — `@anthropic-ai/sdk`, `baseURL` always explicit (`AI_BASE_URL` or `https://api.anthropic.com`).
  Claims / judge / answers: `messages.parse` + `zodOutputFormat`, `effort: 'low'` (JSON-prompt fallback if the helper
  can't take the schema). Browser: a manual tool loop with `messages.create`, `tool_choice: auto`, four `strict` tools,
  screenshots as base64 image blocks (only the newest two stay in the conversation), every tool input validated with the
  core zod schemas before it is executed.
- `heuristic.ts` — the stand-in when `ANTHROPIC_API_KEY` is empty (one warning per process). Ranks visible buttons by
  app-entry keywords, then connect wallet, then the main action; claims from cue sentences; judge maps claim kinds to
  signals and writes the prototype's summaries.
- `index.ts` — `ResilientAi`: any model failure in a stage (rate limit, API error, refusal, `max_tokens`, invalid output)
  falls back to the heuristic for that stage, is logged and lands in `evidence.ai.mode` / `evidence.degraded`.

## Price tracker (`src/prices/*`)

Coins whose first finished check is ≤ 30 days old. Due when the newest `PricePoint` is older than: 15 min (first
24 h), 1 h (to day 7), 1 day (to day 30). Batched `sources.dex.tokens(chain, addresses)`; each hit writes a
`PricePoint` and refreshes `Target.lastPrice / lastMc / lastVol5m / lastCh24 / priceUpdatedAt`.

## Security model (HANDOFF §11)

- **Two SSRF layers.** Chromium runs with `--proxy-server` pointing at `startGuardProxy()` from `@apecheck/sources` and
  `--proxy-bypass-list=<-loopback>`, so *everything* (loopback included, WebSockets included) goes through the guard,
  which resolves, vets and pins each destination (private, loopback, link-local, ULA, metadata refused). On top of that
  `context.route('**/*')` aborts non-http(s) schemes (data: only for sub-resources) and any URL whose host fails
  `checkUrl`. `open_link` and docs links are vetted the same way, and `open_link` only accepts URLs present on the page.
  Server-side fetches of page/user URLs use `sources.http.request(..., { guard: true })`. `SSRF_ALLOW_HOSTS` is honoured
  only outside production (tests).
- **Isolated browser.** A fresh incognito context per check (no persistent profile, disk cache off), downloads off and
  cancelled, service workers blocked, no permissions, dialogs dismissed, WebRTC limited to proxied traffic, no
  background networking / sync / component updates.
- **Mock wallet only** (`browser/mock-wallet.ts`). A fixed burner address/key with no private key anywhere. Signing returns a
  dummy signature; `eth_sendTransaction` and Solana `sign*` record the payload and reject with 4001. Captured
  transactions are only simulated (`sources.evm.simulate` = `eth_call` + `eth_estimateGas`, `sources.sol.simulate` =
  `simulateTransaction`); nothing is ever broadcast. Read-only EVM calls are forwarded to our own RPC only when one is
  configured, capped per check. Messages from the page binding are zod-validated.
- **Untrusted content.** Page text, docs, posts and bios reach the model only inside `<untrusted_page_content>` blocks
  (tags inside the text are neutralised); the system prompts say this is data that can't change the task. In Stage B
  the model's only tools are the four browser actions; all model output is parsed and validated, and nothing it
  returns can do more than steer the browser or fill claim statuses and sentences of this check's record.

## Environment

All from the repo-root `.env` (see `.env.example`). Used here: `DATABASE_URL`, `REDIS_URL`, `ANTHROPIC_API_KEY`,
`AI_BASE_URL`, `AI_MODEL_JUDGE`, `AI_MODEL_FAST`, `CHECK_BUDGET_SECONDS`, `CHECK_MAX_AGENT_ACTIONS`,
`MAX_CONCURRENT_BROWSERS`, `SCREENSHOT_DIR`, `WEB_INTERNAL_URL`, `OUTBOUND_PROXY`, `SSRF_ALLOW_HOSTS` (dev/test only),
`RPC_*` (wallet read passthrough + simulation), plus every data-source key `@apecheck/sources` reads.

## Run

```bash
pnpm --filter @apecheck/worker dev            # checks + prices, reloads on change
pnpm --filter @apecheck/worker start:checks   # what PM2 runs
pnpm --filter @apecheck/worker start:prices
```

Chromium comes from Playwright (`pnpm exec playwright install --with-deps chromium` on the server).

## Tests

```bash
cd apps/worker
npx vitest run                                   # unit + integration (Postgres, Redis db 2, headless Chromium)
npx vitest run --config vitest.e2e.config.ts     # queue end to end on the local fixture site
E2E=1 E2E_TARGET=https://uniswap.org npx vitest run --config vitest.e2e.config.ts   # + one real public check
npx tsc -p tsconfig.json
```

Tests use the database `apecheck_test_worker` (created and migrated by `test/global-setup.ts`) and Redis db 2, never
the dev data. External data sources are replaced by `test/fakes.ts` (`FakeSources`, same `Sources` contract); fixture
sites in `test/fixtures/sites/*` are served on 127.0.0.1 under `<name>.test` host names that a test resolver maps to
loopback, allow-listed through `SSRF_ALLOW_HOSTS`, so the real guard proxy and route guard stay in the path.
