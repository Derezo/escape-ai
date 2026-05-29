'use strict';

/**
 * SERPENT archetype — a long, low, sinuous body (snake) optionally with short
 * legs (crocodile/lizard). The body is a chain of overlapping ellipse segments
 * along an S-curve; the "walk" cycle slithers the curve phase so it undulates.
 * Reused for snake, crocodile, lizard.
 *
 * Authored directions only (s, n, e, se, ne); generator mirrors to w/sw/nw.
 *
 * parts = {
 *   palette,
 *   segCount, segRx, segRy,       // body segments
 *   headR, headY,                 // head
 *   amp,                          // S-curve amplitude (px)
 *   bodyY,                        // baseline y for the body chain
 *   legLen, legThick, legY,       // short legs (0 = legless snake)
 *   tongue,                       // bool: flick a tongue in profile
 *   snout,                        // bool: long croc snout
 * }
 */

const { CENTER } = require('../contract');
const t = require('../template');
const anim = require('../anim');

function bodyChain(parts, dir, state, frame) {
  const { palette, segCount, segRx, segRy, amp, bodyY } = parts;
  const cx = CENTER;
  const phase = state === 'walk' ? frame / 4 : 0;
  let s = '';
  // Lay segments left->right; offset each vertically along a travelling sine so
  // the body undulates as `phase` advances.
  const span = segRx * 1.4 * (segCount - 1);
  const startX = cx - span / 2;
  for (let i = 0; i < segCount; i++) {
    const x = startX + i * segRx * 1.4;
    const wave = amp * Math.sin((i / segCount) * Math.PI * 2 + phase * Math.PI * 2);
    // front/back views: stack the S vertically (coil read); profile: along x.
    const y = dir === 's' || dir === 'n' ? bodyY + wave * 0.5 : bodyY + wave;
    const fill = i % 2 === 0 ? palette.base : palette.shade;
    s += t.ellipse(x, y, segRx, segRy, fill);
  }
  return s;
}

function legs(parts, dir, state, frame) {
  if (!parts.legLen) return '';
  const { palette, legLen, legThick, legY, segRx, segCount } = parts;
  const cx = CENTER;
  const phase = state === 'walk' ? frame / 4 : 0;
  const footY = legY + legLen;
  const span = segRx * 1.4 * (segCount - 1);
  const fx = cx + span * 0.25;
  const bx = cx - span * 0.25;
  const sw = (o) => (state === 'walk' ? anim.limbSwing(phase, o) : 0);
  return (
    t.limb(fx, legY, fx + sw(0), footY, palette.shade, legThick) +
    t.limb(bx, legY, bx + sw(0.5), footY, palette.shade, legThick) +
    t.limb(fx - 3, legY, fx - 3 + sw(0.5), footY, palette.base, legThick) +
    t.limb(bx - 3, legY, bx - 3 + sw(0), footY, palette.base, legThick)
  );
}

function head(parts, dir) {
  const { palette, headR, headY, segRx, segCount } = parts;
  const cx = CENTER;
  const span = segRx * 1.4 * (segCount - 1);
  const hx = dir === 's' || dir === 'n' ? cx : cx + span / 2 + headR * 0.5;
  let s = t.ellipse(hx, headY, headR * (parts.snout ? 1.4 : 1), headR * 0.8, palette.base);
  if (parts.snout) {
    s += t.ellipse(hx + headR * 0.9, headY + headR * 0.1, headR * 0.7, headR * 0.4, palette.shade);
  }
  if (dir === 'n') return s;
  // slit eyes
  const er = Math.max(1.4, headR * 0.22);
  if (dir === 's') {
    s += t.circle(cx - headR * 0.4, headY - headR * 0.2, er, palette.accent) +
      t.circle(cx + headR * 0.4, headY - headR * 0.2, er, palette.accent);
  } else {
    s += t.circle(hx, headY - headR * 0.2, er, palette.accent);
    if (parts.tongue) {
      s += t.path(`M ${t.n1(hx + headR)} ${t.n1(headY)} l 5 -2 m -5 2 l 5 2`, 'none', { stroke: palette.accent, width: 1.5 });
    }
  }
  return s;
}

function buildSerpent(parts, dir, state, frame) {
  const lift = state === 'walk' ? 0 : anim.breathe(frame); // serpents undulate, don't bob
  let body = '';
  body += legs(parts, dir, state, frame);
  body += bodyChain(parts, dir, state, frame);
  body += head(parts, dir);
  return t.group(body, lift ? `translate(0,${t.n1(lift)})` : undefined);
}

module.exports = { buildSerpent };
