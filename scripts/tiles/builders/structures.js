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

// ---------------- Walls (solid stucco blocks) ----------------
function wallBlock(pal) {
  return (
    plainRect(0, 0, S, S, pal.base) +
    topLight(pal.light, 4, 0.6) +
    bottomShade(pal.shade, 5, 0.6) +
    // faint masonry courses
    plainRect(0, 11, S, 1, pal.shade, { opacity: 0.35 }) +
    plainRect(0, 22, S, 1, pal.shade, { opacity: 0.35 })
  );
}

function wallExtMid() {
  return wallBlock(TILE_PAL.wall);
}

/**
 * WALL_EXT_<D>_END: a wall block whose open side D shows a rounded cap (the run
 * terminates). We draw the full block, then a thin grass-transparent... no —
 * the block stays opaque; the END just gets a highlighted cap edge on side D so
 * it reads as a finished end rather than a continuing run.
 */
function wallExtEnd(name) {
  const d = name.slice('WALL_EXT_'.length).replace('_END', ''); // N/E/S/W
  let out = wallBlock(TILE_PAL.wall);
  const cap = TILE_PAL.wall.light;
  if (d === 'N') out += plainRect(0, 0, S, 3, cap, { opacity: 0.9 });
  else if (d === 'S') out += plainRect(0, S - 3, S, 3, cap, { opacity: 0.9 });
  else if (d === 'W') out += plainRect(0, 0, 3, S, cap, { opacity: 0.9 });
  else if (d === 'E') out += plainRect(S - 3, 0, 3, S, cap, { opacity: 0.9 });
  return out;
}

/** WALL_EXT_CORNER_DD: full block with a highlighted L on the two open edges at DD. */
function wallExtCorner(name) {
  const dd = name.slice('WALL_EXT_CORNER_'.length); // NE/NW/SE/SW
  let out = wallBlock(TILE_PAL.wall);
  const cap = TILE_PAL.wall.light;
  if (dd.includes('N')) out += plainRect(0, 0, S, 3, cap, { opacity: 0.8 });
  if (dd.includes('S')) out += plainRect(0, S - 3, S, 3, cap, { opacity: 0.8 });
  if (dd.includes('W')) out += plainRect(0, 0, 3, S, cap, { opacity: 0.8 });
  if (dd.includes('E')) out += plainRect(S - 3, 0, 3, S, cap, { opacity: 0.8 });
  return out;
}

// ---------------- Interior walls (lighter plaster) ----------------
function wallIntMid() {
  return wallBlock(TILE_PAL.wallInt);
}
function wallIntCorner(name) {
  const dd = name.slice('WALL_INT_CORNER_'.length);
  let out = wallBlock(TILE_PAL.wallInt);
  const cap = TILE_PAL.wallInt.light;
  if (dd.includes('N')) out += plainRect(0, 0, S, 3, cap, { opacity: 0.8 });
  if (dd.includes('S')) out += plainRect(0, S - 3, S, 3, cap, { opacity: 0.8 });
  if (dd.includes('W')) out += plainRect(0, 0, 3, S, cap, { opacity: 0.8 });
  if (dd.includes('E')) out += plainRect(S - 3, 0, 3, S, cap, { opacity: 0.8 });
  return out;
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
function roofBase() {
  let out = fillCell(TILE_PAL.roofRed.base);
  // shingle courses
  for (let i = 0; i < 4; i++) {
    out += plainRect(0, i * 8 + 7, S, 1, TILE_PAL.roofRed.shade, { opacity: 0.6 });
  }
  out += topLight(TILE_PAL.roofRed.light, 3, 0.5);
  return out;
}

function roofMid() {
  return roofBase();
}

/** Eave shadow on side D (a darker band where the roof overhangs). */
function roofEdge(name) {
  const d = name.slice('ROOF_RED_EDGE_'.length); // N/E/S/W
  let out = roofBase();
  const sh = TILE_PAL.roofRed.shade;
  if (d === 'N') out += plainRect(0, 0, S, 4, sh, { opacity: 0.7 });
  else if (d === 'S') out += plainRect(0, S - 4, S, 4, sh, { opacity: 0.7 });
  else if (d === 'W') out += plainRect(0, 0, 4, S, sh, { opacity: 0.7 });
  else if (d === 'E') out += plainRect(S - 4, 0, 4, S, sh, { opacity: 0.7 });
  return out;
}

function roofCorner(name) {
  const dd = name.slice('ROOF_RED_CORNER_'.length); // NE/NW/SE/SW
  let out = roofBase();
  const sh = TILE_PAL.roofRed.shade;
  if (dd.includes('N')) out += plainRect(0, 0, S, 4, sh, { opacity: 0.7 });
  if (dd.includes('S')) out += plainRect(0, S - 4, S, 4, sh, { opacity: 0.7 });
  if (dd.includes('W')) out += plainRect(0, 0, 4, S, sh, { opacity: 0.7 });
  if (dd.includes('E')) out += plainRect(S - 4, 0, 4, S, sh, { opacity: 0.7 });
  return out;
}

/** The horizontal ridge cap along the roof crest. */
function roofRidge() {
  let out = roofBase();
  out += plainRect(0, H - 3, S, 6, TILE_PAL.roofRed.shade);
  out += plainRect(0, H - 3, S, 2, TILE_PAL.roofRed.light, { opacity: 0.7 });
  return out;
}

/** The peak / gable cap (a small ridge knob at top-centre). */
function roofPeak() {
  let out = roofBase();
  out += T.polygon([[16, 3], [26, 16], [6, 16]], TILE_PAL.roofRed.light, { stroke: EDGE, width: 1 });
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
