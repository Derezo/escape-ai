#!/usr/bin/env bash
#
# deploy-server.sh — build + deploy Escape AI (server + client) to the VPS.
#
# Run from your dev machine. It builds everything locally, ships it to the VPS
# over rsync-over-ssh, installs production deps remotely, hands ownership to the
# dedicated nologin app user, and (re)starts the node process under that user's
# pm2 via server/ecosystem.config.js. nginx (set up once by provision-escape.sh)
# serves the static client from disk and proxies /socket.io/ + /health to node.
#
# PREREQUISITE: run scripts/provision-escape.sh ONCE on the VPS first (creates
# the app user, dirs, pm2 systemd unit, nginx vhost, TLS cert).
#
# Config is env-driven via scripts/deploy.env (copy from deploy.env.example).
# The HOST and SSH LOGIN USER are NEVER hard-coded here — they must come from the
# (gitignored) env file or the environment; the script errors if they are unset.
# Override any value inline:  APP_PORT=4000 ./scripts/deploy-server.sh
#
# Usage:  cp scripts/deploy.env.example scripts/deploy.env && edit it, then:
#         ./scripts/deploy-server.sh
#
set -euo pipefail

log()  { printf '\033[1;36m==>\033[0m %s\n' "$*"; }
die()  { printf '\033[1;31mERROR:\033[0m %s\n' "$*" >&2; exit 1; }

# --- config (env-driven; load scripts/deploy.env if present) ----------------
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
if [[ -f "${SCRIPT_DIR}/deploy.env" ]]; then
  # deploy.env names your host/user/paths — keep it owner-only. Self-correct loose
  # perms (e.g. a fresh `cp` from the example inherits your umask, often 0644/0664)
  # so the secret-adjacent config can't be read by other local users.
  chmod 600 "${SCRIPT_DIR}/deploy.env" 2>/dev/null || true
  # shellcheck disable=SC1091
  set -a; . "${SCRIPT_DIR}/deploy.env"; set +a
fi

# Required, NO default: the host and login user identify your infrastructure and
# must not live in the committed script. Set them in scripts/deploy.env.
require_env() {
  local name="$1"
  [[ -n "${!name:-}" ]] || die "${name} is not set. Copy scripts/deploy.env.example to scripts/deploy.env and fill it in (or export ${name})."
}
require_env DEPLOY_USER     # the SSH login user (a sudoer) — not hard-coded
require_env DEPLOY_HOST     # the VPS hostname — not hard-coded
require_env APP_DOMAIN      # public hostname (also reveals the host) — not hard-coded

# App-internal identity: safe, non-host-revealing defaults are fine.
APP_USER="${APP_USER:-escape}"
REMOTE_PATH="${REMOTE_PATH:-/var/www/${APP_USER}}"
APP_PORT="${APP_PORT:-3390}"
PM2_NAME="${PM2_NAME:-${APP_USER}}"
NODE_ENV="${NODE_ENV:-production}"
SSH_KEY="${SSH_KEY:-$HOME/.ssh/id_ed25519}"

SSH_TARGET="${DEPLOY_USER}@${DEPLOY_HOST}"
SSH_OPTS=(-i "${SSH_KEY}" -o StrictHostKeyChecking=accept-new -o ConnectTimeout=20)

# A single ssh into the box.
remote() { ssh "${SSH_OPTS[@]}" "${SSH_TARGET}" "$@"; }
# rsync over the same ssh opts. Args: <src> <remote-subpath> [extra rsync args...]
push() {
  local src="$1" dst="$2"; shift 2
  rsync -az --delete -e "ssh ${SSH_OPTS[*]}" "$@" \
    "${src}" "${SSH_TARGET}:${REMOTE_PATH}/${dst}"
}

log "Deploying to ${SSH_TARGET}:${REMOTE_PATH}  (domain ${APP_DOMAIN}, app user ${APP_USER}, port ${APP_PORT})"

# --- preflight --------------------------------------------------------------
for dir in server shared client; do
  [[ -d "${PROJECT_ROOT}/${dir}" ]] || die "${PROJECT_ROOT}/${dir} not found — run from the repo."
done
[[ -f "${SSH_KEY}" ]] || die "SSH key not found: ${SSH_KEY} (set SSH_KEY in scripts/deploy.env)."

# --- 1. build locally -------------------------------------------------------
# These are LOCAL builds and need the devDependencies (typescript, vite) to run.
# deploy.env sets NODE_ENV=production (correct for the *remote* runtime), and we
# export it — which makes a bare `npm install` here omit devDeps, breaking the
# build with "tsc: not found". Force --include=dev so the local toolchain is
# installed regardless of the ambient NODE_ENV. (The REMOTE install in step 4
# stays --omit=dev — production there has no business with the build tools.)
#
# shared/: client imports its TS source via Vite alias, server consumes dist/.
log "Building shared/"
( cd "${PROJECT_ROOT}/shared" && npm install --include=dev && npm run build )

# client/: static bundle with VITE_SERVER_URL baked to the public origin so the
# browser/WebView connects to https://${APP_DOMAIN} (same origin → Socket.IO and
# assets share it; production CORS stays locked).
log "Building client/ (VITE_SERVER_URL=https://${APP_DOMAIN})"
( cd "${PROJECT_ROOT}/client" \
    && npm install --include=dev \
    && VITE_SERVER_URL="https://${APP_DOMAIN}" npm run build )
[[ -f "${PROJECT_ROOT}/client/dist/index.html" ]] || die "client build produced no dist/index.html."

# --- 1b. stage the Android APK into the bundle (for the /android download page)
# The /android page (assets/android/ → dist/android/index.html, copied by Vite)
# links to ./escape-ai.apk. The APK is a large, gitignored binary built
# separately (see docs/ANDROID.md), so we copy the locally-built signed release
# APK into the bundle just before the rsync. It then ships with the static
# client to ${REMOTE_PATH}/client/android/escape-ai.apk and nginx serves it at
# https://${APP_DOMAIN}/android/escape-ai.apk.
#
# Path is overridable: APK_PATH=/path/to.apk ./scripts/deploy-server.sh
# If no APK is found we WARN and continue — the page still deploys; only the
# download link 404s until an APK is staged. Set REQUIRE_APK=1 to hard-fail.
APK_PATH="${APK_PATH:-${PROJECT_ROOT}/client/android/app/build/outputs/apk/release/app-release.apk}"
if [[ -f "${APK_PATH}" ]]; then
  log "Staging Android APK → client/dist/android/escape-ai.apk ($(du -h "${APK_PATH}" | cut -f1))"
  mkdir -p "${PROJECT_ROOT}/client/dist/android"
  cp "${APK_PATH}" "${PROJECT_ROOT}/client/dist/android/escape-ai.apk"
elif [[ "${REQUIRE_APK:-0}" == "1" ]]; then
  die "REQUIRE_APK=1 but no APK at ${APK_PATH}. Build it first (see docs/ANDROID.md) or set APK_PATH."
else
  log "WARNING: no APK at ${APK_PATH} — /android page will deploy but the download link will 404."
  log "         Build a signed release APK (docs/ANDROID.md) or pass APK_PATH=/path/to.apk to include it."
fi

# --- 2. ensure remote dirs exist (idempotent; provision made them, this is safe)
log "Ensuring remote directories"
remote "mkdir -p '${REMOTE_PATH}/server' '${REMOTE_PATH}/shared' '${REMOTE_PATH}/client' '${REMOTE_PATH}/logs' '${REMOTE_PATH}/data'"

# --- 3. sync code -----------------------------------------------------------
# Trailing slashes copy CONTENTS into the named remote subdir. node_modules and
# .env are installed/managed remotely, never shipped. The SQLite data/ dir is
# runtime state — never overwrite it (no --delete reaching it; we sync into
# sibling dirs only).
log "Syncing server/"
push "${PROJECT_ROOT}/server/" "server/" \
  --exclude 'node_modules/' --exclude '.env' --exclude 'data/' --exclude 'test/'

log "Syncing shared/ (src + dist; server requires dist/)"
push "${PROJECT_ROOT}/shared/" "shared/" --exclude 'node_modules/'

log "Syncing client bundle → ${REMOTE_PATH}/client (nginx serves this)"
push "${PROJECT_ROOT}/client/dist/" "client/"

# --- 4. remote: install prod deps, fix ownership, (re)start pm2 -------------
# Everything runs as the deploy user; ownership is then handed to the nologin
# app user, and pm2 is driven AS that user (sudo -u) so the process, its logs,
# and PM2_HOME all belong to ${APP_USER}, never to the login/deploy user.
log "Remote: install prod deps, chown to ${APP_USER}, reload pm2"
remote bash -se <<REMOTE_SCRIPT
set -euo pipefail
cd '${REMOTE_PATH}/server'

# Production deps only; the lockfile is shipped, so this is reproducible.
npm install --omit=dev --no-audit --no-fund

# Hand the whole tree to the app user with tight perms. The data/ dir keeps its
# contents (rsync never touched it); just re-assert ownership.
chown -R '${APP_USER}:${APP_USER}' '${REMOTE_PATH}'
chmod 750 '${REMOTE_PATH}'

# Start or reload under the app user's pm2. startOrReload is idempotent: starts
# on first deploy, zero-downtime reloads thereafter. PORT/PM2_NAME are injected
# so ecosystem.config.js binds the right loopback port. --update-env re-reads them.
sudo -u '${APP_USER}' -H \
  env PM2_HOME='${REMOTE_PATH}/.pm2' PORT='${APP_PORT}' PM2_NAME='${PM2_NAME}' NODE_ENV='${NODE_ENV}' \
  pm2 startOrReload '${REMOTE_PATH}/server/ecosystem.config.js' --update-env

# Persist the process list so the pm2-${APP_USER}.service unit resurrects it on reboot.
sudo -u '${APP_USER}' -H env PM2_HOME='${REMOTE_PATH}/.pm2' pm2 save >/dev/null
REMOTE_SCRIPT

# --- 5. health check --------------------------------------------------------
# A fresh `pm2 start` returns before node has opened the DB and bound the port,
# so a single immediate curl races the cold start and false-fails. Poll the
# loopback /health for up to ~30s (15 tries × 2s) and only fail if it never
# comes up. On genuine failure, tail the logs inline so the operator doesn't
# have to ssh back in to see why.
log "Health check: http://127.0.0.1:${APP_PORT}/health (waiting for the process to come up)"
if remote "for i in \$(seq 1 15); do curl -fsS --max-time 5 http://127.0.0.1:${APP_PORT}/health >/dev/null 2>&1 && exit 0; sleep 2; done; exit 1"; then
  log "Server is healthy on the loopback port."
else
  printf '\033[1;31m--- last 30 log lines ---\033[0m\n' >&2
  remote "sudo -u '${APP_USER}' -H env PM2_HOME='${REMOTE_PATH}/.pm2' pm2 logs '${PM2_NAME}' --lines 30 --nostream" >&2 || true
  die "Health check FAILED after ~30s — see the log tail above, or:  ssh ${SSH_TARGET} \"sudo -u ${APP_USER} -H env PM2_HOME=${REMOTE_PATH}/.pm2 pm2 logs ${PM2_NAME}\""
fi

log "Done.  Live at https://${APP_DOMAIN}"
log "Logs:  ssh ${SSH_TARGET} \"sudo -u ${APP_USER} -H env PM2_HOME=${REMOTE_PATH}/.pm2 pm2 logs ${PM2_NAME}\""
