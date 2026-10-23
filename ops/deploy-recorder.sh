#!/usr/bin/env bash
# Deploys the public-data recorder to a remote host and (re)starts it as a systemd user service.
# Everything gitignored stays local, so internal docs (CLAUDE.md, docs/research, battle plans),
# recordings and node_modules never reach a server.
# Usage: ops/deploy-recorder.sh <ssh-host> [user-agent-suffix]
set -euo pipefail

host="${1:?usage: ops/deploy-recorder.sh <ssh-host> [user-agent-suffix]}"
suffix="${2:-b}"
repo="$(cd "$(dirname "$0")/.." && pwd)"

rsync -az --delete --filter=':- .gitignore' --exclude .git --exclude data "$repo/" "$host:ballast/"

ssh -o BatchMode=yes "$host" "SUFFIX=$suffix bash -s" <<'REMOTE'
set -euo pipefail
cd ~/ballast
pnpm install --frozen-lockfile >/dev/null
mkdir -p ~/.config/systemd/user data/recordings
cat > ~/.config/systemd/user/ballast-recorder.service <<UNIT
[Unit]
Description=Ballast recorder (public Strike market data; holds no keys)
After=network-online.target

[Service]
WorkingDirectory=%h/ballast
Environment=RECORDER_DATA_DIR=%h/ballast/data/recordings
Environment=RECORDER_USER_AGENT=ballast-recorder-${SUFFIX}/0.1
ExecStart=%h/ballast/node_modules/.bin/tsx apps/recorder/src/main.ts
Restart=always
RestartSec=5
KillSignal=SIGTERM
TimeoutStopSec=45
Nice=10

[Install]
WantedBy=default.target
UNIT
systemctl --user daemon-reload
systemctl --user enable ballast-recorder.service >/dev/null
systemctl --user restart ballast-recorder.service
sleep 8
systemctl --user --no-pager --lines=0 status ballast-recorder.service | head -5
journalctl --user -u ballast-recorder.service --no-pager -n 6 -o cat | cut -c1-200
REMOTE
