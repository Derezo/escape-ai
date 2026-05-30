'use strict';

/**
 * FENCE / BARRIER builders (indices 103..118) — TINS 2026, Escape AI.
 *
 * DECO drawn on a TRANSPARENT cell (ground shows between/under the rails). Two
 * materials: tan fence WOOD (rails + posts) and steel CAGE bars (reuse the robot
 * steel so the cages echo the keeper-robots). Top-lit highlight on the upper rail.
 *
 * Naming → geometry:
 *   FENCE_H / _V      : a horizontal / vertical rail run spanning the cell.
 *   FENCE_POST        : a single post.
 *   FENCE_CORNER_DD   : two rails meeting at corner DD (an L).
 *   FENCE_T_<D>       : a T-junction with the stem pointing out side D.
 *   FENCE_GATE        : a walkable opening (posts + a low swung rail).
 *   CAGE_BARS_H/_V    : steel bars; CAGE_CORNER an L; CAGE_GATE an opening.
 */

const T = require('../template-tile');
const { TILE_PAL, EDGE } = require('../tilepalette');

const { plainRect, ellipse } = T;
const S = T.S; // 32
const H = S / 2;

// ---------------- Wooden fence ----------------
const W = TILE_PAL.fence;

/** A horizontal rail (two boards) across the cell at vertical centre. */
function railH(y = H) {
  return (
    plainRect(0, y - 6, S, 3, W.base) +
    plainRect(0, y - 6, S, 1, W.light, { opacity: 0.7 }) +
    plainRect(0, y + 2, S, 3, W.base) +
    plainRect(0, y + 2, S, 1, W.light, { opacity: 0.7 })
  );
}
/** A vertical rail (two boards) across the cell at horizontal centre. */
function railV(x = H) {
  return (
    plainRect(x - 6, 0, 3, S, W.base) +
    plainRect(x - 6, 0, 1, S, W.light, { opacity: 0.7 }) +
    plainRect(x + 2, 0, 3, S, W.base) +
    plainRect(x + 2, 0, 1, S, W.light, { opacity: 0.7 })
  );
}
/** A square post centred at (cx,cy). */
function post(cx = H, cy = H) {
  return (
    plainRect(cx - 4, cy - 11, 8, 22, W.shade) +
    plainRect(cx - 4, cy - 11, 8, 3, W.light, { opacity: 0.7 }) +
    plainRect(cx - 4, cy - 11, 2, 22, W.base, { opacity: 0.4 })
  );
}

function fenceH() {
  return railH() + post(4) + post(28);
}
function fenceV() {
  return railV() + post(H, 4) + post(H, 28);
}
function fencePost() {
  return post();
}

function fenceCorner(name) {
  const dd = name.slice('FENCE_CORNER_'.length); // NE/NW/SE/SW
  // Rails run from the post (centre) toward the two sides named by DD.
  let out = '';
  if (dd.includes('N')) out += plainRect(H - 6, 0, 3, H, W.base) + plainRect(H + 2, 0, 3, H, W.base);
  if (dd.includes('S')) out += plainRect(H - 6, H, 3, H, W.base) + plainRect(H + 2, H, 3, H, W.base);
  if (dd.includes('W')) out += plainRect(0, H - 6, H, 3, W.base) + plainRect(0, H + 2, H, 3, W.base);
  if (dd.includes('E')) out += plainRect(H, H - 6, H, 3, W.base) + plainRect(H, H + 2, H, 3, W.base);
  out += post();
  return out;
}

function fenceT(name) {
  const d = name.slice('FENCE_T_'.length); // N/E/S/W (the stem direction)
  // The through-rail is perpendicular to the stem.
  let out = '';
  if (d === 'N' || d === 'S') out += railH(); // through-rail horizontal
  else out += railV();
  // stem toward side D
  if (d === 'N') out += plainRect(H - 6, 0, 3, H, W.base) + plainRect(H + 2, 0, 3, H, W.base);
  else if (d === 'S') out += plainRect(H - 6, H, 3, H, W.base) + plainRect(H + 2, H, 3, H, W.base);
  else if (d === 'W') out += plainRect(0, H - 6, H, 3, W.base) + plainRect(0, H + 2, H, 3, W.base);
  else if (d === 'E') out += plainRect(H, H - 6, H, 3, W.base) + plainRect(H, H + 2, H, 3, W.base);
  out += post();
  return out;
}

function fenceGate() {
  // posts at each side, a low swung rail across (a walkable opening)
  return (
    post(4) + post(28) +
    plainRect(6, 10, 20, 2.5, W.light, { opacity: 0.9 }) +
    plainRect(6, 18, 20, 2.5, W.light, { opacity: 0.9 }) +
    // a diagonal brace
    T.path('M7 19 L25 11', 'none', { stroke: W.base, width: 2 })
  );
}

// ---------------- Steel cage bars ----------------
const M = TILE_PAL.metal;

function barV(x) {
  return plainRect(x - 1.5, 0, 3, S, M.base) + plainRect(x - 1.5, 0, 1, S, M.light, { opacity: 0.7 });
}
function barH(y) {
  return plainRect(0, y - 1.5, S, 3, M.base) + plainRect(0, y - 1.5, S, 1, M.light, { opacity: 0.7 });
}

function cageBarsH() {
  // vertical bars with a top + bottom horizontal rail (a section of cage seen flat)
  let out = barH(3) + barH(29);
  for (let i = 0; i < 5; i++) out += barV(4 + i * 6);
  return out;
}
function cageBarsV() {
  let out = barV(3) + barV(29);
  for (let i = 0; i < 5; i++) out += barH(4 + i * 6);
  return out;
}
function cageCorner() {
  // an L of bars meeting at the corner post
  let out = '';
  for (let i = 0; i < 3; i++) out += barV(4 + i * 6); // along the top toward W
  out += barH(4);
  out += plainRect(2, 2, 5, 5, M.shade); // the corner post
  out += barV(H) + barH(H);
  return out;
}
function cageGate() {
  // a steel gate frame with sparse bars (a walkable opening)
  let out = plainRect(3, 4, 26, 24, 'none');
  out += plainRect(3, 4, 26, 2, M.base) + plainRect(3, 26, 26, 2, M.base);
  out += plainRect(3, 4, 2, 24, M.base) + plainRect(27, 4, 2, 24, M.base);
  out += barV(12) + barV(20);
  out += ellipse(16, 16, 2, 2, M.light, { stroke: EDGE, width: 1 }); // latch
  return out;
}

module.exports = {
  buildFenceH: fenceH,
  buildFenceV: fenceV,
  buildFencePost: fencePost,
  buildFenceCorner: fenceCorner,
  buildFenceT: fenceT,
  buildFenceGate: fenceGate,
  buildCageBarsH: cageBarsH,
  buildCageBarsV: cageBarsV,
  buildCageCorner: cageCorner,
  buildCageGate: cageGate,
};
