'use strict';

/**
 * BIRD archetype — a compact body with two wings, a head with a beak, and small
 * legs. Reused for bird, parrot, owl, peacock, bat. Wings flap on the walk cycle
 * (and read as a flutter when moving). 3-tone shading shared with the rest.
 *
 * Authored directions only (s, n, e, se, ne); generator mirrors to w/sw/nw.
 *
 * parts = {
 *   palette,
 *   bodyRx, bodyRy, bodyY,        // egg-shaped body
 *   headR, headY,                 // head
 *   beakLen, beakColor,           // beak (uses palette.accent if no color)
 *   wingLen, wingThick,           // wing capsules
 *   legLen, legThick, legY,
 *   crest,                        // bool: a crest tuft on the head (peacock/parrot)
 *   bigEyes,                      // bool: oversized owl eyes
 *   membrane,                     // bool: bat-style membrane wings (drawn as polygons)
 *   fanTail,                      // bool: peacock folded fan hint behind body
 * }
 */

const { CENTER } = require('../contract');
const t = require('../template');
const anim = require('../anim');

function wings(parts, dir, state, frame) {
  const { palette, wingLen, wingThick, bodyY, bodyRx } = parts;
  const cx = CENTER;
  const phase = state === 'walk' ? frame / 4 : 0;
  // Flap: wings lift on alternating phase.
  const flap = state === 'walk' ? anim.limbLift(phase, 0) * 1.5 : anim.breathe(frame);

  if (parts.membrane) {
    // Bat membrane wings: triangular polygons each side.
    const wy = bodyY - 2 + flap;
    const span = wingLen;
    const right = t.polygon(
      [[cx + bodyRx * 0.4, bodyY], [cx + span, wy - span * 0.4], [cx + span * 0.7, bodyY + span * 0.3]],
      palette.shade,
    );
    const left = t.polygon(
      [[cx - bodyRx * 0.4, bodyY], [cx - span, wy - span * 0.4], [cx - span * 0.7, bodyY + span * 0.3]],
      palette.base,
    );
    return dir === 'e' || dir === 'se' || dir === 'ne' ? left : left + right;
  }

  if (dir === 'e' || dir === 'se' || dir === 'ne') {
    // Profile: one near wing folded along the body.
    return t.limb(cx, bodyY - 2, cx - wingLen * 0.6, bodyY + flap, palette.shade, wingThick);
  }
  // Front/back: two swept wings.
  return (
    t.limb(cx - bodyRx * 0.5, bodyY - 2, cx - wingLen, bodyY + flap, palette.base, wingThick) +
    t.limb(cx + bodyRx * 0.5, bodyY - 2, cx + wingLen, bodyY + flap, palette.base, wingThick)
  );
}

function head(parts, dir) {
  const { palette, headR, headY, beakLen } = parts;
  const cx = CENTER;
  const beak = parts.beakColor || palette.accent;
  let s = t.circle(cx, headY, headR, palette.base);

  if (parts.crest) {
    // a small upright tuft
    s = t.polygon(
      [[cx - headR * 0.3, headY - headR], [cx, headY - headR * 1.9], [cx + headR * 0.3, headY - headR]],
      palette.accent,
    ) + s;
  }

  if (dir === 'n') return s; // back: no face

  if (dir === 'e' || dir === 'se' || dir === 'ne') {
    // profile beak to +x
    s += t.polygon(
      [[cx + headR * 0.7, headY - headR * 0.2], [cx + headR * 0.7 + beakLen, headY], [cx + headR * 0.7, headY + headR * 0.2]],
      beak,
    );
    const er = parts.bigEyes ? headR * 0.45 : headR * 0.22;
    s += t.circle(cx + headR * 0.2, headY - headR * 0.05, er, palette.white) +
      t.circle(cx + headR * 0.28, headY - headR * 0.05, er * 0.55, palette.eye, { stroke: palette.eye });
    return s;
  }

  // front: centred beak + two eyes
  s += t.polygon(
    [[cx - headR * 0.22, headY + headR * 0.2], [cx, headY + headR * 0.2 + beakLen], [cx + headR * 0.22, headY + headR * 0.2]],
    beak,
  );
  const er = parts.bigEyes ? headR * 0.5 : headR * 0.24;
  const eyeDx = parts.bigEyes ? headR * 0.5 : headR * 0.45;
  const eyeY = headY - headR * 0.15;
  s += t.circle(cx - eyeDx, eyeY, er, palette.white) +
    t.circle(cx - eyeDx, eyeY, er * 0.5, palette.eye, { stroke: palette.eye }) +
    t.circle(cx + eyeDx, eyeY, er, palette.white) +
    t.circle(cx + eyeDx, eyeY, er * 0.5, palette.eye, { stroke: palette.eye });
  return s;
}

function legs(parts, dir, state, frame) {
  const { palette, legLen, legThick, legY } = parts;
  const cx = CENTER;
  const phase = state === 'walk' ? frame / 4 : 0;
  const swL = state === 'walk' ? anim.limbSwing(phase, 0) : 0;
  const swR = state === 'walk' ? anim.limbSwing(phase, 0.5) : 0;
  const footY = legY + legLen;
  const spread = legThick * 1.2;
  return (
    t.limb(cx - spread, legY, cx - spread + swL, footY, palette.accent, legThick) +
    t.limb(cx + spread, legY, cx + spread + swR, footY, palette.accent, legThick)
  );
}

function buildBird(parts, dir, state, frame) {
  const { palette, bodyRx, bodyRy, bodyY } = parts;
  const cx = CENTER;
  const lift = state === 'walk' ? anim.bob(frame / 4) : anim.breathe(frame);
  let body = '';
  if (parts.fanTail && dir !== 'n') {
    body += t.ellipse(cx - bodyRx * 0.8, bodyY, bodyRx * 0.7, bodyRy * 1.3, palette.accent);
  }
  body += legs(parts, dir, state, frame);
  body += wings(parts, dir, state, frame);
  body += t.ellipse(cx, bodyY, bodyRx, bodyRy, palette.base);
  body += t.ellipse(cx, bodyY - bodyRy * 0.5, bodyRx * 0.55, bodyRy * 0.2, palette.light);
  body += head(parts, dir);
  return t.group(body, lift ? `translate(0,${t.n1(lift)})` : undefined);
}

module.exports = { buildBird };
