# ApeCheck — build status

All four milestones from HANDOFF §13 are built and tested. Nothing is deployed yet (see "To go live").

| Milestone | Status |
|---|---|
| M1 — site + check pipeline | Done |
| M2 — X bot (@ApeCheckBot) | Done, not yet run against live X |
| M3 — depth (prices, deployers, watchlist, notes, wallet sign-in, tiers, follow-ups) | Done; Pro/Max open at token launch |
| M4 — developers (API keys, webhooks, MCP, /api page) | Done |

Tests: core 45, db 17, sources 312, api 218, worker 357, web 94 unit + 49 browser e2e, worker e2e (local fixture sites
through the real queue), deploy checks. `pnpm -r typecheck` and `next build` are clean.

## What works

- **Site** (matches `design/apecheck.html`, light/dark, 1440–390 px): feed with live checks, insights and verdict list; report
  page with the live SSE log and the agent's real screenshots; coins, deployers, X bot and API pages; share card PNG.
  The prototype's mock lines (who funded a deployer, X account age) are not on the live site: it shows only what
  ApeCheck reads itself.
- **Checks**: website, X post/profile, EVM (Base → Ethereum → BNB → Arbitrum → Robinhood Chain) and Solana/Tron contracts.
  Stages A–F with per-stage timeouts; a stage that fails is logged and scored `warn`; a site that never loads finishes with
  `launch = fail`. Scores come only from `packages/core/src/scoring.ts` (tested against `reference/scoring.ts`); every weight and
  threshold is in `packages/core/src/config.ts`. Waitlist/dead sites can't score above Partly real.
- **Security (HANDOFF §11)**: SSRF guard on every fetch and on all browser traffic (DNS pinned), Chromium as its own user with its
  sandbox on behind a firewall in production (`deploy/browser`), mock wallet that only simulates, page content fenced as untrusted
  data, all model output zod-validated, rate limits per IP / user / API key, API keys hashed.
- **Bot**: mention polling, target resolution in the §7 order, one reply per mention with the card, cache, per-user and global
  limits, follow-ups for Pro; never tags anyone uninvited.
- **Accounts**: Sign-In With Ethereum (incl. smart wallets) and Solana, X account linking, tiers from $APECHECK holdings,
  credits/priority/private checks by tier, follow-up questions, community notes, watchlist with change alerts (Pro) and automatic
  re-checks (Max).
- **Developers**: API keys (Max), signed webhooks (`ApeCheck-Signature: t=…,v1=…`), MCP server (`run_check`, `get_check`,
  `ask_followup`, `deployer_history`) at `mcp.apecheck.io`.

## Stubbed or unverified, and why

- **Not run against live services**: the build sandbox blocked X, DexScreener, every RPC and public websites, and had no
  `ANTHROPIC_API_KEY`. Those adapters are tested against recorded/fake responses; the AI stages ran on the heuristic stand-in.
  First thing on the VPS: `pnpm diagnose` (the doctor) as `apecheck` (DEPLOY.md §6 "Doctor"). It writes nothing, probes every
  dependency with the code a check runs, and prints one row per dependency with what to fix. Then run
  `E2E=1 E2E_TARGET=<a real project site> pnpm e2e`.
- **Coin facts without an ApeCheck source**: bundle share, LP status, holder count and EVM/Tron holder share are "not
  checked" (scored `warn`, said so in the log). Deployer history counts only coins ApeCheck has checked from the same
  wallet (EVM: Etherscan creator, else Blockscout's on Ethereum, Base, Arbitrum and Robinhood Chain, where Blockscout is the only source; Tron: contract origin address; Solana deployers are not looked up) and never lifts the
  deployer signal above `warn`.
- **X handle-rename history**: needs a third-party source; always "unknown".
- **Token**: `TOKEN_ADDRESS` is empty, so everyone is Free and the site says "Pro and Max open at token launch". Team wallets can
  be given a tier with `TIER_OVERRIDES` for testing.

## Empty `.env` values

`ANTHROPIC_API_KEY` · `X_API_KEY` `X_API_SECRET` `X_ACCESS_TOKEN` `X_ACCESS_SECRET` `X_BEARER_TOKEN` `X_BOT_USER_ID` ·
`X_OAUTH2_CLIENT_ID` `X_OAUTH2_CLIENT_SECRET` (X account linking) · `HELIUS_API_KEY` `ALCHEMY_API_KEY` (Ethereum, Base and Arbitrum in one key) `ETHERSCAN_API_KEY` `TRONGRID_API_KEY` ·
`RPC_*` (every EVM RPC, Robinhood Chain's included, falls back to a public endpoint) · `GITHUB_TOKEN` (works unauthenticated at 60 requests/hour;
old `FOURTIS_*` lines in `.env` are ignored, delete them) · `TOKEN_ADDRESS` · production `SESSION_SECRET`, database password, `BACKUP_REMOTE`;
`BROWSER_WS_ENDPOINT` is filled in by `deploy/browser/install.sh`.

## Coin data from ApeCheck's own sources only

ApeCheck no longer calls any third-party coin service. Deploying this release:

- `prisma migrate deploy` adds one index (`CoinFacts_deployerAddress_idx`); nothing is dropped or rewritten.
- Rows stored before keep loading: old step source tags and their "unavailable" lines are shown as "not checked"
  (`displayStep` in `packages/core/src/labels.ts`), old holder clusters in `Check.evidence` are never served, and stored
  bundle / LP / holder-count values still show, untagged.
- The `Deployer` table, `CoinFacts.deployerId` and the `DeployerRecord` enum are no longer read or written. They stay
  this release so a rollback still finds them; drop them in a later release (after a backup, `deploy/backup.sh`).
- worker-prices removes the old daily `deployers-refresh` job schedule from Redis when it starts.
- Read-only check of what older rows hold: `SELECT count(*) FROM "Deployer";`,
  `SELECT source, count(*) FROM "CheckStep" WHERE source NOT IN ('X','GitHub','DexScreener','On-chain','ApeCheck') GROUP BY 1;`.

## Decisions for ALFA

- Token: ticker, chain, Pro/Max holding amounts (HANDOFF §14). Paying in USDC is hidden until decided.
- Bot: a second tag by the same person in the same thread gets no second reply (others do). Change if both should get one.
- Final bot handle if `@ApeCheckBot` is taken; whether to buy `apecheck.live`.

## To go live

Follow `DEPLOY.md`. Needed: the VPS IP and an SSH user with sudo; DNS `A` records for `@`, `www`, `api`, `mcp`; the keys above
(at least `ANTHROPIC_API_KEY` and the X keys); the X account's "Automated" label (DEPLOY.md §14).
