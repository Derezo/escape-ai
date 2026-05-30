#!/usr/bin/env node
'use strict';

/**
 * Atlas verifier  (TINS 2026 — Escape AI)
 *
 * The primary headless gate: asserts the packed atlas.json contains EXACTLY the
 * frame keys the contract+registry say it should — every expected key present,
 * no orphans, every cell 64x64 and inside the declared atlas size. This is what
 * proves the renderer's frameKey()/generateFrameNames calls will all resolve, so
 * a typo in a fan-out species file fails here instead of silently in the browser.
 *
 * ZERO dependencies (sharp metadata check is optional, skipped if absent).
 *
 * Usage:
 *   node scripts/verify-atlas.js
 *   node scripts/verify-atlas.js --help
 * Exit code is non-zero on any mismatch.
 */

const fs = require('fs');
const path = require('path');

const contract = require('./sprites/contract');
const { SPECIES } = require('./sprites/registry');

const SPRITES_DIR = path.join(__dirname, '..', 'assets', 'sprites');

if (process.argv.includes('--help') || process.argv.includes('-h')) {
  console.log('Verify assets/sprites/atlas.json against the contract+registry. Exit !=0 on mismatch.');
  process.exit(0);
}

function fail(msg) {
  console.error(`FAIL: ${msg}`);
  process.exitCode = 1;
}

function main() {
  const atlasPath = path.join(SPRITES_DIR, 'atlas.json');
  const pngPath = path.join(SPRITES_DIR, 'atlas.png');

  if (!fs.existsSync(atlasPath)) return fail(`missing ${path.relative(process.cwd(), atlasPath)} — run build-atlas.js`);
  if (!fs.existsSync(pngPath)) return fail(`missing ${path.relative(process.cwd(), pngPath)} — run build-atlas.js`);

  let atlas;
  try {
    atlas = JSON.parse(fs.readFileSync(atlasPath, 'utf8'));
  } catch (e) {
    return fail(`atlas.json is not valid JSON: ${e.message}`);
  }

  if (!atlas.frames || typeof atlas.frames !== 'object') return fail('atlas.json has no `frames` object (expected Phaser JSON Hash)');
  if (!atlas.meta || !atlas.meta.size) return fail('atlas.json has no `meta.size`');

  const expected = new Set();
  for (const mod of SPECIES) for (const k of contract.speciesFrameKeys(mod.species)) expected.add(k);
  const actual = new Set(Object.keys(atlas.frames));

  // Every expected key present?
  const missing = [...expected].filter((k) => !actual.has(k));
  if (missing.length) fail(`${missing.length} expected frame(s) missing, e.g. ${missing.slice(0, 6).join(', ')}`);

  // No orphan keys?
  const orphans = [...actual].filter((k) => !expected.has(k));
  if (orphans.length) fail(`${orphans.length} orphan frame(s) in atlas, e.g. ${orphans.slice(0, 6).join(', ')}`);

  // Geometry sane?
  const { w: W, h: H } = atlas.meta.size;
  let geomBad = 0;
  for (const [key, f] of Object.entries(atlas.frames)) {
    const r = f.frame;
    if (!r || r.w !== contract.CANVAS || r.h !== contract.CANVAS) { geomBad++; if (geomBad <= 3) fail(`${key}: cell is ${r && r.w}x${r && r.h}, expected ${contract.CANVAS}x${contract.CANVAS}`); }
    if (r && (r.x < 0 || r.y < 0 || r.x + r.w > W || r.y + r.h > H)) { geomBad++; if (geomBad <= 3) fail(`${key}: cell out of bounds (${r.x},${r.y}) in ${W}x${H}`); }
  }

  if (W > 2048 || H > 2048) fail(`atlas ${W}x${H} exceeds 2048px — unsafe on weak GPUs / Android WebView`);

  // Optional: sharp metadata cross-check.
  try {
    const sharp = require('sharp');
    // synchronous-ish: kick off and report, but don't block exit on it failing
    sharp(pngPath).metadata().then((m) => {
      if (m.width !== W || m.height !== H) console.warn(`WARN: atlas.png ${m.width}x${m.height} != meta.size ${W}x${H}`);
      if (!m.hasAlpha) console.warn('WARN: atlas.png has no alpha channel (expected RGBA)');
    }).catch(() => {});
  } catch {
    // sharp not installed — skip the binary check (the JSON checks are the gate).
  }

  if (process.exitCode) {
    console.error(`\nAtlas verification FAILED.`);
  } else {
    console.log(`OK: ${expected.size} frames across ${SPECIES.length} species, atlas ${W}x${H}px. All keys present, no orphans.`);
  }
}

main();
