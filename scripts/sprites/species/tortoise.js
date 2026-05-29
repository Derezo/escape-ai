'use strict';

/**
 * TORTOISE — the slow one. Visual: a squat quadruped DOMINATED by a big domed
 * shell (shell-brown base, green head/legs accent), short stubby legs barely
 * lifting a low body off the ground, and a small head on a short neck poking out
 * front. No real tail (a tiny nub). Symmetric front/back with no left/right-unique
 * detail, so it mirrors cleanly to w/sw/nw. Gameplay: shell (immovable +
 * uncatchable; no bespoke ability frames).
 *
 * Archetype: quadruped. Base colour is LOCKED to the renderer's SPECIES_TINT.
 */

const { buildQuadruped } = require('../archetypes/quadruped');
const { PALETTE } = require('../palette');

const PARTS = {
  palette: PALETTE.tortoise,
  // wide, low, squat torso hugging the ground
  bodyRx: 13,
  bodyRy: 7,
  bodyY: 40,
  // the defining feature: a big domed shell over the back (wide as the body,
  // tall to read as a dome). Drawn in palette.accent (green) by the archetype.
  shellRx: 13,
  shellRy: 12,
  // small head on a short neck, poking out the front in profile
  headR: 5,
  headY: 34,
  headX: 14,
  neckLen: 2,
  // short, stubby, chunky legs (footY = 44 + 6 = 50)
  legLen: 6,
  legThick: 5,
  legY: 44,
  legSpread: 8,
  // only a tiny tail nub
  tailLen: 4,
  tailThick: 3,
  tailCurl: -1,
  // no ears; a small blunt snout for the beaky face
  earR: 0,
  snout: true,
};

module.exports = {
  species: 'tortoise',
  archetype: 'quadruped',
  build(dir, state, frame) {
    return buildQuadruped(PARTS, dir, state, frame);
  },
};
