'use strict';

/**
 * ROBOT — the keeper-robot NPC of the Caves of Steel. Server-driven (no player
 * ability), but it shares the animals' idle/walk x 8-dir frame set so it animates
 * and faces while patrolling/pursuing.
 *
 * Archetype: robot. Visual: a clearly MECHANICAL keeper — a flat-top hexagonal
 * steel chassis, a boxy head with a single glowing red optic eye, an antenna, and
 * two stiff piston legs. Deliberately reads as NOT an animal and is symmetric
 * front/back. Base colour is LOCKED to the renderer's robot SPECIES_TINT (steel
 * #9aa3ad), accent the light-blue panel/antenna, eye the red optic.
 */

const { buildRobot } = require('../archetypes/robot');
const { PALETTE } = require('../palette');

const PARTS = {
  palette: PALETTE.robot,
  // flat-top hexagon chassis — the bulky mechanical body, centred on the anchor
  chassisR: 13,
  chassisY: 34,
  // boxy head sits above the chassis; small enough that the antenna tip stays in-frame
  headSize: 12,
  headY: 19,
  // single glowing optic eye
  opticR: 3.2,
  // stiff piston legs
  legLen: 9,
  legThick: 6,
  legY: 44,
  // the antenna tell
  antenna: true,
};

module.exports = {
  species: 'robot',
  archetype: 'robot',
  build(dir, state, frame) {
    return buildRobot(PARTS, dir, state, frame);
  },
};
