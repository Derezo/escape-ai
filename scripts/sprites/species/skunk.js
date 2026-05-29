'use strict';

/**
 * SKUNK — the low, bushy-tailed quadruped. Visual: near-black body slung close
 * to the ground, a small pointed snout, tiny rounded ears, and the skunk
 * signature — a thick, long, bushy tail that plumes up off the rump. The pale
 * "stripe" reading comes from the archetype's top-lit `light` highlight on the
 * back and the near-white `accent` slot; it stays on the centre line so it
 * mirrors cleanly (NO asymmetric one-sided stripe). Symmetric front/back, so it
 * flips correctly to w/sw/nw. Gameplay: stink (drops a hazard zone — no bespoke
 * ability frames).
 *
 * Archetype: quadruped. Base colour is LOCKED to the renderer's SPECIES_TINT.
 */

const { buildQuadruped } = require('../archetypes/quadruped');
const { PALETTE } = require('../palette');

const PARTS = {
  palette: PALETTE.skunk,
  // compact, low-slung torso (skunks are short and round)
  bodyRx: 12,
  bodyRy: 9,
  bodyY: 38,
  // small head sitting straight on the body (no raised neck)
  headR: 6,
  headY: 36,
  headX: 13,
  neckLen: 0,
  // short legs keeping it close to the ground (footY = 42 + 8 = 50)
  legLen: 8,
  legThick: 5,
  legY: 42,
  legSpread: 7,
  // the skunk tell: a thick, long, bushy tail plumed up off the rump
  tailLen: 18,
  tailThick: 8,
  tailCurl: 1,
  // tiny rounded ears + a pointed snout
  earR: 3,
  snout: true,
};

module.exports = {
  species: 'skunk',
  archetype: 'quadruped',
  build(dir, state, frame) {
    return buildQuadruped(PARTS, dir, state, frame);
  },
};
