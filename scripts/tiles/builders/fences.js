'use strict';

/**
 * FENCE / BARRIER builders (indices 103..118) — TINS 2026, Escape AI.
 *
 * DECO drawn on a TRANSPARENT cell (ground shows between/under the rails). Two
 * materials: tan fence WOOD (rails + turned posts) and steel CAGE bars (reuse the
 * robot steel so the cages echo the keeper-robots). Top-lit highlight on the upper
 * edge of every board; wood-grain streaks + a deep core shadow give depth.
 *
 * CONNECTION CONTRACT (the load-bearing bit):
 *   Every horizontal run draws its two boards in the SAME two y-bands (RAIL_A /
 *   RAIL_B, symmetric about the cell centre) and spans the full width x=0..32.
 *   Every vertical run draws its two boards in the SAME two x-bands and spans the
 *   full height y=0..32. Because the H y-bands EQUAL the V x-bands, a horizontal
 *   rail entering a corner/T lines up pixel-for-pixel with the vertical rail
 *   leaving it, and two abutting straight tiles form one unbroken rail line. Rails
 *   always reach the exact shared cell edge (0 or 32) at those fixed offsets.
 *
 * Naming → geometry:
 *   FENCE_H / _V      : a horizontal / vertical rail run spanning the cell.
 *   FENCE_POST        : a single turned post.
 *   FENCE_CORNER_DD   : two rail stubs meeting at the corner post (an L turn).
 *   FENCE_T_<D>       : a through-rail plus a stub toward side D (a T-junction).
 *   FENCE_GATE        : an open doorway — two posts, hinges, a swung-back leaf.
 *   CAGE_BARS_H/_V    : steel bars; CAGE_CORNER an L; CAGE_GATE an opening.
 */

const T = require('../template-tile');
const { TILE_PAL, EDGE } = require('../tilepalette');

const { plainRect, ellipse } = T;
const S = T.S; // 32
const H = S / 2; // 16

// ---------------- Wooden fence ----------------
const W = TILE_PAL.fence;

// Shared rail geometry. The two boards sit in fixed bands symmetric about the
// centre so H y-bands == V x-bands (see CONNECTION CONTRACT above).
const BW = 4; // board thickness
const RAIL_A = H - 7; // near band start (top for H / left for V): 9..13
const RAIL_B = H + 3; // far band start (bottom for H / right for V): 19..23

/** One wood board as a coloured slab: base, a top-lit edge, a grain shadow line. */
function boardH(y) {
  return (
    plainRect(0, y, S, BW, W.base) +
    plainRect(0, y, S, 1, W.light, { opacity: 0.85 }) + // top-lit edge
    plainRect(0, y + BW - 1, S, 1, W.grain, { opacity: 0.6 }) // underside grain
  );
}
function boardV(x) {
  return (
    plainRect(x, 0, BW, S, W.base) +
    plainRect(x, 0, 1, S, W.light, { opacity: 0.85 }) + // lit (left) edge
    plainRect(x + BW - 1, 0, 1, S, W.grain, { opacity: 0.6 }) // shaded (right) edge
  );
}

/** Two horizontal boards spanning the full width (x=0..32) at the shared bands. */
function railH() {
  return boardH(RAIL_A) + boardH(RAIL_B);
}
/** Two vertical boards spanning the full height (y=0..32) at the shared bands. */
function railV() {
  return boardV(RAIL_A) + boardV(RAIL_B);
}

/** Rail stub from the centre out to side D, in the shared bands, reaching the edge. */
function stub(d, cx = H, cy = H) {
  const a = cx - 7;
  const b = cx + 3; // vertical bands for N/S
  const ya = cy - 7;
  const yb = cy + 3; // horizontal bands for E/W
  if (d === 'N') {
    return (
      plainRect(a, 0, BW, cy, W.base) + plainRect(a, 0, 1, cy, W.light, { opacity: 0.85 }) +
      plainRect(b, 0, BW, cy, W.base) + plainRect(b + BW - 1, 0, 1, cy, W.grain, { opacity: 0.6 })
    );
  }
  if (d === 'S') {
    return (
      plainRect(a, cy, BW, S - cy, W.base) + plainRect(a, cy, 1, S - cy, W.light, { opacity: 0.85 }) +
      plainRect(b, cy, BW, S - cy, W.base) + plainRect(b + BW - 1, cy, 1, S - cy, W.grain, { opacity: 0.6 })
    );
  }
  if (d === 'W') {
    return (
      plainRect(0, ya, cx, BW, W.base) + plainRect(0, ya, cx, 1, W.light, { opacity: 0.85 }) +
      plainRect(0, yb, cx, BW, W.base) + plainRect(0, yb + BW - 1, cx, 1, W.grain, { opacity: 0.6 })
    );
  }
  // E
  return (
    plainRect(cx, ya, S - cx, BW, W.base) + plainRect(cx, ya, S - cx, 1, W.light, { opacity: 0.85 }) +
    plainRect(cx, yb, S - cx, BW, W.base) + plainRect(cx, yb + BW - 1, S - cx, 1, W.grain, { opacity: 0.6 })
  );
}

/**
 * A turned (round-ish) wooden post centred at (cx,cy): a tapered barrel that reads
 * as a cylinder — a domed cap, a lit left flank, a deep core shadow on the right,
 * and a couple of grain streaks. Tapered = narrower at top/bottom via cap ellipses.
 */
function post(cx = H, cy = H) {
  const half = 5; // barrel half-width
  const top = cy - 12;
  const bot = cy + 12;
  const hgt = bot - top;
  return (
    // body slab
    plainRect(cx - half, top, half * 2, hgt, W.base) +
    // rounded caps (the taper) — overlay base over the slab corners
    ellipse(cx, top, half, 2.2, W.base, { stroke: 'none' }) +
    ellipse(cx, bot, half, 2.2, W.shade, { stroke: 'none' }) +
    // lit left flank + deep core shadow on the right (cylinder shading)
    plainRect(cx - half, top, 2, hgt, W.light, { opacity: 0.8 }) +
    plainRect(cx + half - 2.5, top, 2.5, hgt, W.deep, { opacity: 0.85 }) +
    // domed top highlight
    ellipse(cx - 1, top + 0.5, half - 1.5, 1.6, W.light, { stroke: 'none', opacity: 0.9 }) +
    // grain streaks
    plainRect(cx - 0.5, top + 2, 1, hgt - 4, W.grain, { opacity: 0.45 }) +
    plainRect(cx + 2, top + 3, 1, hgt - 7, W.grain, { opacity: 0.3 })
  );
}

function fenceH() {
  // rails first, then posts on top so the post reads as in front of the boards.
  return railH() + post(5) + post(27);
}
function fenceV() {
  return railV() + post(H, 5) + post(H, 27);
}
function fencePost() {
  return post();
}

function fenceCorner(name) {
  const dd = name.slice('FENCE_CORNER_'.length); // NE/NW/SE/SW
  // Two stubs from the centre toward the named sides, then the post over the joint.
  let out = '';
  if (dd.includes('N')) out += stub('N');
  if (dd.includes('S')) out += stub('S');
  if (dd.includes('W')) out += stub('W');
  if (dd.includes('E')) out += stub('E');
  out += post();
  return out;
}

function fenceT(name) {
  const d = name.slice('FENCE_T_'.length); // N/E/S/W (the stem direction)
  // The through-rail is perpendicular to the stem (a full straight run), and the
  // stem is a stub toward side D. All in the shared bands → everything connects.
  let out = '';
  if (d === 'N' || d === 'S') out += railH();
  else out += railV();
  out += stub(d);
  out += post();
  return out;
}

function fenceGate() {
  // An OPEN doorway: a tall post on each side, iron hinge straps on the left jamb,
  // and the gate leaf swung back flat against the right post. Reads as a door, not
  // a fence segment — the centre is an open, walkable gap.
  let out = post(4) + post(28);
  // hinge straps on the left post
  out += plainRect(3, 9, 7, 2, TILE_PAL.metal.dark, { opacity: 0.95 });
  out += plainRect(3, 21, 7, 2, TILE_PAL.metal.dark, { opacity: 0.95 });
  // the swung-back leaf folded against the right post (a short stack of boards)
  out += plainRect(22, 6, 7, 3, W.base) + plainRect(22, 6, 7, 1, W.light, { opacity: 0.85 });
  out += plainRect(22, 14, 7, 3, W.base) + plainRect(22, 14, 7, 1, W.light, { opacity: 0.85 });
  out += plainRect(22, 22, 7, 3, W.base) + plainRect(22, 22, 7, 1, W.light, { opacity: 0.85 });
  // a diagonal brace across the folded leaf
  out += T.path('M23 24 L28 7', 'none', { stroke: W.grain, width: 1.5 });
  return out;
}

// ---------------- Steel cage bars ----------------
const M = TILE_PAL.metal;

// Shared bar geometry: round-ish steel bars get a dark core, a bright specular
// highlight, and a soft edge. Like the wood, H rails == V bars in their offsets so
// cage tiles tile and turn cleanly.
const BAR_W = 3;

/** A vertical steel bar centred at x — dark core, lit left, specular streak. */
function barV(x) {
  return (
    plainRect(x - 1.5, 0, BAR_W, S, M.base) +
    plainRect(x - 1.5, 0, 1, S, M.hi, { opacity: 0.85 }) + // specular (lit) edge
    plainRect(x + 0.5, 0, 1, S, M.dark, { opacity: 0.8 }) // shaded edge
  );
}
/** A horizontal steel bar centred at y. */
function barH(y) {
  return (
    plainRect(0, y - 1.5, S, BAR_W, M.base) +
    plainRect(0, y - 1.5, S, 1, M.hi, { opacity: 0.85 }) +
    plainRect(0, y + 0.5, S, 1, M.dark, { opacity: 0.8 })
  );
}

// Fixed inset bar positions so the corner's two runs line up with straight tiles.
const VBARS = [5, 11, 17, 23, 29]; // x positions of the vertical bars
const HRAILS = [4, 28]; // y of the top + bottom binding rails (reach the edges)

function cageBarsH() {
  // A flat cage section: closely-spaced vertical bars, bound by a top + bottom rail.
  let out = barH(HRAILS[0]) + barH(HRAILS[1]);
  for (const x of VBARS) out += barV(x);
  return out;
}
function cageBarsV() {
  // Rotate the above: vertical edge bars bound horizontal rungs.
  let out = barV(4) + barV(28);
  for (const y of VBARS) out += barH(y);
  return out;
}

function cageCorner() {
  // An L: a binding rail along the top edge and one down the right edge, with the
  // perpendicular bars/rungs of each run filling the inner field, joined by a
  // heavier corner post at top-right. Both binding rails reach their shared cell
  // edges (y=4 spans x=0..32; x=28 spans y=0..32) so neighbours join continuously.
  let out = '';
  // the two binding rails that meet at the corner
  out += barH(4); // top binding rail (continues a horizontal run to the W)
  out += barV(28); // right binding bar (continues a vertical run to the S)
  // vertical bars of the top (horizontal) run — stop short of the right post
  for (const x of [4, 10, 16, 22]) out += barV(x);
  // horizontal rungs of the right (vertical) run — stop short of the top rail
  for (const y of [10, 16, 22, 28]) out += barH(y);
  // heavier corner post where the two runs meet (top-right)
  out += plainRect(25, 1, 6, 6, M.dark);
  out += plainRect(25, 1, 6, 1, M.hi, { opacity: 0.7 });
  return out;
}

function cageGate() {
  // A steel gate frame with sparse bars + a latch — a distinct, walkable opening.
  let out = plainRect(3, 4, 26, 24, 'none');
  // frame
  out += plainRect(3, 4, 26, 2, M.base) + plainRect(3, 4, 26, 1, M.hi, { opacity: 0.8 });
  out += plainRect(3, 26, 26, 2, M.base) + plainRect(3, 26, 26, 1, M.dark, { opacity: 0.7 });
  out += plainRect(3, 4, 2, 24, M.base) + plainRect(3, 4, 1, 24, M.hi, { opacity: 0.8 });
  out += plainRect(27, 4, 2, 24, M.base) + plainRect(28, 4, 1, 24, M.dark, { opacity: 0.7 });
  // sparse interior bars
  out += barV(12) + barV(20);
  // hinges on the left jamb + a round latch in the centre
  out += plainRect(2, 9, 3, 2, M.dark) + plainRect(2, 21, 3, 2, M.dark);
  out += ellipse(16, 16, 2.4, 2.4, M.hi, { stroke: EDGE, width: 1 });
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
