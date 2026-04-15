#!/bin/sh
set -eu

SESSIONS_DIR="${BAILEYS_SESSIONS_DIR:-/data/wa-sessions}"

# Docker named volumes can be created as root:root; ensure node can write.
mkdir -p "$SESSIONS_DIR"
chown -R node:node "$SESSIONS_DIR"

exec gosu node "$@"