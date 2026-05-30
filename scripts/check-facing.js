#!/usr/bin/env node
'use strict';

/**
 * Determinism + correctness check for facingFromVec (TINS 2026 — Escape AI).
 *
 * No test framework in the repo; this mirrors the project's deterministic-replay
 * discipline (see the wanderStep checks in CHANGELOG 0.2.9) with a plain node
 * script. Asserts:
 *   - facingFromVec is a pure function (same args -> same dir, twice).
 *   - the 8 cardinal/ordinal unit vectors map to the expected Dir8.
 *   - a zero vector holds the previous facing.
 *   - a full angle sweep produces every direction at least once.
 * Exit code != 0 on any failure.
 *
 * Run AFTER building shared:  cd shared && npm run build  &&  node scripts/check-facing.js
 */

const path = require('path');

async function main() {
  // Resolve relative to THIS file so the check runs from any CWD.
  const { pathToFileURL } = require('url');
  const stepPath = path.join(__dirname, '..', 'shared', 'dist', 'step.js');
  const step = await import(pathToFileURL(stepPath).href);
  const { facingFromVec, DIR8 } = step;

  let failures = 0;
  const ok = (cond, msg) => { if (!cond) { console.error(`FAIL: ${msg}`); failures++; } };

  ok(typeof facingFromVec === 'function', 'facingFromVec is exported');
  ok(Array.isArray(DIR8) && DIR8.length === 8, 'DIR8 has 8 entries');

  // Screen space: +x east, +y south (down). Expected mappings:
  const cases = [
    [1, 0, 'e'],
    [1, 1, 'se'],
    [0, 1, 's'],
    [-1, 1, 'sw'],
    [-1, 0, 'w'],
    [-1, -1, 'nw'],
    [0, -1, 'n'],
    [1, -1, 'ne'],
  ];
  for (const [dx, dy, expected] of cases) {
    const got = facingFromVec(dx, dy);
    ok(got === expected, `facingFromVec(${dx},${dy}) === '${expected}' (got '${got}')`);
    // purity: same args twice
    ok(facingFromVec(dx, dy) === got, `facingFromVec(${dx},${dy}) is pure`);
  }

  // zero vector holds prev
  ok(facingFromVec(0, 0, 'n') === 'n', 'zero vector holds prev (n)');
  ok(facingFromVec(0, 0, 'sw') === 'sw', 'zero vector holds prev (sw)');
  ok(facingFromVec(0, 0) === 's', 'zero vector default is s');

  // full sweep covers every dir
  const seen = new Set();
  for (let a = 0; a < 360; a += 5) {
    const r = (a * Math.PI) / 180;
    seen.add(facingFromVec(Math.cos(r), Math.sin(r)));
  }
  for (const d of DIR8) ok(seen.has(d), `angle sweep produces '${d}'`);

  if (failures) {
    console.error(`\ncheck-facing: ${failures} failure(s).`);
    process.exit(1);
  }
  console.log('OK: facingFromVec — 8 mappings, purity, zero-holds-prev, full sweep all pass.');
}

main().catch((e) => { console.error(e); process.exit(1); });
