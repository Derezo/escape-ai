'use strict';

/**
 * BIPED archetype — a semi-upright body with a head, barrel torso, two arms and
 * two legs (ape, gorilla, kangaroo). Reused across upright animals so they all
 * share posture, limb mechanics, and the 3-tone shading scheme.
 *
 * A species file declares geometry via a `parts` object (sizes/positions, all in
 * px, anchored so the body centre of mass sits at the canvas centre (32,32)),
 * then this archetype animates and renders it for a given (dir, state, frame).
 *
 * The archetype draws ONLY the 5 authored directions (s, n, e, se, ne); the
 * generator mirrors them to w/sw/nw. So this code must never bake left/right
 * asymmetry into the profile/3-4 views.
 *
 * parts = {
 *   palette,                       // species palette {base,shade,light,accent,eye}
 *   headR,                         // head radius
 *   headY,                         // head centre y
 *   torsoRx, torsoRy, torsoY,      // torso ellipse
 *   armLen, armThick, shoulderY,   // arm capsule
 *   legLen, legThick, hipY,        // leg capsule
 *   earR,                          // ear radius (0 = none)
 *   knuckles,                      // bool: draw knuckle circles at arm ends (ape)
 *   muzzle,                        // bool: draw a profile muzzle bump
 * }
 */

const { CENTER } = require('../contract');
const t = require('../template');
const anim = require('../anim');

/** Eyes for a front/back/3-4 view. `n` (back) draws none. */
function faceFront(parts, dir) {
  if (dir === 'n') return ''; // back of head — no face
  const { palette, headR, headY } = parts;
  const cx = CENTER;
  // 3/4 views shift the face slightly toward the facing side and show 1.5 eyes.
  const turn = dir === 'se' || dir === 'ne' ? headR * 0.28 : 0;
  const eyeDx = headR * 0.42;
  const eyeY = headY - headR * 0.1;
  const eyeR = Math.max(1.6, headR * 0.16);
  const faceFill = palette.light;
  // face disc
  let s = t.ellipse(cx + turn * 0.4, headY + headR * 0.1, headR * 0.62, headR * 0.7, faceFill);
  // eyes (symmetric in front; in 3/4 the far eye is smaller/closer)
  const near = t.circle(cx + turn + eyeDx, eyeY, eyeR, palette.white) +
    t.circle(cx + turn + eyeDx, eyeY, eyeR * 0.55, palette.eye, { stroke: palette.eye });
  const farScale = turn ? 0.7 : 1;
  const far = t.circle(cx + turn - eyeDx * farScale, eyeY, eyeR * farScale, palette.white) +
    t.circle(cx + turn - eyeDx * farScale, eyeY, eyeR * 0.55 * farScale, palette.eye, { stroke: palette.eye });
  // brow ridge
  const brow = t.path(
    `M ${t.n1(cx - headR * 0.5)} ${t.n1(eyeY - eyeR - 1)} Q ${t.n1(cx + turn)} ${t.n1(eyeY - eyeR - 3)} ${t.n1(cx + headR * 0.5)} ${t.n1(eyeY - eyeR - 1)}`,
    'none',
    { stroke: palette.shade, width: 2 },
  );
  return s + far + near + brow;
}

/** Profile face (e) — one eye, optional muzzle to +x. */
function faceProfile(parts) {
  const { palette, headR, headY } = parts;
  const cx = CENTER;
  const eyeR = Math.max(1.6, headR * 0.18);
  let s = '';
  if (parts.muzzle) {
    s += t.ellipse(cx + headR * 0.7, headY + headR * 0.15, headR * 0.5, headR * 0.4, palette.shade);
  }
  s += t.circle(cx + headR * 0.25, headY - headR * 0.05, eyeR, palette.white) +
    t.circle(cx + headR * 0.3, headY - headR * 0.05, eyeR * 0.55, palette.eye, { stroke: palette.eye });
  return s;
}

/** The two arms as capsules, swung for walk. */
function arms(parts, dir, state, frame) {
  const { palette, armLen, armThick, shoulderY, headR } = parts;
  const cx = CENTER;
  const phase = state === 'walk' ? frame / 4 : 0;
  // Arms counter-swing to legs.
  const swingL = state === 'walk' ? anim.limbSwing(phase, 0.5) : 0;
  const swingR = state === 'walk' ? anim.limbSwing(phase, 0.0) : 0;
  const spread = headR * 0.9;
  const topL = [cx - spread, shoulderY];
  const topR = [cx + spread, shoulderY];
  const botL = [cx - spread - 1 + swingL, shoulderY + armLen];
  const botR = [cx + spread + 1 + swingR, shoulderY + armLen];

  // Profile: far arm (shaded) first, near arm (base) second.
  if (dir === 'e' || dir === 'se' || dir === 'ne') {
    const far = t.limb(cx - 1, shoulderY, cx - 2 + swingL, shoulderY + armLen, palette.shade, armThick - 1);
    const near = t.limb(cx + spread * 0.4, shoulderY, cx + spread * 0.4 + swingR, shoulderY + armLen, palette.base, armThick);
    let s = far + near;
    if (parts.knuckles) {
      s += t.circle(cx + spread * 0.4 + swingR, shoulderY + armLen, armThick * 0.6, palette.shade);
    }
    return s;
  }

  // Front/back: both arms symmetric.
  let s = t.limb(topL[0], topL[1], botL[0], botL[1], palette.base, armThick) +
    t.limb(topR[0], topR[1], botR[0], botR[1], palette.base, armThick);
  if (parts.knuckles) {
    s += t.circle(botL[0], botL[1], armThick * 0.6, palette.shade) +
      t.circle(botR[0], botR[1], armThick * 0.6, palette.shade);
  }
  return s;
}

/** The two legs as capsules, swung for walk. */
function legs(parts, dir, state, frame) {
  const { palette, legLen, legThick, hipY, headR } = parts;
  const cx = CENTER;
  const phase = state === 'walk' ? frame / 4 : 0;
  const swingL = state === 'walk' ? anim.limbSwing(phase, 0.0) : 0;
  const swingR = state === 'walk' ? anim.limbSwing(phase, 0.5) : 0;
  const spread = headR * 0.5;
  const footY = hipY + legLen;

  if (dir === 'e' || dir === 'se' || dir === 'ne') {
    const far = t.limb(cx - 1, hipY, cx - 1 + swingL, footY, palette.shade, legThick - 1);
    const near = t.limb(cx + 1, hipY, cx + 1 + swingR, footY, palette.base, legThick);
    // small feet
    return far + near +
      t.ellipse(cx + 1 + swingR + legThick * 0.3, footY, legThick * 0.7, legThick * 0.35, palette.shade);
  }
  return (
    t.limb(cx - spread, hipY, cx - spread + swingL, footY, palette.base, legThick) +
    t.limb(cx + spread, hipY, cx + spread + swingR, footY, palette.base, legThick) +
    t.ellipse(cx - spread + swingL, footY, legThick * 0.7, legThick * 0.35, palette.shade) +
    t.ellipse(cx + spread + swingR, footY, legThick * 0.7, legThick * 0.35, palette.shade)
  );
}

/** Ears flanking the head (front/back show two; profile shows one). */
function ears(parts, dir) {
  if (!parts.earR) return '';
  const { palette, headR, headY, earR } = parts;
  const cx = CENTER;
  if (dir === 'e' || dir === 'se' || dir === 'ne') {
    return t.circle(cx - headR * 0.5, headY - headR * 0.6, earR, palette.base);
  }
  return (
    t.circle(cx - headR * 0.85, headY - headR * 0.5, earR, palette.base) +
    t.circle(cx + headR * 0.85, headY - headR * 0.5, earR, palette.base)
  );
}

/**
 * Build one authored frame for a biped. Returns an inner SVG fragment (no doc
 * wrapper). The whole body is translated by the walk bob / idle breathe so the
 * creature lifts as it strides.
 */
function buildBiped(parts, dir, state, frame) {
  const { palette, headR, headY, torsoRx, torsoRy, torsoY } = parts;
  const cx = CENTER;
  const lift = state === 'walk' ? anim.bob(frame / 4) : anim.breathe(frame);

  // Draw order: legs (back), torso, arms, head, ears, face.
  let body = '';
  body += legs(parts, dir, state, frame);
  // torso with a soft top-lit highlight (a thin crescent near the top, not a
  // centred disc — a centred disc reads like a chest badge).
  body += t.ellipse(cx, torsoY, torsoRx, torsoRy, palette.base);
  body += t.ellipse(cx, torsoY - torsoRy * 0.45, torsoRx * 0.6, torsoRy * 0.22, palette.light);
  body += arms(parts, dir, state, frame);
  // head
  body += t.circle(cx, headY, headR, palette.base);
  body += ears(parts, dir);
  body += dir === 'e' ? faceProfile(parts) : faceFront(parts, dir);

  return t.group(body, lift ? `translate(0,${t.n1(lift)})` : undefined);
}

module.exports = { buildBiped };
