'use strict';

/**
 * KANGAROO — a biped tuned for the marsupial silhouette. Same archetype as the
 * ape, but re-proportioned: small thin forearms (low armThick / short armLen),
 * big powerful hind legs (high legThick + long legLen), upright ears, and a long
 * muzzle. The thick-tail impression comes from the heavy lower body sitting low
 * on the canvas. Knuckle-walker tells are OFF (the ape's signature, not ours).
 *
 * Archetype: biped. Visual: sandy base (#c9925b), upright posture, long muzzle,
 * upright ears, oversized legs, dainty arms. Gameplay: leap (a long hop) — no
 * bespoke ability frames; the standard idle/walk gait carries it. Base colour is
 * LOCKED to the renderer's SPECIES_TINT. Symmetric front/back; nothing
 * left/right-unique is baked into the e/se/ne views (they get mirrored).
 */

const { buildBiped } = require('../archetypes/biped');
const { PALETTE } = require('../palette');

const PARTS = {
  palette: PALETTE.kangaroo,
  headR: 8,
  headY: 17,
  torsoRx: 11,
  torsoRy: 13,
  torsoY: 34,
  armLen: 12, // short forearms…
  armThick: 4, // …and thin (vs. the ape's beefy 6)
  shoulderY: 26,
  legLen: 17, // long, powerful hind legs…
  legThick: 9, // …and thick (the kangaroo's signature)
  hipY: 41,
  earR: 4, // modest upright ears
  knuckles: false, // not a knuckle-walker
  muzzle: true, // the long marsupial muzzle
};

module.exports = {
  species: 'kangaroo',
  archetype: 'biped',
  build(dir, state, frame) {
    return buildBiped(PARTS, dir, state, frame);
  },
};
