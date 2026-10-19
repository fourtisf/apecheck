# Deploying ApeCheck (Hostinger VPS)

Follows HANDOFF §12. Target: Ubuntu 24.04 LTS, at least 4 vCPU / 8 GB RAM (each Chromium context needs roughly 0.5–1 GB).

Processes (PM2, `ecosystem.config.cjs`):

| PM2 name | What | Port |
|---|---|---|
| `web` | Next.js 14 site (`apps/web`) | 3000 (localhost only) |
| `api` | Fastify REST + SSE (`apps/api`) | 4000 (localhost only) |
| `worker-checks` | check pipeline; drives the browser agent | — |
| `worker-bot` | @ApeCheckBot mentions + replies | — |
| `worker-prices` | price tracking, screenshot cleanup | — |

Plus one systemd unit, `apecheck-browser.service` (`deploy/browser`): Chromium itself, as a separate user with no access
to the app's secrets (§6). Its Playwright endpoint is `127.0.0.1:9223` (localhost only); worker-checks' SSRF guard proxy is `127.0.0.1:9224`.

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
sudo -u apecheck -i
git clone https://github.com/fourtisf/apecheck.git /srv/apecheck/app
cd /srv/apecheck/app
cp .env.example .env
nano .env        # fill in the values (see step 4 for DATABASE_URL)
chmod 600 .env
```

Every process (PM2 apps, the Prisma CLI, the web build) reads this `.env` and it wins over the shell's variables.
To run a second configuration from the same checkout, point `APECHECK_ENV_FILE` at another file.

`.env` must contain at least: `NODE_ENV=production`, `APP_URL=https://apecheck.io`, `API_URL=https://api.apecheck.io`,
`NEXT_PUBLIC_APP_URL=https://apecheck.io`, `NEXT_PUBLIC_API_URL=https://api.apecheck.io`, a random `SESSION_SECRET`
(`openssl rand -hex 32`), `DATABASE_URL`, `REDIS_URL=redis://localhost:6379`, `SCREENSHOT_DIR=/var/apecheck/shots`.
`BROWSER_WS_ENDPOINT` is filled in by §6; leave `BROWSER_GUARD_PORT=9224`.

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
