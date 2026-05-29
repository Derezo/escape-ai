#!/usr/bin/env node
'use strict';

/**
 * Tileset builder  (TINS 2026 — The Caves of Steel)
 *
 * Rasterises the per-tile SVGs (from gen-tiles.js) into ONE packed PNG plus a
 * small JSON manifest, written to assets/tiles/tileset.{png,json}. The Phaser
 * renderer loads tileset.png and uses each cell directly (slot index === tile
 * index), so this packing MUST match client/src/render/phaser.ts buildWorld().
 *
 * PACKING (LOCKED — the renderer's spec):
 *   - 16 columns, 32px cells, NO margin/spacing.
 *   - Cell i holds the tile whose index === i. Iterating contract.TILE_LIST in
 *     index order makes slot === index by construction; index 0 (EMPTY) is left a
 *     blank transparent cell (Phaser treats tile index 0 as no-tile).
 *   - Grid is 16 wide × ceil((MAX_INDEX+1)/16) tall = ~512×320px. Tiny.
 *
 * This is the ONLY tile script that needs `sharp` (a devDependency of scripts/).
 * The GAME never needs sharp — the committed tileset.png is the runtime truth, so
 * a clean clone boots on it. Deterministic: stable index order + byte-stable input
 * SVGs -> stable tileset.png (librsvg rasterisation is the only wobble; see
 * verify step / report).
 *
 * Usage:
 *   node scripts/build-tileset.js
 *   node scripts/build-tileset.js --help
 */

const fs = require('fs');
const path = require('path');

const contract = require('./tiles/contract');

let sharp;
try {
  sharp = require('sharp');
} catch (err) {
  console.error('build-tileset.js needs `sharp`. Install it:  cd scripts && npm install');
  console.error('(The game itself does NOT need sharp — the committed tileset.png is enough.)');
  process.exit(1);
}

const TILES_DIR = path.join(__dirname, '..', 'assets', 'tiles');
const SVG_DIR = path.join(TILES_DIR, 'svg');
const CELL = contract.TILE_SIZE; // 32
const COLS = contract.COLS; // 16
const DENSITY = 192; // 6x of 32 → crisp 32px raster
const MAX_DIM = 2048; // Capacitor / weak-GPU safe ceiling (we're nowhere near it)

if (process.argv.includes('--help') || process.argv.includes('-h')) {
  console.log(`
Tileset builder (tile SVGs -> packed PNG + JSON manifest; needs sharp)

Reads:  assets/tiles/svg/<NAME>.svg   (run gen-tiles.js first)
Writes: assets/tiles/tileset.png + assets/tiles/tileset.json
Packing: ${COLS}-col grid, ${CELL}px cells, slot index === tile index (0 = blank).
`);
  process.exit(0);
}

async function main() {
  const maxIndex = contract.MAX_INDEX;
  const rows = Math.ceil((maxIndex + 1) / COLS);
  const width = COLS * CELL;
  const height = rows * CELL;

  if (width > MAX_DIM || height > MAX_DIM) {
    console.warn(`WARNING: tileset ${width}x${height} exceeds ${MAX_DIM}px — may fail on weak GPUs / WebView.`);
  }

  // Every drawable tile (index != 0) needs an SVG present.
  const drawable = contract.TILE_LIST.filter((t) => t.index !== 0);
  const missing = drawable.filter((t) => !fs.existsSync(path.join(SVG_DIR, `${t.name}.svg`)));
  if (missing.length) {
    console.error(`Missing ${missing.length} tile SVG(s). Run: node scripts/gen-tiles.js --force`);
    console.error(`  e.g. ${missing.slice(0, 6).map((t) => t.name).join(', ')}${missing.length > 6 ? ' ...' : ''}`);
    process.exit(1);
  }

  // Rasterise each drawable tile to a CELL×CELL transparent PNG at its index slot.
  const composites = [];
  const tileMap = {}; // NAME -> index
  for (const t of contract.TILE_LIST) {
    tileMap[t.name] = t.index;
    if (t.index === 0) continue; // blank slot
    const left = (t.index % COLS) * CELL;
    const top = Math.floor(t.index / COLS) * CELL;
    const svgBuf = fs.readFileSync(path.join(SVG_DIR, `${t.name}.svg`));
    const cell = await sharp(svgBuf, { density: DENSITY })
      .resize(CELL, CELL, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
      .png()
      .toBuffer();
    composites.push({ input: cell, left, top });
  }

  await sharp({
    create: { width, height, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } },
  })
    .composite(composites)
    .png({ compressionLevel: 9 })
    .toFile(path.join(TILES_DIR, 'tileset.png'));

  const manifest = {
    image: 'tileset.png',
    tileWidth: CELL,
    tileHeight: CELL,
    columns: COLS,
    tilecount: maxIndex + 1, // includes the blank EMPTY slot 0
    tiles: tileMap, // NAME -> index (= grid slot)
    meta: {
      app: 'tins2026-build-tileset',
      size: { w: width, h: height },
      note: 'slot index === tile index; 16-col grid, 32px cells, no padding; index 0 = blank',
    },
  };
  fs.writeFileSync(path.join(TILES_DIR, 'tileset.json'), JSON.stringify(manifest, null, 0) + '\n', 'utf8');

  console.log(`Packed ${composites.length} tiles -> ${COLS}x${rows} grid, ${width}x${height}px (slot index === tile index)`);
  console.log(`Wrote: assets/tiles/tileset.png + assets/tiles/tileset.json`);
  console.log(`Verify: node scripts/verify-tileset.js`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
