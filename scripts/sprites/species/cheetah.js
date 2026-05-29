'use strict';

/**
 * CHEETAH — the fastest one. A lean, long-bodied big cat: a slim athletic barrel
 * (wide but shallow), legs longer than the rat's, a small rounded-eared head on a
 * small muzzle, and a long trailing tail for balance. Tan base; the archetype's
 * 3-tone shading suggests the spotted coat without any asymmetric spot art, so the
 * profile stays mirror-safe to w/sw/nw. Symmetric front/back. Gameplay: dash (a
 * speed burst — no bespoke ability frames).
 *
 * Archetype: quadruped. Built on the shared base so its posture, trot gait and
 * shading cohere with the rest of the zoo. All ink sits inside the [4,60] safe
 * area with the centre of mass at the canvas centre (32,32).
 */

const { buildQuadruped } = require('../archetypes/quadruped');
const { PALETTE } = require('../palette');

const PARTS = {
  palette: PALETTE.cheetah,
  // long, lean torso: wide along the body, shallow in depth (the athletic build)
  bodyRx: 16,
  bodyRy: 9,
  bodyY: 36,
  // small head set forward in profile, raised a touch on a short neck
  headR: 7,
  headY: 24,
  headX: 13,
  neckLen: 0,
  // longer legs than a rat keep it tall and poised (footY = 40 + 16 = 56)
  legLen: 16,
  legThick: 4,
  legY: 40,
  legSpread: 7,
  // the long balancing tail — the cheetah's silhouette tell
  tailLen: 24,
  tailThick: 3,
  tailCurl: 1,
  // small rounded ears + a small muzzle
  earR: 3,
  snout: true,
};

module.exports = {
  species: 'cheetah',
  archetype: 'quadruped',
  build(dir, state, frame) {
    return buildQuadruped(PARTS, dir, state, frame);
  },
};
