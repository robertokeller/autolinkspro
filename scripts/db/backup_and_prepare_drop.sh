#!/usr/bin/env bash
set -euo pipefail

# Usage: DB_URL="postgresql://user:pass@host:5432/dbname" ./backup_and_prepare_drop.sh stripe

TABLE="$1"
DB_URL="${DB_URL:-}"
if [ -z "$TABLE" ]; then
  echo "Usage: $0 <table_name>"
  exit 2
fi
if [ -z "$DB_URL" ]; then
  echo "Set DB_URL environment variable, e.g. export DB_URL=\"postgresql://user:pass@host:5432/dbname\""
  exit 2
fi

DUMP_FILE="${TABLE}_$(date +%F_%H%M%S).dump"

echo "Backing up public.$TABLE -> $DUMP_FILE"
pg_dump "$DB_URL" -t "public.$TABLE" -Fc -f "$DUMP_FILE"

echo "Listing foreign key references (if any):"
psql "$DB_URL" -v tbl="$TABLE" -f "$(dirname "$0")/find_fk_references.sql"

DROP_SQL_FILE="drop_${TABLE}.sql"
cat > "$DROP_SQL_FILE" <<SQL
-- Backup file: $DUMP_FILE
-- Review foreign key references above before running this.
BEGIN;
-- Uncomment the following line to actually drop the table after review and backup
-- DROP TABLE IF EXISTS public.$TABLE CASCADE;
COMMIT;
SQL

echo "Generated $DROP_SQL_FILE (DROP is commented). Review and run manually when ready."
