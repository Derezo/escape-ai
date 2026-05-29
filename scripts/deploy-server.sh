#!/usr/bin/env bash
#
# deploy-server.sh — Deploy the TINS 2026 Socket.IO server to the VPS.
#
# Minimal jam-grade deploy: rsync server/ + shared/ to the remote, install
# production deps, (re)start under pm2. No nginx/SSL/backups — keep it fast.
# (galaxy-miner's scripts/deploy-production.sh is the heavyweight reference if
#  you later need backups/health-checks/rollback.)
#
# >>> FILL THESE IN before first use <<<
#   HOST          ssh target, e.g. root@mittonvillage.com
#   REMOTE_PATH   absolute dir on the VPS to deploy into
# Override any var without editing the file:  HOST=root@host ./deploy-server.sh
#
# Usage:  ./scripts/deploy-server.sh
#
set -euo pipefail

# --- config (EDIT ME) -------------------------------------------------------
HOST="${HOST:-root@mittonvillage.com}"        # TODO: confirm ssh user@host
REMOTE_PATH="${REMOTE_PATH:-/var/www/tins2026}" # TODO: confirm remote dir
PM2_NAME="${PM2_NAME:-tins2026}"
SSH_KEY="${SSH_KEY:-$HOME/.ssh/id_ed25519}"
NODE_ENV="${NODE_ENV:-production}"

# --- paths ------------------------------------------------------------------
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"

SSH_OPTS=(-i "${SSH_KEY}" -o StrictHostKeyChecking=accept-new -o ConnectTimeout=20)

echo "==> Deploying to ${HOST}:${REMOTE_PATH} (pm2 name: ${PM2_NAME})"

# --- preflight --------------------------------------------------------------
for dir in server shared; do
  if [[ ! -d "${PROJECT_ROOT}/${dir}" ]]; then
    echo "ERROR: ${PROJECT_ROOT}/${dir} not found — run from the repo." >&2
    exit 1
  fi
done

# --- sync code --------------------------------------------------------------
# Trailing slashes matter: copy CONTENTS of server/ and shared/ into remote
# subdirs of the same name. node_modules/.env are excluded (installed remotely).
echo "==> Creating remote directory"
ssh "${SSH_OPTS[@]}" "${HOST}" "mkdir -p '${REMOTE_PATH}'"

echo "==> Syncing server/ and shared/"
rsync -az --delete \
  --exclude 'node_modules/' \
  --exclude '.env' \
  -e "ssh ${SSH_OPTS[*]}" \
  "${PROJECT_ROOT}/server/" "${HOST}:${REMOTE_PATH}/server/"

rsync -az --delete \
  --exclude 'node_modules/' \
  -e "ssh ${SSH_OPTS[*]}" \
  "${PROJECT_ROOT}/shared/" "${HOST}:${REMOTE_PATH}/shared/"

# --- install + restart ------------------------------------------------------
echo "==> Installing production deps and (re)starting via pm2"
ssh "${SSH_OPTS[@]}" "${HOST}" \
  "cd '${REMOTE_PATH}/server' \
   && npm install --omit=dev \
   && NODE_ENV='${NODE_ENV}' pm2 restart '${PM2_NAME}' --update-env \
      || NODE_ENV='${NODE_ENV}' pm2 start index.js --name '${PM2_NAME}' \
   && pm2 save"

echo "==> Done. Logs:  ssh ${HOST} 'pm2 logs ${PM2_NAME}'"
