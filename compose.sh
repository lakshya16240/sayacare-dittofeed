#!/usr/bin/env bash
#
# Wrapper for the production stack. Passes every argument through to
# `docker compose`, with the compose file and env file already applied:
#
#   sudo ./compose.sh up -d
#   sudo ./compose.sh ps
#   sudo ./compose.sh logs -f lite worker
#   sudo ./compose.sh pull
#   sudo ./compose.sh run --rm admin migrate
#
# Passing -f disables Compose's automatic override discovery and forgetting
# --env-file fails on every required variable, so going through this script
# keeps every command pointed at the same stack.
set -euo pipefail

cd "$(dirname "$0")"

ENV_FILE="${ENV_FILE:-.env.prod}"
if [ ! -f "$ENV_FILE" ]; then
  echo "error: $ENV_FILE not found. Copy .env.prod.example and fill it in." >&2
  exit 1
fi

files=(-f docker-compose.prod.yaml)

# Only the file list is echoed, never the arguments: a command like
# `exec ... clickhouse-client --password X` would otherwise put the secret
# into the terminal and the shell history.
echo "+ compose files: ${files[*]} --env-file $ENV_FILE" >&2
exec docker compose "${files[@]}" --env-file "$ENV_FILE" "$@"
