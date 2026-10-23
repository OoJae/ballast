#!/usr/bin/env bash
# Provisions an eligible-jurisdiction signing host (host A): a dedicated `ballast` system user
# with no sudo and a 0700 home, the repo (gitignored files never leave the laptop), its
# dependencies, and system units for the recorder and the keeper. Re-running it redeploys the
# code and restarts both services; data/, deploy/*.env and ~ballast/.ballast are left alone.
#
# HOSTING RULE (CLAUDE.md): run this only against a host outside every jurisdiction on
# https://www.strikefinance.org/restricted, checked from the host itself (its egress IP). Never
# against Sonar-VPS2 or Railway, and never through a VPN or proxy.
#
# Keys are never copied by this script. The keeper unit refuses to start until
# ~ballast/ballast/deploy/keeper.env and the key files it names exist (see docs/runbook-host-a.md).
# Usage: ops/deploy-signing-host.sh <ssh-host> [recorder-user-agent-suffix]
set -euo pipefail

host="${1:?usage: ops/deploy-signing-host.sh <ssh-host> [recorder-user-agent-suffix]}"
suffix="${2:-a}"
repo="$(cd "$(dirname "$0")/.." && pwd)"

ssh -o BatchMode=yes "$host" 'sudo bash -s' <<'ROOT'
set -euo pipefail
id ballast >/dev/null 2>&1 || useradd --create-home --home-dir /home/ballast --shell /usr/sbin/nologin ballast
chmod 700 /home/ballast
corepack enable
install -d -o ballast -g ballast -m 700 /home/ballast/ballast /home/ballast/.ballast /home/ballast/.ballast/keys
ROOT

rsync -az --delete --filter=':- .gitignore' --exclude .git --exclude data \
  --rsync-path='sudo -u ballast rsync' "$repo/" "$host:/home/ballast/ballast/"

ssh -o BatchMode=yes "$host" 'sudo -u ballast -H bash -s' <<'BALLAST'
set -euo pipefail
cd ~/ballast
export COREPACK_ENABLE_DOWNLOAD_PROMPT=0
pnpm install --frozen-lockfile >/dev/null
mkdir -p data/recordings data/keeper data/policies
BALLAST

ssh -o BatchMode=yes "$host" "SUFFIX=$suffix sudo -E bash -s" <<'ROOT'
set -euo pipefail
cat > /etc/systemd/system/ballast-recorder.service <<UNIT
[Unit]
Description=Ballast recorder (public Strike market data; holds no keys)
After=network-online.target
Wants=network-online.target

[Service]
User=ballast
WorkingDirectory=/home/ballast/ballast
Environment=RECORDER_DATA_DIR=/home/ballast/ballast/data/recordings
Environment=RECORDER_USER_AGENT=ballast-recorder-${SUFFIX}/0.1
ExecStart=/home/ballast/ballast/node_modules/.bin/tsx apps/recorder/src/main.ts
Restart=always
RestartSec=5
KillSignal=SIGTERM
TimeoutStopSec=45
Nice=10
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ReadWritePaths=/home/ballast/ballast/data

[Install]
WantedBy=multi-user.target
UNIT

# The keeper signs (decision records today; Strike requests once accounts are bound). DRY_RUN is
# the default in keeper.env; arming also needs `--mainnet` on ExecStart and a human go-ahead.
cat > /etc/systemd/system/ballast-keeper.service <<'UNIT'
[Unit]
Description=Ballast keeper (signs; eligible-jurisdiction host only)
After=network-online.target time-sync.target ballast-recorder.service
Wants=network-online.target
ConditionPathExists=/home/ballast/ballast/deploy/keeper.env

[Service]
User=ballast
WorkingDirectory=/home/ballast/ballast
EnvironmentFile=/home/ballast/ballast/deploy/keeper.env
ExecStart=/home/ballast/ballast/node_modules/.bin/tsx apps/keeper/src/main.ts
# SIGTERM: stop ticking, cancel every resting ask, confirm, release the single-instance lock.
KillSignal=SIGTERM
TimeoutStopSec=30
# A crashed keeper's lock goes stale after 15 s; restarting sooner would be refused.
Restart=on-failure
RestartSec=20
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ReadWritePaths=/home/ballast/ballast/data
UMask=0077

[Install]
WantedBy=multi-user.target
UNIT

systemctl daemon-reload
systemctl enable ballast-recorder.service ballast-keeper.service >/dev/null 2>&1
systemctl restart ballast-recorder.service
if [ -f /home/ballast/ballast/deploy/keeper.env ]; then systemctl restart ballast-keeper.service; fi
sleep 8
systemctl --no-pager --lines=0 status ballast-recorder.service | head -3
systemctl --no-pager --lines=0 status ballast-keeper.service | head -3 || true
ROOT
