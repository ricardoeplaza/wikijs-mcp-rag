#!/bin/sh
# Entrypoint for the published image.
#
# When the container starts as root (the default), host-mounted volumes are
# usually root-owned and the unprivileged `node` user could not write the
# SQLite file. In that case we create the data directory, hand ownership of
# it to `node`, and re-exec the command through `su-exec` (busybox).
# When the container already runs as a non-root user, the command is exec'd
# directly.
set -eu

DATA_DIR=$(dirname "${RAG_DB_PATH:-/data/rag.db}")

if [ "$(id -u)" = "0" ]; then
  mkdir -p "$DATA_DIR"
  chown -R node:node "$DATA_DIR"
  exec su-exec node "$@"
fi

exec "$@"
