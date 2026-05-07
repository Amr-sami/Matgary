#!/usr/bin/env sh
# matgary nightly backup
#
# Streams a pg_dump of the running postgres container to a timestamped file
# under $BACKUP_DIR (default ./backups), then prunes old dumps based on the
# retention policy below. Designed to run inside the matgary-backup sidecar
# (see docker-compose.yml) but works standalone too — just point the env vars
# at your postgres.
#
# Retention:
#   - keep the last 14 daily dumps
#   - keep the last 8 weekly dumps (any dump created on Sunday)
#
# Off-site shipping: if $BACKUP_REMOTE_HOOK is set, it's executed with the
# dump path as $1 after the local write succeeds. Wire rclone, aws s3 cp,
# rsync, or anything else there. Stays out of this script so the script
# stays simple and the secrets stay in the host.

set -eu

PGHOST="${PGHOST:-postgres}"
PGPORT="${PGPORT:-5432}"
PGUSER="${PGUSER:-matgary}"
PGDATABASE="${PGDATABASE:-matgary}"
BACKUP_DIR="${BACKUP_DIR:-/backups}"
DAILY_KEEP="${DAILY_KEEP:-14}"
WEEKLY_KEEP="${WEEKLY_KEEP:-8}"

mkdir -p "$BACKUP_DIR"

stamp="$(date -u +%Y-%m-%dT%H-%M-%SZ)"
weekday="$(date -u +%u)"   # 1..7, Mon..Sun
prefix="daily"
[ "$weekday" = "7" ] && prefix="weekly"

target="$BACKUP_DIR/${prefix}-${stamp}.sql.gz"
tmp="$target.partial"

echo "[backup] dumping ${PGDATABASE} to ${target}"

# --no-owner / --no-privileges keep the dump portable across roles.
PGPASSWORD="${PGPASSWORD:-}" pg_dump \
  -h "$PGHOST" -p "$PGPORT" -U "$PGUSER" -d "$PGDATABASE" \
  --no-owner --no-privileges --clean --if-exists \
  | gzip -9 > "$tmp"

# Atomically rename so a partial file is never picked up by retention or
# remote sync. Also fail loud if the dump produced 0 bytes.
size="$(wc -c < "$tmp" | tr -d ' ')"
if [ "$size" -lt 1024 ]; then
  echo "[backup] FAIL: dump is ${size} bytes (sanity threshold 1024)"
  rm -f "$tmp"
  exit 1
fi
mv "$tmp" "$target"
echo "[backup] wrote ${size} bytes"

# Optional off-site shipping. Errors here don't fail the local backup.
if [ -n "${BACKUP_REMOTE_HOOK:-}" ]; then
  echo "[backup] shipping to remote via hook"
  if ! "$BACKUP_REMOTE_HOOK" "$target"; then
    echo "[backup] WARN: remote hook exited non-zero — local copy is fine"
  fi
fi

# Retention. Two independent rotations: daily-* and weekly-*.
prune() {
  glob="$1"
  keep="$2"
  # ls -1t newest-first; tail+N drops everything past the keep limit.
  files="$(ls -1t "$BACKUP_DIR"/$glob 2>/dev/null || true)"
  [ -z "$files" ] && return 0
  echo "$files" | awk -v k="$keep" 'NR>k { print }' | while IFS= read -r f; do
    [ -n "$f" ] && rm -f -- "$f" && echo "[backup] pruned $(basename "$f")"
  done
}

prune "daily-*.sql.gz" "$DAILY_KEEP"
prune "weekly-*.sql.gz" "$WEEKLY_KEEP"

echo "[backup] done"
