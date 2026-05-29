'use strict';

/**
 * MOLE — the round, burrowing quadruped. Visual: dark earthy brown, a plump
 * near-spherical body slung low to the ground, a pointed snout, tiny eyes, no
 * visible ears, and only the stub of a tail. Very short legs give the big
 * front-paw, close-to-the-dirt feel. Reads as a mole. Symmetric front/back (no
 * left/right-unique detail), so it mirrors cleanly to w/sw/nw.
 *
 * Archetype: quadruped. Gameplay: burrow — teleport + briefly unseen (no bespoke
 * ability frames). Base colour is LOCKED to the renderer's SPECIES_TINT. All ink
 * stays inside the [4,60] safe area with the centre of mass at the canvas
 * centre (32,32): footY = legY(46) + legLen(6) = 52.
 */

const { buildQuadruped } = require('../archetypes/quadruped');
const { PALETTE } = require('../palette');

const PARTS = {
  palette: PALETTE.mole,
  // plump, round body — nearly as tall as it is wide, sitting low
  bodyRx: 13,
  bodyRy: 11,
  bodyY: 38,
  // small head set forward on the bulk, no raised neck
  headR: 7,
  headY: 36,
  headX: 13,
  neckLen: 0,
  // very short stubby legs keeping it close to the ground (footY = 52)
  legLen: 6,
  legThick: 5,
  legY: 46,
  legSpread: 6,
  // barely a tail — a tiny stub on the rump
  tailLen: 4,
  tailThick: 4,
  tailCurl: 1,
  // no visible ears; the mole's loudest read is the pointed snout
  earR: 0,
  snout: true,
};

module.exports = {
  species: 'mole',
  archetype: 'quadruped',
  build(dir, state, frame) {
    return buildQuadruped(PARTS, dir, state, frame);
  },
};
