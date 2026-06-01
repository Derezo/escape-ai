#!/usr/bin/env bats
#
# Unit tests for scripts/bundle-submission.sh — the competition .zip packager.
#
# Strategy: source bundle-submission.sh (its BATS_TEST_FILENAME guard makes it
# return before doing any work, exposing the pure decision functions). We test
# the inclusion policy and the file-list filter against a synthetic git listing
# injected via the GIT_LS hook, so no real index or zip is touched.
#
# Run:  bats scripts/test/bundle-submission.bats   (or: npm run test:shell)

setup() {
  SCRIPT="${BATS_TEST_DIRNAME}/../bundle-submission.sh"
  source "${SCRIPT}"
}

# --- is_excluded_path: things that MUST stay out -----------------------------

@test "asset-pipeline/output is excluded (raw generation samples)" {
  run is_excluded_path "asset-pipeline/output/robot_alert/sample1.mp3"
  [ "$status" -eq 0 ]
}

@test ".claude agent definitions are excluded (dev tooling)" {
  run is_excluded_path ".claude/agents/client-netcode-engineer.md"
  [ "$status" -eq 0 ]
}

@test "internal dev docs are excluded" {
  run is_excluded_path "CLAUDE.md"
  [ "$status" -eq 0 ]
  run is_excluded_path "FINDINGS_OUTSIDE_SCOPE.md"
  [ "$status" -eq 0 ]
  run is_excluded_path "docs/UPSTREAM_ASKS.md"
  [ "$status" -eq 0 ]
  run is_excluded_path "docs/archive/findings-stat-field-dry-2026-05.md"
  [ "$status" -eq 0 ]
}

@test "local deploy identity is excluded but its .example template is not" {
  run is_excluded_path "scripts/deploy.env"
  [ "$status" -eq 0 ]
  run is_excluded_path "scripts/deploy.env.example"
  [ "$status" -ne 0 ]
}

# --- is_excluded_path: things that MUST stay in ------------------------------

@test "both run-dev launchers are included (linux/macos AND windows)" {
  run is_excluded_path "scripts/run-dev.sh"
  [ "$status" -ne 0 ]
  run is_excluded_path "scripts/run-dev.ps1"
  [ "$status" -ne 0 ]
}

@test "the asset-pipeline manifest/theme/readme are included (output is not)" {
  run is_excluded_path "asset-pipeline/manifest.json"
  [ "$status" -ne 0 ]
  run is_excluded_path "asset-pipeline/theme.json"
  [ "$status" -ne 0 ]
  run is_excluded_path "asset-pipeline/README.md"
  [ "$status" -ne 0 ]
}

@test "reviewer-facing docs and committed assets are included" {
  for keep in README.md LICENSE THIRD_PARTY_NOTICES.md ARCHITECTURE.md \
              RULES.md CHANGELOG.md docs/PLAYBOOK.md docs/ANDROID.md \
              assets/sprites/atlas.png assets/music/title_theme.mp3 \
              client/src/main.ts server/index.js shared/src/net.ts; do
    run is_excluded_path "${keep}"
    [ "$status" -ne 0 ] || { echo "wrongly excluded: ${keep}"; return 1; }
  done
}

# --- bundle_file_list: the policy applied to a listing -----------------------

@test "bundle_file_list drops excluded paths and keeps the rest" {
  GIT_LS="$(printf '%s\n' \
    "scripts/run-dev.sh" \
    "scripts/run-dev.ps1" \
    "README.md" \
    "CLAUDE.md" \
    ".claude/agents/foo.md" \
    "asset-pipeline/manifest.json" \
    "asset-pipeline/output/x/sample1.mp3" \
    "docs/UPSTREAM_ASKS.md" \
    "docs/PLAYBOOK.md" \
    "scripts/deploy.env" \
    "scripts/deploy.env.example")"
  export GIT_LS
  run bundle_file_list

  [ "$status" -eq 0 ]
  # kept
  [[ "$output" == *"scripts/run-dev.sh"* ]]
  [[ "$output" == *"scripts/run-dev.ps1"* ]]
  [[ "$output" == *"README.md"* ]]
  [[ "$output" == *"asset-pipeline/manifest.json"* ]]
  [[ "$output" == *"docs/PLAYBOOK.md"* ]]
  [[ "$output" == *"scripts/deploy.env.example"* ]]
  # dropped
  [[ "$output" != *"CLAUDE.md"* ]]
  [[ "$output" != *".claude/agents/foo.md"* ]]
  [[ "$output" != *"asset-pipeline/output/"* ]]
  [[ "$output" != *"UPSTREAM_ASKS.md"* ]]
}

@test "bundle_file_list emits exactly one line per kept file" {
  GIT_LS="$(printf '%s\n' "README.md" "CLAUDE.md" "scripts/run-dev.ps1")"
  export GIT_LS
  run bundle_file_list
  [ "$status" -eq 0 ]
  # README + run-dev.ps1 kept, CLAUDE.md dropped -> 2 lines
  [ "$(printf '%s\n' "$output" | grep -c .)" -eq 2 ]
}

# --- bundle_file_list against the REAL index (integration) -------------------

@test "the real repo bundle includes both launchers and excludes node_modules/.claude" {
  unset GIT_LS
  run bundle_file_list
  [ "$status" -eq 0 ]
  [[ "$output" == *"scripts/run-dev.sh"* ]]
  [[ "$output" == *"scripts/run-dev.ps1"* ]]
  [[ "$output" == *"asset-pipeline/manifest.json"* ]]
  # git ls-files never lists ignored content, and the policy drops .claude
  [[ "$output" != *"node_modules/"* ]]
  [[ "$output" != *".claude/"* ]]
  [[ "$output" != *"asset-pipeline/output/"* ]]
}

# --- human_size --------------------------------------------------------------

@test "human_size formats bytes, KB and MB" {
  run human_size 340
  [ "$output" = "340 bytes" ]
  run human_size 2048
  [ "$output" = "2K" ]
  run human_size $((67 * 1048576 + 419430))
  [[ "$output" == "67."* ]]
  [[ "$output" == *"M" ]]
}
