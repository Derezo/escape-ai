#!/usr/bin/env node
// @ts-check
'use strict';

/**
 * Repo-wide verification aggregator (TINS 2026 — Escape AI).
 *
 * The repo has rich verification gates but, by design, NO CI and only a
 * reminder-only commit-msg hook — so each gate (shared/server tests, the facing
 * determinism check, the atlas/tileset rasterisation verifiers, the audio drift
 * gate) was previously MANUAL and easy to forget. This script runs them all in
 * one shot and exits non-zero if ANY fail, so a developer (or a future CI step)
 * has a single command that proves the tree is green.
 *
 *   node scripts/verify.mjs            # run every gate
 *   node scripts/verify.mjs --quick    # skip the asset rasterisation gates
 *                                       # (atlas/tileset) for a faster inner loop
 *
 * Zero dependencies (Node built-ins only). Each gate runs in its own cwd; a gate
 * that exits non-zero is reported and fails the whole run, but the remaining
 * gates STILL run so one invocation surfaces every problem, not just the first.
 *
 * shared is built FIRST because the determinism + net-contract gates import
 * shared/dist, and the server tests consume it too — a stale dist would mask or
 * fake a failure.
 */

import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const SCRIPTS_DIR = dirname(fileURLToPath(import.meta.url));
const ROOT = join(SCRIPTS_DIR, '..');

const quick = process.argv.includes('--quick');

/**
 * @typedef {{ name: string, cmd: string, args: string[], cwd: string }} Gate
 */

/** Build shared FIRST — every downstream gate reads shared/dist. */
/** @type {Gate} */
const BUILD_SHARED = { name: 'build shared', cmd: 'npm', args: ['run', 'build'], cwd: join(ROOT, 'shared') };

/** @type {Gate[]} */
const GATES = [
  { name: 'shared tests', cmd: 'npm', args: ['test'], cwd: join(ROOT, 'shared') },
  { name: 'server tests', cmd: 'npm', args: ['test'], cwd: join(ROOT, 'server') },
  { name: 'client tests', cmd: 'npm', args: ['test'], cwd: join(ROOT, 'client') },
  { name: 'client typecheck', cmd: 'npx', args: ['tsc', '--noEmit'], cwd: join(ROOT, 'client') },
  { name: 'facing determinism', cmd: 'node', args: ['check-facing.js'], cwd: SCRIPTS_DIR },
  // Asset rasterisation gates — skipped under --quick (slower; rarely change).
  { name: 'atlas verify', cmd: 'node', args: ['verify-atlas.js'], cwd: SCRIPTS_DIR, asset: true },
  { name: 'tileset verify', cmd: 'node', args: ['verify-tileset.js'], cwd: SCRIPTS_DIR, asset: true },
  { name: 'audio drift', cmd: 'npm', args: ['run', 'audio:verify'], cwd: SCRIPTS_DIR },
];

/**
 * Run one gate, streaming its output. Returns true on exit 0.
 * @param {Gate} gate
 * @returns {boolean}
 */
function runGate(gate) {
  process.stdout.write(`\n── ${gate.name} ── (${gate.cmd} ${gate.args.join(' ')})\n`);
  const res = spawnSync(gate.cmd, gate.args, { cwd: gate.cwd, stdio: 'inherit', shell: false });
  if (res.error) {
    process.stdout.write(`   ✗ ${gate.name}: failed to launch (${res.error.message})\n`);
    return false;
  }
  const ok = res.status === 0;
  process.stdout.write(`   ${ok ? '✓' : '✗'} ${gate.name}: ${ok ? 'PASS' : `FAIL (exit ${res.status})`}\n`);
  return ok;
}

// 1) Build shared up front — a failure here aborts the run (downstream gates
//    would read a stale or missing dist and report misleading results).
if (!runGate(BUILD_SHARED)) {
  process.stdout.write('\nverify: shared build FAILED — aborting (downstream gates depend on shared/dist).\n');
  process.exit(1);
}

// 2) Run every gate; collect results so one invocation surfaces ALL failures.
const selected = GATES.filter((g) => !(quick && g.asset));
const failed = [];
for (const gate of selected) {
  if (!runGate(gate)) failed.push(gate.name);
}

if (quick) {
  process.stdout.write('\n(--quick: skipped the atlas/tileset asset gates)\n');
}

process.stdout.write('\n' + '═'.repeat(48) + '\n');
if (failed.length === 0) {
  process.stdout.write(`verify: ALL ${selected.length} gates PASSED ✓\n`);
  process.exit(0);
} else {
  process.stdout.write(`verify: ${failed.length}/${selected.length} gate(s) FAILED ✗ — ${failed.join(', ')}\n`);
  process.exit(1);
}
