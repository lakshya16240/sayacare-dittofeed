#!/usr/bin/env bash
#
# Wrapper for the production stack. Passes every argument through to
# `docker compose`, with the right -f files and env file already applied:
#
#   sudo ./compose.sh up -d
#   sudo ./compose.sh ps
#   sudo ./compose.sh logs -f lite worker
#   sudo ./compose.sh pull
#   sudo ./compose.sh run --rm admin migrate
#
# This exists because passing -f disables Compose's automatic override
# discovery. A command that forgets `-f docker-compose.tailnet.yaml` silently
# drops the tailnet bind on the next `up -d` -- the tunnel keeps working and
# direct access just stops, with no error. Going through this script makes that
# impossible to get wrong.
set -euo pipefail

cd "$(dirname "$0")"

ENV_FILE="${ENV_FILE:-.env.prod}"
if [ ! -f "$ENV_FILE" ]; then
  echo "error: $ENV_FILE not found. Copy .env.prod.example and fill it in." >&2
  exit 1
fi

files=(-f docker-compose.prod.yaml)

# The tailnet overlay is included only when this host has an address set, so
# the same script works unchanged on hosts that only need loopback. The
# overlay's LITE_TAILNET_BIND is required, so including it unconditionally
# would break those hosts.
if grep -qE '^[[:space:]]*LITE_TAILNET_BIND=[^[:space:]]' "$ENV_FILE"; then
  files+=(-f docker-compose.tailnet.yaml)
fi

# Only the file list is echoed, never the arguments: a command like
# `exec ... clickhouse-client --password X` would otherwise put the secret
# into the terminal and the shell history.
echo "+ compose files: ${files[*]} --env-file $ENV_FILE" >&2
exec docker compose "${files[@]}" --env-file "$ENV_FILE" "$@"
