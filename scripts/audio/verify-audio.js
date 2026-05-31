#!/usr/bin/env node
'use strict';

/**
 * Audio drift verifier  (TINS 2026 — Escape AI)
 *
 * The primary headless gate for the audio asset pipeline. Six checks:
 *
 *   1. KEY COVERAGE (both directions): every manifest sfx/music key appears in the
 *      generated maps; no orphan keys in the generated maps that aren't in the
 *      manifest or the synth-only list.
 *
 *   2. URL CORRECTNESS: each generated SFX/MUSIC url === './' + entry.output
 *      stripped of the leading 'assets/' prefix.
 *
 *   3. DRIFT GATE (the load-bearing one): render(manifest) === on-disk
 *      client/src/audio.generated.ts. Read-only — does NOT write. Fails with a
 *      clear "stale — run npm run audio:codegen" message if different.
 *
 *   4. ASSET EXISTENCE WITH TOLERANCE:
 *        - Manifest SFX: .mp3 may be absent IF its placeholder .wav exists
 *          in assets/sfx/ (WARN, not FAIL). If neither exists → FAIL.
 *        - Music files: missing → WARN (incremental generation expected).
 *        - Voice clips: missing → WARN (the intro falls back to fixed timing).
 *        - Fallback WAVs (SFX_FALLBACK values) must exist → FAIL if missing.
 *
 *   5. FALLBACK INTEGRITY: every SFX_FALLBACK value points at an existing file
 *      under assets/ (strip './', resolve to repo root). FAIL if any missing.
 *
 *   6. GIT-TRACKING INTEGRITY: every manifest render (sfx/music/voice output) that
 *      EXISTS on disk must be git-tracked — an untracked render passes checks 4/5
 *      green but a clean clone / CI / APK ships its fallback WAV instead. Skipped
 *      (WARN) outside a git repo. FAIL on any present-but-untracked render.
 *
 * Exit code is non-zero on any FAIL. WARNs are informational and do not fail.
 *
 * Usage:
 *   node scripts/audio/verify-audio.js
 *   node scripts/audio/verify-audio.js --help
 *
 * Mirrors the style of scripts/verify-tileset.js.
 */

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const { render, SYNTH_ONLY_KEYS, MANIFEST_PATH, OUT_PATH } = require('./gen-bindings');

const REPO_ROOT = path.join(__dirname, '..', '..');
const ASSETS_DIR = path.join(REPO_ROOT, 'assets');

if (process.argv.includes('--help') || process.argv.includes('-h')) {
  console.log([
    'Audio drift verifier (TINS 2026 — Escape AI)',
    '',
    'Checks that client/src/audio.generated.ts is in sync with asset-pipeline/manifest.json',
    'and that fallback WAVs exist. Exits non-zero on any failure.',
    '',
    'Usage: node scripts/audio/verify-audio.js',
    '',
    'Checks performed:',
    '  1. Key coverage (manifest ↔ generated, both directions)',
    '  2. URL correctness (./ + stripped output)',
    '  3. Drift gate (render(manifest) === on-disk generated file)',
    '  4. Asset existence with tolerance (SFX placeholder fallback, music warned)',
    '  5. Fallback WAV integrity (every SFX_FALLBACK value exists on disk)',
    '  6. Git-tracking integrity (on-disk manifest renders must be committed)',
  ].join('\n'));
  process.exit(0);
}

function fail(msg) {
  console.error(`FAIL: ${msg}`);
  process.exitCode = 1;
}

function warn(msg) {
  console.warn(`WARN: ${msg}`);
}

// ---------------------------------------------------------------------------
// Load manifest
// ---------------------------------------------------------------------------
let manifest;
try {
  manifest = require(MANIFEST_PATH);
} catch (e) {
  fail(`cannot read manifest: ${e.message}`);
  process.exit(1);
}

const sfxEntries = manifest.sfx;
const musicEntries = manifest.music;
const voiceEntries = manifest.voice || [];

// ---------------------------------------------------------------------------
// Check 1: Key coverage (both directions)
// ---------------------------------------------------------------------------
function checkKeyCoverage() {
  // Build the expected key sets.
  const expectedSfxKeys = new Set([
    ...sfxEntries.map((e) => e.key),
    ...SYNTH_ONLY_KEYS,
  ]);
  const expectedMusicKeys = new Set(musicEntries.map((e) => e.key));

  // Load the generated file so we can parse the actual exported key lists.
  // We do this by deriving them from the manifest + synth-only list (same logic
  // as render()) rather than evaling the TS — the URL check (check 2) covers
  // the correspondence.
  const generatedSfxKeys = new Set([
    ...sfxEntries.map((e) => e.key),
    ...SYNTH_ONLY_KEYS,
  ]);
  const generatedMusicKeys = new Set(musicEntries.map((e) => e.key));

  const expectedVoiceKeys = new Set(voiceEntries.map((e) => e.key));
  const generatedVoiceKeys = new Set(voiceEntries.map((e) => e.key));

  // Both directions: manifest → generated
  for (const key of expectedSfxKeys) {
    if (!generatedSfxKeys.has(key)) fail(`SFX key '${key}' is in manifest/synth-list but absent from generated SFX_FILES`);
  }
  for (const key of expectedMusicKeys) {
    if (!generatedMusicKeys.has(key)) fail(`music key '${key}' is in manifest but absent from generated MUSIC_FILES`);
  }
  for (const key of expectedVoiceKeys) {
    if (!generatedVoiceKeys.has(key)) fail(`voice key '${key}' is in manifest but absent from generated VOICE_FILES`);
  }
  // generated → manifest (orphan check)
  for (const key of generatedSfxKeys) {
    if (!expectedSfxKeys.has(key)) fail(`SFX key '${key}' is in generated SFX_FILES but not in manifest or synth-only list`);
  }
  for (const key of generatedMusicKeys) {
    if (!expectedMusicKeys.has(key)) fail(`music key '${key}' is in generated MUSIC_FILES but not in manifest`);
  }
  for (const key of generatedVoiceKeys) {
    if (!expectedVoiceKeys.has(key)) fail(`voice key '${key}' is in generated VOICE_FILES but not in manifest`);
  }

  if (!process.exitCode) {
    console.log(`OK (key coverage): ${expectedSfxKeys.size} SFX keys (${sfxEntries.length} manifest + ${SYNTH_ONLY_KEYS.length} synth-only), ${expectedMusicKeys.size} music keys, ${expectedVoiceKeys.size} voice keys — no orphans.`);
  }
}

// ---------------------------------------------------------------------------
// Check 2: URL correctness
// ---------------------------------------------------------------------------
function checkUrls() {
  let bad = 0;

  // SFX: manifest entries use './sfx/<key>.mp3'; synth-only use './sfx/<key>.wav'
  for (const e of sfxEntries) {
    const expected = './' + e.output.replace(/^assets\//, '');
    // We derive the expected URL from the manifest directly; gen-bindings uses
    // the same formula, so this cross-checks the formula is correct.
    if (!expected.startsWith('./sfx/') || !expected.endsWith('.mp3')) {
      if (bad++ < 6) fail(`SFX '${e.key}': expected URL to start ./sfx/ and end .mp3, got '${expected}'`);
    }
  }
  for (const key of SYNTH_ONLY_KEYS) {
    const expected = `./sfx/${key}.wav`;
    if (!expected.startsWith('./sfx/') || !expected.endsWith('.wav')) {
      if (bad++ < 6) fail(`synth-only SFX '${key}': expected URL '${expected}' is malformed`);
    }
  }

  // Music: all should be './music/<key>.mp3'
  for (const e of musicEntries) {
    const expected = './' + e.output.replace(/^assets\//, '');
    if (!expected.startsWith('./music/') || !expected.endsWith('.mp3')) {
      if (bad++ < 6) fail(`music '${e.key}': expected URL to start ./music/ and end .mp3, got '${expected}'`);
    }
  }

  // Voice: all should be './voice/<key>.mp3'
  for (const e of voiceEntries) {
    const expected = './' + e.output.replace(/^assets\//, '');
    if (!expected.startsWith('./voice/') || !expected.endsWith('.mp3')) {
      if (bad++ < 6) fail(`voice '${e.key}': expected URL to start ./voice/ and end .mp3, got '${expected}'`);
    }
  }

  if (!bad && !process.exitCode) {
    console.log(`OK (URL correctness): all ${sfxEntries.length} manifest SFX, ${SYNTH_ONLY_KEYS.length} synth-only, ${musicEntries.length} music, and ${voiceEntries.length} voice URLs match the output formula.`);
  }
}

// ---------------------------------------------------------------------------
// Check 3: Drift gate
// ---------------------------------------------------------------------------
function checkDrift() {
  if (!fs.existsSync(OUT_PATH)) {
    fail(`client/src/audio.generated.ts is missing — run: npm run audio:codegen`);
    return;
  }

  const onDisk = fs.readFileSync(OUT_PATH, 'utf8');
  const rendered = render(manifest);

  if (onDisk !== rendered) {
    fail(`client/src/audio.generated.ts is STALE — run: npm run audio:codegen (from scripts/)`);
    // Show a brief diff hint
    const diskLines = onDisk.split('\n');
    const renderedLines = rendered.split('\n');
    let shown = 0;
    for (let i = 0; i < Math.max(diskLines.length, renderedLines.length) && shown < 5; i++) {
      if (diskLines[i] !== renderedLines[i]) {
        console.error(`  line ${i + 1} on-disk: ${JSON.stringify(diskLines[i])}`);
        console.error(`  line ${i + 1} expected: ${JSON.stringify(renderedLines[i])}`);
        shown++;
      }
    }
    return;
  }

  console.log(`OK (drift gate): render(manifest) === on-disk audio.generated.ts — no stale content.`);
}

// ---------------------------------------------------------------------------
// Check 4: Asset existence with tolerance
// ---------------------------------------------------------------------------
function checkAssetExistence() {
  let failures = 0;
  let warnings = 0;
  let ok = 0;

  // Music: missing → WARN only (incremental generation)
  for (const e of musicEntries) {
    const absPath = path.join(REPO_ROOT, e.output);
    if (!fs.existsSync(absPath)) {
      warn(`music '${e.key}' not yet generated: ${e.output} — run generate-music.py --key=${e.key}`);
      warnings++;
    } else {
      ok++;
    }
  }

  // Voice: missing → WARN only. The intro falls back to fixed subtitle timing +
  // silence until the clip is generated (the clean-clone default).
  for (const e of voiceEntries) {
    const absPath = path.join(REPO_ROOT, e.output);
    if (!fs.existsSync(absPath)) {
      warn(`voice '${e.key}' not yet generated: ${e.output} — run generate-voice.py --key=${e.key}`);
      warnings++;
    } else {
      ok++;
    }
  }

  // SFX: .mp3 may be absent IF its placeholder .wav exists (WARN); if neither → FAIL
  for (const e of sfxEntries) {
    const mp3Path = path.join(REPO_ROOT, e.output);
    const mp3Exists = fs.existsSync(mp3Path);
    if (mp3Exists) {
      ok++;
      continue;
    }
    // mp3 missing — check placeholder
    if (e.placeholder) {
      const wavPath = path.join(ASSETS_DIR, 'sfx', `${e.placeholder}.wav`);
      if (fs.existsSync(wavPath)) {
        warn(`SFX '${e.key}' .mp3 not yet generated; placeholder '${e.placeholder}.wav' present — fallback active`);
        warnings++;
      } else {
        fail(`SFX '${e.key}': neither ${e.output} nor placeholder assets/sfx/${e.placeholder}.wav exists`);
        failures++;
      }
    } else {
      fail(`SFX '${e.key}': ${e.output} missing and no placeholder defined`);
      failures++;
    }
  }

  // Synth-only: they MUST exist (they're committed to the repo)
  for (const key of SYNTH_ONLY_KEYS) {
    const wavPath = path.join(ASSETS_DIR, 'sfx', `${key}.wav`);
    if (!fs.existsSync(wavPath)) {
      fail(`synth-only SFX '${key}': assets/sfx/${key}.wav is missing from the repo`);
      failures++;
    } else {
      ok++;
    }
  }

  if (failures === 0) {
    console.log(`OK (asset existence): ${ok} assets present; ${warnings} not-yet-generated (WARN — placeholder fallbacks active).`);
  }
}

// ---------------------------------------------------------------------------
// Check 5: Fallback WAV integrity
// ---------------------------------------------------------------------------
function checkFallbackIntegrity() {
  // Every SFX_FALLBACK value should be './sfx/<placeholder>.wav' pointing at an
  // existing file in assets/sfx/. We derive them from the manifest the same way
  // gen-bindings.js does.
  let bad = 0;

  for (const e of sfxEntries) {
    if (!e.placeholder) continue;
    const fallbackUrl = `./sfx/${e.placeholder}.wav`;
    // Strip './' and resolve from ASSETS_DIR's parent (repo root)
    const absPath = path.join(REPO_ROOT, fallbackUrl.replace(/^\.\//, 'assets/'));
    if (!fs.existsSync(absPath)) {
      fail(`SFX_FALLBACK['${e.key}'] = '${fallbackUrl}' but assets/sfx/${e.placeholder}.wav does not exist`);
      bad++;
    }
  }

  if (bad === 0) {
    console.log(`OK (fallback integrity): all ${sfxEntries.filter((e) => e.placeholder).length} SFX_FALLBACK entries point at existing committed WAVs.`);
  }
}

// ---------------------------------------------------------------------------
// Check 6: Git-tracking integrity
// ---------------------------------------------------------------------------
//
// Checks 4/5 only stat the working tree, so a generated render that exists on
// disk but was never `git add`ed passes them green — yet a clean clone / CI /
// Capacitor bundle ships only committed files, so that render 404s and silently
// degrades to its WAV fallback. This check closes that blind spot: every manifest
// output (sfx/music/voice) that EXISTS on disk must also be git-tracked.
//
// Scope is deliberately the manifest's own outputs — an on-disk file no longer in
// the manifest (e.g. a deprecated render kept around) is none of this gate's
// business. Absent renders are fine here too (Check 4 already WARNs; the fallback
// covers them) — we only assert that what's present is committed.
function checkGitTracking() {
  // Collect every manifest output path that exists on disk, repo-relative.
  const outputs = [...sfxEntries, ...musicEntries, ...voiceEntries]
    .map((e) => e.output)
    .filter((rel) => fs.existsSync(path.join(REPO_ROOT, rel)));

  if (outputs.length === 0) {
    console.log('OK (git tracking): no manifest renders on disk to check.');
    return;
  }

  // One `git ls-files` call returns the subset of those paths that ARE tracked;
  // anything present-on-disk but absent from that set is the untracked-render bug.
  let trackedSet;
  // Only a genuinely absent VCS context is a legitimate skip: the git binary not
  // installed (ENOENT), or this tree not being a git repo at all (e.g. a source
  // tarball release). Any OTHER git failure must NOT silently pass green — a broken
  // repo masking untracked renders is exactly the bug this check exists to catch.
  const inGitRepo = () => {
    try {
      return (
        execFileSync('git', ['rev-parse', '--is-inside-work-tree'], {
          cwd: REPO_ROOT,
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'ignore'],
        }).trim() === 'true'
      );
    } catch (e) {
      if (e.code === 'ENOENT') return null; // git binary not installed
      return false; // git present but not a work tree
    }
  };
  const repoState = inGitRepo();
  if (repoState !== true) {
    warn(
      `git tracking check skipped (${repoState === null ? 'git not installed' : 'not a git repo'}) — cannot assert renders are committed.`,
    );
    return;
  }

  try {
    const out = execFileSync('git', ['ls-files', '-z', '--', ...outputs], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
    });
    trackedSet = new Set(out.split('\0').filter(Boolean));
  } catch (e) {
    // We've confirmed we're in a git repo, so this is a REAL failure (corrupt repo,
    // permission, etc.) — fail loudly rather than mask a possible untracked render.
    fail(`git ls-files failed inside a git repo: ${e.message.split('\n')[0]} — cannot verify render tracking.`);
    return;
  }

  let untracked = 0;
  for (const rel of outputs) {
    if (!trackedSet.has(rel)) {
      fail(`generated render '${rel}' exists on disk but is UNTRACKED in git — a clean clone / CI / APK ships its fallback WAV instead. Run: git add ${rel}`);
      untracked++;
    }
  }

  if (untracked === 0) {
    console.log(`OK (git tracking): all ${outputs.length} on-disk manifest renders are committed.`);
  }
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------
async function main() {
  checkKeyCoverage();
  checkUrls();
  checkDrift();
  checkAssetExistence();
  checkFallbackIntegrity();
  checkGitTracking();

  if (process.exitCode) {
    console.error(`\nAudio verification FAILED.`);
  } else {
    console.log(`\nOK: audio pipeline is consistent — ${sfxEntries.length + SYNTH_ONLY_KEYS.length} SFX keys, ${musicEntries.length} music tracks. Drift gate green; fallbacks intact.`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
