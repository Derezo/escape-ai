'use strict';

/**
 * ELEPHANT — the biggest silhouette in the zoo. A heavy, bulky barrel torso on
 * four thick column legs, a broad head with LARGE ears, a curling trunk and a
 * pair of tusks. Slate-grey base. Built on the quadruped archetype so its
 * posture, trot gait, and 3-tone shading cohere with the rest of the set.
 *
 * Archetype: quadruped. Gameplay: shove (no bespoke ability frames). Front view
 * is symmetric — the trunk hangs straight down the centre line and the two ears
 * mirror about it — so the auto-mirrored w/sw/nw views never flip wrong. In
 * profile the head/trunk/tusks face +x. All ink is scaled to sit inside the
 * [4,60] safe area while keeping the centre of mass at the canvas centre (32,32).
 */

const { buildQuadruped } = require('../archetypes/quadruped');
const { PALETTE } = require('../palette');

const PARTS = {
  palette: PALETTE.elephant,
  // heavy barrel torso — the largest body in the library
  bodyRx: 18,
  bodyRy: 14,
  bodyY: 36,
  // broad head, set forward in profile (headX) but centred front/back
  headR: 11,
  headY: 18,
  headX: 8,
  neckLen: 0, // head sits on the bulk; no raised neck
  // thick column legs, planted feet at y=56 (inside the safe area)
  legLen: 14,
  legThick: 9,
  legY: 42,
  legSpread: 9,
  // short tail with a gentle curl
  tailLen: 10,
  tailThick: 4,
  tailCurl: 1,
  // big flapping ears — the elephant's loudest read
  earR: 7,
  // elephant signatures
  trunk: true,
  tusks: true,
};

module.exports = {
  species: 'elephant',
  archetype: 'quadruped',
  build(dir, state, frame) {
    return buildQuadruped(PARTS, dir, state, frame);
  },
};
