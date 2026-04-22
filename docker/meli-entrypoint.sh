#!/bin/sh
set -eu

SESSIONS_DIR="${MELI_SESSIONS_DIR:-/app/services/mercadolivre-rpa/.sessions}"

# Docker named volumes can be created as root:root; ensure pwuser can write.
mkdir -p "$SESSIONS_DIR"
chown -R pwuser:pwuser "$SESSIONS_DIR"

exec gosu pwuser "$@"
