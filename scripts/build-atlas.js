#!/usr/bin/env node
'use strict';

/**
 * Atlas builder  (TINS 2026 — Escape AI)
 *
 * Rasterises the per-frame SVGs (from gen-sprites.js) into ONE packed PNG plus a
 * Phaser "JSON Hash" atlas, written to assets/sprites/atlas.{png,json}. The
 * Phaser renderer loads these via this.load.atlas('creatures', ...).
 *
 * This is the ONLY script that needs `sharp` (a devDependency of scripts/). The
 * GAME never needs sharp to run — the atlas is committed — so a clean clone boots
 * on the committed PNG. Only a maintainer regenerating art runs this.
 *
 * Packing: a fixed grid of uniform 64x64 cells, frames in stable contract order
 * (registry order, then state/dir/frame). Both atlas dimensions are kept under
 * 2048 so the texture is safe in the Android WebView (Capacitor). Deterministic:
 * stable order + byte-stable input SVGs -> byte-stable atlas.png.
 *
 * Usage:
 *   node scripts/build-atlas.js            # build atlas.png + atlas.json
 *   node scripts/build-atlas.js --cols=24  # override grid columns
 *   node scripts/build-atlas.js --help
 */

const fs = require('fs');
const path = require('path');

const contract = require('./sprites/contract');
const { SPECIES } = require('./sprites/registry');

let sharp;
try {
  sharp = require('sharp');
} catch (err) {
  console.error('build-atlas.js needs `sharp`. Install it:  cd scripts && npm install');
  console.error('(The game itself does NOT need sharp — the committed atlas.png is enough.)');
  process.exit(1);
}

const SPRITES_DIR = path.join(__dirname, '..', 'assets', 'sprites');
const FRAMES_DIR = path.join(SPRITES_DIR, 'frames');
const CELL = contract.CANVAS; // 64
const MAX_ATLAS_DIM = 2048; // Capacitor / weak-GPU safe ceiling

function parseArgs() {
  const args = process.argv.slice(2);
  const colsArg = args.find((a) => a.startsWith('--cols='));
  return {
    help: args.includes('--help') || args.includes('-h'),
    cols: colsArg ? parseInt(colsArg.split('=')[1], 10) || 0 : 0,
  };
}

function showHelp() {
  console.log(`
Atlas builder (SVG frames -> packed PNG + JSON; needs sharp)

Usage:
  node scripts/build-atlas.js [options]

Options:
  --cols=<n>   Grid columns (default: auto, square-ish, kept under ${MAX_ATLAS_DIM}px)
  --help, -h   Show this help

Reads:  assets/sprites/frames/*.svg   (run gen-sprites.js first)
Writes: assets/sprites/atlas.png + assets/sprites/atlas.json  (Phaser JSON Hash)
`);
}

/** All frame keys for the whole registry, in stable contract order. */
function allFrameKeys() {
  const keys = [];
  for (const mod of SPECIES) keys.push(...contract.speciesFrameKeys(mod.species));
  return keys;
}

/** Pick a column count so both atlas dims fit under MAX_ATLAS_DIM, square-ish. */
function chooseCols(n, override) {
  if (override) return override;
  let cols = Math.ceil(Math.sqrt(n));
  // ensure height fits; grow cols (shrink height) until rows*CELL <= MAX
  while (Math.ceil(n / cols) * CELL > MAX_ATLAS_DIM) cols++;
  // and ensure width fits
  while (cols * CELL > MAX_ATLAS_DIM && cols > 1) cols--;
  return cols;
}

async function main() {
  const opts = parseArgs();
  if (opts.help) {
    showHelp();
    return;
  }

  if (SPECIES.length === 0) {
    console.error('Registry is empty — nothing to pack.');
    process.exit(1);
  }

  const keys = allFrameKeys();
  const missing = keys.filter((k) => !fs.existsSync(path.join(FRAMES_DIR, `${k}.svg`)));
  if (missing.length) {
    console.error(`Missing ${missing.length} frame SVG(s). Run: node scripts/gen-sprites.js`);
    console.error(`  e.g. ${missing.slice(0, 5).join(', ')}${missing.length > 5 ? ' ...' : ''}`);
    process.exit(1);
  }

  const cols = chooseCols(keys.length, opts.cols);
  const rows = Math.ceil(keys.length / cols);
  const width = cols * CELL;
  const height = rows * CELL;

  if (width > MAX_ATLAS_DIM || height > MAX_ATLAS_DIM) {
    console.warn(`WARNING: atlas ${width}x${height} exceeds ${MAX_ATLAS_DIM}px — may fail on weak GPUs / WebView.`);
  }

  // Rasterise each frame to a 64x64 transparent PNG and record its grid slot.
  const composites = [];
  const frames = {};
  for (let i = 0; i < keys.length; i++) {
    const key = keys[i];
    const left = (i % cols) * CELL;
    const top = Math.floor(i / cols) * CELL;
    const svgBuf = fs.readFileSync(path.join(FRAMES_DIR, `${key}.svg`));
    const cell = await sharp(svgBuf, { density: 96 })
      .resize(CELL, CELL, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
      .png()
      .toBuffer();
    composites.push({ input: cell, left, top });
    frames[key] = {
      frame: { x: left, y: top, w: CELL, h: CELL },
      rotated: false,
      trimmed: false,
      spriteSourceSize: { x: 0, y: 0, w: CELL, h: CELL },
      sourceSize: { w: CELL, h: CELL },
    };
  }

  await sharp({
    create: { width, height, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } },
  })
    .composite(composites)
    .png({ compressionLevel: 9 })
    .toFile(path.join(SPRITES_DIR, 'atlas.png'));

  const atlas = {
    frames,
    meta: {
      app: 'tins2026-build-atlas',
      image: 'atlas.png',
      format: 'RGBA8888',
      size: { w: width, h: height },
      scale: '1',
    },
  };
  fs.writeFileSync(path.join(SPRITES_DIR, 'atlas.json'), JSON.stringify(atlas, null, 0) + '\n', 'utf8');

  console.log(`Packed ${keys.length} frames -> ${cols}x${rows} grid, ${width}x${height}px`);
  console.log(`Wrote: assets/sprites/atlas.png + assets/sprites/atlas.json`);
  console.log(`Verify: node scripts/verify-atlas.js`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
