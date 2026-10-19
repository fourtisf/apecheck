# Deploying ApeCheck (Hostinger VPS)

Follows HANDOFF §12. Target: Ubuntu 24.04 LTS, at least 4 vCPU / 8 GB RAM (each Chromium context needs roughly 0.5–1 GB).

Processes (PM2, `ecosystem.config.cjs`):

| PM2 name | What | Port |
|---|---|---|
| `web` | Next.js 14 site (`apps/web`) | 3000 (localhost only) |
| `api` | Fastify REST + SSE (`apps/api`) | 4000 (localhost only) |
| `worker-checks` | check pipeline + Chromium agent | — |
| `worker-bot` | @ApeCheckBot mentions + replies | — |
| `worker-prices` | price tracking, screenshot cleanup | — |

Nginx terminates TLS: `apecheck.io` → `:3000`, `api.apecheck.io` → `:4000` (SSE-safe), `www` → apex.

---

## 0. What you need before starting

- The VPS IP address and an SSH user with `sudo`.
- DNS for `apecheck.io` at your registrar (step 7).
- The `.env` values: see `.env.example`. Keys that are still empty don't block the deploy: that adapter runs as a stub and logs a warning (see "Empty keys" at the end).

## 1. Server packages (as root / sudo)

```bash
sudo apt-get update && sudo apt-get -y upgrade
sudo apt-get install -y curl git build-essential ca-certificates gnupg ufw

# Node 20 LTS
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt-get install -y nodejs
sudo corepack enable
sudo corepack prepare pnpm@10.28.0 --activate

# PostgreSQL 16, Redis 7, Nginx, certbot, rclone (backups)
sudo apt-get install -y postgresql-16 redis-server nginx certbot python3-certbot-nginx rclone

# PM2
sudo npm install -g pm2

# Firewall: only SSH and HTTP(S) from outside
sudo ufw allow OpenSSH
sudo ufw allow 'Nginx Full'
sudo ufw --force enable
```

Redis listens on localhost only by default on Ubuntu; keep it that way (`bind 127.0.0.1 ::1` in `/etc/redis/redis.conf`).

## 2. Unprivileged app user

The browser agent opens untrusted sites, so nothing runs as root (HANDOFF §11).

```bash
sudo adduser --system --group --home /srv/apecheck --shell /bin/bash apecheck
sudo mkdir -p /var/apecheck/shots /var/log/apecheck /var/backups/apecheck
sudo chown -R apecheck:apecheck /var/apecheck /var/log/apecheck /var/backups/apecheck
```

## 3. Code and `.env`

```bash
sudo -u apecheck -i
git clone https://github.com/fourtisf/apecheck.git /srv/apecheck/app
cd /srv/apecheck/app
cp .env.example .env
nano .env        # fill in the values (see step 4 for DATABASE_URL)
chmod 600 .env
```

`.env` must contain at least: `NODE_ENV=production`, `APP_URL=https://apecheck.io`, `API_URL=https://api.apecheck.io`,
`NEXT_PUBLIC_APP_URL=https://apecheck.io`, `NEXT_PUBLIC_API_URL=https://api.apecheck.io`, a random `SESSION_SECRET`
(`openssl rand -hex 32`), `DATABASE_URL`, `REDIS_URL=redis://localhost:6379`, `SCREENSHOT_DIR=/var/apecheck/shots`.

> The paths below assume the repo lives in `/srv/apecheck/app`. `deploy/backup.sh` defaults to `APP_DIR=/srv/apecheck`; set `APP_DIR=/srv/apecheck/app` in its cron line (step 10).

## 4. Database

```bash
sudo -u postgres psql -c "CREATE ROLE apecheck LOGIN PASSWORD '<strong-password>';"
sudo -u postgres psql -c "CREATE DATABASE apecheck OWNER apecheck;"
```

Then in `.env`: `DATABASE_URL=postgresql://apecheck:<strong-password>@localhost:5432/apecheck`.

## 5. Install, browser, migrate, build (as `apecheck`)

```bash
cd /srv/apecheck/app
pnpm install --frozen-lockfile

# Chromium for the agent. System libraries need root once:
sudo /srv/apecheck/app/apps/worker/node_modules/.bin/playwright install-deps chromium
# the browser itself goes in the app user's cache:
pnpm --filter @apecheck/worker exec playwright install chromium
# (HANDOFF one-liner, run as root, does both: pnpm exec playwright install --with-deps chromium)

pnpm --filter db prisma migrate deploy
pnpm build
```

`pnpm build` builds the Next.js site and typechecks the API and workers (they run TypeScript directly through `tsx`).

## 6. Start with PM2 (as `apecheck`)

```bash
cd /srv/apecheck/app
pm2 start ecosystem.config.cjs
pm2 save
pm2 startup systemd -u apecheck --hp /srv/apecheck
# pm2 prints a `sudo env PATH=... pm2 startup ...` line: run it once (as your sudo user) so PM2 starts on boot.
```

Check: `pm2 ls` (all five `online`), `pm2 logs --lines 50`, `curl -s localhost:4000/health`, `curl -sI localhost:3000`.

## 7. DNS (at the registrar for apecheck.io)

| Type | Name | Value |
|---|---|---|
| A | `@` | VPS IP |
| A | `www` | VPS IP |
| A | `api` | VPS IP |

## 8. Nginx + SSL

```bash
sudo cp /srv/apecheck/app/deploy/nginx/apecheck.conf /etc/nginx/sites-available/apecheck.conf
sudo ln -sf /etc/nginx/sites-available/apecheck.conf /etc/nginx/sites-enabled/apecheck.conf
sudo rm -f /etc/nginx/sites-enabled/default
sudo nginx -t && sudo systemctl reload nginx

sudo certbot --nginx -d apecheck.io -d www.apecheck.io -d api.apecheck.io
```

`/v1/checks/*/events` (SSE) is proxied with `proxy_buffering off` and a 1 h read timeout, so the live log streams through.

Verify SSE end to end once a check exists: `curl -N https://api.apecheck.io/v1/checks/<id>/events` prints `event: step` lines as they happen.

## 9. Screenshots

Screenshots are written under `SCREENSHOT_DIR` (`/var/apecheck/shots`) and served by the API at `/shots/*`.
`worker-prices` deletes screenshot folders older than 30 days once a day, except for checks on the feed's top lists
(most checked, most real, least real) — HANDOFF §12.6.

## 10. Backups (nightly `pg_dump`, off-server)

```bash
sudo -u apecheck rclone config            # create a remote, e.g. "s3" or "b2"
echo 'BACKUP_REMOTE=s3:apecheck-backups/pg' | sudo -u apecheck tee -a /srv/apecheck/app/.env
sudo -u apecheck crontab -e
# add:
15 3 * * * APP_DIR=/srv/apecheck/app /srv/apecheck/app/deploy/backup.sh >> /var/log/apecheck/backup.log 2>&1
```

Restore: `pg_restore --clean --no-owner --dbname="$DATABASE_URL" apecheck-<stamp>.dump`.

## 11. Updating to a new version

```bash
sudo -u apecheck -i
cd /srv/apecheck/app
git pull
pnpm install --frozen-lockfile
pnpm --filter db prisma migrate deploy
pnpm build
pm2 reload ecosystem.config.cjs
```

## 12. Optional: apecheck.live

Point `apecheck.live` (and `www`) A records at the VPS, uncomment the `apecheck.live` block at the bottom of
`deploy/nginx/apecheck.conf`, reload Nginx, then `sudo certbot --nginx -d apecheck.live -d www.apecheck.live`.

## Browser isolation notes

- The agent runs as the unprivileged `apecheck` user with a fresh incognito context per check, downloads off, service workers blocked,
  no persistent profile, and all browser traffic forced through the worker's SSRF guard proxy (private, loopback, link-local, ULA and
  metadata addresses refused; DNS pinned). Never set `SSRF_ALLOW_HOSTS` or `OUTBOUND_PROXY` in production.
- Ubuntu 24.04 restricts unprivileged user namespaces, which Chromium's own sandbox needs; Playwright launches without it by default.
  For stronger isolation run `worker-checks` in a container (Docker with `--security-opt seccomp=...` and a read-only filesystem except `SCREENSHOT_DIR`).
- The mock wallet never holds a key; transactions are simulated with `eth_call`/`eth_estimateGas` or `simulateTransaction` only.

## Empty keys

Every adapter checks its key at startup. Missing ones log one line like
`[apecheck] WARN X API not configured (X_BEARER_TOKEN empty): ...` and are skipped: the check still finishes, and the affected signal is scored `warn`
with a log line saying which source was unavailable.
