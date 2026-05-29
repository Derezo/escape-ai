#!/usr/bin/env node
'use strict';

/**
 * Tile SVG generator  (TINS 2026 — The Caves of Steel)
 *
 * Emits one 32x32 SVG per registry tile into assets/tiles/svg/<NAME>.svg. ZERO
 * dependencies — pure string templates — so it runs on a clean clone with nothing
 * installed. The tile analogue of gen-sprites.js.
 *
 * Rasterising these SVGs into the packed tileset.png + tileset.json is a SEPARATE
 * step (build-tileset.js, which needs sharp). This split keeps the committed
 * runtime art (tileset.png) the source of truth and keeps THIS step zero-dep.
 *
 * Usage:
 *   node scripts/gen-tiles.js                 # generate all tile SVGs (skip existing)
 *   node scripts/gen-tiles.js --force         # overwrite existing SVGs
 *   node scripts/gen-tiles.js --only=GRASS_A  # only these tiles (comma list)
 *   node scripts/gen-tiles.js --help
 */

const fs = require('fs');
const path = require('path');

const contract = require('./tiles/contract');
const { svgDocTile } = require('./tiles/template-tile');
const { REGISTRY } = require('./tiles/registry');

const SVG_DIR = path.join(__dirname, '..', 'assets', 'tiles', 'svg');

function parseArgs() {
  const args = process.argv.slice(2);
  const onlyArg = args.find((a) => a.startsWith('--only='));
  return {
    help: args.includes('--help') || args.includes('-h'),
    force: args.includes('--force'),
    only: onlyArg ? onlyArg.split('=')[1].split(',').map((s) => s.trim()).filter(Boolean) : null,
  };
}

function showHelp() {
  console.log(`
Tile SVG generator (zero deps)

Usage:
  node scripts/gen-tiles.js [options]

Options:
  --force          Overwrite SVGs that already exist
  --only=A,B,C     Only generate these tile names
  --help, -h       Show this help

Output: assets/tiles/svg/<NAME>.svg
Next:   node scripts/build-tileset.js   (packs SVGs -> tileset.png + tileset.json; needs sharp)
`);
}

function main() {
  const opts = parseArgs();
  if (opts.help) {
    showHelp();
    return;
  }

  fs.mkdirSync(SVG_DIR, { recursive: true });

  // EMPTY (index 0) draws nothing — the packer leaves slot 0 blank. Skip writing a
  // file for it (an empty SVG would needlessly churn), but still validate builders.
  const tiles = contract.TILE_LIST.filter((t) => t.index !== 0).filter(
    (t) => !opts.only || opts.only.includes(t.name),
  );
  if (tiles.length === 0) {
    console.error(`No tiles matched ${opts.only ? `--only=${opts.only.join(',')}` : '(list empty)'}`);
    process.exitCode = 1;
    return;
  }

  // Fail loudly if any referenced builder is missing (an un-implemented tile).
  const missingBuilders = tiles.filter((t) => typeof REGISTRY[t.build] !== 'function');
  if (missingBuilders.length) {
    console.error(`Missing ${missingBuilders.length} builder(s):`);
    for (const t of missingBuilders.slice(0, 10)) console.error(`  ${t.name} -> registry.${t.build}() not found`);
    process.exitCode = 1;
    return;
  }

  let written = 0;
  let skipped = 0;
  for (const t of tiles) {
    const file = path.join(SVG_DIR, `${t.name}.svg`);
    if (fs.existsSync(file) && !opts.force) {
      skipped++;
      continue;
    }
    const inner = REGISTRY[t.build](t.name);
    fs.writeFileSync(file, svgDocTile(inner), 'utf8');
    written++;
  }

  console.log(`Done. ${written} written, ${skipped} skipped -> ${path.relative(process.cwd(), SVG_DIR)}/`);
  console.log(`(${tiles.length} drawable tiles; index 0 = EMPTY is a blank cell, no file.)`);
  console.log(`Next: node scripts/build-tileset.js`);
}

main();
