# ApeCheck

**apecheck.io** tells people whether a crypto project is actually built or just announced (a "LARP").
Paste a contract address, an X post or a website: an agent opens the project in a real browser, tries the main flow,
extracts every claim, checks the claims against the code, the chain and X, and publishes a verdict with the evidence.
The same check runs when someone tags **@ApeCheckBot** under a post on X.

- Spec: [`docs/HANDOFF.md`](docs/HANDOFF.md) · Approved UI: [`design/apecheck.html`](design/apecheck.html) · Deploy: [`DEPLOY.md`](DEPLOY.md)

## Layout

```
apps/
  web/      Next.js 14 (App Router): feed, report, coins, deployers, bot, API pages, share-card PNG
  api/      Fastify: REST API, SSE live log, credits, rate limits, /shots
  worker/   BullMQ workers: check pipeline + browser agent, X bot, price tracker
packages/
  core/     scoring.ts + config.ts (every weight/threshold), DTOs, target detection, shared copy, env schema
  db/       Prisma schema + client (PostgreSQL)
  sources/  data adapters (DexScreener, EVM/Solana/Tron RPC, Etherscan, GitHub, X) + SSRF guard
reference/  scoring.ts as handed off (the port in packages/core is tested against it)
deploy/     Nginx config, backup script, browser/ (the isolated Chromium host: systemd unit, firewall, AppArmor, installer)
ecosystem.config.cjs   PM2 processes
```

## Local development

Requirements: Node ≥ 20.11, pnpm 10, PostgreSQL 16, Redis 7.

```bash
pnpm install
cp .env.example .env        # then set local values: DATABASE_URL, REDIS_URL, APP_URL=http://localhost:3000,
                            # API_URL / NEXT_PUBLIC_API_URL=http://localhost:4000, SCREENSHOT_DIR=./.data/shots
pnpm --filter db prisma migrate deploy
pnpm dev                    # web :3000, api :4000, worker (checks + prices; the X bot only with X_BOT_DEV=1)
```

Chromium for the agent: `pnpm --filter @apecheck/worker exec playwright install chromium`. In development the worker launches
it in-process (with a minimal environment, never the `.env` secrets). In production it never does: Chromium runs as a separate
user with its sandbox on, behind a firewall, in `apecheck-browser.service` (`deploy/browser`, DEPLOY.md §6), and worker-checks
connects to it at `BROWSER_WS_ENDPOINT`; with `NODE_ENV=production` and no endpoint, worker-checks refuses to start.

Every Node process reads the repo-root `.env` and lets it win over inherited variables (a deploy is configured by its `.env`
only). `APECHECK_ENV_FILE=<path>` (absolute, or relative to the repo root) selects another file for every process, the Prisma
CLI and the web build, e.g. `APECHECK_ENV_FILE=deploy/staging.env pm2 start ecosystem.config.cjs`. Under `NODE_ENV=test`
(set by every vitest config) inherited variables win instead, so tests always use their own `DATABASE_URL` / `REDIS_URL`.

Empty API keys are fine: each adapter runs as a stub, logs one warning, and the check still finishes
(missing signals are scored `warn`). Without `ANTHROPIC_API_KEY` the AI stages use a heuristic stand-in with the same interface.

## Tests

```bash
pnpm test                   # unit + integration tests in every package (needs Postgres + Redis running)
pnpm typecheck
pnpm e2e                    # full pipeline against local fixture sites
pnpm test:deploy            # deploy artifacts: browser host unit, firewall, installer (some checks need root)
E2E=1 pnpm e2e              # plus one real check against a public site (needs open internet)
```

## Scoring

`packages/core/src/scoring.ts` is the handed-off `reference/scoring.ts`, unchanged except that weights, thresholds and bands
live in `packages/core/src/config.ts`. `packages/core/test/scoring.reference.test.ts` checks the port against the reference for
every input combination. The AI never picks a score: it only fills claim statuses and sentences.
