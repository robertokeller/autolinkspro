#!/usr/bin/env bash
set -euo pipefail
CSV="${1:-memory/decisions.csv}"
if [ ! -f "$CSV" ]; then
  echo "Nenhuma decisao registrada."
  exit 0
fi
awk -F, 'NR==1 {next} $6 ~ /REVIEW DUE/ {print}' "$CSV"
