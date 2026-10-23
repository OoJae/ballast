#!/usr/bin/env bash
# Runs the public recorder and the read-only API side by side. If either exits, the container
# exits and Railway restarts it; SIGTERM reaches both so segments are sealed on shutdown.
set -euo pipefail

data="${RAILWAY_VOLUME_MOUNT_PATH:-/data}/recordings"
mkdir -p "$data"
tsx=node_modules/.bin/tsx

RECORDER_DATA_DIR="$data" RECORDER_USER_AGENT="ballast-recorder-railway/0.1" \
  "$tsx" apps/recorder/src/main.ts &
recorder=$!

API_HOST=0.0.0.0 API_PORT="${PORT:-8787}" RECORDINGS_ROOT="$data" BOOK_SOURCE=replay \
  WEB_DIST=/app/apps/web/dist "$tsx" apps/api/src/main.ts &
api=$!

trap 'kill -TERM "$recorder" "$api" 2>/dev/null; wait' TERM INT
wait -n "$recorder" "$api"
kill -TERM "$recorder" "$api" 2>/dev/null || true
wait
exit 1
