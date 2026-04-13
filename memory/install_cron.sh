#!/usr/bin/env bash
set -euo pipefail
if ! command -v crontab >/dev/null 2>&1; then
  echo "crontab nao encontrado neste ambiente."
  exit 1
fi
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
JOB="0 9 * * * cd '$ROOT' && /usr/bin/env bash memory/review_due.sh >/dev/null 2>&1"
( crontab -l 2>/dev/null | grep -Fv "memory/review_due.sh" || true; echo "$JOB" ) | crontab -
echo "Cron diario configurado para revisar decisions.csv."
