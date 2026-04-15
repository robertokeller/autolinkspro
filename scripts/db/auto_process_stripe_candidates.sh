#!/usr/bin/env bash
set -euo pipefail

# Usage:
# DB_URL="postgresql://user:pass@host:5432/dbname" ./scripts/db/auto_process_stripe_candidates.sh
# This script WILL NOT execute DROP statements. It will:
# - find tables with 'stripe' in their name
# - estimate row counts via pg_stat_user_tables
# - for tables with 0 rows: create a pg_dump, run FK reference check, and generate drop_<table>.sql (DROP commented)

DB_URL="${DB_URL:-}"
if [ -z "$DB_URL" ]; then
  echo "Set DB_URL environment variable, e.g. export DB_URL=\"postgresql://user:pass@host:5432/dbname\""
  exit 2
fi

OUT_DIR="$(dirname "$0")"
SUMMARY_FILE="$OUT_DIR/stripe_candidates_summary.csv"
: > "$SUMMARY_FILE"
echo "schema,table,row_estimate,dump_file,fk_file,drop_sql_file" >> "$SUMMARY_FILE"

echo "Querying tables containing 'stripe'..."
mapfile -t rows < <(psql "$DB_URL" -At -F '|' -c "SELECT schemaname, relname, coalesce(n_live_tup,0) FROM pg_stat_user_tables WHERE relname ILIKE '%stripe%';")

if [ ${#rows[@]} -eq 0 ]; then
  echo "No tables matching '%stripe%' found in pg_stat_user_tables. Exiting."
  exit 0
fi

for row in "${rows[@]}"; do
  IFS='|' read -r schema relname n_live <<< "$row"
  echo "Found: $schema.$relname (estimated rows: $n_live)"

  dump_file="$OUT_DIR/${relname}_$(date +%F_%H%M%S).dump"
  fk_file="$OUT_DIR/${relname}_fk_refs.txt"
  drop_sql_file="$OUT_DIR/drop_${relname}.sql"

  if [ "$n_live" -eq 0 ]; then
    echo "  -> Candidate (0 rows). Creating backup: $dump_file"
    pg_dump "$DB_URL" -t "$schema.$relname" -Fc -f "$dump_file"

    echo "  -> Checking FKs (output to $fk_file)"
    psql "$DB_URL" -v tbl="$relname" -f "$OUT_DIR/find_fk_references.sql" > "$fk_file" || true

    echo "  -> Generating drop file (DROP commented)"
    cat > "$drop_sql_file" <<SQL
-- Backup file: $dump_file
-- FK references (see $fk_file)
BEGIN;
-- Uncomment the following line to actually drop the table after review and backup
-- DROP TABLE IF EXISTS $schema.$relname CASCADE;
COMMIT;
SQL

    echo "$schema,$relname,$n_live,$dump_file,$fk_file,$drop_sql_file" >> "$SUMMARY_FILE"
  else
    echo "  -> Skipping (non-zero rows)."
    echo "$schema,$relname,$n_live,,," >> "$SUMMARY_FILE"
  fi

done

echo "Processing complete. Summary: $SUMMARY_FILE"
