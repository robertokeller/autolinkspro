#!/bin/sh
set -eu

SESSIONS_DIR="${TELEGRAM_SESSIONS_DIR:-/data/tg-sessions}"

# Docker named volumes can be created as root:root; ensure node can write.
mkdir -p "$SESSIONS_DIR"
chown -R node:node "$SESSIONS_DIR"

exec gosu node "$@"
