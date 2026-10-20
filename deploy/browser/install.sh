#!/usr/bin/env bash
# Install or update the isolated browser host (DEPLOY.md §6, HANDOFF §11). Run as root from the app checkout,
# after `git pull` + `pnpm install` (review what you pulled: this runs as root):
#
#   sudo /srv/apecheck/app/deploy/browser/install.sh
#
# Idempotent; re-run it after every Playwright bump (DEPLOY.md §13). It
#   1. creates the apecheck-browser system user (no home, no shell, owns nothing);
#   2. installs the exact playwright-core version apps/worker pins, its headless Chromium (+ system libraries) and
#      browser-host.cjs into /opt/apecheck-browser, all root-owned and read-only for that user;
#   3. installs the AppArmor profile that lets those Chromium binaries create their sandbox's user namespace;
#   4. writes /etc/apecheck/browser.env (root-only; a random BROWSER_WS_PATH on first run) and the egress firewall;
#   5. installs, enables and (re)starts apecheck-browser.service and waits until it reports the sandbox verified;
#   6. sets BROWSER_WS_ENDPOINT in the app's .env (owner and mode kept), so worker-checks connects to it.
# Afterwards: pm2 reload worker-checks (as apecheck).
set -euo pipefail

APP_DIR="${APP_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)}"
APP_USER="${APP_USER:-apecheck}"
# fixed: apecheck-browser.service, the AppArmor profile and browser-firewall.nft name these
PREFIX=/opt/apecheck-browser
BROWSER_USER=apecheck-browser
ETC=/etc/apecheck
SRC="$APP_DIR/deploy/browser"
UNIT=/etc/systemd/system/apecheck-browser.service

die() { echo "install.sh: $*" >&2; exit 1; }
[[ $EUID -eq 0 ]] || die "run as root: sudo $0"
[[ -f "$SRC/browser-host.cjs" && -f "$APP_DIR/apps/worker/package.json" ]] || die "APP_DIR=$APP_DIR is not the ApeCheck checkout"
command -v node >/dev/null || die "node is not installed (DEPLOY.md §1)"
command -v nft >/dev/null || die "nft is not installed: apt-get install -y nftables"

# Playwright client (worker-checks) and server (this host) must be the same version
PW_VERSION="$(node -p 'require(require("node:path").resolve(process.argv[1])).dependencies.playwright' "$APP_DIR/apps/worker/package.json")"
[[ "$PW_VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || die "apps/worker pins playwright '$PW_VERSION'; it must be an exact version"

# the guard port the firewall allows must be the one worker-checks listens on
FW_GUARD_PORT="$(grep -oE 'tcp dport [0-9]+ accept' "$SRC/browser-firewall.nft" | grep -oE '[0-9]+')"
# (strip an inline "  # comment" the way dotenv does: .env.example has one on this line)
ENV_GUARD_PORT="$(grep -E '^BROWSER_GUARD_PORT=' "$APP_DIR/.env" 2>/dev/null | tail -1 | cut -d= -f2- | sed -E 's/[[:space:]]+#.*$//' | tr -d '[:space:]' || true)"
[[ -z "$ENV_GUARD_PORT" || "$ENV_GUARD_PORT" == "$FW_GUARD_PORT" ]] ||
  die "BROWSER_GUARD_PORT=$ENV_GUARD_PORT in .env but browser-firewall.nft allows $FW_GUARD_PORT; make them match"

# Playwright's --with-deps (step 2) runs apt-get; a broken third-party repository fails it with only "exit code 100"
apt_log="$(mktemp)"
if ! apt-get update >"$apt_log" 2>&1; then
  grep -E '^(E|W):' "$apt_log" >&2 || cat "$apt_log" >&2
  rm -f "$apt_log"
  die "apt-get update failed (above), and Chromium's system libraries come from apt. Fix or switch off the repositories it names (DEPLOY.md §6), then re-run"
fi
rm -f "$apt_log"

echo "== 1. user $BROWSER_USER"
id -u "$BROWSER_USER" >/dev/null 2>&1 ||
  adduser --system --group --no-create-home --home /nonexistent --shell /usr/sbin/nologin "$BROWSER_USER"
APP_HOME="$(getent passwd "$APP_USER" | cut -d: -f6 || true)"
APP_HOME="${APP_HOME:-/srv/apecheck}"
# nothing under the app user's home (code, .env, ~/.pm2, ~/.config/rclone) is for other users
[[ -d "$APP_HOME" ]] && chmod 0750 "$APP_HOME"

echo "== 2. playwright-core $PW_VERSION + Chromium in $PREFIX"
install -d -o root -g root -m 0755 "$PREFIX"
printf '{\n  "private": true,\n  "dependencies": { "playwright-core": "%s" }\n}\n' "$PW_VERSION" >"$PREFIX/package.json"
npm install --prefix "$PREFIX" --omit=dev --ignore-scripts --no-audit --no-fund --loglevel=error
install -o root -g root -m 0644 "$SRC/browser-host.cjs" "$PREFIX/browser-host.cjs"
# headless shell only (what headless launches use) plus its system libraries; old builds are garbage-collected
PLAYWRIGHT_BROWSERS_PATH="$PREFIX/browsers" node "$PREFIX/node_modules/playwright-core/cli.js" install --with-deps --only-shell chromium
chown -R root:root "$PREFIX"
chmod -R u+rwX,go+rX,go-w "$PREFIX"

echo "== 3. AppArmor profile (user namespaces for Chromium's sandbox)"
if [[ -d /etc/apparmor.d ]] && command -v apparmor_parser >/dev/null; then
  install -o root -g root -m 0644 "$SRC/apparmor-apecheck-chromium" /etc/apparmor.d/apecheck-chromium
  apparmor_parser -r /etc/apparmor.d/apecheck-chromium
else
  echo "   AppArmor not present: skipped (Chromium's sandbox then needs unprivileged user namespaces enabled)"
fi

echo "== 4. $ETC: browser.env, browser-firewall.nft"
install -d -o root -g root -m 0700 "$ETC"
install -o root -g root -m 0600 "$SRC/browser-firewall.nft" "$ETC/browser-firewall.nft"
if [[ ! -f "$ETC/browser.env" ]]; then
  (
    umask 077
    cat >"$ETC/browser.env" <<EOF
# read by systemd for apecheck-browser.service only (see deploy/browser/browser-host.cjs)
BROWSER_WS_PATH=$(openssl rand -hex 32)
BROWSER_PORT=9223
# the host refuses to start if it can read any of these or connect to any of these local ports
BROWSER_FORBIDDEN_PATHS=$APP_HOME:$APP_DIR:$APP_DIR/.env:$APP_HOME/.config/rclone:/var/backups/apecheck
BROWSER_FORBIDDEN_PORTS=5432,6379
EOF
  )
fi
chmod 0600 "$ETC/browser.env"

echo "== 5. apecheck-browser.service"
install -o root -g root -m 0644 "$SRC/apecheck-browser.service" "$UNIT"
NODE_BIN="$(command -v node)"
[[ "$NODE_BIN" == /usr/bin/node ]] || sed -i "s#^ExecStart=/usr/bin/node #ExecStart=$NODE_BIN #" "$UNIT"
systemctl daemon-reload
systemctl enable apecheck-browser.service >/dev/null
systemctl reset-failed apecheck-browser.service 2>/dev/null || true
systemctl restart apecheck-browser.service
PORT="$(grep -E '^BROWSER_PORT=' "$ETC/browser.env" | tail -1 | cut -d= -f2-)"
PORT="${PORT:-9223}"
# the host only listens once the sandbox, the unreadable paths and the firewall checked out
for _ in $(seq 1 45); do
  ss -Hltn "sport = :$PORT" | grep -q . && break
  sleep 1
done
if ! ss -Hltn "sport = :$PORT" | grep -q .; then
  journalctl -u apecheck-browser.service -n 30 --no-pager >&2 || true
  die "apecheck-browser did not come up (log above)"
fi
journalctl -u apecheck-browser.service -n 1 --no-pager -o cat || true

echo "== 6. BROWSER_WS_ENDPOINT in $APP_DIR/.env"
WS_PATH="$(grep -E '^BROWSER_WS_PATH=' "$ETC/browser.env" | tail -1 | cut -d= -f2-)"
LINE="BROWSER_WS_ENDPOINT=ws://127.0.0.1:$PORT/$WS_PATH"
if [[ -f "$APP_DIR/.env" ]]; then
  owner="$(stat -c %u:%g "$APP_DIR/.env")"
  mode="$(stat -c %a "$APP_DIR/.env")"
  if grep -qE '^BROWSER_WS_ENDPOINT=' "$APP_DIR/.env"; then
    sed -i "s#^BROWSER_WS_ENDPOINT=.*#$LINE#" "$APP_DIR/.env"
  else
    printf '\n%s\n' "$LINE" >>"$APP_DIR/.env"
  fi
  chown "$owner" "$APP_DIR/.env"
  chmod "$mode" "$APP_DIR/.env"
  echo "   set. Now, as $APP_USER: pm2 reload worker-checks"
else
  echo "   $APP_DIR/.env does not exist yet: add this line to it (DEPLOY.md §3):"
  echo "   $LINE"
fi
