'use strict';

/**
 * Pure animation phase-math for the sprite library (TINS 2026 — Escape AI).
 *
 * Walk/idle motion is fully determined by integer frame indices, so every
 * species' archetype calls these helpers and the whole zoo bobs and swings in
 * the SAME rhythm — that shared cadence is a big part of why 14 animals read as
 * one cohesive set. No Math.random, no wall-clock: pure functions of the frame.
 *
 * `phase` is the walk-cycle position in [0, 1): frame 0 -> 0, 1 -> .25, etc.
 */

/** Vertical body-lift amplitude (px) at mid-stride. */
const BOB_AMP = 2;
/** Horizontal foot/limb swing amplitude (px) over a stride. */
const SWING_AMP = 3;

/**
 * Vertical body offset for a walk phase: the body rises at mid-stride (when
 * weight transfers) and dips at footfall. Negative = up (SVG y is down).
 * A full |sin| over the cycle gives two lifts per stride (a natural gait bob).
 */
function bob(phase) {
  return -Math.round(BOB_AMP * Math.abs(Math.sin(phase * Math.PI * 2)));
}

/**
 * Horizontal swing offset (px) for a limb at a walk phase. `legPhaseOffset` lets
 * a builder put opposing limbs in counter-phase (pass 0.5) or diagonal pairs in
 * phase (pass 0 for a trot). Returns a signed px offset to add to a foot x.
 */
function limbSwing(phase, legPhaseOffset = 0) {
  return Math.round(SWING_AMP * Math.sin((phase + legPhaseOffset) * Math.PI * 2));
}

/**
 * Vertical lift (px) for a limb at a walk phase — feet lift off the ground on the
 * forward swing. Half-rectified sine so a foot only rises (never sinks below
 * ground). Negative = up.
 */
function limbLift(phase, legPhaseOffset = 0) {
  const s = Math.sin((phase + legPhaseOffset) * Math.PI * 2);
  return -Math.round(BOB_AMP * Math.max(0, s));
}

/**
 * Idle "breathing": a tiny vertical offset for an idle frame. Frame 0 neutral,
 * frame 1 raised ~1px — reads as a slow breath without animating limbs.
 */
function breathe(frame) {
  return frame === 1 ? -1 : 0;
}

/**
 * Idle vertical-scale factor (subtle chest expansion) for an idle frame. Returns
 * a multiplier near 1; apply to a body's ry if a builder wants the breath to
 * also swell the torso slightly.
 */
function breatheScale(frame) {
  return frame === 1 ? 1.03 : 1.0;
}

/**
 * Quadruped trot-gait leg phase offsets, indexed by leg. Diagonal pairs move
 * together: front-left + back-right share phase 0; front-right + back-left share
 * phase 0.5. Returns the legPhaseOffset to pass to limbSwing/limbLift.
 *   leg: 'fl' | 'fr' | 'bl' | 'br'
 */
function quadLegPhase(leg) {
  return leg === 'fl' || leg === 'br' ? 0 : 0.5;
}

module.exports = {
  BOB_AMP,
  SWING_AMP,
  bob,
  limbSwing,
  limbLift,
  breathe,
  breatheScale,
  quadLegPhase,
};
