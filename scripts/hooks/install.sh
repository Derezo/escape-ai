#!/usr/bin/env bash
# Install the TINS 2026 git hooks into this repo's .git/hooks.
# Idempotent: re-running just refreshes the symlinks. Run from anywhere in the repo.

set -euo pipefail

repo_root="$(git rev-parse --show-toplevel)"
hooks_src="${repo_root}/scripts/hooks"
hooks_dst="${repo_root}/.git/hooks"

mkdir -p "${hooks_dst}"

# shellcheck disable=SC2043  # single hook today; list grows as we add more (pre-push, etc.)
for hook in commit-msg; do
    src="${hooks_src}/${hook}"
    dst="${hooks_dst}/${hook}"
    if [ ! -f "${src}" ]; then
        echo "install: missing ${src}, skipping" >&2
        continue
    fi
    chmod +x "${src}"
    ln -sf "${src}" "${dst}"
    echo "install: linked ${hook}"
done

echo "install: done. Bypass any hook with 'git commit --no-verify'."
