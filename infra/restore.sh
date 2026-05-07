#!/usr/bin/env sh
# Restore a matgary backup created by infra/backup.sh.
#
#   ./infra/restore.sh ./backups/daily-2026-05-08T00-00-00Z.sql.gz
#
# Refuses to run unless RESTORE_CONFIRM=1 is set, because this drops every
# table in the target DB before reloading. Always restore into a freshly
# created or test database first; promote it only after sanity checks.

set -eu

if [ "$#" -ne 1 ]; then
  echo "usage: $0 <path-to-dump.sql.gz>" >&2
  exit 64
fi

dump="$1"
if [ ! -f "$dump" ]; then
  echo "restore: '$dump' is not a file" >&2
  exit 66
fi

if [ "${RESTORE_CONFIRM:-}" != "1" ]; then
  cat >&2 <<EOF
restore: refusing to run without RESTORE_CONFIRM=1.

This will overwrite the contents of the target database:
  PGHOST=${PGHOST:-postgres} PGUSER=${PGUSER:-matgary} PGDATABASE=${PGDATABASE:-matgary}

Re-run with:
  RESTORE_CONFIRM=1 $0 "$dump"
EOF
  exit 70
fi

PGHOST="${PGHOST:-postgres}"
PGPORT="${PGPORT:-5432}"
PGUSER="${PGUSER:-matgary}"
PGDATABASE="${PGDATABASE:-matgary}"

echo "restore: streaming '$dump' into ${PGDATABASE}@${PGHOST}"
gunzip -c "$dump" | PGPASSWORD="${PGPASSWORD:-}" psql \
  -h "$PGHOST" -p "$PGPORT" -U "$PGUSER" -d "$PGDATABASE" \
  --set=ON_ERROR_STOP=1 --quiet
echo "restore: done"
