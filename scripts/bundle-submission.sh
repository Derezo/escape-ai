#!/usr/bin/env bash
#
# bundle-submission.sh — package the project into a competition-ready .zip.
#
# TINS 2026 requires the SOURCES of the entry so a reviewer can build and run the
# game locally. This script produces a single `escape-ai-submission.zip` at the
# repo root containing exactly that — and nothing a reviewer doesn't need.
#
# WHAT GOES IN (and why this is the right list):
#   * Source for all three workspaces: shared/, server/, client/ (TypeScript,
#     CommonJS server, configs, package.json + package-lock.json so installs are
#     reproducible).
#   * Runtime assets the game loads: assets/ (sprites atlas, tileset, music, sfx,
#     voice, images). These are committed artifacts a clean clone boots on.
#   * The asset pipeline INPUTS: asset-pipeline/manifest.json + theme.json +
#     README — the single source of truth for audio — WITHOUT asset-pipeline/output/
#     (raw Suno/ElevenLabs samples + provenance; large, regenerable, never shipped).
#   * The cross-platform launchers — scripts/run-dev.sh (Linux/macOS) and
#     scripts/run-dev.ps1 (Windows) — plus the verify/build/asset tooling under
#     scripts/, so a reviewer on any OS can run the stack with one command.
#   * Reviewer-facing docs: README.md, LICENSE, THIRD_PARTY_NOTICES.md,
#     ARCHITECTURE.md, RULES.md, CHANGELOG.md, and the curated docs/ set.
#
# WHAT STAYS OUT:
#   * Anything git does not track — so node_modules/, dist/, .env, build output,
#     and every .gitignore entry are excluded for free (we drive off `git ls-files`).
#   * asset-pipeline/output/  (raw generation samples; not tracked anyway).
#   * .claude/  (Claude Code agent definitions — dev tooling, not the entry).
#   * Internal/dev-only docs: CLAUDE.md, FINDINGS_OUTSIDE_SCOPE.md,
#     docs/UPSTREAM_ASKS.md, docs/archive/ — backlog/process notes, not needed to
#     build or play the game.
#
# The bundle is built from the git index (HEAD-tracked files), so it is clean,
# reproducible, and can never accidentally sweep in untracked junk or secrets.
#
# Usage:
#   ./scripts/bundle-submission.sh                # writes ./escape-ai-submission.zip
#   OUT=/tmp/entry.zip ./scripts/bundle-submission.sh   # custom output path
#
# Exit status: 0 on success; non-zero if not a git repo, zip is missing, the
# bundle would exceed the 100 MB competition limit, or no files were selected.
#
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"

# --- config -----------------------------------------------------------------
# Output zip path (override with OUT=...). Default sits at the repo root.
OUT="${OUT:-${ROOT}/escape-ai-submission.zip}"
# Competition hard limit. 100 MB == 100 * 1024 * 1024 bytes.
MAX_BYTES="${MAX_BYTES:-$((100 * 1024 * 1024))}"

log()  { printf '\033[1;36m==>\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m[warn]\033[0m %s\n' "$*"; }
err()  { printf '\033[1;31m[error]\033[0m %s\n' "$*" >&2; }

# --- inclusion policy -------------------------------------------------------
# is_excluded_path PATH -> exit 0 (true) if the repo-relative PATH must be kept
# OUT of the submission, 1 (false) if it should be included. This is the single
# decision point for the whole bundle and is unit-tested in isolation; keep it
# pure (no I/O, decide purely from the path string).
is_excluded_path() {
  local p="$1"
  case "${p}" in
    # Raw asset-generation samples + provenance. Large, regenerable; the manifest
    # is the source of truth that DOES ship. (Not git-tracked, but belt-and-braces.)
    asset-pipeline/output/*)        return 0 ;;
    # Claude Code agent definitions — developer tooling, not part of the entry.
    .claude/*)                      return 0 ;;
    # Internal/process docs a reviewer does not need to build or play the game.
    CLAUDE.md)                      return 0 ;;
    FINDINGS_OUTSIDE_SCOPE.md)      return 0 ;;
    docs/UPSTREAM_ASKS.md)          return 0 ;;
    docs/archive/*)                 return 0 ;;
    # Local deploy identity (names a private VPS host/user). The committed
    # *.example template still ships so the deploy path is documented.
    scripts/deploy.env)             return 0 ;;
  esac
  return 1
}

# --- file list --------------------------------------------------------------
# bundle_file_list -> emit, one per line, every repo-relative path that belongs
# in the submission: git-tracked files minus the inclusion-policy exclusions.
# Reads `git ls-files` from ROOT; honours an injectable GIT_LS override so tests
# can feed a synthetic file list without a real index.
bundle_file_list() {
  local listing path
  if [[ -n "${GIT_LS:-}" ]]; then
    listing="${GIT_LS}"           # test hook: newline-separated paths
  else
    listing="$(cd "${ROOT}" && git ls-files)"
  fi
  while IFS= read -r path; do
    [[ -z "${path}" ]] && continue
    is_excluded_path "${path}" && continue
    printf '%s\n' "${path}"
  done <<< "${listing}"
}

# --- helpers ----------------------------------------------------------------
# human_size BYTES -> a friendly size string (e.g. "67.4M", "812K", "340 bytes").
human_size() {
  local b="$1"
  if   (( b >= 1024 * 1024 )); then printf '%d.%dM' "$(( b / 1048576 ))" "$(( (b % 1048576) * 10 / 1048576 ))"
  elif (( b >= 1024 ));        then printf '%dK' "$(( b / 1024 ))"
  else                              printf '%d bytes' "${b}"
  fi
}

# --- BATS sourcing guard ----------------------------------------------------
# When sourced by a BATS test, stop here so the functions above are available
# for unit testing without building anything. (BATS sets BATS_TEST_FILENAME.)
[[ -n "${BATS_TEST_FILENAME:-}" ]] && return 0

# --- preflight --------------------------------------------------------------
if ! command -v git >/dev/null 2>&1; then
  err "git not found — this script bundles the git-tracked sources."
  exit 1
fi
if ! (cd "${ROOT}" && git rev-parse --is-inside-work-tree >/dev/null 2>&1); then
  err "${ROOT} is not a git repository; cannot determine the source set."
  exit 1
fi
if ! command -v zip >/dev/null 2>&1; then
  err "zip not found. Install it (Debian/Ubuntu: 'sudo apt install zip')."
  exit 1
fi

# --- collect ----------------------------------------------------------------
log "Collecting git-tracked sources from ${ROOT}"
mapfile -t FILES < <(bundle_file_list)
if (( ${#FILES[@]} == 0 )); then
  err "No files selected for the bundle — refusing to write an empty zip."
  exit 1
fi
log "Selected ${#FILES[@]} files."

# --- sanity: the things a reviewer cannot run without --------------------------
# Fail loudly if a refactor of the policy or index ever drops a must-have entry
# point, rather than shipping a bundle a reviewer can't boot.
REQUIRED=(
  scripts/run-dev.sh        # Linux/macOS launcher
  scripts/run-dev.ps1       # Windows launcher
  README.md
  asset-pipeline/manifest.json
)
missing=()
for req in "${REQUIRED[@]}"; do
  printf '%s\n' "${FILES[@]}" | grep -Fxq "${req}" || missing+=("${req}")
done
if (( ${#missing[@]} > 0 )); then
  err "Bundle is missing required files: ${missing[*]}"
  exit 1
fi

# --- stage ------------------------------------------------------------------
# Copy the selected files into a temp staging tree (preserving paths) and zip
# that. Staging — rather than `zip <list>` — keeps the archive layout obvious and
# lets us report the on-disk size before compression. Cleaned up on any exit.
STAGE="$(mktemp -d "${TMPDIR:-/tmp}/escape-ai-submission.XXXXXX")"
cleanup() { rm -rf "${STAGE}"; }
trap cleanup EXIT

raw_bytes=0
for rel in "${FILES[@]}"; do
  src="${ROOT}/${rel}"
  [[ -f "${src}" ]] || { warn "skipping missing tracked file: ${rel}"; continue; }
  dest="${STAGE}/${rel}"
  mkdir -p "$(dirname "${dest}")"
  cp -p "${src}" "${dest}"
  sz=$(stat -c%s "${src}" 2>/dev/null || stat -f%z "${src}" 2>/dev/null || echo 0)
  raw_bytes=$(( raw_bytes + sz ))
done
log "Staged $(human_size "${raw_bytes}") of source + assets (uncompressed)."

# --- zip --------------------------------------------------------------------
rm -f "${OUT}"
log "Writing ${OUT}"
( cd "${STAGE}" && zip -q -r -X "${OUT}" . )

zip_bytes=$(stat -c%s "${OUT}" 2>/dev/null || stat -f%z "${OUT}" 2>/dev/null || echo 0)

# --- verify size ------------------------------------------------------------
if (( zip_bytes > MAX_BYTES )); then
  err "Bundle is $(human_size "${zip_bytes}") — over the $(human_size "${MAX_BYTES}") limit."
  err "Trim large assets or split the submission, then re-run."
  rm -f "${OUT}"
  exit 1
fi

log "Done. $(human_size "${zip_bytes}") → ${OUT}  (limit $(human_size "${MAX_BYTES}"))"
log "Reviewer unzips, then runs:  Linux/macOS → ./scripts/run-dev.sh   |   Windows → .\\scripts\\run-dev.ps1"
