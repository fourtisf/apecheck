# Deploying ApeCheck (Hostinger VPS)

Follows HANDOFF §12. Target: Ubuntu 24.04 LTS, at least 4 vCPU / 8 GB RAM (each Chromium context needs roughly 0.5–1 GB).

Processes (PM2, `ecosystem.config.cjs`):

| PM2 name | What | Port |
|---|---|---|
| `web` | Next.js 14 site (`apps/web`) | 3000 (localhost only) |
| `api` | Fastify REST + SSE (`apps/api`) | 4000 (localhost only) |
| `worker-checks` | check pipeline; drives the browser agent | — |
| `worker-bot` | @ApeCheckBot mentions + replies (§14); answers the site's follow-up questions (M3, queue `asks`), so it must run even before the bot has X keys | — |
| `worker-prices` | price tracking, screenshot cleanup; M3: re-check alerts for watchlists (queue `rechecks`), daily deployer refresh, hourly tier refresh; M4: webhook deliveries (queue `webhooks`, outbound HTTPS to developers' URLs through the SSRF guard) | — |

Plus one systemd unit, `apecheck-browser.service` (`deploy/browser`): Chromium itself, as a separate user with no access
to the app's secrets (§6). Its Playwright endpoint is `127.0.0.1:9223` (localhost only); worker-checks' SSRF guard proxy is `127.0.0.1:9224`.

Nginx terminates TLS: `apecheck.io` → `:3000`, `api.apecheck.io` → `:4000` (SSE-safe), `mcp.apecheck.io` → the API's
`/mcp` (MCP server, M4; SSE-safe), `www` → apex.

---

## 0. What you need before starting

- The VPS IP address and an SSH user with `sudo`.
- DNS for `apecheck.io` at your registrar (step 7).
- The `.env` values: see `.env.example`. Keys that are still empty don't block the deploy: that adapter runs as a stub and logs a warning (see "Empty keys" at the end).
  The X bot needs its own X account and developer app (§14); until its keys are in, `worker-bot` idles.

## 1. Server packages (as root / sudo)

```bash
sudo apt-get update && sudo apt-get -y upgrade
sudo apt-get install -y curl git build-essential ca-certificates gnupg ufw

# Node 22 LTS (HANDOFF §12 says Node 20, which reached end-of-life in April 2026; everything is tested on 22)
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt-get install -y nodejs
sudo npm install -g pnpm@10.28.0

# PostgreSQL 16, Redis 7, Nginx, certbot, rclone (backups), nftables + AppArmor (browser isolation, §6)
sudo apt-get install -y postgresql-16 redis-server nginx certbot python3-certbot-nginx rclone nftables apparmor

# PM2
sudo npm install -g pm2

# Firewall: only SSH and HTTP(S) from outside
sudo ufw allow OpenSSH
sudo ufw allow 'Nginx Full'
sudo ufw --force enable
```

Redis listens on localhost only by default on Ubuntu; keep it that way (`bind 127.0.0.1 ::1` in `/etc/redis/redis.conf`).

## 2. Unprivileged users

The browser agent opens untrusted sites, so nothing runs as root (HANDOFF §11), and Chromium does not run as the app user either:

| User | Runs | Can read / reach |
|---|---|---|
| `apecheck` | the five PM2 apps, the backup cron | the checkout, `.env`, `~/.pm2`, the rclone config, Postgres, Redis |
| `apecheck-browser` | Chromium only (`apecheck-browser.service`, created by §6) | none of that; network: only worker-checks' SSRF guard proxy |

```bash
sudo adduser --system --group --home /srv/apecheck --shell /bin/bash apecheck
sudo mkdir -p /var/apecheck/shots /var/log/apecheck /var/backups/apecheck
sudo chown -R apecheck:apecheck /var/apecheck /var/log/apecheck /var/backups/apecheck
# nothing of the app user is for other users: code, .env, ~/.pm2, ~/.config/rclone, screenshots, logs, dumps
sudo chmod 0750 /srv/apecheck /var/apecheck /var/log/apecheck /var/backups/apecheck
```

## 3. Code and `.env`

```bash
sudo -u apecheck git clone https://github.com/fourtisf/apecheck.git /srv/apecheck/app   # add -b <branch> to deploy a branch
cd /srv/apecheck/app
sudo -u apecheck cp .env.example .env
sudo -u apecheck chmod 600 .env
sudo -u apecheck nano .env        # fill in the values (see step 4 for DATABASE_URL)
```

(If the repository is made private later, give the server a read-only GitHub deploy key and clone `git@github.com:fourtisf/apecheck.git`.)

Every process (PM2 apps, the Prisma CLI, the web build) reads this `.env` and it wins over the shell's variables.
To run a second configuration from the same checkout, point `APECHECK_ENV_FILE` at another file.

`.env` must contain at least: `NODE_ENV=production`, `APP_URL=https://apecheck.io`, `API_URL=https://api.apecheck.io`,
`NEXT_PUBLIC_APP_URL=https://apecheck.io`, `NEXT_PUBLIC_API_URL=https://api.apecheck.io`, a random `SESSION_SECRET`
(`openssl rand -hex 32`), `DATABASE_URL`, `REDIS_URL=redis://localhost:6379`, `SCREENSHOT_DIR=/var/apecheck/shots`.
`BROWSER_WS_ENDPOINT` is filled in by §6; leave `BROWSER_GUARD_PORT=9224`.

Accounts (M3):

- `COOKIE_DOMAIN=.apecheck.io`, so the session cookies the API sets also reach the site and a page renders signed in on
  the first paint (without it the header shows "Connect wallet" for a moment until the browser asks the API itself).
- `TOKEN_ADDRESS` stays empty until the token launches: everyone is Free and the site hides holding amounts ("Pro and
  Max open at token launch"). `TIER_OVERRIDES=<wallet>:pro,<wallet>:max` gives team wallets a tier before that (applied
  at sign-in; `pm2 restart api worker-prices` after changing it).
- "Link your X" (bot limits follow the wallet's tier): set `X_OAUTH2_CLIENT_ID` / `X_OAUTH2_CLIENT_SECRET` from an X
  app with OAuth 2.0 and register `https://api.apecheck.io/v1/auth/x/callback` as its callback URL. Without them the
  link is simply not offered.

> The paths below assume the repo lives in `/srv/apecheck/app`. `deploy/backup.sh` defaults to `APP_DIR=/srv/apecheck`; set `APP_DIR=/srv/apecheck/app` in its cron line (step 10).

## 4. Database

```bash
sudo -u postgres psql -c "CREATE ROLE apecheck LOGIN PASSWORD '<strong-password>';"
sudo -u postgres psql -c "CREATE DATABASE apecheck OWNER apecheck;"
```

Then in `.env`: `DATABASE_URL=postgresql://apecheck:<strong-password>@localhost:5432/apecheck`.

## 5. Install, migrate, build (as `apecheck`)

```bash
cd /srv/apecheck/app
pnpm install --frozen-lockfile
pnpm --filter db prisma migrate deploy
pnpm build
```

`pnpm build` builds the Next.js site and typechecks the API and workers (they run TypeScript directly through `tsx`).
Chromium is not installed for the app user: the browser host in §6 gets its own copy (this replaces HANDOFF §12.1's
`playwright install --with-deps chromium`).

## 6. Isolated browser host (as root), then PM2 (as `apecheck`)

Chromium renders attacker-chosen pages, so it never runs inside worker-checks, which holds every secret in `.env`.
It runs in its own systemd unit, `apecheck-browser.service`:

- as the `apecheck-browser` system user, which owns no code and cannot read `/srv/apecheck` (code, `.env`, `~/.pm2`,
  the rclone config) or the dumps; the unit also hides those paths and makes everything but a private `/tmp` read-only;
- from a root-owned copy in `/opt/apecheck-browser`: playwright-core at the exact version `apps/worker` pins, its
  headless Chromium, and `deploy/browser/browser-host.cjs`;
- with Chromium's own sandbox on (`chromiumSandbox: true`). Ubuntu 24.04 only lets programs with an AppArmor `userns`
  rule create the user namespace that sandbox needs; `deploy/browser/apparmor-apecheck-chromium` grants it to these
  binaries, as Google's chrome package does for Chrome. Do not turn `kernel.apparmor_restrict_unprivileged_userns` off instead;
- with an explicit minimal environment (no secrets) and systemd hardening (no capabilities, `NoNewPrivileges`, only the
  user/pid/net namespaces the sandbox needs, `MemoryMax=4G`);
- behind an egress firewall (`deploy/browser/browser-firewall.nft`, nftables, for this user only): it can reach
  worker-checks' SSRF guard proxy on `127.0.0.1:9224` and nothing else (not Redis, Postgres, the API, DNS or the internet directly).

On startup the host refuses to run as root, if it can read `.env` or the app tree, if it can connect to
`127.0.0.1:5432` or `:6379` (firewall missing), or if Chromium comes up with `--no-sandbox` or a renderer outside
seccomp-bpf; it rechecks the running process tree every 30 s. worker-checks connects at `BROWSER_WS_ENDPOINT` (its path
is a random secret), checks that the browser can reach the guard, gives every check's context the guard as its proxy
(a context without one fails closed), and refuses to start in production without the endpoint.

```bash
sudo /srv/apecheck/app/deploy/browser/install.sh
```

It installs all of the above, writes `/etc/apecheck/browser.env` (root-only; the endpoint secret), starts the unit,
waits until it listens (only after its checks passed) and sets `BROWSER_WS_ENDPOINT` in `.env`. It needs the same
`playwright` version as `apps/worker/package.json`, so re-run it after every bump (§11, §13). Check:

```bash
systemctl status apecheck-browser
journalctl -u apecheck-browser -n 5    # ... ready on ws://127.0.0.1:9223/<BROWSER_WS_PATH> as uid ...; Chromium 141..., sandbox verified
```

If `install.sh` stops at `apt-get update failed`, a repository on the server (not ApeCheck's) is broken, e.g.
`NO_PUBKEY` or `is not signed` for a third-party repository whose signing key changed. Fix its key, or switch it off
for the install and back on afterwards:

```bash
for f in $(grep -lE 'packages\.clickhouse\.com|cli\.github\.com' /etc/apt/sources.list.d/* 2>/dev/null); do mv "$f" "$f.apecheck-off"; done
sudo /srv/apecheck/app/deploy/browser/install.sh
for f in /etc/apt/sources.list.d/*.apecheck-off; do [ -e "$f" ] && mv "$f" "${f%.apecheck-off}"; done
```

(Put the hosts `apt-get update` named in the `grep` pattern.)

If the unit keeps restarting, the journal names the failed check: `Chromium sandboxing failed` (AppArmor profile not
loaded: `sudo aa-status | grep apecheck`), `this user can read ...` (`/srv/apecheck` is not 0750, §2) or
`can connect to 127.0.0.1:6379` (firewall not loaded: `sudo nft list table inet apecheck_browser`). If worker-checks
logs `cannot reach the guard proxy`, `BROWSER_GUARD_PORT` and the port in `browser-firewall.nft` differ (install.sh
refuses that; change both together).

Then start the apps (as `apecheck`):

```bash
cd /srv/apecheck/app
pm2 start ecosystem.config.cjs
pm2 save
pm2 startup systemd -u apecheck --hp /srv/apecheck
# pm2 prints a `sudo env PATH=... pm2 startup ...` line: run it once (as your sudo user) so PM2 starts on boot.
```

Check: `pm2 ls` (all five `online`), `pm2 logs --lines 50`, `curl -s localhost:4000/health`, `curl -sI localhost:3000`.

### Doctor: check every dependency (read-only)

Once PM2 is up, and again after every change to `.env`, run the doctor (`pnpm diagnose`) as `apecheck`:

```bash
sudo -iu apecheck
cd /srv/apecheck/app && pnpm diagnose
```

The doctor loads the same `.env` as the workers. It prints the AI mode worker-checks will use (`claude` or
`heuristic`) and the host each chain's RPC points at, then one row per dependency, each probed with the code a check
runs:

- Postgres (pending migrations) and Redis (which workers listen on each queue);
- a website fetch through the SSRF guard, the guard's own DNS and egress, the browser host, and a page loaded by the
  browser through worker-checks' guard;
- both AI models (`AI_MODEL_JUDGE`, `AI_MODEL_FAST`), each with one small real call; the two calls together cost well
  under one cent;
- each EVM RPC (chain id, latest block, and one known token decoded by the same adapter), Robinhood Chain when
  configured, Etherscan, Solana, TronGrid, DexScreener and GitHub (with its remaining rate limit);
- X reads (the Bearer token), the X bot's OAuth 1.0a keys (a signed `GET /2/users/me`; it never posts) and Fourtis.

| Status | Meaning |
|---|---|
| `PASS` | configured, and it answers as a check needs |
| `WARN` | it works, but on a keyless or public fallback or only partly; or a recommended key is empty, so that part of every check is skipped |
| `FAIL` | a request was made and failed, or required infrastructure is missing |
| `SKIP` | an optional service that is not configured |

Every row that is not `PASS` has a `fix:` line that names the variable to set and where to get the key. The command
exits 1 when any row is `FAIL`.

The doctor writes nothing: no database rows, no queue jobs and no posts. Its output shows hosts only, with keys,
passwords and the browser endpoint's path redacted. It never listens on `BROWSER_GUARD_PORT`. worker-checks starts
its guard there when it opens its first website, so until then "Browser via guard" is `WARN`. In that case run one
website check, then run the doctor again.

A check that ends `partly` within a second or two usually matches a non-PASS row here. Common causes are an X post or
profile checked without `X_BEARER_TOKEN`, a site the browser could not open, or chain RPCs the VPS cannot reach.

## 7. DNS (at the registrar for apecheck.io)

| Type | Name | Value |
|---|---|---|
| A | `@` | VPS IP |
| A | `www` | VPS IP |
| A | `api` | VPS IP |
| A | `mcp` | VPS IP (M4: the MCP server) |

## 8. Nginx + SSL

```bash
sudo cp /srv/apecheck/app/deploy/nginx/apecheck.conf /etc/nginx/sites-available/apecheck.conf
sudo ln -sf /etc/nginx/sites-available/apecheck.conf /etc/nginx/sites-enabled/apecheck.conf
sudo rm -f /etc/nginx/sites-enabled/default
sudo nginx -t && sudo systemctl reload nginx

sudo certbot --nginx -d apecheck.io -d www.apecheck.io -d api.apecheck.io -d mcp.apecheck.io
```

`/v1/checks/*/events` (SSE) is proxied with `proxy_buffering off` and a 1 h read timeout, so the live log streams through.
`mcp.apecheck.io` (`/` and `/mcp`) and `api.apecheck.io/mcp` go to the API's `/mcp` the same way (no buffering, 300 s
reads): the MCP tool `run_check` answers over SSE after up to 150 s. `MCP_ENABLED=false` turns the MCP server off (404).
Adding `mcp` to an existing certificate later: `sudo certbot --nginx --expand -d apecheck.io -d www.apecheck.io -d api.apecheck.io -d mcp.apecheck.io`.

Verify the MCP server: `curl -s -X POST https://mcp.apecheck.io -H 'content-type: application/json' -d '{}'` answers 401
`key_required`; with `-H "authorization: Bearer <a Max user's key>" -H 'accept: application/json, text/event-stream'` and an
MCP `initialize` body it answers `event: message` with the server info.

Verify SSE end to end once a check exists: `curl -N https://api.apecheck.io/v1/checks/<id>/events` prints `event: step` lines as they happen.

## 9. Screenshots

Screenshots are written under `SCREENSHOT_DIR` (`/var/apecheck/shots`) and served by the API at `/shots/*`; the share cards
the worker saved for the bot are in `SCREENSHOT_DIR/cards/`. Every day at 03:20 UTC `worker-prices` deletes the screenshot
folder and saved card of each check that finished more than 30 days ago, except checks in the top 50 of the feed's Most
checked, Most real and Least real lists (HANDOFF §12.6), and clears their screenshot references so reports show no broken
images. Retention and list size are `TUNING.shotsKeepDays` / `TUNING.shotsKeepTop` in `packages/core/src/config.ts`.

## 10. Backups (nightly `pg_dump`, off-server)

```bash
sudo -u apecheck rclone config            # create a remote, e.g. "s3" or "b2"
echo 'BACKUP_REMOTE=s3:apecheck-backups/pg' | sudo -u apecheck tee -a /srv/apecheck/app/.env
sudo -u apecheck crontab -e
# add:
15 3 * * * APP_DIR=/srv/apecheck/app /srv/apecheck/app/deploy/backup.sh >> /var/log/apecheck/backup.log 2>&1
```

Give rclone a credential that can write but not delete (a B2 application key without `deleteFiles`, or an S3 policy
without `s3:DeleteObject` on a bucket with Object Lock), so whoever gets the app user cannot erase the off-site copies.

Restore: `pg_restore --clean --no-owner --dbname="$DATABASE_URL" apecheck-<stamp>.dump`.

## 11. Updating to a new version

```bash
sudo -u apecheck -i
cd /srv/apecheck/app
git pull
pnpm install --frozen-lockfile
pnpm --filter db prisma migrate deploy
pnpm build
pm2 stop worker-checks          # queued checks wait in Redis
exit

# same Playwright as the worker (client and server must match), restarts the browser host
sudo /srv/apecheck/app/deploy/browser/install.sh

sudo -iu apecheck pm2 reload /srv/apecheck/app/ecosystem.config.cjs
```

`install.sh` is idempotent and quick when nothing changed. It runs as root from the checkout, so look at what `git pull` brought first.

## 12. Optional: apecheck.live

Point `apecheck.live` (and `www`) A records at the VPS, uncomment the `apecheck.live` block at the bottom of
`deploy/nginx/apecheck.conf`, reload Nginx, then `sudo certbot --nginx -d apecheck.live -d www.apecheck.live`.

## 13. Keeping Chromium current

The agent renders hostile pages, so a Chromium bug fixed upstream but not here is the easiest way in. Chromium comes
with Playwright (`apps/worker/package.json` pins `playwright` exactly; 1.56.1 ships Chromium 141). Bump it **every
month**, and **within a few days** of a Chrome stable update that fixes a security bug exploited in the wild
(<https://chromereleases.googleblog.com/>):

```bash
# on a dev machine
pnpm --filter @apecheck/worker add playwright@<latest x.y.z> --save-exact
pnpm --filter @apecheck/worker exec playwright install chromium
pnpm --filter @apecheck/worker test && pnpm --filter @apecheck/worker e2e && pnpm test:deploy
# commit apps/worker/package.json + pnpm-lock.yaml, then deploy with §11
```

§11's `install.sh` step installs the matching playwright-core and Chromium into `/opt/apecheck-browser` (Playwright
removes the old build) and restarts the host; `journalctl -u apecheck-browser -n 1` shows the new Chromium version.
Ubuntu security updates (`unattended-upgrades`) cover the kernel and the system libraries Chromium uses.

## 14. X bot (@ApeCheckBot)

`worker-bot` idles (one warning in `pm2 logs worker-bot`) until the four OAuth 1.0a keys of the bot account are in `.env`.
The account and the app are set up once, by ALFA:

1. **The account.** Create `@ApeCheckBot` (fallback `@apecheck_io`, HANDOFF §14) with its own e-mail. Logged in as the bot:
   Settings and privacy → Your account → Account information → **Automation** → Managing account → choose **ALFA's main
   account** and confirm from it. The profile and every reply then show "Automated by @…", which X requires for bots.
2. **The developer app.** Sign in to <https://developer.x.com> **as @ApeCheckBot** (the access token below must belong to
   the bot, not to ALFA; with ALFA's account as the developer account you would need the 3-legged OAuth flow instead).
   Create a Project and an App (pay-per-use). In the App → *User authentication settings*: App permissions **Read and
   write**, Type of App **Web App, Automated App or Bot**, Callback URI and Website `https://apecheck.io` (required
   fields, not used). Save this **before** generating the access token: a token generated earlier stays read-only.
3. **Keys and tokens** tab → `.env`:
   - API Key / API Key Secret → `X_API_KEY` / `X_API_SECRET` (the consumer keys);
   - Access Token / Secret (generate; the page must say *Read and Write*) → `X_ACCESS_TOKEN` / `X_ACCESS_SECRET`;
   - Bearer Token → `X_BEARER_TOKEN` (post and account reads during checks);
   - `X_BOT_HANDLE=ApeCheckBot` (without `@`).
   They live only in `.env` (`chmod 600`), never in the repo or the database (HANDOFF §11).
4. **`X_BOT_USER_ID`**, the bot's numeric id:
   ```bash
   set -a; . /srv/apecheck/app/.env; set +a
   curl -s "https://api.x.com/2/users/by/username/$X_BOT_HANDLE" -H "Authorization: Bearer $X_BEARER_TOKEN"   # → data.id
   ```
   Without it the bot still runs (the adapter looks the id up once per start and logs
   `X_BOT_USER_ID not set: looked up the bot account id (…)`), but set it to save the call.
5. **Start and check:** `pm2 restart worker-bot` (it reads `.env` at start), then `pm2 logs worker-bot` shows
   `active: polling @ApeCheckBot's mentions every 20s`. From another account that is at least 7 days old, reply to a
   project's post with `@ApeCheckBot real or larp?`: the reply with the verdict and the share card comes within a few
   minutes (the check itself takes 1–3). `curl https://api.apecheck.io/v1/bot/stats` counts it.

**Costs and limits.** Mentions are read every `BOT_POLL_SECONDS` (20) with `since_id`, so only new posts are fetched;
reading your own mentions is billed as an owned read, the cheapest read. Posting is billed per post, and X bills posts
that contain a URL at a much higher rate: `BOT_INCLUDE_LINK=false` (the default) leaves the `apecheck.io/c/<id>` link out of
every reply, even the follow-up pointer. Look at the per-post prices in the developer console (Usage / Billing) before
setting `BOT_INCLUDE_LINK=true`. `BOT_HOURLY_CAP` (200) bounds the bill: at most that many replies an hour across all
users; `BOT_USER_HOURLY` (3) and `BOT_PRO_USER_HOURLY` (20) limit one account. Mentions over a limit are stored and
ignored, never answered later.

**One bot at a time.** `worker-bot` is a single PM2 instance; a Redis lock (`bot:lock`) also keeps a second copy (a
manual start on the same server) on standby, so replies are never doubled. The lock only covers processes that share the
same `REDIS_URL` and database: a copy with another Redis (another machine, a laptop with a copied `.env`) is a second live
bot that replies again. Never put the bot's OAuth keys anywhere else; `pnpm dev` leaves the bot off unless `X_BOT_DEV=1`
(use a separate test bot account for that). `pm2 stop worker-bot` pauses the bot: mentions that
arrive meanwhile are read on restart (`since_id` is kept in Redis), except those older than 12 hours, which are not answered.

## Browser isolation notes

Layers between a page and the server, outermost first (details in §6):

1. **OS user + firewall.** Chromium runs as `apecheck-browser`, which cannot read the app tree, `.env`, `~/.pm2`, the
   rclone config or the dumps, owns no code (`/opt/apecheck-browser` is root's), and can only reach the SSRF guard.
   An exploit that gets out of Chromium entirely lands there, not in the `apecheck` account.
2. **Chromium's sandbox** (namespaces + seccomp-bpf; never `--no-sandbox`), verified by the host at startup and every 30 s.
3. **systemd hardening**: read-only filesystem except a private `/tmp`, no capabilities, no new privileges, loopback-only IP access, `MemoryMax`.
4. **No secrets in the browser's environment**: the host passes Chromium only `PATH`, `HOME`, `TMPDIR`, `TZ`, `LANG`
   and XDG dirs; the host itself only gets `/etc/apecheck/browser.env`. (Dev and test launch Chromium inside the
   worker with the same minimal environment; production refuses that.)
5. **SSRF guard** in worker-checks: every request (loopback included) goes through it; private, loopback, link-local,
   ULA and metadata addresses are refused and DNS is pinned. Never set `SSRF_ALLOW_HOSTS` or `OUTBOUND_PROXY` in production.
6. **Per check**: a fresh incognito context, downloads off, service workers blocked, no persistent profile, no
   permissions; the mock wallet never holds a key, and transactions are only simulated (`eth_call`/`eth_estimateGas`,
   `simulateTransaction`).

Further hardening if wanted: run `browser-host.cjs` in a rootless container (read-only rootfs, its own network
namespace with only the guard port forwarded) instead of the systemd unit; worker-checks only needs `BROWSER_WS_ENDPOINT`.

## Empty keys

Every adapter checks its key at startup. Missing ones log one line like
`[apecheck] WARN X API not configured (X_BEARER_TOKEN empty): ...` and are skipped: the check still finishes, and the affected signal is scored `warn`
with a log line saying which source was unavailable.
`pnpm diagnose` (§6) lists every empty key, the fallback used instead, and where to get the key.
