'use strict';

/**
 * PEACOCK — an ornate, showy bird. Visual: teal egg-shaped body, a rounded head
 * topped by an upright CREST tuft, a short beak, two wings, thin legs, and a
 * folded FAN tail hinted behind the body in the blue accent. The crest + fan are
 * the peacock tell; no oversized owl eyes, no bat membrane. Symmetric front/back
 * so it stays mirror-safe in the e/se/ne views. Gameplay: dazzle (AoE robot
 * stand-down) — no bespoke ability frames. Base colour is LOCKED to the
 * renderer's SPECIES_TINT.
 *
 * Archetype: bird.
 */

const { buildBird } = require('../archetypes/bird');
const { PALETTE } = require('../palette');

const PARTS = {
  palette: PALETTE.peacock,
  bodyRx: 10,
  bodyRy: 12,
  bodyY: 36,
  headR: 7,
  headY: 20,
  beakLen: 4,
  wingLen: 13,
  wingThick: 5,
  legLen: 7,
  legThick: 3,
  legY: 46,
  crest: true, // upright head tuft — the showy peacock signature
  fanTail: true, // folded fan hint behind the body in palette.accent
};

module.exports = {
  species: 'peacock',
  archetype: 'bird',
  build(dir, state, frame) {
    return buildBird(PARTS, dir, state, frame);
  },
};
