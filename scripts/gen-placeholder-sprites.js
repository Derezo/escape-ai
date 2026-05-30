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
// Escape AI entities (see shared/src/types.ts EntityKind + animal
// species). Each gets a distinct shape + colour + a short label so they're
// tellable apart on screen before real art exists. The PhaserRenderer draws
// these as shapes today (no image load); these SVGs are the committed art
// reference and the drop-in target if/when the renderer loads sprites.

const SPRITES = [
  // Animal species — the player-controlled escapees. Shape + base tint per
  // species so they read at a glance (mirrors the renderer's species branch).
  { name: 'ape', shape: 'circle', fill: '#8d6e4f', label: 'AP' },
  { name: 'bird', shape: 'triangle', fill: '#4cc9f0', label: 'BD' },
  { name: 'rat', shape: 'diamond', fill: '#9aa3ad', label: 'RT' },
  { name: 'elephant', shape: 'square', fill: '#5a6b7a', label: 'EL' },
  // Keeper-robot — a steel-gray mechanical hexagon (clearly not a creature).
  { name: 'robot', shape: 'hexagon', fill: '#9aa3ad', label: 'BOT' },
  // Static room furniture.
  { name: 'pen', shape: 'square', fill: '#3a5a78', label: 'PEN' },
  { name: 'terminal', shape: 'square', fill: '#32d296', label: 'T' },
  { name: 'gate', shape: 'square', fill: '#e0a526', label: 'GATE' },
  // The Clipboard — a pale carryable disguise prop (a document, not a creature).
  { name: 'prop', shape: 'clipboard', fill: '#eef0f2', label: 'CLIP' },
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
    case 'hexagon':
      // Flat-top hexagon — reads "mechanical / robot", distinct from a creature.
      return `<polygon points="${polyPoints(c, c, r, 6, -Math.PI / 2)}" ${common}/>`;
    case 'clipboard': {
      // A document/clipboard: a tall rounded rect with a clip tab at the top, so
      // the carryable prop reads as an item rather than a creature.
      const w = r * 1.5;
      const h = r * 1.9;
      const x = c - w / 2;
      const y = c - h / 2;
      const clipW = w * 0.34;
      const clipH = h * 0.14;
      return (
        `<rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${w.toFixed(1)}" height="${h.toFixed(1)}" rx="${(s * 0.06).toFixed(1)}" ${common}/>` +
        `<rect x="${(c - clipW / 2).toFixed(1)}" y="${(y - clipH * 0.5).toFixed(1)}" width="${clipW.toFixed(1)}" height="${clipH.toFixed(1)}" rx="${(clipH * 0.4).toFixed(1)}" ${common}/>`
      );
    }
    default:
      return `<circle cx="${c}" cy="${c}" r="${r}" ${common}/>`;
  }
}

/** Points for a regular `n`-gon centred at (cx,cy), starting angle `start`. */
function polyPoints(cx, cy, radius, n, start) {
  const pts = [];
  for (let i = 0; i < n; i++) {
    const ang = start + (i * 2 * Math.PI) / n;
    pts.push(`${(cx + Math.cos(ang) * radius).toFixed(1)},${(cy + Math.sin(ang) * radius).toFixed(1)}`);
  }
  return pts.join(' ');
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
