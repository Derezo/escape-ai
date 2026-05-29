'use strict';

/**
 * THE LOCKED SPRITE CONTRACT  (TINS 2026 — The Caves of Steel)
 *
 * Every dimension, name, and frame-key the whole sprite library must agree on
 * lives here, exactly once. The generator (gen-sprites.js), the atlas writer
 * (build-atlas.js), the verifier (verify-atlas.js), AND the Phaser renderer all
 * derive their frame keys from `frameKey()` below — so a contract change is a
 * one-line edit and 14 parallel species builders stay consistent by construction.
 *
 * DO NOT EDIT once the reference animal (ape) is verified and the fan-out begins.
 * Species builders depend on these constants being stable.
 *
 * Coordinate system (per frame):
 *   - 64 x 64 px canvas, viewBox "0 0 64 64".
 *   - The sprite's ground-contact center of mass sits at the canvas CENTER
 *     (32, 32) — the renderer draws entities at (e.x, e.y) with origin 0.5, so
 *     a sprite's visual center must be (32, 32). Feet hang toward y~=52, head
 *     reaches toward y~=14.
 *   - Keep all ink within a 4px inset (x,y in [4, 60]) so antialiasing / strokes
 *     never clip at the frame edge.
 */

/** Canvas side length in px (square). */
const CANVAS = 64;
/** Center of the canvas — the sprite anchor / ground-contact point. */
const CENTER = CANVAS / 2;
/** SVG viewBox string for one frame. */
const VIEWBOX = `0 0 ${CANVAS} ${CANVAS}`;
/** Safe-area inset (px) — keep ink inside [INSET, CANVAS - INSET]. */
const INSET = 4;

/**
 * The 8 facing directions, in screen space (y-down). Clockwise from south.
 * These strings ARE the `dir` segment of every frame key and every renderer
 * animation key — they must match shared/src/types.ts Dir8 exactly.
 */
const DIRECTIONS = ['s', 'se', 'e', 'ne', 'n', 'nw', 'w', 'sw'];

/**
 * The 5 directions a species author actually draws. The other 3 are produced by
 * the pipeline as horizontal mirrors (see MIRROR) — so a builder implements 5
 * directions and gets 8 for free. CRITICAL: never bake left/right-unique detail
 * into e/se/ne or it flips wrong when mirrored.
 */
const AUTHORED_DIRS = ['s', 'n', 'e', 'se', 'ne'];

/**
 * Mirrored direction -> the authored direction it is a horizontal flip of. The
 * generator wraps the authored fragment in a flip transform to emit these.
 */
const MIRROR = { w: 'e', sw: 'se', nw: 'ne' };

/**
 * Animation states and their frame counts.
 *   - idle: subtle breathing/bob (frame 0 neutral, frame 1 raised).
 *   - walk: one full gait cycle, phase = frame / 4.
 */
const STATES = { idle: 2, walk: 4 };

/** Walk-cycle frame phase for a given walk frame index (0..3 -> 0,.25,.5,.75). */
function walkPhase(frame) {
  return frame / STATES.walk;
}

/**
 * Build the canonical atlas frame key. The ONE place this string is formed.
 *   frameKey('ape', 'walk', 's', 0) -> 'ape_walk_s_0'
 */
function frameKey(species, state, dir, frame) {
  return `${species}_${state}_${dir}_${frame}`;
}

/**
 * Every frame key for one species, in stable contract order
 * (state asc by STATES key order, dir asc by DIRECTIONS, frame asc). Used by the
 * generator to enumerate work and by the verifier to assert completeness.
 */
function speciesFrameKeys(species) {
  const keys = [];
  for (const state of Object.keys(STATES)) {
    for (const dir of DIRECTIONS) {
      for (let frame = 0; frame < STATES[state]; frame++) {
        keys.push(frameKey(species, state, dir, frame));
      }
    }
  }
  return keys;
}

/** Frames authored vs emitted per species (sanity: 5*6=30 authored, 8*6=48 emitted). */
const FRAMES_PER_STATE_SET = Object.values(STATES).reduce((a, b) => a + b, 0); // 6
const AUTHORED_FRAMES_PER_SPECIES = AUTHORED_DIRS.length * FRAMES_PER_STATE_SET; // 30
const EMITTED_FRAMES_PER_SPECIES = DIRECTIONS.length * FRAMES_PER_STATE_SET; // 48

module.exports = {
  CANVAS,
  CENTER,
  VIEWBOX,
  INSET,
  DIRECTIONS,
  AUTHORED_DIRS,
  MIRROR,
  STATES,
  walkPhase,
  frameKey,
  speciesFrameKeys,
  FRAMES_PER_STATE_SET,
  AUTHORED_FRAMES_PER_SPECIES,
  EMITTED_FRAMES_PER_SPECIES,
};
