'use strict';

/**
 * RAT — the small, sneaky quadruped. Visual: cool gray, a compact low-slung
 * body close to the ground, a pointed snout, small rounded ears, and the rat
 * signature — a long thin tail trailing off the rump. Reads as small and
 * skittery. Symmetric front/back (no left/right-unique detail), so it mirrors
 * cleanly to w/sw/nw. Gameplay: skitter (no bespoke ability frames).
 *
 * Archetype: quadruped. Base colour is LOCKED to the renderer's SPECIES_TINT.
 */

const { buildQuadruped } = require('../archetypes/quadruped');
const { PALETTE } = require('../palette');

const PARTS = {
  palette: PALETTE.rat,
  // compact, low torso
  bodyRx: 12,
  bodyRy: 8,
  bodyY: 38,
  // small head sitting straight on the body (no raised neck)
  headR: 6,
  headY: 36,
  headX: 13,
  neckLen: 0,
  // short legs keeping it low to the ground (footY = 42 + 8 = 50)
  legLen: 8,
  legThick: 4,
  legY: 42,
  legSpread: 7,
  // the rat tell: a long, thin, gently curled tail
  tailLen: 22,
  tailThick: 3,
  tailCurl: 1,
  // small rounded ears + a pointed snout
  earR: 3,
  snout: true,
};

module.exports = {
  species: 'rat',
  archetype: 'quadruped',
  build(dir, state, frame) {
    return buildQuadruped(PARTS, dir, state, frame);
  },
};
