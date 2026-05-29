#!/usr/bin/env node
'use strict';

/**
 * Tileset verifier  (TINS 2026 — The Caves of Steel)
 *
 * The primary headless gate for the tile-art pipeline. Three checks:
 *
 *   1. DRIFT GATE (the load-bearing one): contract.TILE_LIST must mirror
 *      shared/src/tiles.ts EXACTLY — same names, same indices, same order, same
 *      solid/ysort flags. This is the ONE cross-language guarantee that the
 *      tileset PNG's grid position (= index) lines up with what world-gen emits.
 *
 *   2. COMPLETENESS: tileset.json exists, lists every registry tile at its
 *      contiguous index, the grid is 16-wide, and the image dims are
 *      ceil((MAX_INDEX+1)/16) rows × 32px.
 *
 *   3. PACKING SANITY (optional, sharp): tileset.png dims match the manifest, and
 *      a spot-check that a known opaque tile's cell is non-transparent.
 *
 * ZERO required dependencies (the sharp checks are skipped if sharp is absent —
 * the JSON + drift checks are the gate). Exit code is non-zero on any mismatch.
 *
 * Usage:
 *   node scripts/verify-tileset.js
 *   node scripts/verify-tileset.js --help
 */

const fs = require('fs');
const path = require('path');

const contract = require('./tiles/contract');

const TILES_DIR = path.join(__dirname, '..', 'assets', 'tiles');

if (process.argv.includes('--help') || process.argv.includes('-h')) {
  console.log('Verify the tile contract mirrors shared/src/tiles.ts AND tileset.json/png match it. Exit !=0 on mismatch.');
  process.exit(0);
}

function fail(msg) {
  console.error(`FAIL: ${msg}`);
  process.exitCode = 1;
}

/**
 * THE DRIFT GATE: diff contract.TILE_LIST against the parsed shared/src/tiles.ts.
 * Asserts identical length, and identical name+index+layer+solid+ysort at each
 * position (so order matches too).
 */
function checkMirror() {
  let shared;
  try {
    shared = contract.readSharedTiles();
  } catch (e) {
    fail(`could not parse shared/src/tiles.ts: ${e.message}`);
    return;
  }
  const mirror = contract.TILE_LIST;

  if (shared.length !== mirror.length) {
    fail(`tile count mismatch: shared/src/tiles.ts has ${shared.length}, contract.js has ${mirror.length}`);
  }

  const n = Math.max(shared.length, mirror.length);
  let mismatches = 0;
  for (let i = 0; i < n; i++) {
    const s = shared[i];
    const m = mirror[i];
    if (!s) { if (mismatches++ < 6) fail(`contract.js has extra tile at position ${i}: ${m.name}#${m.index}`); continue; }
    if (!m) { if (mismatches++ < 6) fail(`contract.js is missing tile at position ${i}: ${s.name}#${s.index}`); continue; }
    if (s.name !== m.name || s.index !== m.index) {
      if (mismatches++ < 6) fail(`position ${i}: shared has ${s.name}#${s.index}, contract has ${m.name}#${m.index}`);
      continue;
    }
    // Flags must agree too (these drive the renderer's layer/collision routing).
    if (s.layer !== m.layer) { if (mismatches++ < 6) fail(`${s.name}: layer '${s.layer}' (shared) != '${m.layer}' (contract)`); }
    if (s.solid !== m.solid) { if (mismatches++ < 6) fail(`${s.name}: solid ${s.solid} (shared) != ${m.solid} (contract)`); }
    if (s.ysort !== m.ysort) { if (mismatches++ < 6) fail(`${s.name}: ysort '${s.ysort}' (shared) != '${m.ysort}' (contract)`); }
  }

  // Sanity: indices contiguous 0..MAX in declaration order.
  for (let i = 0; i < mirror.length; i++) {
    if (mirror[i].index !== i) {
      fail(`contract index not contiguous: position ${i} is ${mirror[i].name}#${mirror[i].index} (expected index ${i})`);
      break;
    }
  }

  if (!process.exitCode) {
    console.log(`OK (drift gate): contract.js mirrors shared/src/tiles.ts — ${mirror.length} tiles, names+indices+flags+order match.`);
  }
}

/** Completeness: the manifest exists and matches the contract's grid + indices. */
function checkManifest() {
  const jsonPath = path.join(TILES_DIR, 'tileset.json');
  const pngPath = path.join(TILES_DIR, 'tileset.png');
  if (!fs.existsSync(jsonPath)) return fail(`missing ${path.relative(process.cwd(), jsonPath)} — run build-tileset.js`);
  if (!fs.existsSync(pngPath)) return fail(`missing ${path.relative(process.cwd(), pngPath)} — run build-tileset.js`);

  let m;
  try {
    m = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
  } catch (e) {
    return fail(`tileset.json is not valid JSON: ${e.message}`);
  }

  if (m.columns !== contract.COLS) fail(`columns ${m.columns} != ${contract.COLS}`);
  if (m.tileWidth !== contract.TILE_SIZE || m.tileHeight !== contract.TILE_SIZE) {
    fail(`tile size ${m.tileWidth}x${m.tileHeight} != ${contract.TILE_SIZE}x${contract.TILE_SIZE}`);
  }
  if (m.tilecount !== contract.MAX_INDEX + 1) fail(`tilecount ${m.tilecount} != ${contract.MAX_INDEX + 1}`);

  // Every registry tile present at exactly its index.
  if (!m.tiles || typeof m.tiles !== 'object') {
    fail('tileset.json has no `tiles` map');
  } else {
    let bad = 0;
    for (const t of contract.TILE_LIST) {
      if (m.tiles[t.name] !== t.index) {
        if (bad++ < 6) fail(`tile ${t.name}: manifest index ${m.tiles[t.name]} != contract index ${t.index}`);
      }
    }
    const extra = Object.keys(m.tiles).filter((k) => !contract.TILE_LIST.some((t) => t.name === k));
    if (extra.length) fail(`${extra.length} orphan tile(s) in manifest, e.g. ${extra.slice(0, 6).join(', ')}`);
  }

  // Expected image geometry.
  const rows = Math.ceil((contract.MAX_INDEX + 1) / contract.COLS);
  const expW = contract.COLS * contract.TILE_SIZE;
  const expH = rows * contract.TILE_SIZE;
  if (!m.meta || !m.meta.size) fail('tileset.json has no meta.size');
  else {
    if (m.meta.size.w !== expW || m.meta.size.h !== expH) fail(`meta.size ${m.meta.size.w}x${m.meta.size.h} != expected ${expW}x${expH}`);
  }
  if (expW > 2048 || expH > 2048) fail(`tileset ${expW}x${expH} exceeds 2048px — unsafe on weak GPUs / Android WebView`);

  return { expW, expH };
}

/** Optional sharp cross-check: PNG dims match, and a known opaque tile is drawn. */
async function checkPng(exp) {
  let sharp;
  try {
    sharp = require('sharp');
  } catch {
    console.log('(sharp absent — skipping the binary PNG check; JSON + drift checks are the gate.)');
    return;
  }
  const pngPath = path.join(TILES_DIR, 'tileset.png');
  const img = sharp(pngPath);
  const meta = await img.metadata();
  if (exp && (meta.width !== exp.expW || meta.height !== exp.expH)) {
    fail(`tileset.png ${meta.width}x${meta.height} != expected ${exp.expW}x${exp.expH}`);
  }
  if (!meta.hasAlpha) console.warn('WARN: tileset.png has no alpha channel (expected RGBA)');

  // Spot-check GRASS_A (index 1 → cell (1,0) = x32,y0): centre pixel must be opaque
  // and greenish (the grass base). Proves the index-slot packing landed art there.
  const grass = contract.TILE_LIST.find((t) => t.name === 'GRASS_A');
  if (grass) {
    const cx = (grass.index % contract.COLS) * contract.TILE_SIZE + contract.TILE_SIZE / 2;
    const cy = Math.floor(grass.index / contract.COLS) * contract.TILE_SIZE + contract.TILE_SIZE / 2;
    const { data } = await sharp(pngPath)
      .extract({ left: Math.floor(cx), top: Math.floor(cy), width: 1, height: 1 })
      .raw()
      .toBuffer({ resolveWithObject: true });
    const [r, g, b, a] = data;
    if (a < 200) fail(`GRASS_A cell (x${cx},y${cy}) is transparent (alpha ${a}) — packing/art problem`);
    else if (!(g > r && g > b)) fail(`GRASS_A cell (x${cx},y${cy}) is not greenish (rgb ${r},${g},${b}) — wrong tile in slot?`);
    else console.log(`OK (packing): GRASS_A@index ${grass.index} cell is opaque green (rgb ${r},${g},${b}, a ${a}).`);
  }
}

async function main() {
  checkMirror();
  const exp = checkManifest();
  await checkPng(exp);

  if (process.exitCode) {
    console.error(`\nTileset verification FAILED.`);
  } else {
    const rows = Math.ceil((contract.MAX_INDEX + 1) / contract.COLS);
    console.log(`\nOK: ${contract.TILE_LIST.length} tiles, ${contract.COLS}x${rows} grid, ${contract.COLS * contract.TILE_SIZE}x${rows * contract.TILE_SIZE}px. Contract mirrors shared, manifest + png match.`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
