#!/usr/bin/env bash
#
# run-dev.sh — developer comfort launcher for local Escape AI development.
#
# Boots the whole local stack with one command: builds shared/, starts the
# authoritative server (:3000) and the Vite client (:5173) together, and tears
# both down cleanly on Ctrl-C. It is conservative and idempotent:
#
#   * Conditionally runs `npm install` — only when node_modules is missing or the
#     package-lock.json is newer than the installed marker (no needless reinstall).
#   * Auto-kills any server/client already listening on those ports before start
#     (so a stale process from a previous run never blocks this one).
#   * --clean wipes local dev data (the SQLite store) for a fresh-state run.
#
# Usage:
#   ./scripts/run-dev.sh                 # install-if-needed, then run server + client
#   ./scripts/run-dev.sh --clean         # also wipe server/data (fresh accounts/stats)
#   ./scripts/run-dev.sh --force-install  # reinstall deps even if up to date
#   ./scripts/run-dev.sh --server-only    # run only the server
#   ./scripts/run-dev.sh --client-only    # run only the client (assumes a server elsewhere)
#   SERVER_PORT=3001 CLIENT_PORT=5180 ./scripts/run-dev.sh   # override ports
#
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"

# --- config (env-overridable) -----------------------------------------------
SERVER_PORT="${SERVER_PORT:-3000}"   # server/config.js default
CLIENT_PORT="${CLIENT_PORT:-5173}"   # Vite default
# Point the dev client at the local server unless the caller overrides it.
export VITE_SERVER_URL="${VITE_SERVER_URL:-http://localhost:${SERVER_PORT}}"

# --- flags ------------------------------------------------------------------
CLEAN=0 FORCE_INSTALL=0 RUN_SERVER=1 RUN_CLIENT=1
for arg in "$@"; do
  case "$arg" in
    --clean)         CLEAN=1 ;;
    --force-install) FORCE_INSTALL=1 ;;
    --server-only)   RUN_CLIENT=0 ;;
    --client-only)   RUN_SERVER=0 ;;
    -h|--help)
      sed -n '2,30p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
      exit 0 ;;
    *) echo "unknown flag: $arg (try --help)" >&2; exit 2 ;;
  esac
done

log()  { printf '\033[1;36m==>\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m[warn]\033[0m %s\n' "$*"; }

# --- conditional install ----------------------------------------------------
# Reinstall only when node_modules is absent OR package-lock.json is newer than
# our stamp (a marker file we touch after a successful install). Cheap to call.
ensure_deps() {
  local dir="$1" stamp
  stamp="${dir}/node_modules/.run-dev-installed"
  if [[ "${FORCE_INSTALL}" -eq 1 ]] \
     || [[ ! -d "${dir}/node_modules" ]] \
     || [[ "${dir}/package-lock.json" -nt "${stamp}" ]] \
     || [[ "${dir}/package.json"      -nt "${stamp}" ]]; then
    log "Installing deps in ${dir#"${ROOT}"/}/"
    ( cd "${dir}" && npm install )
    touch "${stamp}"
  else
    log "Deps up to date in ${dir#"${ROOT}"/}/ (skipping install)"
  fi
}

# --- kill anything already on our ports -------------------------------------
# Frees the port without caring HOW it got taken (stale dev run, crashed node,
# another vite). Tries the precise lsof/fuser path; degrades gracefully if the
# tool is missing. Never touches anything not bound to the port.
kill_port() {
  local port="$1" label="$2" pids=""
  if command -v lsof >/dev/null 2>&1; then
    pids="$(lsof -ti "tcp:${port}" -sTCP:LISTEN 2>/dev/null || true)"
  elif command -v fuser >/dev/null 2>&1; then
    pids="$(fuser "${port}/tcp" 2>/dev/null || true)"
  else
    warn "neither lsof nor fuser found — cannot auto-free port ${port}; kill ${label} manually if it is running."
    return 0
  fi
  if [[ -n "${pids}" ]]; then
    log "Freeing ${label} port ${port} (killing PID(s): ${pids})"
    # shellcheck disable=SC2086
    kill ${pids} 2>/dev/null || true
    sleep 0.5
    # Escalate if anything survived a graceful TERM.
    for p in ${pids}; do kill -0 "$p" 2>/dev/null && kill -9 "$p" 2>/dev/null || true; done
  fi
}

# --- clean dev data ---------------------------------------------------------
clean_data() {
  local data="${ROOT}/server/data"
  if [[ -d "${data}" ]]; then
    log "Cleaning dev data (${data#"${ROOT}"/}/* — SQLite store + WAL/SHM)"
    rm -f "${data}"/*.db "${data}"/*.db-wal "${data}"/*.db-shm 2>/dev/null || true
  else
    log "No dev data dir to clean (fresh state already)."
  fi
}

# --- teardown: kill our children (and THEIR children) on exit ----------------
# `npm run dev` forks node --watch / vite as grandchildren, so killing the direct
# child PID would orphan the real listeners. With `setsid` each service leads its
# OWN process group, so we group-kill the whole tree (kill -- -PGID). Without
# setsid we must NOT group-kill (the child shares THIS script's group — signalling
# -PGID would kill the script itself); we kill the child PID and let the port
# sweep below reap any orphaned grandchildren.
# Entries are "g:<pid>" (group leader, safe to group-kill) or "p:<pid>" (kill PID only).
PROCS=()
cleanup() {
  trap - INT TERM EXIT
  set +e   # never let a failed kill abort cleanup under `set -e`
  [[ ${#PROCS[@]} -gt 0 ]] && log "Shutting down (server/client)..."
  # Graceful TERM, then escalate to KILL for survivors.
  for sig in TERM KILL; do
    for entry in "${PROCS[@]:-}"; do
      [[ -z "${entry}" ]] && continue
      local kind="${entry%%:*}" pid="${entry#*:}"
      if [[ "${kind}" == "g" ]]; then kill "-${sig}" "-${pid}" 2>/dev/null
      else                            kill "-${sig}"  "${pid}" 2>/dev/null; fi
    done
    [[ "${sig}" == "TERM" ]] && sleep 1
  done
  # Belt-and-suspenders: free our ports in case a grandchild escaped the group.
  [[ "${RUN_SERVER:-1}" -eq 1 ]] && kill_port "${SERVER_PORT}" "server" >/dev/null 2>&1
  [[ "${RUN_CLIENT:-1}" -eq 1 ]] && kill_port "${CLIENT_PORT}" "client" >/dev/null 2>&1
  wait 2>/dev/null
}
trap cleanup INT TERM EXIT

# Launch a command and record how cleanup() should take it down. With setsid the
# child leads its own group (PGID==PID) → mark "g:" for a safe group-kill. Without
# setsid it shares our group → mark "p:" so we kill only its PID (group-kill would
# hit this script); the cleanup port sweep reaps any orphaned grandchildren.
spawn_group() {
  if command -v setsid >/dev/null 2>&1; then
    setsid bash -c "$1" &
    PROCS+=("g:$!")
  else
    bash -c "$1" &
    PROCS+=("p:$!")
  fi
}

# ============================================================================
[[ "${CLEAN}" -eq 1 ]] && clean_data

# shared/ is required by both: client imports its src, server loads its dist.
ensure_deps "${ROOT}/shared"
log "Building shared/"
( cd "${ROOT}/shared" && npm run build )

if [[ "${RUN_SERVER}" -eq 1 ]]; then
  ensure_deps "${ROOT}/server"
  kill_port "${SERVER_PORT}" "server"
fi
if [[ "${RUN_CLIENT}" -eq 1 ]]; then
  ensure_deps "${ROOT}/client"
  kill_port "${CLIENT_PORT}" "client"
fi

# --- launch -----------------------------------------------------------------
# Each service runs in its own process group (spawn_group) so Ctrl-C tears down
# npm AND its node --watch / vite grandchildren, not just the wrapper.
if [[ "${RUN_SERVER}" -eq 1 ]]; then
  log "Starting server  → http://localhost:${SERVER_PORT}  (npm run dev, --watch)"
  spawn_group "cd '${ROOT}/server' && PORT='${SERVER_PORT}' exec npm run dev"
fi
if [[ "${RUN_CLIENT}" -eq 1 ]]; then
  log "Starting client  → http://localhost:${CLIENT_PORT}  (VITE_SERVER_URL=${VITE_SERVER_URL})"
  # --strictPort so Vite fails loudly instead of silently hopping ports (we just
  # freed CLIENT_PORT, so it should be available).
  spawn_group "cd '${ROOT}/client' && exec npm run dev -- --port '${CLIENT_PORT}' --strictPort"
fi

log "Up. Open http://localhost:${CLIENT_PORT} in two tabs. Ctrl-C to stop both."
# Wait on the children; if either dies, cleanup() tears the other down.
wait
