'use strict';

/**
 * FOX — the sleek, bushy-tailed quadruped. Visual: warm orange body on a slim,
 * athletic frame, a pointed snout, large pointed EARS (the fox tell), slim legs,
 * and a long, thick, bushy TAIL trailing off the rump. The off-white tail-tip /
 * chest reads from the archetype's near-white `accent` and top-lit `light`
 * highlight — both on the centre line — so NO asymmetric markings are baked in
 * and it mirrors cleanly to w/sw/nw. Symmetric front/back. Gameplay: decoy
 * (spawns a lure — no bespoke ability frames).
 *
 * Archetype: quadruped. Built on the shared base so its posture, trot gait and
 * 3-tone shading cohere with the rest of the zoo. All ink sits inside the [4,60]
 * safe area with the centre of mass at the canvas centre (32,32).
 */

const { buildQuadruped } = require('../archetypes/quadruped');
const { PALETTE } = require('../palette');

const PARTS = {
  palette: PALETTE.fox,
  // sleek, lean torso — a touch shallower than a cheetah for a slim fox build
  bodyRx: 14,
  bodyRy: 8,
  bodyY: 36,
  // small head set forward in profile, raised a touch on a short neck
  headR: 7,
  headY: 24,
  headX: 13,
  neckLen: 0,
  // slim legs, longer than the rat's, keeping it poised (footY = 40 + 15 = 55)
  legLen: 15,
  legThick: 4,
  legY: 40,
  legSpread: 6,
  // the fox tell: a long, thick, bushy tail plumed off the rump
  tailLen: 22,
  tailThick: 7,
  tailCurl: 1,
  // large pointed ears (the fox signature) + a pointed snout
  earR: 4,
  snout: true,
};

module.exports = {
  species: 'fox',
  archetype: 'quadruped',
  build(dir, state, frame) {
    return buildQuadruped(PARTS, dir, state, frame);
  },
};
