'use strict';

/**
 * QUADRUPED archetype — a four-legged body with head, neck, barrel torso, four
 * legs and a tail. The highest-reuse base in the library: rat, elephant,
 * chameleon, skunk, mole, cheetah, tortoise, fox, lion, zebra, wolf all build on
 * it. Posture, the trot gait, and 3-tone shading are shared so they cohere.
 *
 * A species file declares geometry via `parts`; this archetype animates + renders
 * for one authored direction (s, n, e, se, ne). The generator mirrors to w/sw/nw,
 * so never bake left/right asymmetry into the profile / 3-4 views.
 *
 * parts = {
 *   palette,
 *   bodyRx, bodyRy, bodyY,         // torso ellipse (side profile dimensions)
 *   headR, headY, headX,           // head circle; headX is its profile x-offset from centre
 *   neckLen,                       // 0 = head sits on body (rat); >0 = raised neck
 *   legLen, legThick, legY,        // legs (footY = legY + legLen)
 *   legSpread,                     // half-distance between the left/right leg pair (front view)
 *   tailLen, tailThick, tailCurl,  // tail capsule; tailCurl signs the curl direction
 *   earR,                          // ear radius (0 = none)
 *   snout,                         // bool: draw a pointed snout in profile
 *   shellRx, shellRy,              // optional dome shell over the back (tortoise); 0 = none
 *   trunk,                         // bool: elephant trunk in profile
 *   tusks,                         // bool: elephant tusks
 * }
 */

const { CENTER } = require('../contract');
const t = require('../template');
const anim = require('../anim');

/** The four legs, trot-gaited. In profile we see two near + two far (shaded). */
function legs(parts, dir, state, frame) {
  const { palette, legLen, legThick, legY, legSpread, bodyRx } = parts;
  const cx = CENTER;
  const phase = state === 'walk' ? frame / 4 : 0;
  const footY = legY + legLen;
  const sw = (leg) => (state === 'walk' ? anim.limbSwing(phase, anim.quadLegPhase(leg)) : 0);

  if (dir === 'e' || dir === 'se' || dir === 'ne') {
    // Profile: front pair near x = cx+bodyRx*0.6, back pair near cx-bodyRx*0.6.
    const fx = cx + bodyRx * 0.55;
    const bx = cx - bodyRx * 0.55;
    // far legs (shaded), then near legs (base)
    let s = '';
    s += t.limb(fx, legY, fx + sw('fr'), footY, palette.shade, legThick - 1); // far front
    s += t.limb(bx, legY, bx + sw('br'), footY, palette.shade, legThick - 1); // far back
    s += t.limb(fx + 2, legY, fx + 2 + sw('fl'), footY, palette.base, legThick); // near front
    s += t.limb(bx + 2, legY, bx + 2 + sw('bl'), footY, palette.base, legThick); // near back
    return s;
  }

  // Front (s) / back (n): two visible legs side by side (the far pair hidden).
  return (
    t.limb(cx - legSpread, legY, cx - legSpread + sw('fl'), footY, palette.base, legThick) +
    t.limb(cx + legSpread, legY, cx + legSpread + sw('fr'), footY, palette.base, legThick) +
    t.ellipse(cx - legSpread + sw('fl'), footY, legThick * 0.6, legThick * 0.3, palette.shade) +
    t.ellipse(cx + legSpread + sw('fr'), footY, legThick * 0.6, legThick * 0.3, palette.shade)
  );
}

/** The tail as a curled capsule. Side-on in profile/3-4; hidden-behind in front;
 *  a centred plume in back. Never juts sideways in the front (s) view. */
function tail(parts, dir) {
  if (!parts.tailLen) return '';
  const { palette, bodyRx, bodyRy, bodyY, tailLen, tailThick, tailCurl } = parts;
  const cx = CENTER;
  const curl = (tailCurl || 1) * tailLen * 0.4;

  if (dir === 's') {
    // Facing the camera: the tail is behind the body. Show just a small tip
    // peeking up over one shoulder so the silhouette still reads (no sideways jut).
    const tipY = bodyY - bodyRy * 0.9;
    return t.limb(cx, bodyY, cx, tipY - tailThick, palette.shade, tailThick * 0.8);
  }
  if (dir === 'n') {
    // Back view: the tail points straight down the centre (we see its full length).
    return t.limb(cx, bodyY, cx, bodyY + tailLen, palette.base, tailThick);
  }
  // Profile / 3-4: a side-on curled tail off the rump (toward -x; mirror handles +x).
  const baseX = cx - bodyRx * 0.95;
  return t.limb(baseX, bodyY, baseX - tailLen * 0.5, bodyY - curl, palette.base, tailThick);
}

/** Head + face. Profile gets a snout/trunk/tusks; front/back get symmetric eyes. */
function head(parts, dir) {
  const { palette, headR, headY, headX, eye } = parts;
  const cx = CENTER;
  const eyeColor = palette.eye;

  if (dir === 'e' || dir === 'se' || dir === 'ne') {
    const hx = cx + (headX || 0);
    let s = t.circle(hx, headY, headR, palette.base);
    // ear (one in profile)
    if (parts.earR) s = t.circle(hx - headR * 0.2, headY - headR * 0.8, parts.earR, palette.base) + s;
    if (parts.snout) s += t.ellipse(hx + headR * 0.85, headY + headR * 0.2, headR * 0.5, headR * 0.35, palette.shade);
    if (parts.trunk) {
      s += t.limb(hx + headR * 0.6, headY + headR * 0.3, hx + headR * 1.3, headY + headR * 1.4, palette.base, parts.legThick * 0.7);
    }
    if (parts.tusks) {
      s += t.path(`M ${t.n1(hx + headR * 0.7)} ${t.n1(headY + headR * 0.5)} q ${t.n1(headR * 0.4)} ${t.n1(headR * 0.2)} ${t.n1(headR * 0.2)} ${t.n1(headR * 0.7)}`, 'none', { stroke: palette.light, width: 3 });
    }
    // eye
    const er = Math.max(1.6, headR * 0.2);
    s += t.circle(hx + headR * 0.2, headY - headR * 0.1, er, palette.white) +
      t.circle(hx + headR * 0.25, headY - headR * 0.1, er * 0.55, eyeColor, { stroke: eyeColor });
    return s;
  }

  // Front / back
  let s = t.circle(cx, headY, headR, palette.base);
  if (parts.earR) {
    s = t.circle(cx - headR * 0.8, headY - headR * 0.55, parts.earR, palette.base) +
      t.circle(cx + headR * 0.8, headY - headR * 0.55, parts.earR, palette.base) + s;
  }
  if (parts.trunk) {
    // front-facing trunk hangs down the centre
    s += t.limb(cx, headY + headR * 0.4, cx, headY + headR * 1.6, palette.base, parts.legThick * 0.7);
  }
  if (dir === 'n') return s; // back of head: no face
  const er = Math.max(1.6, headR * 0.2);
  const eyeDx = headR * 0.45;
  const eyeY = headY - headR * 0.1;
  s += t.circle(cx - eyeDx, eyeY, er, palette.white) +
    t.circle(cx - eyeDx, eyeY, er * 0.55, eyeColor, { stroke: eyeColor }) +
    t.circle(cx + eyeDx, eyeY, er, palette.white) +
    t.circle(cx + eyeDx, eyeY, er * 0.55, eyeColor, { stroke: eyeColor });
  // snout/nose on the centre line (symmetric, mirror-safe)
  if (parts.snout) s += t.ellipse(cx, headY + headR * 0.5, headR * 0.4, headR * 0.3, palette.shade);
  return s;
}

/** The barrel torso with a top-lit highlight, plus optional dome shell. */
function torso(parts) {
  const { palette, bodyRx, bodyRy, bodyY, shellRx, shellRy } = parts;
  const cx = CENTER;
  let s = t.ellipse(cx, bodyY, bodyRx, bodyRy, palette.base);
  s += t.ellipse(cx, bodyY - bodyRy * 0.5, bodyRx * 0.6, bodyRy * 0.2, palette.light);
  if (shellRx) {
    s += t.ellipse(cx, bodyY - bodyRy * 0.3, shellRx, shellRy, palette.accent);
    s += t.ellipse(cx, bodyY - bodyRy * 0.3, shellRx * 0.55, shellRy * 0.55, palette.shade);
  }
  return s;
}

/** Build one authored quadruped frame. */
function buildQuadruped(parts, dir, state, frame) {
  const lift = state === 'walk' ? anim.bob(frame / 4) : anim.breathe(frame);
  let body = '';
  body += legs(parts, dir, state, frame); // legs behind body
  body += tail(parts, dir);
  body += torso(parts);
  body += head(parts, dir);
  return t.group(body, lift ? `translate(0,${t.n1(lift)})` : undefined);
}

module.exports = { buildQuadruped };
