#!/usr/bin/env bats
#
# Unit tests for the dependency preflight in scripts/run-dev.sh.
#
# Strategy: source run-dev.sh (it returns early when BATS_TEST_FILENAME is set,
# exposing its functions without booting the stack), then control which tools
# "exist" by pointing PATH at a sandbox bin/ we populate per-test with fake
# `node`/`npm` executables. `command -v` then resolves against our sandbox, so
# we can simulate a fresh machine with node missing / too old / npm missing.
#
# Run:  bats scripts/test/run-dev.bats

setup() {
  SCRIPT="${BATS_TEST_DIRNAME}/../run-dev.sh"
  ORIG_PATH="${PATH}"
  # A throwaway bin dir that becomes the ONLY thing on PATH. We populate it with
  # symlinks to just the coreutils bats and our helpers need, so the shell still
  # works — but node/npm/lsof/etc. are absent until a test creates a fake one.
  # This way a tool is "installed" iff it exists in the sandbox, with no real
  # node leaking in from /usr/bin (this host has both an nvm and a system node).
  SANDBOX_BIN="${BATS_TEST_TMPDIR}/bin"
  mkdir -p "${SANDBOX_BIN}"
  local tool tp
  for tool in bash sh cat chmod mkdir rm env sed grep printf cut tr head tail \
              ls dirname basename mktemp expr wc sort find date stat readlink; do
    tp="$(PATH="${ORIG_PATH}" command -v "${tool}" 2>/dev/null)" || continue
    ln -sf "${tp}" "${SANDBOX_BIN}/${tool}"
  done
  PATH="${SANDBOX_BIN}"
  # Source under test. The BATS_TEST_FILENAME guard makes this return cleanly.
  source "${SCRIPT}"
}

teardown() {
  PATH="${ORIG_PATH}"
}

# Write a fake executable into the sandbox that prints $2 and exits 0.
fake_tool() {
  local name="$1" output="$2"
  cat >"${SANDBOX_BIN}/${name}" <<EOF
#!/usr/bin/env bash
printf '%s\n' "${output}"
EOF
  chmod +x "${SANDBOX_BIN}/${name}"
}

# --- node_major (version parser) -------------------------------------------

@test "node_major extracts major version from node -v" {
  fake_tool node "v22.22.2"
  run node_major
  [ "$status" -eq 0 ]
  [ "$output" = "22" ]
}

@test "node_major handles a bare major.minor" {
  fake_tool node "v18.0.0"
  run node_major
  [ "$output" = "18" ]
}

@test "node_major is empty when node is absent" {
  # No node in the sandbox.
  run node_major
  [ "$status" -eq 0 ]
  [ -z "$output" ]
}

# --- preflight: success path -----------------------------------------------

@test "preflight passes when node>=22 and npm are present" {
  fake_tool node "v22.22.2"
  fake_tool npm  "10.9.7"
  run preflight
  [ "$status" -eq 0 ]
  [[ "$output" == *"Preflight OK"* ]]
}

@test "preflight passes at exactly the required major version" {
  fake_tool node "v22.0.0"
  fake_tool npm  "10.0.0"
  run preflight
  [ "$status" -eq 0 ]
}

# --- preflight: failure paths ----------------------------------------------

@test "preflight fails and names node when node is missing" {
  fake_tool npm "10.9.7"   # npm present, node absent
  run preflight
  [ "$status" -ne 0 ]
  [[ "$output" == *"node not found"* ]]
}

@test "preflight fails when node is too old" {
  fake_tool node "v18.19.0"
  fake_tool npm  "10.9.7"
  run preflight
  [ "$status" -ne 0 ]
  [[ "$output" == *"too old"* ]]
  [[ "$output" == *"22"* ]]
}

@test "preflight fails and names npm when npm is missing" {
  fake_tool node "v22.22.2"   # node present, npm absent
  run preflight
  [ "$status" -ne 0 ]
  [[ "$output" == *"npm not found"* ]]
}

@test "preflight reports BOTH missing tools at once (not one-at-a-time)" {
  # Neither node nor npm in the sandbox.
  run preflight
  [ "$status" -ne 0 ]
  [[ "$output" == *"node not found"* ]]
  [[ "$output" == *"npm not found"* ]]
  [[ "$output" == *"Missing required tooling"* ]]
}

# --- preflight: soft deps warn but never fail -------------------------------

@test "preflight still passes (with warnings) when soft deps are absent" {
  # node + npm present, but no lsof/fuser/setsid in the sandbox.
  fake_tool node "v22.22.2"
  fake_tool npm  "10.9.7"
  run preflight
  [ "$status" -eq 0 ]
  [[ "$output" == *"lsof"* ]] || [[ "$output" == *"setsid"* ]]
}

@test "preflight does not warn about ports when lsof is present" {
  fake_tool node "v22.22.2"
  fake_tool npm  "10.9.7"
  fake_tool lsof ""
  fake_tool setsid ""
  run preflight
  [ "$status" -eq 0 ]
  [[ "$output" != *"ports won't be auto-freed"* ]]
}

# --- REQUIRED_NODE_MAJOR is configurable ------------------------------------

@test "REQUIRED_NODE_MAJOR override changes the minimum" {
  fake_tool node "v20.0.0"
  fake_tool npm  "10.0.0"
  REQUIRED_NODE_MAJOR=20 run preflight
  [ "$status" -eq 0 ]
}

# --- OS detection + per-OS install hints ------------------------------------

@test "detect_os classifies Darwin as macos and Linux as linux" {
  # Shadow uname in the sandbox so we control what the OS reports.
  fake_tool uname "Darwin"
  run detect_os
  [ "$output" = "macos" ]
  fake_tool uname "Linux"
  run detect_os
  [ "$output" = "linux" ]
}

@test "node hint mentions Homebrew on macOS" {
  HOST_OS=macos run node_hint
  [[ "$output" == *"brew install node"* ]]
}

@test "node hint mentions apt/nvm on Linux (not Homebrew)" {
  HOST_OS=linux run node_hint
  [[ "$output" == *"nvm install"* ]]
  [[ "$output" != *"brew"* ]]
}

@test "missing-node error carries the macOS hint when HOST_OS=macos" {
  fake_tool npm "10.9.7"   # npm present, node absent
  HOST_OS=macos run preflight
  [ "$status" -ne 0 ]
  [[ "$output" == *"node not found"* ]]
  [[ "$output" == *"brew install node"* ]]
}

@test "preflight does not nag about setsid on macOS" {
  # macOS never has setsid and doesn't need it — no warning should appear.
  fake_tool node "v22.22.2"
  fake_tool npm  "10.9.7"
  fake_tool lsof ""
  HOST_OS=macos run preflight
  [ "$status" -eq 0 ]
  [[ "$output" != *"setsid"* ]]
}

@test "lsof hint differs by OS" {
  HOST_OS=macos run lsof_hint
  [[ "$output" == *"ships with macOS"* ]]
  HOST_OS=linux run lsof_hint
  [[ "$output" == *"apt install lsof"* ]]
}
