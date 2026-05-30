'use strict';

/**
 * STRUCTURE builders (indices 75..102): walls, windows, doors, roofs.
 * TINS 2026 — Escape AI.
 *
 * Walls are SOLID DECO: an opaque stucco block filling the cell (a building's
 * footprint reads as a wall). Ends/corners trim the block on the open side(s) so a
 * wall run terminates cleanly. Roofs are ROOF-layer clay tiles, full-bleed red,
 * with edge/corner trims and a ridge/peak. All top-lit.
 *
 * Naming → geometry:
 *   WALL_EXT_<X>_END   : a wall block open on side X (the run ends there).
 *   WALL_EXT_CORNER_DD : an L-corner — the block occupies the two sides meeting at DD.
 *   ROOF_..._EDGE_D    : the eave on side D (a darker shadow band along that edge).
 *   ROOF_..._CORNER_DD : eave shadow on the two sides meeting at DD.
 */

const T = require('../template-tile');
const { TILE_PAL, EDGE } = require('../tilepalette');

const { plainRect, fillCell, topLight, bottomShade, circle } = T;
const S = T.S; // 32
const H = S / 2;

// ---------------- Walls (coursed brick/stone blocks) ----------------
//
// A real running-bond brick face that tiles seamlessly in both axes:
//   - Course height 8px → 4 courses fill the cell exactly (period divides 32).
//   - Brick width 32/3 ≈ 10.67px → 3 bricks per course; odd courses shift by a
//     half-brick. Both 32/3 and the half-brick offset wrap cleanly mod 32, so the
//     neighbouring wall cell continues the same bond with no seam.
// Each brick gets a lit top-edge, a bottom contact-shadow, and the mortar joints
// are real recessed lines (wall.mortar over wall.deep), not 1px ghosts.

const BRICK_H = 8;            // px per course
const BRICK_W = S / 3;        // ≈10.67px per brick (3 per course → wraps mod 32)
const WALL_COURSES = S / BRICK_H; // 4
const MORTAR = 1;             // mortar joint thickness

/** Draw the running-bond brick field for material `pal` across the whole cell. */
function brickField(pal) {
  const mortar = pal.mortar || pal.shade;
  const deep = pal.deep || pal.shade;
  // The mortar bed shows in the joints between bricks.
  let out = plainRect(0, 0, S, S, mortar);
  for (let row = 0; row < WALL_COURSES; row++) {
    const y = row * BRICK_H;
    const offset = row % 2 === 0 ? 0 : -BRICK_W / 2;
    // alternate brick face tone per course so the bond reads
    const face = row % 2 === 0 ? pal.base : (pal.mid || pal.base);
    for (let i = -1; i <= 3; i++) {
      const x = offset + i * BRICK_W;
      const bx = x + MORTAR / 2;
      const bw = BRICK_W - MORTAR;
      const by = y + MORTAR / 2;
      const bh = BRICK_H - MORTAR;
      out += plainRect(bx, by, bw, bh, face);                       // brick face
      out += plainRect(bx, by, bw, 1.4, pal.light, { opacity: 0.7 }); // lit top edge
      out += plainRect(bx, by + bh - 1.6, bw, 1.6, deep, { opacity: 0.6 }); // contact shadow
    }
  }
  // top-lit / bottom-shaded the whole wall plane (the masonry still tiles).
  out += topLight(pal.light, 3, 0.4);
  out += bottomShade(deep, 3, 0.45);
  return out;
}

/** Back-compat: window/door builders call wallBlock(pal); now a brick face. */
function wallBlock(pal) {
  return brickField(pal);
}

/**
 * A dressed-stone QUOIN stack along edge D — interlocking corner blocks that make a
 * wall END or CORNER read as a real, dressed termination (not a generic bright cap).
 * The quoins alternate long/short like masonry returns, with a lit outer face and a
 * shadow where they meet the brick field.
 */
function quoinEdge(pal, d) {
  const q = pal.quoin || pal.light;
  const hi = pal.light;  // a sunlit lip on the exposed outer edge
  const deep = pal.deep || pal.shade;
  const T2 = 5;          // quoin depth (how far in from the edge)
  let out = '';
  if (d === 'N' || d === 'S') {
    const y = d === 'N' ? 0 : S - T2;
    out += plainRect(0, y, S, T2, q);                                   // dressed band
    out += plainRect(0, d === 'N' ? T2 : S - T2 - 1.6, S, 1.6, deep, { opacity: 0.7 }); // inner shadow
    // alternating long/short blocks (the interlocking quoin reveal)
    for (let i = 0; i < 4; i++) {
      out += plainRect(i * BRICK_W * 0.75 + 0.6, y + 0.6, 0.9, T2 - 1.2, deep, { opacity: 0.55 });
    }
    // a bright sunlit lip right on the exposed outer edge
    out += plainRect(0, d === 'N' ? 0 : S - 1.4, S, 1.4, hi, { opacity: 0.9 });
  } else {
    const x = d === 'W' ? 0 : S - T2;
    out += plainRect(x, 0, T2, S, q);
    out += plainRect(d === 'W' ? T2 : S - T2 - 1.6, 0, 1.6, S, deep, { opacity: 0.7 });
    for (let i = 0; i < 4; i++) {
      out += plainRect(x + 0.6, i * BRICK_W * 0.75 + 0.6, T2 - 1.2, 0.9, deep, { opacity: 0.55 });
    }
    out += plainRect(d === 'W' ? 0 : S - 1.4, 0, 1.4, S, hi, { opacity: 0.9 });
  }
  return out;
}

function wallExtMid() {
  return brickField(TILE_PAL.wall);
}

/**
 * WALL_EXT_<D>_END: the run terminates on side D. The brick face fills the cell;
 * side D gets a dressed quoin stack capping the open end so the wall visibly STOPS
 * there (you can read which way it faces). The opposite side stays plain brick so it
 * abuts the continuing run.
 */
function wallExtEnd(name) {
  const d = name.slice('WALL_EXT_'.length).replace('_END', ''); // N/E/S/W
  return brickField(TILE_PAL.wall) + quoinEdge(TILE_PAL.wall, d);
}

/**
 * WALL_EXT_CORNER_DD: an L-corner. The two OPEN faces (the letters in DD) each get a
 * quoin return, and the outer corner where they meet gets a single bright dressed
 * corner stone — so the corner reads as turning, with a clear facing direction.
 */
function wallExtCorner(name) {
  const dd = name.slice('WALL_EXT_CORNER_'.length); // NE/NW/SE/SW
  return cornerWall(TILE_PAL.wall, dd);
}

function cornerWall(pal, dd) {
  const q = pal.quoin || pal.light;
  const deep = pal.deep || pal.shade;
  let out = brickField(pal);
  if (dd.includes('N')) out += quoinEdge(pal, 'N');
  if (dd.includes('S')) out += quoinEdge(pal, 'S');
  if (dd.includes('W')) out += quoinEdge(pal, 'W');
  if (dd.includes('E')) out += quoinEdge(pal, 'E');
  // the bright dressed corner stone where the two returns meet
  const cx = dd.includes('W') ? 0 : S - 7;
  const cy = dd.includes('N') ? 0 : S - 7;
  out += plainRect(cx, cy, 7, 7, q);
  out += plainRect(cx, cy, 7, 1.6, pal.light, { opacity: 0.9 }); // sunlit top of the corner stone
  // an inner shadow on the two sides of the corner stone that face into the brick
  const ix = dd.includes('W') ? cx + 7 - 1.4 : cx;
  const iy = dd.includes('N') ? cy + 7 - 1.4 : cy;
  out += plainRect(ix, cy, 1.4, 7, deep, { opacity: 0.6 });
  out += plainRect(cx, iy, 7, 1.4, deep, { opacity: 0.6 });
  return out;
}

// ---------------- Interior walls (lighter plaster brick) ----------------
function wallIntMid() {
  return brickField(TILE_PAL.wallInt);
}
function wallIntCorner(name) {
  const dd = name.slice('WALL_INT_CORNER_'.length);
  return cornerWall(TILE_PAL.wallInt, dd);
}

// ---------------- Window / doors ----------------
function windowTile() {
  let out = wallBlock(TILE_PAL.wall);
  // a glass pane inset with a cross mullion
  out += T.rect(7, 7, 18, 18, TILE_PAL.glass.base, { stroke: EDGE, width: 1, rx: 1 });
  out += plainRect(7, 9, 18, 5, TILE_PAL.glass.light, { opacity: 0.6 });
  out += plainRect(15, 7, 2, 18, TILE_PAL.wall.shade);
  out += plainRect(7, 15, 18, 2, TILE_PAL.wall.shade);
  return out;
}

function doorClosed() {
  let out = wallBlock(TILE_PAL.wall);
  out += T.rect(8, 5, 16, 23, TILE_PAL.woodFloorDark.base, { stroke: EDGE, width: 1, rx: 1 });
  out += plainRect(15, 5, 2, 23, TILE_PAL.woodFloorDark.shade);
  out += circle(21, 17, 1.4, TILE_PAL.metal.light, { stroke: 'none' }); // knob
  return out;
}

function doorOpen() {
  // walkable threshold: dark interior opening framed by the wall jambs
  let out = '';
  // jambs (wall) on the left/right, dark gap in the middle
  out += plainRect(0, 0, 7, S, TILE_PAL.wall.base);
  out += plainRect(S - 7, 0, 7, S, TILE_PAL.wall.base);
  out += topLight(TILE_PAL.wall.light, 3, 0.5);
  out += plainRect(7, 0, S - 14, S, TILE_PAL.woodFloorDark.shade); // the dark doorway
  // the swung-open door leaf against the right jamb
  out += plainRect(S - 11, 2, 3, S - 4, TILE_PAL.woodFloorDark.base, { opacity: 0.9 });
  return out;
}

// ---------------- Roofs (clay-red, ROOF layer) ----------------
//
// A field of OVERLAPPING terracotta shingle tabs in running-bond courses. The
// geometry is chosen to tile seamlessly in BOTH axes across a multi-cell roof:
//   - Course height 8px → 4 courses fill the 32px cell exactly (period divides 32).
//   - Tab width 8px → 4 tabs per course; even courses start at x=0, odd courses at
//     x=-4 (a half-tab running-bond offset). Both wrap cleanly mod 32, so the next
//     cell over continues the same brickwork without a seam.
// Each tab reads as a discrete clay tile: a body fill, a sunlit top-edge highlight
// (roofRed.hi), a deep lip-shadow under its bottom overhang (roofRed.deep), and a
// thin vertical groove between neighbours.

const COURSE_H = 8;   // px per shingle course
const TAB_W = 8;      // px per shingle tab
const ROOF_COURSES = S / COURSE_H; // 4

/** One running-bond course of clay tabs at row `row` (0..3). */
function shingleCourse(row) {
  const rp = TILE_PAL.roofRed;
  const y = row * COURSE_H;
  // Alternate the base clay tone per course so courses read distinct (running bond).
  const body = row % 2 === 0 ? rp.base : rp.mid;
  // Half-tab horizontal offset on odd courses; draw one extra tab so the wrap covers
  // the cell edge cleanly (x can be negative / exceed S — the cell clips it).
  const offset = row % 2 === 0 ? 0 : -TAB_W / 2;
  let out = '';
  // The course-wide lip shadow sits at the bottom of the course (the overhang of the
  // tabs above onto the next course down) — a real 2px band, not a 1px ghost line.
  out += plainRect(0, y, S, COURSE_H, body);
  out += plainRect(0, y + COURSE_H - 2, S, 2, rp.deep, { opacity: 0.85 });
  for (let i = -1; i <= ROOF_COURSES; i++) {
    const x = offset + i * TAB_W;
    // sunlit top roll of the tab
    out += plainRect(x + 0.6, y + 1, TAB_W - 1.2, 1.6, rp.hi, { opacity: 0.8 });
    // a soft mid-body shadow toward the tab's lower-right (rounds the clay)
    out += plainRect(x + 1, y + COURSE_H - 3.6, TAB_W - 2, 1.6, rp.shade, { opacity: 0.5 });
    // the vertical groove between this tab and the next (the keyway shadow)
    out += plainRect(x + TAB_W - 0.9, y + 1.5, 0.9, COURSE_H - 2.5, rp.deep, { opacity: 0.7 });
  }
  return out;
}

/** The full seamless shingle field for an interior roof cell. */
function shingleField() {
  let out = fillCell(TILE_PAL.roofRed.base);
  for (let r = 0; r < ROOF_COURSES; r++) out += shingleCourse(r);
  // a gentle overall top-lit roll across the whole slope
  out += topLight(TILE_PAL.roofRed.hi, 2, 0.4);
  return out;
}

function roofMid() {
  return shingleField();
}

/**
 * An eave / gutter on side D — the overhanging edge of the roof. The shingle field
 * stays seamless toward the building; the exposed side gets a projecting fascia
 * board (a lit lip) and the dark soffit shadow beneath it.
 */
function eave(d) {
  const rp = TILE_PAL.roofRed;
  let out = '';
  if (d === 'N') {
    out += plainRect(0, 0, S, 2.4, rp.hi);            // lit fascia lip
    out += plainRect(0, 2.4, S, 2.2, rp.deep, { opacity: 0.9 }); // soffit shadow
  } else if (d === 'S') {
    out += plainRect(0, S - 2.4, S, 2.4, rp.hi);
    out += plainRect(0, S - 4.6, S, 2.2, rp.deep, { opacity: 0.9 });
  } else if (d === 'W') {
    out += plainRect(0, 0, 2.4, S, rp.hi);
    out += plainRect(2.4, 0, 2.2, S, rp.deep, { opacity: 0.9 });
  } else if (d === 'E') {
    out += plainRect(S - 2.4, 0, 2.4, S, rp.hi);
    out += plainRect(S - 4.6, 0, 2.2, S, rp.deep, { opacity: 0.9 });
  }
  return out;
}

/** Eave overhang on side D (a lit gutter lip + soffit shadow). */
function roofEdge(name) {
  const d = name.slice('ROOF_RED_EDGE_'.length); // N/E/S/W
  return shingleField() + eave(d);
}

/** Two eaves meeting — the overhang wraps the two open sides of the roof corner. */
function roofCorner(name) {
  const dd = name.slice('ROOF_RED_CORNER_'.length); // NE/NW/SE/SW
  let out = shingleField();
  if (dd.includes('N')) out += eave('N');
  if (dd.includes('S')) out += eave('S');
  if (dd.includes('W')) out += eave('W');
  if (dd.includes('E')) out += eave('E');
  return out;
}

/**
 * A capped ridge beam along the crest: a row of half-round ridge tiles running
 * left↔right across the top, seamless to its neighbours, sitting over the slope's
 * shingles below.
 */
function roofRidge() {
  const rp = TILE_PAL.roofRed;
  let out = shingleField();
  const top = 1.5;
  const beamH = 11;
  // the ridge beam body
  out += plainRect(0, top, S, beamH, rp.mid);
  out += plainRect(0, top + beamH - 2, S, 2, rp.deep, { opacity: 0.9 }); // under-lip shadow
  // a run of half-round cap tiles along the beam (seamless: 4 × 8px, wraps mod 32)
  for (let i = 0; i < 4; i++) {
    const cx = i * TAB_W + TAB_W / 2;
    out += T.ellipse(cx, top + beamH * 0.55, TAB_W * 0.46, beamH * 0.5, rp.base, { stroke: 'none' });
    out += T.ellipse(cx - 1, top + beamH * 0.4, TAB_W * 0.28, beamH * 0.3, rp.hi, { stroke: 'none', opacity: 0.85 });
    out += plainRect(i * TAB_W, top + 1, 0.9, beamH - 2, rp.deep, { opacity: 0.7 }); // groove between caps
  }
  out += plainRect(0, top, S, 1.4, rp.hi, { opacity: 0.85 }); // sunlit crest
  return out;
}

/**
 * A gable peak — the triangular end of the ridge. A capped apex stone over the
 * shingles, with the two slopes falling away (a darker shoulder either side).
 */
function roofPeak() {
  const rp = TILE_PAL.roofRed;
  let out = shingleField();
  // the two shaded gable shoulders falling from the apex
  out += T.polygon([[0, 6], [16, 5], [2, 22]], rp.shade, { stroke: 'none', opacity: 0.45 });
  out += T.polygon([[32, 6], [16, 5], [30, 22]], rp.shade, { stroke: 'none', opacity: 0.45 });
  // the apex cap stone
  out += T.polygon([[16, 3], [25, 16], [7, 16]], rp.base, { stroke: 'none' });
  out += T.polygon([[16, 3], [20.5, 9.5], [11.5, 9.5]], rp.hi, { stroke: 'none', opacity: 0.9 }); // sunlit apex
  out += plainRect(7, 15.2, 18, 1.8, rp.deep, { opacity: 0.85 }); // lip shadow under the cap
  return out;
}

module.exports = {
  buildWallExtMid: wallExtMid,
  buildWallExtEnd: wallExtEnd,
  buildWallExtCorner: wallExtCorner,
  buildWallIntMid: wallIntMid,
  buildWallIntCorner: wallIntCorner,
  buildWindow: windowTile,
  buildDoorClosed: doorClosed,
  buildDoorOpen: doorOpen,
  buildRoofMid: roofMid,
  buildRoofEdge: roofEdge,
  buildRoofCorner: roofCorner,
  buildRoofRidge: roofRidge,
  buildRoofPeak: roofPeak,
};
