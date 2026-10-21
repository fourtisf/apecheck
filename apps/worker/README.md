# @apecheck/worker

Node workers for ApeCheck (HANDOFF §4, §7, §8, §10, §11):

| Entry (tsx) | PM2 app | What it does |
|---|---|---|
| `src/checks.ts` | `worker-checks` | BullMQ worker on queue `checks`: the check pipeline and the browser agent. Concurrency `MAX_CONCURRENT_BROWSERS`, one Chromium per process. |
| `src/prices.ts` | `worker-prices` | The light periodic work, no browser. Queue `prices`: "since check" price points from DexScreener every 5 minutes, the daily screenshot cleanup (03:20 UTC). Queue `rechecks` (M3): re-check alerts for watched targets, every 15 minutes. Queue `maintenance` (M3): the hourly tier refresh (:07), and the logo backfill every 10 minutes (and at start): coins without a logo (checked before logos were stored) get the image a check would pick, a dozen per run. Queue `webhooks` (M4): signed webhook deliveries with retries (below). |
| `src/bot.ts` | `worker-bot` | The X bot @ApeCheckBot (`src/bot/*`, below): polls the bot's mentions, starts or reuses checks, posts the replies queued on `bot-replies`. Without the X keys it logs one warning and idles, so PM2 keeps it `online`. It also answers the site's follow-up questions (queue `asks`, M3), with or without the X keys. |
| `src/dev.ts` | — | `pnpm dev`: checks, prices, re-check alerts, maintenance, asks and webhook deliveries in one process; the bot too only with `X_BOT_DEV=1` (use a test bot account: the one-bot lock only covers processes on the same Redis). |

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
| A resolve | no | `detect()` the input. EVM → `evm.detectChain` (Base, Ethereum, BNB, Arbitrum, Robinhood); X post → `x.getPost` (free embed read: links, cashtags, contracts; never the paid X API); X profile → the handle only (accounts are not read); website → normalised. Gaps: contract → website + X handle (+ Telegram, Discord, logo URL) merged per field from DexScreener's token info > the token's own metadata (`On-chain`: Solana via Helius DAS `getAsset` with `HELIUS_API_KEY`, else the Metaplex metadata PDA / Token-2022 `tokenMetadata`, then the metadata JSON through the SSRF guard, 256 KB, 8 s) > GeckoTerminal token info (no key), the last two read in parallel with DexScreener, capped and never fatal; one `Token metadata: website foo.xyz, X @foo` step per source (`src/pipeline/resolve.ts` `fromTokenLinks`, `packages/sources` `links.ts` / `adapters/token-links.ts`). After Stage A the coin's logo (same priority) is downloaded through the guard (1 MB, PNG/JPEG/WebP/GIF by magic bytes, never SVG) to `SCREENSHOT_DIR/logos/<sha256>.<ext>` and saved as `Target.logo` (`src/pipeline/logo.ts`), before the share card is drawn; website → the page HTML (guarded fetch) for a contract address and an X link; post → linked site / contract. A lookup still running at the stage's timeout writes nothing (its steps are dropped, no `run.*` field changes). After the stage, `runCheck` gives the Target its canonical key (`ca:<chain>:<address>`, …); if another Target already owns it, the check is moved there and `checkCount` fixed. A coin's `coinFacts()` is asked right then, so it runs alongside the browser. |
| B browse | `AI_MODEL_JUDGE` | Fresh context, open the site (network idle, max 20 s), screenshot, hero/footer/links. A bot challenge (Cloudflare `cf-mitigated` / "Just a moment...", DDoS-Guard, Vercel checkpoint, 429) gets up to 8 s to solve itself; if it doesn't, the site is "could not be checked" (`site.infraError`, `degraded: browse:blocked`), never "didn't load". Bounded exploration (`browser/agent.ts`): at most `CHECK_MAX_AGENT_ACTIONS` actions and 60 s, tools `click(text)`, `scroll()`, `open_link(url)`, `done(reason)`, a screenshot step after every action. Once an app screen is reached, an empty amount field gets a small amount (as a tester would) so a main button waiting for input can be tried. A captured transaction is simulated within what is left of the stage. The verdict uses a snapshot of what the explorer saw when the stage ended: an action still in flight can't change it later; a transaction captured but not recorded in time gets its own step ("not simulated in time"). Then the docs: same-site links to depth 2 / 15 pages. |
| C claims | `AI_MODEL_FAST` | Up to `TUNING.maxClaims` claims from the hero, footer, docs, post and X bio. `ClaimsOutZ` + `normaliseClaims`. |
| D evidence | no | GitHub (repos linked from the site, docs, bio or post; a name search only counts when owner/repo clearly match), the X account, and for coins the `coinFacts()` answer (asked after Stage A). A contract the rendered page shows is picked up here too. If the stage runs out of time before the coin is assessed, the coin is still scored: with the facts if they already arrived, else as unknown (deployer `mixed`, every section `warn`, "Coin data not gathered in time; counts as unknown"), never as "no coin". With a deployer wallet, the step "Deployer history: …" lists the other coins from it that ApeCheck has checked (below). |
| E judge | `AI_MODEL_JUDGE` | Claim statuses with one-sentence evidence citing a step, `acct`/`git` (used only where Stage D could not decide, and never above `warn`), summary ≤ 180 chars, coin summary. `JudgeOutZ` + `normaliseJudge`. The model never sees or picks a score. A judge that times out, or a model that fails and is replaced by the stand-in (claims or judge), leaves a `warn` step ("Claim review timed out; used the simple rules"). |
| F save | no | `scoreCheck()` from core. One transaction: signals, `CheckEvidence`, scores, bands, areas, claims (in extraction order, `Claim.idx` 0..n-1), `CoinFacts` (with `deployerAddress` whenever the wallet is known), Deployer upsert (never from a private check: the deployers page lists every row, so a private check only links a row the public already knows), `priceAtCheck`/`mcAtCheck`, first `PricePoint`, `Target.last*`, `isLatest` moved to this check (a private check never takes or clears `isLatest` and leaves `Target.lastCheckedAt` / `checkCount` alone: the public verdict stays the public one). Then the share card (`GET WEB_INTERNAL_URL/card/<shortId>.png`, 5 s, skipped with a log line when the web app is down) → `SCREENSHOT_DIR/cards/<shortId>.png`, `done` on `check:{id}`, `end` on `live`, a `bot-replies` job for every X mention still waiting on the check (`BotMention` `QUEUED`, done or failed), the `rechecked` notifications of the watchers whose automatic re-check this is (see Re-check alerts; also after a failure), and its `check.completed` webhooks (requester, Max joiners, re-check watchers: see Webhooks; also after a failure). |

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
  entry led nowhere useful, or the site couldn't be checked (our browser failed after the site answered, or a bot challenge
  blocked it). Our browser failing before the site answered (no browser host, or our SSRF guard unreachable) ends the check
  `FAILED`: no verdict, nothing cached, Re-check to try again.
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
- **acct** — not checked: checks don't read X accounts (age, followers and bio need the paid X API, which only the bot
  uses). The signal is stored as null and left out of the score (`scoredSignals`: People is the GitHub signal alone,
  without touching the scoring weights); the judge's `acct` is ignored. The log names the account (`X account: @x`).

Coin (Stage D) — only the core helpers: `deployerRecord`/`deployerSignal`, `bandSignal(CONFIG.bundlePct)`,
`holdersSignal`, `lpSignal`, `authoritiesSignal`. A section ApeCheck has no source for, or did not get this time, is
`warn` with a log line saying so, untagged: "Bundle share: not checked", "Holder share: not checked" (+ " (Solana RPC
unavailable)" when that RPC failed), "LP status not checked" inside the holders line, "Deployer: not checked" (+ "
(Etherscan unavailable)", " (Blockscout unavailable)" or both, by which EVM creator lookup failed; " (lookup timed out)"
when neither answered in time). "Unavailable" only ever names a source that failed. The
deployer wallet (EVM: Etherscan creator, else Blockscout's; Tron: the contract's origin address) is kept in `CoinFacts.deployerAddress`
(`deployerKey`: EVM lowercased). Its history is read from ApeCheck's own checks and never scored: the step "Deployer
history: no earlier launches seen by ApeCheck (0xAbC…Ef02)" or "Deployer history: 2 other coins from this wallet checked
by ApeCheck, $FOO and $BAR (0xAbC…Ef02)", status `warn`, source `ApeCheck`; the deployer signal stays unknown (`mixed`,
`warn`), because ApeCheck only sees coins someone checked.

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
  show one), and cites why an X account is unknown ("@x: account age and followers not checked": accounts are not read).

## X bot (`src/bot/*`, HANDOFF §7, §11)

`startBotWorker()` (`bot/index.ts`) is what `worker-bot` runs. It needs `XSource.mentions()` / `reply()` from
`@apecheck/sources` and the four OAuth 1.0a user keys of the bot account (`X_API_KEY`, `X_API_SECRET`, `X_ACCESS_TOKEN`,
`X_ACCESS_SECRET`, env only); without them it warns once and idles. `X_BOT_USER_ID` is recommended (without it the
adapter looks the id up and the bot recognises itself by `X_BOT_HANDLE`).

- **One active bot.** A Redis lock (`bot:lock`, `SET NX EX`, TTL max(60 s, 3 polls), refreshed every poll and during a
  long batch). A second `worker-bot` stands by and takes over when the lock expires. Only the holder polls and runs the
  reply worker, so two processes never double-reply.
- **Polling.** Every `BOT_POLL_SECONDS` (default 60): `mentions(since_id)`, oldest first. `since_id` lives in Redis (`bot:since_id`)
  and only moves after the whole batch was stored and handled; on a cold start it is the newest handled
  `BotMention.tweetId` (or just below the oldest one still `RECEIVED`, so a mention whose handling was cut off is read
  again).
- **Store first** (`bot/handle.ts`). Every mention becomes a `BotMention` row before anything is decided
  (`createMany … skipDuplicates` on the unique tweet id): whoever inserts it handles it, once. A mention already stored
  is never handled again, so a re-delivered mention is never answered twice — except one still `RECEIVED` whose handling
  was cut off: a lease (`bot:handling:<tweetId>`, 120 s) is held while a mention is handled; a process that dies
  mid-mention leaves the row `RECEIVED` and the next poll stops there (since_id kept) until the lease is gone, then
  handles it. A transient database / Redis error (Prisma P1001/P1002/P1008/P1017/P2024/P2034, ioredis connection
  errors) leaves the row `RECEIVED`, lets go of the lease and stops the poll, so the next poll handles it; any other
  error marks it `FAILED`. `BotMention.text` is what the author typed
  (X's reply prefix left out): what the /bot page shows and what a follow-up asks. `BotMention.tagged` records that the
  author typed the bot's handle (not a retweet, not the bot itself), whatever the rules then do with it: `/v1/bot/stats`
  counts those authors as the accounts that have tagged the bot.
- **Rules, in order** (status `IGNORED` + `ignoreReason`, no reply, unless said otherwise):
  1. the bot itself (`self`), retweets (`retweet`), mentions older than `TUNING.botMaxMentionAgeHours` = 12 h when first
     read (`stale`: a backlog after downtime), accounts younger than `TUNING.botMinAccountAgeDays` = 7 days
     (`young_account`; the age comes with the mention, else `getUserById`; unknown is not held against anyone);
  2. **follow-ups**: a reply to (or a quote of) one of the bot's own verdict (or follow-up) posts (`inReplyToId` /
     `quotedId` = some `BotMention.replyTweetId`) is a question about that check (`kind: 'followup'`, `isFollowUp`) —
     unless the author typed the bot's handle with a new link, contract or X post of another target (or a bare
     "@ApeCheckBot @project"): that is a check of it (rules 4–5). An @handle inside a question ("is the @orbitxyz team
     doxxed?") stays a question. Tagging the bot under its "Couldn't finish" post runs that check's target again. A Pro/Max author
     (`User.tier` through `User.xUserId`, linked in M3) gets an answer from that check's stored data only
     (`answerFromCheck`: `loadAnswerData` + `ai.answer`, `AI_MODEL_JUDGE`, the same as site asks), saved as an `Ask` (via `BOT`, `askerHandle`) with
     `Check.asksCount + 1`. Anyone else gets one line pointing to the site ("Follow-up answers here are for Pro holders.
     The full report is on the ApeCheck site."), once per person per thread (`pointer_already_sent`), no URL unless
     `BOT_INCLUDE_LINK`. Empty questions (`empty_question`) and replies to a "Couldn't finish" post (`no_report`) get none;
  3. the author has to have **typed** the bot's handle: X's `display_text_range` (`XPost.displayTextRange`); when X sent
     none, the leading @handles X carries into a reply (the parent's author and its mentions) are its prefix. A bot
     handle only in that prefix is someone chatting further down a thread the bot is in (`not_tagged`) — except a direct
     reply to the bot's help line (answering "include its link or contract" with the link);
  4. **target** (`bot/resolve.ts`, `resolveBotTarget()`, pure): a contract or link (project site, X post, chart/explorer
     link with a contract) written in the mention (a quoted post counts as a link; links to and quotes of the bot's own
     posts and apecheck.io don't), else the links and contracts of the post it replies to (never its @handles: "Audited
     by @CertiK" names an auditor; cashtags never count), else an @handle typed in the mention (it never beats the
     parent's link: people tag friends next to the bot), else that post's author's profile; contract > site > X post >
     @handle when several appear in one post. A post it replies to that is itself a tag of the bot is a request, not a
     project post: its author (who asked) is never checked; the target is the earlier tag's check when it got one (so a
     second tag in the thread joins it), else what that tag named, else what it was under (the post above it, read with
     `getPost`). When only a post's author (or nothing) is found and the thread already has a public check, that check
     (a tag under the project's own "2/" post). Nothing → the help line "Tag me under a project's post, or include its
     link or contract." (`kind: 'help'`), at most once per thread (`help_already_sent`);
  5. **one check per target**: the same target already checked in this thread (running, or done at any age), else the
     shared `findReusableCheck()` of `@apecheck/db` (same rules as `POST /v1/checks`: the same target running, or a verdict
     younger than `CACHE_HOURS`), else `createCheck()` (via `BOT`, `requesterHandle`, `postId` for an X post, the linked
     `User` as requester) + a `checks` job with `PRIORITY.bot`, all under the API's `lock:create:<key>` lock. The mention is
     linked (`checkId`, `targetKey`, `kind: 'check'`, `QUEUED`) before the job is queued. A finished check (a cached
     verdict) is answered at once; a running one when Stage F queues the reply of **every** `QUEUED` mention linked to it.
     **Tagging twice in the same thread never makes a second check.** Another account's tag in the thread gets its own reply
     with the same verdict; the same account re-tagging for the same check is linked to it and not answered again
     (`answered_in_thread`: the thread already has, or will get, their answer, and X refuses a repeated post).
  Rules 2, 4 and 5 count against the hourly limits before anything starts (`bot/limits.ts`): `BOT_USER_HOURLY` per free
  account, `BOT_PRO_USER_HOURLY` for Pro/Max, `BOT_HOURLY_CAP` for the bot (`user_limit` / `global_limit`). A mention
  is counted when it is accepted (each accepted mention gets exactly one reply), so a burst can't overshoot while checks
  run; one Lua script moves both counters (fixed UTC hours). Posted replies are counted in `bot:replied:<hour>`.
- **Replies** (`bot/reply.ts`, the `bot-replies` consumer, jobId = mention id). Only ever to the stored mention's own
  tweet id, never without a stored `BotMention`, and notifying the asker only: X would put the mention's author and
  every account the mention names (its reply prefix included) in the reply's "Replying to"; all but the author are
  stored on the mention (`BotMention.replyExcludeIds`, `bot/mention.ts` `replyExcludeIds()`) and sent with every reply
  — verdict, "Couldn't finish", help, follow-up — as `reply.exclude_reply_user_ids`. Text from `bot/compose.ts` (pure):
  ```
  LIKELY LARP (37/100) · Coin: SKETCHY (37)
  'Launch app' does nothing; GitHub pushed in one burst at launch.
  Checks the claims, not the team. DYOR.
  ```
  No "· Coin: …" without a coin; a FAILED check: "Couldn't finish this check. Try again in a few minutes." Max 280
  counted the way X counts (`bot/xtext.ts`: URL = 23, CJK and other wide characters = 2, any emoji = 2, NFC); the summary is
  cut at a word boundary with "…". `xLength` is an upper bound: a domain under a TLD the list in `xtext.ts` doesn't know
  counts max(its length, 23), since X links every gTLD. `BOT_INCLUDE_LINK=true` appends `apecheck.io/c/<id>`
  (`APP_URL`'s host). Model-written text (summary, answers, and the stored `Ask.answer`) is built from untrusted pages
  and questions (HANDOFF §11), so it never mentions anyone (the "@" of any handle is dropped) and never carries a link:
  scheme URLs are dropped and every other domain is defanged (`orbit[.]xyz`), whatever its TLD; a model line in which
  anything could still be a link is left out. Right before posting, a reply holding any link but the opt-in report
  link is refused (`FAILED`). A verdict carries the share card PNG:
  `SCREENSHOT_DIR/cards/<shortId>.png` (Stage F), else `WEB_INTERNAL_URL/card/<shortId>.png` (5 s), else text only.
  Success → `REPLIED`, `replyTweetId`, `replyText`, `repliedAt`. A Redis marker (`bot:posted:<id>`) written as soon as X
  accepted the post makes a retry record it instead of posting again. **Nothing is answered twice**: a second marker
  (`bot:posting:<id>`) is written right before the POST. A failure is read for what it says about the post
  (`replyFailure()`): 429 or a connection that never opened → not sent, retried (3 attempts, backoff type `x-reply`:
  30 s, 60 s, or until X's rate-limit reset, max 30 min); a timeout, 5xx, dropped connection or unreadable answer →
  unknown (X may have created the reply): the marker stays and the next attempt first looks for the bot's reply on X
  (`XSource.findReply`, `GET /2/users/:id/tweets?since_id=<mention>`, an owned read), records it if found, posts only
  if not, and never posts when the lookup fails; the same lookup runs after a process died mid-POST. "Duplicate
  content" right after such an attempt means it posted: `REPLIED` (post id unknown when the lookup still misses it),
  never `FAILED`. A refusal (other 4xx, a first-attempt duplicate) or the last attempt → `FAILED` with the reason in
  `ignoreReason`.
- **Lost reply jobs.** On taking over the lock and every 5 minutes, `sweepLostReplies()` queues the reply again for any
  mention `QUEUED` for 5+ minutes (and less than 24 h) that is a help / follow-up reply or linked to a `DONE` / `FAILED`
  check, with no waiting, delayed or running job (a crash between `QUEUED` and the enqueue, a failed Stage F enqueue, a
  job that failed for good); a finished job with that id is removed first. After 3 re-queues it is given up (`FAILED`).
  A check job that finds its check already finished also queues the replies of its waiting mentions.

## Follow-up questions (`src/asks/*`, M3)

`POST /v1/checks/:id/asks` (Pro/Max, the API checks tier and `ASKS_PER_HOUR`) enqueues an `AskJob` on queue `asks` and
waits up to 45 s for the job's `AskJobResult` (`{ askId }`). worker-bot consumes it (`startAsksWorker`, concurrency 4,
no browser), also while the bot itself idles without X keys.

- `answerFromCheck()` (`asks/answer.ts`): `loadAnswerData(checkId)` — the check's stored record only, never the live
  page — then `ai.answer()` (`AI_MODEL_JUDGE`, or the heuristic stand-in) with 30 s; a model that fails or runs over is
  replaced by the stand-in's answer. The answer is model-written text built from untrusted pages (HANDOFF §11), so it
  is made safe like the bot's: no @mention, no link (scheme URLs dropped, domains defanged `orbit[.]xyz`), one line,
  ≤ 600 characters cut at a sentence (core `normaliseAnswer`), `pgText`; one in which anything could still be a link
  falls back to the stand-in's answer, then to "This check has no answer for that.". The bot's Pro follow-ups use the
  same function (then cut to fit 280).
- One transaction: `Ask { question, answer, askerId, askerHandle, via }` (`via: 'web' → WEB`, `'bot' → BOT`; an unknown
  `userId` is stored as null) and `Check.asksCount + 1`. A re-run of the same job (stalled worker) returns the Ask it
  already saved (`asks:done:<jobId>`, 1 h).
- `AskJob.checkId` is the internal `Check.id` (a shortId is accepted too). Jobs that can never be answered fail at once
  with BullMQ's `UnrecoverableError` and a message starting with a code: `bad_request:` (malformed job, empty
  question), `not_found:` (no such check), `no_report:` (the check isn't `DONE`), `expired:` (queued for more than
  2 minutes: the API answered 504 long ago and the asker may have asked again).

## Re-check alerts (`src/watch/*`, M3, HANDOFF §8)

Pro: "re-check alerts when a site or contract changes"; Max: "watchlists that re-check on their own". Runs in
worker-prices on queue `rechecks` (`startWatchWorker`).

- **Scan** (repeatable job `scan`, every 15 minutes, `watch/recheck.ts` `scanWatched`): targets with at least one Pro or
  Max watcher whose `Target.fingerprintAt` is missing or older than `WATCH_RECHECK_HOURS` (5 min of slack), oldest
  first, at most 500 per scan, minus those backing off after a failed read (`watch:retry:<targetId>`). Each gets a
  `RecheckJob { targetId }` (job name `target`, jobId `fp-<targetId>`, so it is never queued twice). Any job on the
  queue that isn't `scan` is a `RecheckJob`; the API queues one when a Pro/Max user starts watching a target that was never fingerprinted.
- **Fingerprints** (`watch/fingerprint.ts`, stored versioned as `<kind>:v3:<sha256>`; v2 added the proxy
  implementation, Token-2022 extensions and more volatile page values; v3 the ZeppelinOS and PROXIABLE implementation
  slots, the issue / mintTo mint selectors and an unknown mint for an unresolved proxy. Older values are replaced
  silently, never an alert):
  - site → the root page of the address people checked (the latest check's input gives scheme and port; else
    `https://<domain>/`), fetched with `sources.http` and `guard: true` (SSRF guard, 15 s, 1.5 MB). Hashed is the page's
    title, meta / Open Graph description and visible text after `watch/normalise.ts`: scripts, styles, templates, SVG,
    comments and the head out, tags to spaces, entities decoded, then every value that changes on its own → `#`:
    numbers of any shape with their currency, sign, direction arrow (▲ ▼ ↑ ↓) and k/M/B/% unit (prices, market caps,
    counters, holders, block numbers, years, versions; subscript and superscript digits as in `$0.0₄12`; `1e9`),
    durations and countdowns (`1d 2h`, `23h 59m`), dates (month / weekday names next to a number), clock times with
    am/pm/time zone, relative times ("5 minutes ago", "just now", "yesterday", "today"), transaction and block hashes
    (0x + 64 hex, base58 signatures, an id after "block", "tx", "commit", "build"…), the plural after a number ("1
    holder" / "2 holders"). A contract address (0x + 40 hex, a Solana or Tron base58 address) is kept whole: the site
    swapping its token is a change. Words, buttons, headings and links' text are what count; a change
    that is only a number (a new launch date, "v2" → "v3") is deliberately not one. A page rendered entirely by
    JavaScript is compared by its title, description and whatever text the server sends;
  - EVM coin → sha256(`eth_getCode` + `owner()` + whether a mint function exists + the implementation behind a proxy
    and the hash of its code, `sources.evm.getCode/tokenBasics`): a proxy's own bytecode never changes, so an upgrade
    (EIP-1967 slot, beacon, or new code at the same implementation address) is seen through the implementation;
    Solana coin → sha256(mint authority + freeze authority + token program + the Token-2022 extension settings an
    authority changes — transfer fee, transfer hook, permanent delegate, pause… — `sources.sol.mintInfo`); Tron →
    owner + mint function; a coin whose chain is unknown is not watched;
  - X post / profile → not watched for changes (a profile needs the paid X API, which only the bot uses; a post's
    text doesn't change): those targets are left out of the scan.
- **Never alert on errors.** A fingerprint is only produced from a read that worked: an HTTP error, an SSRF refusal, a
  timeout, a bot challenge (also a 200 "Just a moment..." page), a page with no text, any RPC error reported through
  `captureErrors`, an account X can't read → not compared, nothing stored, retried in an hour (a day for a target that
  can't be read at all: no RPC for its chain, not a page). On chain every part must be read definitively: an
  `owner()` call the node didn't run (HTTP 429, -32005, "header not found"…), an unread proxy slot or implementation,
  an `owner()` TronGrid didn't run are failed reads reported by the adapters (packages/sources README), never "no
  owner" / "not a proxy" — a throttled RPC can't fake a change, twice in a row or ever.
- **Compare.** The first fingerprint (or one from another method/version) is only stored. The same one moves
  `fingerprintAt`. A different one is read **a second time**, 5 s later (`CONFIRM_DELAY_MS`): only when both reads
  agree is it a change (a page that differs on every load — rotating tips, A/B tests — or a flaky RPC answer never
  alerts; it is `unstable`).
- **Whose baseline.** A change is news only to the watchers the stored fingerprint was kept for: those whose watch
  started before the fingerprint was `COVER_INTERVALS` (2) × `WATCH_RECHECK_HOURS` old (one kept current by its
  watchers is never older than an interval plus a late scan or a few failed reads). A fingerprint frozen while no
  Pro/Max user watched (the last one left or was downgraded weeks ago) is no baseline for someone who just started
  watching: the change may predate their watch, so with no watcher covered the new fingerprint simply replaces it
  (`rebaselined`, no alert, no re-check), and their alerts start from there. Watchers not covered get no alert, no
  `lastAlertAt` and no automatic re-check for that change. When a change alerts, the new
  fingerprint is stored (compare-and-set on the old one) in the same transaction that writes the alerts: only one run
  alerts for a change, and a failure leaves both as they were, so the next scan finds the change again. A job that
  throws anyway (the database blinked) is logged, backs off an hour and completes, so its jobId is free again.
- **A confirmed change:** one Notification `kind: 'changed'` per Pro and Max watcher ("orbitswap.xyz changed since its
  last check", "$ORBIT's contract changed since its last check", "$ORBIT's mint or freeze authority changed since its
  last check", "@kairolabs changed its X profile since its last check"), and `Watch.lastAlertAt`. Free watchers get
  nothing (the watchlist only). M4: in the same transaction, a `watch.changed` WebhookDelivery for each enabled webhook
  of a notified Max user that subscribed to it (queued once the transaction commits; see Webhooks).
- **Max: automatic re-check.** Max watchers whose watch wasn't re-checked in the last 12 h (`Watch.lastRecheckAt`) and
  who got fewer than `MAX_AUTO_RECHECKS_PER_DAY` automatic re-checks today (UTC; counted from their `changed`
  notifications that carry a `checkId`, and the slot reserved atomically in Redis — `watch:autorecheck:<userId>:<day>`,
  seeded from that count, given back when no re-check comes of it — so targets changing at once, 4 jobs in parallel,
  can't overrun the cap; a Redis failure falls back to the count) get **one** re-check of the target between them: the input of the latest
  public verdict through the shared `findReusableCheck` (with `recheck: true`: a run of the same target already in
  progress is joined) + `createCheck` of `@apecheck/db` under the same `lock:create:<key>` as the API and the bot, via
  `WEB`, `requesterId` = the first of them, a `checks` job with `PRIORITY.recheck` (jobId = check id). No credits are
  involved (credits are the API's, per request). Their `changed` notification then says "…; re-checking it now",
  carries the re-check's `checkId`, and `Watch.lastRecheckAt` is set — before the job is queued. A target with only
  private verdicts is never re-checked in public (its watchers still get the alert). A re-check that can't be queued is
  marked `FAILED`, and the alerts go back to the plain text without `checkId`.
- **The marker that links an automatic re-check to its watchers** is that `changed` Notification itself: it gets
  `checkId` = the re-check (internal `Check.id`) *before* the check's job is queued (a joined run that is already
  under way is linked the same way). Whenever a check ends
  — Stage F (`afterDone`), a failure, the stuck-check recovery, or a job re-run that finds the check finished
  (`pipeline/save.ts` `afterFinish`) — `completeAutoRechecks()` (`watch/notify.ts`) reads the watchers of the check's
  target (and of any Target row of the same project, in case the run re-keyed it), looks for their `changed`
  notifications with that `checkId`, and gives each of those users one `kind: 'rechecked'` notification: "Re-checked
  orbitswap.xyz: Likely real 72, was Partly real 48" (narrative band and score; "was" = the newest public verdict that
  finished before the re-check was created; without one just the new verdict), or "The re-check of orbitswap.xyz
  couldn't finish; the last verdict stands" for a failed run. Idempotent (a Postgres advisory lock per check and an
  existence check per user), durable (no Redis state to lose), and cheap for the checks nobody watches (three indexed
  reads). The same link sends the check's `check.completed` webhooks to every one of those Max watchers (M4, see
  Webhooks), not only to the one named as requester. A joined run that finished while the alerts were being written is
  completed right away by the scan job (the `rechecked` notifications and those webhooks).
- `Notification.checkId` holds the internal `Check.id`; the API maps it to the shortId of `NotificationDTO.checkId`
  (null → the target's latest check).

## Webhooks (`src/webhooks/*`, M4, HANDOFF §9, §11)

Max: "Get the verdict pushed to your server when a check finishes, or when a watched coin changes." The API stores the
webhooks (`POST /v1/webhooks`: URL vetted with the SSRF guard, https in production, `whsec_` secret) and queues the
"Send test" ping; this worker makes the event deliveries and sends every one. One `WebhookDelivery` row per (webhook,
event) and one job on queue `webhooks` per row (`WebhookJob { deliveryId }`, jobId = delivery id), consumed in
**worker-prices** (`startWebhooksWorker`, concurrency 8; see Fairness).

**Events** (`webhooks/events.ts`). Only webhooks that are enabled (`disabledAt` null), subscribed to the event and owned
by a user whose `User.tier` is `MAX` right now (kept current by the tier refresh) get deliveries.
- `check.completed` — every finished check (DONE or FAILED: Stage F, a failure, the stuck-check recovery, a job re-run
  that finds it finished: `afterFinish` → `fireCheckWebhooks`) goes to the webhooks of everyone who asked for it, and
  only to those:
  - its requester (`Check.requesterId`: a check started on the site, through the API or MCP, by a linked X account
    through the bot);
  - a Max user whose request (site, API key, MCP `run_check`) joined it while it was running: the API answered with
    this check's id instead of starting another and recorded them in Redis (`checkJoinersKey(checkId)`, a set of user
    ids kept 2 days, and `CHECK_JOINED_INDEX`; `readJoiners`). A request answered with a cached verdict
    (`cached: true`) makes no event;
  - every Max watcher it ran for as their automatic re-check (their `changed` notification links it, Re-check alerts),
    not only the first of them that the re-check names as requester; also when the re-check joined a run already in
    progress (and, when that run had already finished while the alerts were written, recheck.ts sends it right away).
  Someone else's check of the same target never reaches anyone else, and a private check only ever reaches its owner.
  A webhook added after the check finished doesn't get it. Delivery ids are derived from (webhook, event, check)
  (`deliveryIdFor`, `wd_<24 hex>`), so a check finished twice, or a user who is both requester and joiner, never makes
  a second delivery. `WebhookDelivery.checkId` is the internal `Check.id` (the API maps it to the shortId). A webhook
  deleted while the rows are written (a foreign-key error) makes the receivers be read again once, so the others still
  get theirs.
- `watch.changed` — the change detector's `changed` notification (Re-check alerts) for a Max watcher; written in the
  same transaction as the notifications (an alert and its webhooks exist together or not at all), `targetId` set, id
  derived from (webhook, event, notification).
- `ping` — the API's row and job (`attempts: 1`, `priority: WEBHOOK_PING_PRIORITY`: BullMQ takes every job without a
  priority — all event deliveries — before any prioritized one, so pings never hold up an event).

**Payload** (`WebhookPayload`, rebuilt from the database on each attempt: every attempt carries the same `id` = the
delivery id and the same `created` = when the event happened; delivery is at least once, so receivers dedupe on `id`):
```json
{ "id": "wd_…", "event": "check.completed", "created": "2026-10-19T23:30:00.000Z",
  "check": { "id": "<shortId>", "target": "orbitswap.xyz", "narrative": 48, "coin": 44, "total": 46,
             "verdict": "PARTLY_REAL", "summary": "The app loads but …", "report_url": "https://apecheck.io/c/<shortId>" } }
{ "id": "wd_…", "event": "watch.changed", "created": "…", "target": { "id": "<targetId>", "name": "orbitswap.xyz", "change": "site" } }
{ "id": "<delivery id>", "event": "ping", "created": "…" }
```
`check` is the flat shape of the MCP tool `run_check`, built by the same function (`checkResultOf` in
`@apecheck/core`, behind apps/api `toCheckResult`): `target` = what was pasted, `verdict` =
the narrative verdict enum (the coin verdict when only a coin score exists). A check that couldn't finish has
`narrative`/`coin`/`total`/`verdict` null and its plain reason (`Check.error`, "The check hit an error and could not
finish") as `summary`. `change` = what the change detector saw change: `site` (the page's text), `contract` (EVM/Tron
code, owner, mint function, proxy implementation), `mint` (a Solana mint's authorities / Token-2022 settings),
`profile` (the X profile).

**Sending** (`webhooks/deliver.ts`): `POST` the JSON with `Content-Type: application/json`, `User-Agent:
ApeCheck-Webhooks/1.0` and `ApeCheck-Signature: t=<unix seconds>,v1=<hex HMAC-SHA256(secret, "<t>.<raw body>")>`
(`signWebhook` of `@apecheck/core/node`; `verifyWebhook` there is the receiver side), through `sources.http` with
`guard: true` (the URL is resolved and vetted on **every** attempt and the socket pinned to the vetted address, so a
name that later points at a private address is refused), `redirect: false`, 10 s, at most 64 KB of the answer read.
https only in production (checked again here).
- **2xx** → `ok`, `deliveredAt`, `responseCode`; the webhook's `failCount` back to 0.
- **Anything else** (another status, 3xx included: "HTTP 302 (redirects are not followed)", a timeout, a refused or reset
  connection, a name that didn't resolve) → a failed attempt, retried: `WEBHOOK_JOB_OPTIONS` = 6 attempts with the
  `webhook` backoff (`webhookRetryDelayMs`: 1 min, then ×4 — 4, 16, 64 min, ~4.3 h — up to 10 % jitter; the sixth and
  last attempt is ~5.7 h after the first). The attempt count is `WebhookDelivery.attempts` (a re-queued job doesn't get
  6 more).
- **Refused without a request, not retried**: an SSRF refusal (private, loopback, link-local, metadata address or name;
  stored as "Not sent: the URL points to a private, local or internal address", the guard's reason — what the name
  resolved to — goes to the log only), a plain http URL in production, an invalid URL.
- Every attempt sets `Webhook.lastDeliveryAt` and `lastStatus` (null when nothing answered) and the row's `attempts`,
  `responseCode`, `error`. A delivery that fails for good adds 1 to `failCount`; **20 failed deliveries in a row**
  (`WEBHOOK_DISABLE_AFTER`) set `disabledAt`: no new events, and its pending deliveries fail without a request ("Not sent:
  the webhook was disabled after repeated failures") until the API's `POST /v1/webhooks/:id/enable` clears it.
- A **ping** is tried once and never adds to `failCount` (a success resets it, without re-enabling). The API only queues
  pings for an enabled webhook (`POST /v1/webhooks/:id/test` on a disabled one is 409 `webhook_disabled`; the /api
  page shows Enable there instead); a ping that is already queued when the webhook is turned off is still sent.
- Rows are written compare-and-set on (`status: pending`, `attempts`), so a stalled job's second run never records twice.
  The row and the webhook's health (`lastDeliveryAt`, `lastStatus`, `failCount`, `disabledAt`) are written in one
  transaction, so whoever sees a delivery settled (the /api page after "Send test") also sees the webhook as it now is.
  Logs name the webhook id and URL host only (a path or query may carry a token); the secret never leaves the HMAC.

**Fairness** (`deliverySlots`, Redis, shared by every worker-prices process). Each request holds slots: its webhook's
(one request in flight per webhook), its owner's (`PER_USER_IN_FLIGHT` = 2 across their webhooks) and, for a ping, its
owner's ping slot (one test in flight per user). A delivery whose slot is taken is `busy`: its job goes back to the
queue for 1–2 s (`moveToDelayed` + `DelayedError`: no attempt used, no worker slot held). So an endpoint that accepts
connections and never answers holds one of the 8 slots for at most 10 s at a time, however many pings or events are
queued for it, and one account holds at most 2: everyone else's deliveries go on. A slot frees itself after 30 s (a
worker that died holding it). When Redis can't be asked the delivery goes ahead.

**Lost deliveries.** A repeatable `sweep` job (every 5 minutes) queues again any delivery still `pending` 5+ minutes
after it was written whose job is gone, failed or completed (a crash between the row and the enqueue); one older than a
day, or with every attempt used, is marked `failed` ("Not delivered in time"). It reads the ids of every live job once
and pages through all pending rows in (`createdAt`, `id`) order, so deliveries waiting hours for a retry never hide a
lost one behind them; a sweep that stops early (20 000 rows looked at, 500 queued again) leaves its place and the next
one goes on from there. Any job on the queue that isn't `sweep` is a `WebhookJob`. While worker-prices is down,
deliveries wait in the queue.

**Catch-up.** The same sweep writes `check.completed` rows that were never written: `afterFinish` runs after the check
is already DONE/FAILED and announced, so a database error there (a pool timeout) is only logged. `missedCheckCompleted`
finds checks finished between 6 h and 5 minutes ago that a receiving webhook (of the requester, a re-check watcher, or a
joiner from `CHECK_JOINED_INDEX`) has no row for, and `checkCompletedDeliveries` writes and queues them (idempotent). A
webhook re-enabled within those 6 h can therefore get the events of checks that finished while it was off.

## Deployer history (ApeCheck's own checks)

A coin's deployer history is the other coins from the same wallet that ApeCheck has checked: `@apecheck/db`
`coinsByDeployer(prisma, { chain, address, excludeCa })` over `CoinFacts.deployerAddress` (indexed). One row per coin
(its contract on that chain, so a website or X post check that found a coin and a check of the coin itself count once):
the coin's newest finished **public** check naming the wallet, newest first. Private (Max) checks are never counted, so a
wallet only a private check named is never listed and a privately vetted coin never shows up in someone else's history.
Stage D reads it once per check for the log line (5 s cap; a failed lookup logs "Deployer history: not checked"); the API
reads it live for the report, the deployers page and MCP, and follow-up answers read it too. Nothing is stored, so
nothing needs refreshing: the old daily `deployers-refresh` job is gone, `startMaintenanceWorker` removes its schedule
from Redis at start, and a leftover job of that name finishes as a no-op.

## Tier refresh (`src/maintenance/tiers.ts`, M3, HANDOFF §8)

Hourly (`tiers-refresh`, minute 7, queue `maintenance`): `refreshUserTier()` / `computeTier()` of `@apecheck/db` (the
API's sign-in uses the same) for users seen in the last 7 days (`User.lastSeenAt`) whose tier is older than an hour,
and for Pro/Max users not seen lately once a day (their watchlists run without visits; someone who sold doesn't keep a
paid tier). Balances through `walletTokenBalance()` of `@apecheck/sources` (`sources.sol.tokenBalance` /
`sources.evm.tokenBalance`), 4 users at a time. A failed read keeps the last tier (computeTier retries it soon) for at
most 24 h after the last good read (`User.tierReadAt`), then drops the holding (Free unless overridden, logged); while
`TOKEN_ADDRESS` is empty nothing is read and only `TIER_OVERRIDES` wallets are above Free. The bot marks an X-linked user
as seen (`lastSeenAt`, at most once an hour) when they mention it, so bot limits and follow-ups read a current tier.
The job runs for minutes while the API signs users in and links wallets, so it loads only the ids that are due and reads
each user again just before refreshing them (skipped, and counted as `skipped`, when a sign-in stored their tier
meanwhile); `refreshUserTier()` writes only while the row is still the one it computed from (same wallets, same stored
tier), so a tier computed from an older copy never overwrites a newer one (`test/tier-refresh-race.test.ts`).

## Screenshot retention (`src/maintenance/shots.ts`, HANDOFF §12.6)

A daily repeatable job (`shots-cleanup`, `20 3 * * *` UTC) on the `prices` queue deletes `SCREENSHOT_DIR/<checkId>/` and
`SCREENSHOT_DIR/cards/<shortId>.png` of every check that finished more than `TUNING.shotsKeepDays` (30) days ago, except the
checks on the feed's top lists: the top `TUNING.shotsKeepTop` (50) of Most checked, Most real and Least real among the latest
public verdicts (same orderings as `GET /v1/feed`). For the cleaned checks `CheckStep.screenshot` and `Check.cardPath` are
set to null, so their reports show no broken images (the web still draws `/card/<id>.png` on demand). Files are deleted
before the DB is updated, in batches of 200; only plain `<id>` folder and card names inside `SCREENSHOT_DIR` are touched. `SCREENSHOT_DIR/logos/` (coin logos, content-addressed, shared by every check of a coin) is never touched.
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

Coins whose latest finished public check is ≤ 30 days old, on that check's cadence (a Re-check starts the schedule
again, since "since check" compares with the latest check's `priceAtCheck`). A private (Max) check never moves a public
coin's schedule (it would squeeze the public chart and sparkline into the last few hours); a coin only private checks
looked at is tracked on the newest of them. Due when the newest `PricePoint` is older than: 15 min
(first 24 h after the check), 1 h (to day 7), 1 day (to day 30), with one minute of slack on the 5-minute tick. Batched
`sources.dex.tokens(chain, addresses)`; each hit writes a `PricePoint` and refreshes `Target.lastPrice / lastMc /
lastVol5m / lastCh24 / priceUpdatedAt`. A check that finished while DexScreener didn't answer has no `priceAtCheck` (so no
"since check" at all): the first price the tracker reads within 30 minutes of the check finishing becomes its
`priceAtCheck` / `mcAtCheck`; a later one never does (a pair created hours after the check is not the price at check).

The API turns these into what the site shows (`apps/api` `loadSeries` / insights): since % = `Target.lastPrice` vs the
latest check's `priceAtCheck`; the feed sparkline and the report's "Price since check" chart = 0 at the check plus the
newest 27 points after it (`TUNING.sparkPoints` = 28); "Since check, by verdict" = the average since % per narrative band
of the latest public coin verdicts of the last 30 days. `test/e2e/since-check.test.ts` checks all of it end to end.

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

All from the repo-root `.env` (see `.env.example`). M4 webhooks need no new variable: `APP_URL` (the payload's
`report_url`), `NODE_ENV` (https only in production), `OUTBOUND_PROXY`, `SSRF_ALLOW_HOSTS` (tests only). M3: `WATCH_RECHECK_HOURS` (fingerprint cadence, default 6),
`MAX_AUTO_RECHECKS_PER_DAY` (default 20), `TOKEN_CHAIN`, `TOKEN_ADDRESS`, `PRO_MIN_HOLD`, `MAX_MIN_HOLD`, `TIER_OVERRIDES`
(tier refresh). worker-bot: `X_API_KEY`, `X_API_SECRET`, `X_ACCESS_TOKEN`,
`X_ACCESS_SECRET`, `X_BEARER_TOKEN` (optional), `X_BOT_USER_ID`, `X_BOT_HANDLE`, `BOT_POLL_SECONDS`, `BOT_USER_HOURLY`,
`BOT_PRO_USER_HOURLY`, `BOT_HOURLY_CAP`, `BOT_INCLUDE_LINK`, `APP_URL`, `CACHE_HOURS`. Used here: `DATABASE_URL`, `REDIS_URL`, `ANTHROPIC_API_KEY`,
`AI_BASE_URL`, `AI_MODEL_JUDGE`, `AI_MODEL_FAST`, `CHECK_BUDGET_SECONDS`, `CHECK_MAX_AGENT_ACTIONS`,
`MAX_CONCURRENT_BROWSERS`, `SCREENSHOT_DIR`, `WEB_INTERNAL_URL`, `OUTBOUND_PROXY`, `SSRF_ALLOW_HOSTS` (dev/test only),
`BROWSER_WS_ENDPOINT` + `BROWSER_GUARD_PORT` (production browser host),
`RPC_*` (wallet read passthrough + simulation), plus every data-source key `@apecheck/sources` reads.

## Run

```bash
pnpm --filter @apecheck/worker dev            # checks + prices, reloads on change
pnpm --filter @apecheck/worker start:checks   # what PM2 runs
pnpm --filter @apecheck/worker start:prices
pnpm --filter @apecheck/worker start:bot      # worker-bot (idles without the X keys)
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
Cloudflare challenge, error text; coins with ApeCheck's own facts only: the deployer history from earlier public checks of
the wallet, never a private one, and Solana / EVM / Tron coins whose every step says "not checked" in ApeCheck's words); `test/pipeline-timing.test.ts` covers late and repeated work (an abandoned Stage A, a
coin whose Stage D ran short, model fallbacks in the log, re-runs, a run that lost its check, stuck-check recovery, the
browser pool relaunch).

The bot: `test/bot-resolve.test.ts` (target resolution table: links, contracts, handles, reply prefix, quotes, the bot's own
links, several candidates, non-Latin and empty text), `test/bot-compose.test.ts` (reply format, X lengths with URLs / CJK /
emoji, link on/off, no coin, failed), `test/bot.test.ts` (with a `FakeX`, `test/fake-x.ts`: ignore rules, limits,
idempotency, one check per thread, cache hits, follow-ups Pro / non-Pro, posting retries and refusals, since_id, the lock
and the idle mode) and `test/bot-flow.test.ts` (M2 acceptance through the real queues and pipeline: a tag under a project
post whose link is the local working-app fixture gets one reply with the verdict and the card PNG, and a second tag in the
thread makes no second check). The same on the real X adapter: `test/bot-adapter.test.ts` (the adapter's recorded API
fixtures over a fake Http) and `test/bot-x-e2e.test.ts`, where `createSources()` builds the X adapter over `test/x-api.ts`,
a stateful api.x.com emulator (OAuth 1.0a signatures verified independently, nonces never reused, mentions timeline with
since_id / paging / field projection / a 429, the v2 chunked media upload checked byte for byte, POST /2/tweets with
X's reply, media and duplicate rules) and `sources.x` drives worker-bot, the queues and the pipeline: one reply with the
card per answered mention, one check per thread, a cached answer elsewhere, and a batch cut short by a 429 handled once;
the emulator builds each reply's "Replying to" list like X (minus `exclude_reply_user_ids`), which must be the asker
alone. `test/bot-reply-mentions.test.ts`: a tag naming 25 accounts, the help line and a follow-up pointer notify only
the asker. `test/bot-threads.test.ts`: second tags in a thread (replying to a tag, to the project's "2/" post, a tag
never stored), retry under "Couldn't finish", answering the help line, @handles in follow-ups, quotes of the bot's
verdict, mentions cut off by a crash or a transient error, the lost-reply sweep (also on the real queue), reply POSTs
with an unknown outcome on the FakeX and on the real X adapter (one POST, the lookup's id), `findReply` on the X API
emulator, and links in model-written text (reply and stored Ask).

M3: `test/asks.test.ts` (answers from the stored check with asker and `asksCount`, shortId, once per job, failure
codes, planted links / mentions made safe, model failure → stand-in, and the queue the way the API waits on it; a check
stored before ApeCheck dropped its third-party coin sources: no holder clusters or retired names reach the answerer),
`test/watch.test.ts` (normalising; a fixture site fingerprinted, its text changed → `changed` for Pro and Max but not
Free; a timestamp / price-only change, HTTP errors, bot challenges, a refused connection, a page that differs on every
load → no alert; automatic re-check limits — per day, 12 h per watch, private-only targets, joining a running check, a
failed enqueue; `rechecked` once; a fingerprint frozen while nobody paid watched → `rebaselined` for new watchers, and
only covered watchers alerted; the per-day cap with 4 targets changing at once; EVM fingerprints through the real
adapter — a 429 / -32005 `owner()` or proxy slot never alerts, a proxy upgrade with the same owner does; Tron with a
throttled `owner()`; Solana and Token-2022 extensions; the scan's selection),
`test/watch-flow.test.ts` (acceptance through the real `checks` and `rechecks` queues and the pipeline: a Max user's
watched site changes → one automatic re-check with `PRIORITY.recheck` → the `rechecked` notification with the new
verdict next to the old one), `test/maintenance.test.ts` (the retired deployer refresh: its schedule removed at start,
a leftover job a no-op; tier refresh: who is
due, holdings, overrides while the token isn't live, failed reads), `test/prices.test.ts` (+ the price-at-check backfill;
a private check never moves a public coin's schedule)
and `test/e2e/since-check.test.ts` (two coin checks through the queue and pipeline, 31 simulated days of price ticks on
the 15 min / 1 h / 1 day schedule with moving fake DexScreener prices, then the real API from `apps/api` against the same
database: report since % and chart series, feed since % and sparkline, the "Since check, by verdict" card).

M4: `test/webhooks.test.ts` (the real `webhooks` queue and the real SSRF-guarded client against a local receiver
allow-listed with `SSRF_ALLOW_HOSTS`: who gets `check.completed` — the requester's enabled, subscribed webhooks, Max only,
once per check, a private check only its owner; Max joiners and every Max watcher an automatic re-check ran for (created
or joined, through `processRecheck`); a webhook deleted mid-write; fairness: an endpoint that never answers holds one
slot while 16 pings queue for it and another user's delivery goes straight through, at most 2 requests per user, pings
after events; the sweep paging past live jobs and resuming where it stopped; the catch-up after a database error in
`afterFinish`; the WebhookPayload, headers and a signature verified with `verifyWebhook`
and an HMAC computed in the test; a failed check; retries on 500/503 with spaced attempts and one delivery id; no retry
storm — exactly 6 attempts, one `failCount`, nothing after; redirects not followed; 20 failed deliveries disable the
webhook, after which no events are made and a waiting delivery fails without a request; loopback, private, metadata and
`localhost` URLs refused without a request and not retried; a name that now resolves to a private address; https only
in production; a refused connection retried; pings; the sweep; `watch.changed` from `processRecheck` for Max watchers
only; Stage F and the failure path queueing `check.completed`).

Tests use the database `apecheck_test_worker` (created and migrated by `test/global-setup.ts`) and Redis db 2, never
the dev data. External data sources are replaced by `test/fakes.ts` (`FakeSources`, same `Sources` contract); fixture
sites in `test/fixtures/sites/*` are served on 127.0.0.1 under `<name>.test` host names that a test resolver maps to
loopback, allow-listed through `SSRF_ALLOW_HOSTS`, so the real guard proxy and route guard stay in the path.
