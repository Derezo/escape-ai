'use strict';

/**
 * Species registry — the fan-out join point. Each species module exports
 * `{ species, archetype, build(dir,state,frame) }`; this file imports them and
 * exposes them in a stable, contract-significant order (atlas packing + verify
 * iterate this order, so it must not be alphabetised — keep gameplay roster order
 * so the atlas layout is meaningful and stable).
 *
 * A fan-out subagent adds ONE require + ONE array entry for its species and
 * touches nothing else.
 *
 * NOTE: the order here MUST stay in sync with server/socket/lobby.js
 * SPECIES_ROSTER (+ the robot NPC) so every playable/idle species has art.
 */

const ape = require('./species/ape');
// --- fan-out species are added below (one line each) ---
// const bird = require('./species/bird');
// const rat = require('./species/rat');
// ... etc

/** Ordered list of species modules. Add new species to this array. */
const SPECIES = [
  ape,
  // bird, rat, elephant, chameleon, peacock, skunk, mole, cheetah,
  // parrot, tortoise, kangaroo, owl, fox, robot,
];

/** species name -> module, for quick lookup. */
const SPECIES_REGISTRY = Object.fromEntries(SPECIES.map((m) => [m.species, m]));

module.exports = { SPECIES, SPECIES_REGISTRY };
