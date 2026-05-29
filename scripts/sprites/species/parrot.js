'use strict';

/**
 * PARROT — a colourful tropical bird. Visual: red egg-shaped body, a rounded head
 * topped by an upright CREST tuft, and a CHUNKY hooked-look beak (the parrot tell)
 * in the green accent, two wings that flutter on the walk cycle, and thin legs.
 * The crest + heavy beak are the parrot signature; no oversized owl eyes, no bat
 * membrane, no peacock fan. Symmetric front/back so it stays mirror-safe in the
 * e/se/ne views. Gameplay: mimic (order a robot with no suspicion) — no bespoke
 * ability frames. Base colour is LOCKED to the renderer's SPECIES_TINT.
 *
 * Archetype: bird.
 */

const { buildBird } = require('../archetypes/bird');
const { PALETTE } = require('../palette');

const PARTS = {
  palette: PALETTE.parrot,
  bodyRx: 10,
  bodyRy: 12,
  bodyY: 36,
  headR: 7,
  headY: 20,
  beakLen: 7, // chunky parrot beak — heavier than the songbird (5) / peacock (4)
  wingLen: 13,
  wingThick: 5,
  legLen: 7,
  legThick: 3,
  legY: 46,
  crest: true, // upright head tuft — the colourful parrot signature
};

module.exports = {
  species: 'parrot',
  archetype: 'bird',
  build(dir, state, frame) {
    return buildBird(PARTS, dir, state, frame);
  },
};
