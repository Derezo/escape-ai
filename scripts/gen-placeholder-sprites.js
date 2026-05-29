#!/usr/bin/env node
/**
 * Placeholder Sprite Generator  (TINS 2026 starter kit)
 *
 * Emits a handful of labelled placeholder sprites as **SVG files** into
 * assets/sprites/. SVG is chosen because it has ZERO dependencies — pure string
 * templates written with `fs` — so it runs on a clean clone with nothing
 * installed (`node scripts/gen-placeholder-sprites.js`).
 *
 * Phaser loads SVG fine via `this.load.svg(key, path, { width, height })`. If a
 * GRAPHICS/ART Rule-O-Matic rule demands rasterised PNGs (or you want sharp's
 * pixel-art pipeline like Modia's scripts/tiles), install `sharp` at hour 0 and
 * convert these SVGs — see docs/PLAYBOOK.md (GRAPHICS row).
 *
 * Ported & simplified from ~/Projects/Modia/scripts/generate-svg-icons.js
 * (which uses code-defined SVG generators) — stripped of game-specific content
 * (enemies/portraits) and of the sharp PNG step.
 *
 * Usage:
 *   node scripts/gen-placeholder-sprites.js            # generate all
 *   node scripts/gen-placeholder-sprites.js --force    # overwrite existing
 *   node scripts/gen-placeholder-sprites.js --size=128 # change canvas size
 *   node scripts/gen-placeholder-sprites.js --help
 */

'use strict';

const fs = require('fs');
const path = require('path');

const OUTPUT_DIR = path.join(__dirname, '..', 'assets', 'sprites');

// --- args -------------------------------------------------------------------

function parseArgs() {
  const args = process.argv.slice(2);
  const sizeArg = args.find((a) => a.startsWith('--size='));
  return {
    help: args.includes('--help') || args.includes('-h'),
    force: args.includes('--force'),
    size: sizeArg ? parseInt(sizeArg.split('=')[1], 10) || 64 : 64,
  };
}

function showHelp() {
  console.log(`
Placeholder Sprite Generator (SVG, zero deps)

Usage:
  node scripts/gen-placeholder-sprites.js [options]

Options:
  --force        Overwrite sprites that already exist
  --size=<px>    Canvas size in px (square; default 64)
  --help, -h     Show this help

Output: assets/sprites/*.svg
`);
}

// --- sprite catalogue -------------------------------------------------------
// Game-agnostic shapes. Add/rename here at hour 0 to match the genre rule.
// Each gets a distinct shape + colour + a short label so they're tellable apart
// on screen before real art exists.

const SPRITES = [
  { name: 'player', shape: 'circle', fill: '#4cc9f0', label: 'P1' },
  { name: 'player2', shape: 'circle', fill: '#f72585', label: 'P2' },
  { name: 'enemy', shape: 'triangle', fill: '#e63946', label: 'E' },
  { name: 'item', shape: 'diamond', fill: '#ffd166', label: '!' },
  { name: 'wall', shape: 'square', fill: '#6c757d', label: '#' },
  { name: 'goal', shape: 'star', fill: '#06d6a0', label: '*' },
];

// --- shape path builders ----------------------------------------------------
// All take the canvas size `s` and return an inner SVG fragment. A small inset
// keeps shapes off the very edge so a stroke is visible.

function shapeFragment(shape, s, fill) {
  const c = s / 2; // center
  const r = s * 0.38; // primary radius
  const stroke = '#0b0c10';
  const sw = Math.max(2, Math.round(s * 0.04));
  const common = `fill="${fill}" stroke="${stroke}" stroke-width="${sw}" stroke-linejoin="round"`;

  switch (shape) {
    case 'circle':
      return `<circle cx="${c}" cy="${c}" r="${r}" ${common}/>`;
    case 'square': {
      const x = c - r;
      const side = r * 2;
      return `<rect x="${x}" y="${x}" width="${side}" height="${side}" rx="${s * 0.08}" ${common}/>`;
    }
    case 'triangle': {
      const pts = [
        [c, c - r],
        [c + r, c + r],
        [c - r, c + r],
      ];
      return `<polygon points="${pts.map((p) => p.join(',')).join(' ')}" ${common}/>`;
    }
    case 'diamond': {
      const pts = [
        [c, c - r],
        [c + r, c],
        [c, c + r],
        [c - r, c],
      ];
      return `<polygon points="${pts.map((p) => p.join(',')).join(' ')}" ${common}/>`;
    }
    case 'star':
      return `<polygon points="${starPoints(c, c, r, r * 0.45, 5)}" ${common}/>`;
    default:
      return `<circle cx="${c}" cy="${c}" r="${r}" ${common}/>`;
  }
}

function starPoints(cx, cy, outer, inner, points) {
  const pts = [];
  const step = Math.PI / points;
  for (let i = 0; i < points * 2; i++) {
    const rad = i % 2 === 0 ? outer : inner;
    const ang = i * step - Math.PI / 2;
    pts.push(`${(cx + Math.cos(ang) * rad).toFixed(1)},${(cy + Math.sin(ang) * rad).toFixed(1)}`);
  }
  return pts.join(' ');
}

function buildSvg({ shape, fill, label }, s) {
  const fontSize = Math.round(s * 0.28);
  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${s}" height="${s}" viewBox="0 0 ${s} ${s}">
  <rect width="${s}" height="${s}" fill="none"/>
  ${shapeFragment(shape, s, fill)}
  <text x="${s / 2}" y="${s / 2}" font-family="monospace" font-size="${fontSize}"
        font-weight="bold" fill="#0b0c10" text-anchor="middle"
        dominant-baseline="central">${label}</text>
</svg>
`;
}

// --- main -------------------------------------------------------------------

function main() {
  const opts = parseArgs();
  if (opts.help) {
    showHelp();
    return;
  }

  fs.mkdirSync(OUTPUT_DIR, { recursive: true });

  let written = 0;
  let skipped = 0;
  for (const sprite of SPRITES) {
    const file = path.join(OUTPUT_DIR, `${sprite.name}.svg`);
    if (fs.existsSync(file) && !opts.force) {
      console.log(`  skip   ${sprite.name}.svg (exists; --force to overwrite)`);
      skipped++;
      continue;
    }
    fs.writeFileSync(file, buildSvg(sprite, opts.size), 'utf8');
    console.log(`  write  ${sprite.name}.svg  [${sprite.shape} ${sprite.fill}]`);
    written++;
  }

  console.log(`\nDone. ${written} written, ${skipped} skipped -> ${path.relative(process.cwd(), OUTPUT_DIR)}/`);
}

main();
