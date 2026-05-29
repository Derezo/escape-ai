'use strict';

/**
 * BIRD — a light, nimble flyer. Visual: cyan egg-shaped body, a small rounded
 * head with a short orange beak, two swept wings that flutter on the walk cycle,
 * and thin legs. Plain songbird silhouette (no crest / oversized eyes / membrane
 * / fan-tail) so it reads instantly as a small bird and stays left/right
 * symmetric in the front/back views. Gameplay: flit (briefly uncatchable) — no
 * bespoke frames needed. Base colour is LOCKED to the renderer's SPECIES_TINT.
 *
 * Archetype: bird.
 */

const { buildBird } = require('../archetypes/bird');
const { PALETTE } = require('../palette');

const PARTS = {
  palette: PALETTE.bird,
  bodyRx: 9,
  bodyRy: 11,
  bodyY: 36,
  headR: 7,
  headY: 20,
  beakLen: 5,
  wingLen: 14,
  wingThick: 5,
  legLen: 7,
  legThick: 3,
  legY: 46,
};

module.exports = {
  species: 'bird',
  archetype: 'bird',
  build(dir, state, frame) {
    return buildBird(PARTS, dir, state, frame);
  },
};
