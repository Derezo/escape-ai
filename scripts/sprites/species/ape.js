'use strict';

/**
 * APE — the reference animal (built first, serially, before the fan-out). It
 * exercises every template primitive, the palette, symmetry, mirror-safety, and
 * the exact frame-key naming, so once it renders + animates correctly the whole
 * archetype/template/contract foundation is proven.
 *
 * Archetype: biped. Visual: warm brown, round face, long knuckle-walking arms
 * (the ape signature), short bent legs, small ears. Gameplay: carry (disguise
 * courier). Base colour is LOCKED to the renderer's SPECIES_TINT.
 */

const { buildBiped } = require('../archetypes/biped');
const { PALETTE } = require('../palette');

const PARTS = {
  palette: PALETTE.ape,
  headR: 9,
  headY: 18,
  torsoRx: 12,
  torsoRy: 13,
  torsoY: 36,
  armLen: 20,
  armThick: 6,
  shoulderY: 27,
  legLen: 12,
  legThick: 7,
  hipY: 44,
  earR: 3,
  knuckles: true, // the ape's knuckle-walker tell
  muzzle: true,
};

module.exports = {
  species: 'ape',
  archetype: 'biped',
  build(dir, state, frame) {
    return buildBiped(PARTS, dir, state, frame);
  },
};
