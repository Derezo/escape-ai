'use strict';

/**
 * OWL — a round, wise-looking night bird. Visual: dusk-purple, a chunky rounded
 * body, a large head dominated by oversized owl EYES (bigEyes), a small hooked
 * gold beak, two stubby wings folded against the body, and short legs. The big
 * head + big eyes + small beak are the owl signature; no crest, no bat membrane,
 * no peacock fan — so it reads instantly as an owl and stays left/right symmetric
 * in the front/back and e/se/ne views (mirror-safe). Gameplay: hush (drain panic)
 * — no bespoke ability frames needed. Base colour is the renderer's SPECIES_TINT.
 *
 * Archetype: bird.
 */

const { buildBird } = require('../archetypes/bird');
const { PALETTE } = require('../palette');

const PARTS = {
  palette: PALETTE.owl,
  bodyRx: 12, // chunky round body — heavier than the songbird (9) / parrot (10)
  bodyRy: 13,
  bodyY: 37,
  headR: 9, // larger head than a small bird (7) to carry the oversized eyes
  headY: 18,
  beakLen: 3, // small hooked beak — shorter than the songbird (5) / parrot (7)
  wingLen: 12,
  wingThick: 6,
  legLen: 6,
  legThick: 3,
  legY: 47,
  bigEyes: true, // oversized owl eyes — the wise-bird signature
};

module.exports = {
  species: 'owl',
  archetype: 'bird',
  build(dir, state, frame) {
    return buildBird(PARTS, dir, state, frame);
  },
};
