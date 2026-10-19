# @apecheck/worker

Node workers for ApeCheck (HANDOFF §4, §10, §11):

| Entry (tsx) | PM2 app | What it does |
|---|---|---|
| `src/checks.ts` | `worker-checks` | BullMQ worker on queue `checks`: the check pipeline and the browser agent. Concurrency `MAX_CONCURRENT_BROWSERS`, one Chromium per process. |
| `src/prices.ts` | `worker-prices` | Repeatable jobs on queue `prices`: "since check" price points from DexScreener every 5 minutes, and the daily screenshot cleanup (03:20 UTC, see below). |
| `src/bot.ts` | `worker-bot` | Placeholder until M2: logs "X bot arrives in M2" once and idles until SIGTERM, so PM2 keeps it `online` instead of restart-looping it. |
| `src/dev.ts` | — | `pnpm dev`: checks + prices in one process. |

Every process loads the repo-root `.env` (`loadEnv()` from `@apecheck/core/node`; `APECHECK_ENV_FILE` picks another file,
and under `NODE_ENV=test` inherited variables win so a test can never be pointed at the dev database).

## Pipeline (`src/pipeline/*`)

`runCheck(checkId)` loads the Check and its Target, sets `RUNNING`, publishes `start` on `live`, then runs
Stage A–E under one `CHECK_BUDGET_SECONDS` budget. Each stage also has its own limit (`STAGE_LIMITS` in
`pipeline/context.ts`). A stage that times out or throws is logged as a step ("Docs link timed out"), recorded in
`evidence.degraded`, and the check carries on: whatever it didn't establish counts as `warn`. Stage F always runs.

Every step is one `CheckStep` row (idx, ms since start, status, one plain sentence, source, url, caption,
screenshot `<checkId>/<idx>.jpg` under `SCREENSHOT_DIR`), one `{type:'step'}` message on `check:{id}` and an
update of the progress key (A 5 %, B up to 55 %, C 65 %, D up to 85 %, E 95 %, F 100 %). Step text, urls and
captions, the evidence JSON, claims, coin facts and Target fields all go through `pgSafe()` (`pipeline/pgsafe.ts`):
U+0000 and lone surrogates, which Postgres refuses in text and jsonb, are removed, so a page (or a DexScreener / X
string) can't make a check fail. If the final save still fails, it is retried once with the evidence reduced to its
signal sentences (`degraded: save:retry`).

Each run owns its check through `Check.startedAt`: the run claims the check atomically (only while it is QUEUED or
RUNNING), steps are written only while `startedAt` is still this run's, and the final save / failure checks it again.
A re-run of a stalled job continues the step idx after the previous run's last one (with a "Check restarted" step),
so an open SSE stream shows the new steps and no screenshot path is reused. A run whose BullMQ lock was lost, or
whose check another run took over, stops without writing, publishing or replying anything.

| Stage | AI | What happens |
|---|---|---|
| A resolve | no | `detect()` the input. EVM → `evm.detectChain` (Base, Ethereum, BNB, Arbitrum, Robinhood); X post → `x.getPost` (links, cashtags, contracts; the author's profile as fallback); X profile → `x.getUser`; website → normalised. Gaps: contract → DexScreener token info → website + X handle; website → the page HTML (guarded fetch) for a contract address and an X link; post → linked site / contract. A lookup still running at the stage's timeout writes nothing (its steps are dropped, no `run.*` field changes). After the stage, `runCheck` gives the Target its canonical key (`ca:<chain>:<address>`, …); if another Target already owns it, the check is moved there and `checkCount` fixed. A coin's `coinFacts()` is asked right then, so it runs alongside the browser. |
| B browse | `AI_MODEL_JUDGE` | Fresh context, open the site (network idle, max 20 s), screenshot, hero/footer/links. A bot challenge (Cloudflare `cf-mitigated` / "Just a moment...", DDoS-Guard, Vercel checkpoint, 429) gets up to 8 s to solve itself; if it doesn't, the site is "could not be checked" (`site.infraError`, `degraded: browse:blocked`), never "didn't load". Bounded exploration (`browser/agent.ts`): at most `CHECK_MAX_AGENT_ACTIONS` actions and 60 s, tools `click(text)`, `scroll()`, `open_link(url)`, `done(reason)`, a screenshot step after every action. Once an app screen is reached, an empty amount field gets a small amount (as a tester would) so a main button waiting for input can be tried. A captured transaction is simulated within what is left of the stage. The verdict uses a snapshot of what the explorer saw when the stage ended: an action still in flight can't change it later; a transaction captured but not recorded in time gets its own step ("not simulated in time"). Then the docs: same-site links to depth 2 / 15 pages. |
| C claims | `AI_MODEL_FAST` | Up to `TUNING.maxClaims` claims from the hero, footer, docs, post and X bio. `ClaimsOutZ` + `normaliseClaims`. |
| D evidence | no | GitHub (repos linked from the site, docs, bio or post; a name search only counts when owner/repo clearly match), the X account, and for coins the `coinFacts()` answer (asked after Stage A). A contract the rendered page shows is picked up here too. If the stage runs out of time before the coin is assessed, the coin is still scored: with the facts if they already arrived, else as unknown (deployer `mixed`, every section `warn`, "Coin data not gathered in time; counts as unknown"), never as "no coin". |
| E judge | `AI_MODEL_JUDGE` | Claim statuses with one-sentence evidence citing a step, `acct`/`git` (used only where Stage D could not decide, and never above `warn`), summary ≤ 180 chars, coin summary. `JudgeOutZ` + `normaliseJudge`. The model never sees or picks a score. A judge that times out, or a model that fails and is replaced by the stand-in (claims or judge), leaves a `warn` step ("Claim review timed out; used the simple rules"). |
| F save | no | `scoreCheck()` from core. One transaction: signals, `CheckEvidence`, scores, bands, areas, claims (in extraction order, `Claim.idx` 0..n-1), `CoinFacts` (with `deployerAddress` whenever the wallet is known), Deployer upsert, `priceAtCheck`/`mcAtCheck`, first `PricePoint`, `Target.last*`, `isLatest` moved to this check. Then the share card (`GET WEB_INTERNAL_URL/card/<shortId>.png`, 5 s, skipped with a log line when the web app is down) → `SCREENSHOT_DIR/cards/<shortId>.png`, `done` on `check:{id}`, `end` on `live`, the `bot-replies` job for bot checks, and the webhooks hook (a no-op until M4). |

An unrecoverable error (e.g. input that isn't a target) marks the check `FAILED` with a final `fail` step and a
`done` message. `Check.error` (public through the API) only ever holds that plain sentence ("The check hit an error
and could not finish"); the exception itself goes to the log. A database error while the run claims the check is
thrown so BullMQ retries the job (the API enqueues with `attempts: 3`, exponential backoff); when the last attempt
fails, the worker's `failed` handler ends the check (`FAILED`, final step, `done`, bot reply). At startup and every
5 minutes `worker-checks` ends checks that would never finish: `RUNNING` for more than twice the budget, and `QUEUED`
(> 10 min) or `RUNNING` (> 2 min) checks whose job is gone, failed or completed (e.g. a job that stalled past its
limit). SIGTERM stops taking jobs, gives running checks 15 s, then interrupts them (they mark themselves `FAILED`).

### Signal rules (`pipeline/signals.ts`)

Product (Stage B):
- **launch** — `ok`: an app screen was reached (an app page/route or link, an amount field, a transaction, a signature
  from the main action), or a wallet connect worked on a site whose app entry didn't end in a blocker. A wallet connect
  on a page that shows no app does **not** outweigh an app entry that leads to a waitlist, "Coming soon", a 404, an
  error or nothing ("'Launch app' shows 'Coming soon' (only the wallet connect works)"), and a connect that itself lands
  on a waitlist is no app at all. `warn`: waitlist / "Coming soon" (modal or splash page), no app entry on the site, the
  entry led nowhere useful, or the site couldn't be checked (our browser failed, or a bot challenge blocked it).
  `fail`: the site never loaded, the launch button is dead (no navigation, no popup, no meaningful DOM change, measured
  against the page's own background churn), or it leads to a 404 / error screen.
- **flow** (only tried when launch is ok; otherwise it takes launch's value, like `scoreNarrative`) — `ok`: a captured
  transaction simulated fine, or the main action asked the wallet to sign. `warn`: a transaction that couldn't be
  simulated (our RPC down, a chain ApeCheck can't simulate, out of time — it says which), the main action only opened a
  dialog / changed the page / asked to connect ("The main action opened a dialog; the flow wasn't completed"), stops at
  "Coming soon" / waitlist, needs funds the burner doesn't have (also a simulation that fails only for lack of funds),
  or nothing to try. `fail`: JS error on the main action, error screen, or a simulation that reverts. The summary says
  "The app works end to end" only for a transaction that simulated fine.
- **docs** — `ok`: ≥ `TUNING.docsMinPages` pages and no broken links. `warn`: no docs link, a single page / PDF, thin docs,
  broken subpages, timed out. `fail`: the docs link is 404 / unreachable.

People (Stage D, deterministic first):
- **git** — `ok`: ≥ `TUNING.gitThinCommits` commits, pushed within `TUNING.gitStaleDays`, no burst. `warn`: a launch burst
  (a share above `TUNING.gitBurstShare` of the commits within `CONFIG.gitBurstHours` of the token launch, or of the first
  commit when there is no coin, with at least `TUNING.gitBurstMinCommits` commits), thin, stale, forks only, or no repo
  and no open-source claim. `fail`: no repo but the project says it is open source. Unknown → `warn` (GitHub
  unavailable, Stage D cut short); only when there was nothing to look up may the judge lower it to `fail`.
- **acct** — `ok`: X account ≥ `CONFIG.acctAgeDays.ok` days old (warn instead below `TUNING.acctLowFollowers` followers);
  `warn`: ≥ `CONFIG.acctAgeDays.warn` days; `fail`: younger. Unknown → `warn` (account linked but unreadable); with no X
  account at all the judge may lower it to `fail`. An unknown people signal is never `ok`, whatever the model says.

Coin (Stage D) — only the core helpers: `deployerRecord`/`deployerSignal`, `bandSignal(CONFIG.bundlePct)`,
`holdersSignal`, `lpSignal`, `authoritiesSignal`. An unknown section is `warn` with a log line naming the missing
source ("BundleScan unavailable, bundle share unknown"; "(Solana RPC unavailable)" is added when the public on-chain
fallback failed too); unknown deployer history is recorded as `mixed`. A Deployer row is only written when the history is
known (no made-up counts); the wallet itself (e.g. the Etherscan creator) is still kept in `CoinFacts.deployerAddress`, and the
site shows it with "Launch history unavailable".

### Saying only what was seen

The log, the claims and the summary never turn "a source was down" into a finding:
- EVM chain detection names only the chains whose RPC answered ("Contract … not found on Base or Ethereum; BNB Chain RPC
  unavailable", or "Couldn't reach the … RPCs, so the chain of … is unknown"). When an earlier chain's RPC never answered
  (the adapter already retried it once) but a later chain has the code, DexScreener is asked without a chain: a pair on the
  unanswered chain moves the check there; otherwise the later chain stays and the log adds "Base RPC unavailable; contract
  found on Ethereum".
- An address on the page or in the post that DexScreener / the RPCs couldn't vet is logged as "Address … on the site couldn't be
  checked (DexScreener and the chain RPCs unavailable)", not "No contract found".
- GitHub: "GitHub unavailable, code not checked" (errors, rate limit) or "No GitHub link or project name to look up" (never
  asked) leave `git` unknown; the summary then says "the code could not be checked", not "no public code was found".
- A transaction that couldn't be simulated because *our* RPC failed says so in plain words ("our Base RPC didn't answer");
  the raw error stays in `Check.evidence`. A transaction on a chain we don't know (the site switched the wallet to Polygon,
  Optimism, …) is not simulated at all ("it targets a chain ApeCheck can't simulate (chain id 137)"), never on Ethereum.
- A bot challenge is "<domain> blocks automated browsers; the site could not be checked", and an X handle the unread site
  might have linked is "X account unknown (the site couldn't be read)", not "No X account linked to the project".
- The heuristic stand-in only marks a "mainnet" claim seen when a transaction simulated fine on the chain the claim names
  (an app that opens, or a dialog, doesn't show the chain), never marks an "AI agent" claim seen (a working swap doesn't
  show one), and cites why an X account is unknown ("@x: account could not be read").

## Screenshot retention (`src/maintenance/shots.ts`, HANDOFF §12.6)

A daily repeatable job (`shots-cleanup`, `20 3 * * *` UTC) on the `prices` queue deletes `SCREENSHOT_DIR/<checkId>/` and
`SCREENSHOT_DIR/cards/<shortId>.png` of every check that finished more than `TUNING.shotsKeepDays` (30) days ago, except the
checks on the feed's top lists: the top `TUNING.shotsKeepTop` (50) of Most checked, Most real and Least real among the latest
public verdicts (same orderings as `GET /v1/feed`). For the cleaned checks `CheckStep.screenshot` and `Check.cardPath` are
set to null, so their reports show no broken images (the web still draws `/card/<id>.png` on demand). Files are deleted
before the DB is updated, in batches of 200; only plain `<id>` folder and card names inside `SCREENSHOT_DIR` are touched.
`selectExpired()` is the pure selection rule; `test/shots-cleanup.test.ts` covers it and one run against the test database.

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

Coins whose latest finished check is ≤ 30 days old, on that check's cadence (a Re-check starts the schedule again, since
"since check" compares with the latest check's `priceAtCheck`). Due when the newest `PricePoint` is older than: 15 min
(first 24 h after the check), 1 h (to day 7), 1 day (to day 30). Batched `sources.dex.tokens(chain, addresses)`; each hit writes a
`PricePoint` and refreshes `Target.lastPrice / lastMc / lastVol5m / lastCh24 / priceUpdatedAt`.

## Security model (HANDOFF §11)

- **Two SSRF layers.** Chromium runs with `--proxy-server` pointing at `startGuardProxy()` from `@apecheck/sources` and
  `--proxy-bypass-list=<-loopback>`, so *everything* (loopback included, WebSockets included) goes through the guard,
  which resolves, vets and pins each destination (private, loopback, link-local, ULA, metadata refused). On top of that
  `context.route('**/*')` aborts non-http(s) schemes (data: only for sub-resources) and any URL whose host fails
  `checkUrl`. `open_link` and docs links are vetted the same way, and `open_link` only accepts URLs present on the page.
  Server-side fetches of page/user URLs use `sources.http.request(..., { guard: true })`. `SSRF_ALLOW_HOSTS` is honoured
  only outside production (tests).
- **Browser outside this process (production).** worker-checks never launches Chromium with `NODE_ENV=production`: it
  connects to the isolated browser host (`deploy/browser/browser-host.cjs`, systemd unit `apecheck-browser.service`, DEPLOY.md §6)
  at `BROWSER_WS_ENDPOINT`, which runs Chromium as the `apecheck-browser` user with its sandbox on, a minimal environment and
  a firewall that only lets it reach the guard proxy (listening on the fixed `BROWSER_GUARD_PORT`). On connect the worker
  checks the browser reaches the guard; every context gets the guard as its proxy. Without the endpoint `src/checks.ts` exits.
  Dev/test launch Chromium in-process with `chromeEnv()` (never `process.env`). `test/browser-isolation.test.ts` runs Stage B
  through the real host as `nobody` and checks the sandbox, the environment and the host's refusals.
- **Isolated browser.** A fresh incognito context per check (no persistent profile, disk cache off), downloads off and
  cancelled, service workers blocked, no permissions, dialogs dismissed, WebRTC limited to proxied traffic, no
  background networking / sync / component updates.
- **Page reads the page can't tamper with.** The DOM summary, probe and text scripts run in an isolated world (CDP
  `Page.createIsolatedWorld` + `Runtime.evaluate`, `browser/page.ts`): the page shares the DOM with them but can't
  redefine the builtins or getters they use, so their caps hold (title 160, text 30 k, hero 6 k, ≤ 500 links …) and a
  page can't push megabytes through the protocol; each read has a 10 s limit. Every result is clamped again on the
  Node side (types, lengths, list sizes, U+0000) before anything uses it.
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
`BROWSER_WS_ENDPOINT` + `BROWSER_GUARD_PORT` (production browser host),
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

`test/pipeline.test.ts` covers whole checks (the M1 acceptance fixtures include waitlist / 'Coming soon' / dead-launch sites
with a working Connect wallet button, a main button that only opens a dialog, U+0000 in page and third-party strings, a
Cloudflare challenge, error text); `test/pipeline-timing.test.ts` covers late and repeated work (an abandoned Stage A, a
coin whose Stage D ran short, model fallbacks in the log, re-runs, a run that lost its check, stuck-check recovery, the
browser pool relaunch).

Tests use the database `apecheck_test_worker` (created and migrated by `test/global-setup.ts`) and Redis db 2, never
the dev data. External data sources are replaced by `test/fakes.ts` (`FakeSources`, same `Sources` contract); fixture
sites in `test/fixtures/sites/*` are served on 127.0.0.1 under `<name>.test` host names that a test resolver maps to
loopback, allow-listed through `SSRF_ALLOW_HOSTS`, so the real guard proxy and route guard stay in the path.
