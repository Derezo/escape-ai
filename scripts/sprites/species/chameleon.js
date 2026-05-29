'use strict';

/**
 * CHAMELEON — the disguise specialist. Visual: bright green, a small lizard-like
 * body sitting low on short legs, a rounded head with bulgy eyes, a small snout,
 * a subtle casque hint via the single profile ear-bump, and the chameleon tell —
 * a long, tightly CURLED tail (strong tailCurl). Symmetric front/back with no
 * left/right-unique detail, so it mirrors cleanly to w/sw/nw. The archetype draws
 * the tail toward -x in profile and down-centre in back view, so a single
 * tailCurl value stays mirror-safe — no bespoke tail art added here.
 *
 * Archetype: quadruped. Gameplay: cloak (perfect disguise) — no bespoke ability
 * frames. Base colour is LOCKED to the renderer's SPECIES_TINT.
 */

const { buildQuadruped } = require('../archetypes/quadruped');
const { PALETTE } = require('../palette');

const PARTS = {
  palette: PALETTE.chameleon,
  // small-to-medium, low-slung lizard torso
  bodyRx: 13,
  bodyRy: 8,
  bodyY: 37,
  // rounded head sitting straight on the body — larger headR drives the bulgy
  // eyes (eye radius derives from headR in the archetype)
  headR: 7,
  headY: 34,
  headX: 14,
  neckLen: 0,
  // short legs keeping it close to a branch (footY = 41 + 9 = 50)
  legLen: 9,
  legThick: 4,
  legY: 41,
  legSpread: 7,
  // the chameleon tell: a long tail with a pronounced, tight curl
  tailLen: 22,
  tailThick: 4,
  tailCurl: 1.6,
  // small rounded ear/casque bump + a small snout/mouth
  earR: 3,
  snout: true,
};

module.exports = {
  species: 'chameleon',
  archetype: 'quadruped',
  build(dir, state, frame) {
    return buildQuadruped(PARTS, dir, state, frame);
  },
};
