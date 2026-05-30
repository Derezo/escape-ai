#!/usr/bin/env node
'use strict';

/**
 * Sprite frame generator  (TINS 2026 — Escape AI)
 *
 * Emits one SVG file per (species, state, dir, frame) into assets/sprites/frames/.
 * ZERO dependencies — pure string templates — so it runs on a clean clone with
 * nothing installed. The 5 authored directions come from each species' build();
 * the 3 mirrored directions (w/sw/nw) are produced here by wrapping the authored
 * fragment in a horizontal-flip transform (so a species author implements 5 dirs
 * and gets 8 for free).
 *
 * Rasterising these SVGs into the packed atlas.png + atlas.json is a SEPARATE
 * step (build-atlas.js, which needs sharp). This split keeps the game's runtime
 * art (the committed atlas) buildable without sharp, and keeps THIS step zero-dep.
 *
 * Usage:
 *   node scripts/gen-sprites.js              # generate all species frames
 *   node scripts/gen-sprites.js --force      # overwrite existing frame files
 *   node scripts/gen-sprites.js --only=ape   # only these species (comma list)
 *   node scripts/gen-sprites.js --help
 */

const fs = require('fs');
const path = require('path');

const contract = require('./sprites/contract');
const { svgDoc, mirrorX } = require('./sprites/template');
const { SPECIES } = require('./sprites/registry');

const FRAMES_DIR = path.join(__dirname, '..', 'assets', 'sprites', 'frames');

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
Sprite frame generator (SVG, zero deps)

Usage:
  node scripts/gen-sprites.js [options]

Options:
  --force          Overwrite frame files that already exist
  --only=a,b,c     Only generate these species
  --help, -h       Show this help

Output: assets/sprites/frames/<species>_<state>_<dir>_<frame>.svg
Next:   node scripts/build-atlas.js   (packs frames -> atlas.png + atlas.json; needs sharp)
`);
}

/**
 * Build the inner SVG fragment for one species/state/dir/frame, applying the
 * mirror transform for the 3 mirrored directions.
 */
function fragmentFor(mod, state, dir, frame) {
  const authored = contract.MIRROR[dir]; // the source dir if `dir` is mirrored
  if (authored) {
    return mirrorX(mod.build(authored, state, frame));
  }
  return mod.build(dir, state, frame);
}

function main() {
  const opts = parseArgs();
  if (opts.help) {
    showHelp();
    return;
  }

  fs.mkdirSync(FRAMES_DIR, { recursive: true });

  const species = opts.only ? SPECIES.filter((m) => opts.only.includes(m.species)) : SPECIES;
  if (species.length === 0) {
    console.error(`No species matched ${opts.only ? `--only=${opts.only.join(',')}` : '(registry empty)'}`);
    process.exitCode = 1;
    return;
  }

  let written = 0;
  let skipped = 0;
  for (const mod of species) {
    for (const state of Object.keys(contract.STATES)) {
      for (const dir of contract.DIRECTIONS) {
        for (let frame = 0; frame < contract.STATES[state]; frame++) {
          const key = contract.frameKey(mod.species, state, dir, frame);
          const file = path.join(FRAMES_DIR, `${key}.svg`);
          if (fs.existsSync(file) && !opts.force) {
            skipped++;
            continue;
          }
          const svg = svgDoc(fragmentFor(mod, state, dir, frame));
          fs.writeFileSync(file, svg, 'utf8');
          written++;
        }
      }
    }
    console.log(`  ${mod.species.padEnd(10)} ${contract.EMITTED_FRAMES_PER_SPECIES} frames  [${mod.archetype}]`);
  }

  console.log(`\nDone. ${written} written, ${skipped} skipped -> ${path.relative(process.cwd(), FRAMES_DIR)}/`);
  console.log(`Next: node scripts/build-atlas.js`);
}

main();
