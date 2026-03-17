#!/bin/sh
# Migration runner — applies any unapplied SQL files from /migrations/ in order.
# Tracks applied versions in the schema_migrations table.
set -e

MIGRATIONS_DIR="${MIGRATIONS_DIR:-/migrations}"
export PGPASSWORD="$POSTGRES_PASSWORD"

PSQL="psql -h ${POSTGRES_HOST:-postgres} -p ${POSTGRES_PORT:-5432} \
  -U ${POSTGRES_USER:-autolinks} -d ${POSTGRES_DB:-autolinks} -v ON_ERROR_STOP=1"

echo "[migrate] Connecting to ${POSTGRES_HOST:-postgres}:${POSTGRES_PORT:-5432} ..."

# Ensure tracking table exists
$PSQL -c "
  CREATE TABLE IF NOT EXISTS schema_migrations (
    version    TEXT PRIMARY KEY,
    applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );"

echo "[migrate] Scanning $MIGRATIONS_DIR ..."

for file in $(ls "$MIGRATIONS_DIR"/*.sql 2>/dev/null | sort); do
  version=$(basename "$file" .sql)
  exists=$($PSQL -tAc "SELECT COUNT(*) FROM schema_migrations WHERE version = '$version'")

  if [ "$exists" = "0" ]; then
    echo "[migrate] Applying: $version"
    $PSQL -f "$file"
    $PSQL -c "INSERT INTO schema_migrations (version) VALUES ('$version')"
    echo "[migrate] Applied:  $version"
  else
    echo "[migrate] Skipped:  $version (already applied)"
  fi
done

echo "[migrate] All migrations up to date."
