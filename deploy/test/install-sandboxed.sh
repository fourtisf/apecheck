#!/usr/bin/env bash
# Test helper for deploy/test/deploy.test.mjs: runs deploy/browser/install.sh for real, as root, inside a private
# mount namespace where /etc and /opt are throwaway overlays, with stubs for the parts that need a real VPS
# (adduser, npm, the Playwright download, AppArmor, systemd, ss). Nothing outside the namespace changes.
#
#   install-sandboxed.sh <app dir copy> <out dir> [runs]
#
# SEED_BROWSER_ENV, if set, is written to /etc/apecheck/browser.env first (as an earlier install would have left it).
# Copies what install.sh wrote (/opt/apecheck-browser, /etc/apecheck, the unit, the AppArmor profile), its output
# and the stub call log to <out dir>; exits with install.sh's status.
set -euo pipefail

APP="$1"
OUT="$2"
RUNS="${3:-1}"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
mkdir -p "$OUT" "$WORK/stubs"
export STUB_LOG="$OUT/calls.log"
: >"$STUB_LOG"

stub() {
  # shellcheck disable=SC2016 # $* and $STUB_LOG expand when the stub runs
  printf '#!/usr/bin/env bash\necho "%s $*" >>"$STUB_LOG"\n%s\n' "$1" "${2:-}" >"$WORK/stubs/$1"
  chmod +x "$WORK/stubs/$1"
}
stub adduser
stub apparmor_parser
stub systemctl
stub journalctl 'echo "[apecheck-browser] INFO ready (stub)"'
stub ss 'echo "LISTEN 0 511 127.0.0.1:9223 0.0.0.0:*"'
# npm "installs" a playwright-core whose CLI only records how it was called
cat >"$WORK/stubs/npm" <<'EOF'
#!/usr/bin/env bash
echo "npm $*" >>"$STUB_LOG"
prefix=""
while [[ $# -gt 0 ]]; do
  [[ $1 == --prefix ]] && prefix=$2
  shift
done
mkdir -p "$prefix/node_modules/playwright-core"
cat >"$prefix/node_modules/playwright-core/cli.js" <<'JS'
require('fs').appendFileSync(process.env.STUB_LOG, `playwright-cli ${process.argv.slice(2).join(' ')} PLAYWRIGHT_BROWSERS_PATH=${process.env.PLAYWRIGHT_BROWSERS_PATH}\n`);
JS
EOF
chmod +x "$WORK/stubs/npm"

code=0
# shellcheck disable=SC2016 # the inner script gets its values as arguments
unshare --mount --propagation private bash -euo pipefail -c '
  W="$1"; APP="$2"; OUT="$3"; RUNS="$4"
  for d in etc opt; do
    mkdir -p "$W/$d-up" "$W/$d-work"
    mount -t overlay overlay -o "lowerdir=/$d,upperdir=$W/$d-up,workdir=$W/$d-work" "/$d"
  done
  mkdir -p /etc/apparmor.d
  if [[ -n "${SEED_BROWSER_ENV:-}" ]]; then
    mkdir -p /etc/apecheck
    printf "%s" "$SEED_BROWSER_ENV" >/etc/apecheck/browser.env
  fi
  code=0
  for _ in $(seq 1 "$RUNS"); do
    PATH="$W/stubs:$PATH" "$APP/deploy/browser/install.sh" >>"$OUT/stdout.log" 2>&1 || { code=$?; break; }
  done
  mkdir -p "$OUT/fs"
  cp -a /etc/apecheck "$OUT/fs/etc-apecheck" 2>/dev/null || true
  cp -a /etc/systemd/system/apecheck-browser.service "$OUT/fs/" 2>/dev/null || true
  cp -a /etc/apparmor.d/apecheck-chromium "$OUT/fs/" 2>/dev/null || true
  cp -a /opt/apecheck-browser "$OUT/fs/opt-apecheck-browser" 2>/dev/null || true
  exit "$code"
' _ "$WORK" "$APP" "$OUT" "$RUNS" || code=$?
exit "$code"
