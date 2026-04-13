#!/usr/bin/env bash
set -euo pipefail
CSV="${1:-memory/decisions.csv}"
if [ ! -f "$CSV" ]; then
  exit 0
fi
TODAY="$(date +%F)"
TMP="${CSV}.tmp"
awk -F, -v OFS=, -v today="$TODAY" 'NR==1 {print; next} { review=$5; status=$6; if (review != "" && review <= today && status !~ /REVIEW DUE/) { status = (status == "" ? "REVIEW DUE" : status "|REVIEW DUE") } $6=status; print }' "$CSV" > "$TMP"
mv "$TMP" "$CSV"
