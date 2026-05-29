'use strict';

/**
 * Species registry — the fan-out join point. Each species module exports
 * `{ species, archetype, build(dir,state,frame) }`; this file imports them and
 * exposes them in a stable, contract-significant order (atlas packing + verify
 * iterate this order, so it must not be alphabetised — keep gameplay roster order
 * so the atlas layout is meaningful and stable).
 *
 * NOTE: the order here MUST stay in sync with server/socket/lobby.js
 * SPECIES_ROSTER (+ the robot NPC) so every playable/idle species has art.
 */

const ape = require('./species/ape');
const bird = require('./species/bird');
const rat = require('./species/rat');
const elephant = require('./species/elephant');
const chameleon = require('./species/chameleon');
const peacock = require('./species/peacock');
const skunk = require('./species/skunk');
const mole = require('./species/mole');
const cheetah = require('./species/cheetah');
const parrot = require('./species/parrot');
const tortoise = require('./species/tortoise');
const kangaroo = require('./species/kangaroo');
const owl = require('./species/owl');
const fox = require('./species/fox');
const robot = require('./species/robot');

/** Ordered list of species modules (gameplay roster order, then the robot NPC). */
const SPECIES = [
  ape, bird, rat, elephant, chameleon, peacock, skunk,
  mole, cheetah, parrot, tortoise, kangaroo, owl, fox,
  robot,
];

/** species name -> module, for quick lookup. */
const SPECIES_REGISTRY = Object.fromEntries(SPECIES.map((m) => [m.species, m]));

module.exports = { SPECIES, SPECIES_REGISTRY };
