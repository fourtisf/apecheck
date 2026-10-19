#!/usr/bin/env bash
# Nightly PostgreSQL backup (HANDOFF §12.7). Dumps the database and copies it off-server.
# Cron (as the apecheck user):  15 3 * * *  /srv/apecheck/deploy/backup.sh >> /var/log/apecheck/backup.log 2>&1
#
# Off-server target: set BACKUP_REMOTE to an rclone remote (e.g. "s3:apecheck-backups/pg" or "b2:apecheck/pg").
# Configure it once with `rclone config`. Without BACKUP_REMOTE the dump stays local and the script exits non-zero
# so the missing off-server copy is noticed.
set -euo pipefail

APP_DIR="${APP_DIR:-/srv/apecheck}"
BACKUP_DIR="${BACKUP_DIR:-/var/backups/apecheck}"
KEEP_LOCAL_DAYS="${KEEP_LOCAL_DAYS:-7}"

# DATABASE_URL from the app's .env
DATABASE_URL="$(grep -E '^DATABASE_URL=' "$APP_DIR/.env" | head -1 | cut -d= -f2-)"
BACKUP_REMOTE="${BACKUP_REMOTE:-$(grep -E '^BACKUP_REMOTE=' "$APP_DIR/.env" 2>/dev/null | head -1 | cut -d= -f2- || true)}"

mkdir -p "$BACKUP_DIR"
stamp="$(date -u +%Y%m%dT%H%M%SZ)"
file="$BACKUP_DIR/apecheck-$stamp.dump"

pg_dump --format=custom --no-owner --dbname="$DATABASE_URL" --file="$file"
echo "dumped $(du -h "$file" | cut -f1) to $file"

find "$BACKUP_DIR" -name 'apecheck-*.dump' -mtime +"$KEEP_LOCAL_DAYS" -delete

if [[ -z "$BACKUP_REMOTE" ]]; then
  echo "BACKUP_REMOTE is not set: dump kept locally only" >&2
  exit 2
fi
rclone copy "$file" "$BACKUP_REMOTE/" --immutable
echo "copied to $BACKUP_REMOTE"
