#!/bin/sh
# Prepares the data directory of the container, then runs the command (`msum daemon` by default).
#
# The web listens on 0.0.0.0 inside the container through MSUM_WEB_HOST (set in the Dockerfile). If config.json sets
# web.host, that explicit choice wins: with 127.0.0.1 the published port reaches nothing and the healthcheck keeps
# working (it reads the real address from web.json).
set -eu

if ! { mkdir -p "$MSUM_DATA_DIR" "$HOME" 2>/dev/null && [ -w "$MSUM_DATA_DIR" ] && [ -w "$HOME" ]; }; then
  echo "message-summarize: $MSUM_DATA_DIR is not writable by uid $(id -u). Run: chown $(id -u):$(id -g) <dir> (the host directory), or use a named volume." >&2
  exit 1
fi

case "$*" in
  "msum daemon"*) node "${MSUM_PREPARE:-/app/docker/prepare.mjs}" ;;
esac
exec "$@"
