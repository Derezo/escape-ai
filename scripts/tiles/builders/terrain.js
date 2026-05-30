'use strict';

/**
 * TERRAIN / ground tile builders (indices 1..24) — TINS 2026, Escape AI.
 *
 * All are FULL-BLEED (fillCell) + seamless: the top-lit band is full-width and
 * scatter detail is deterministic (seeded by tile name) and kept off the cell
 * seams, so neighbouring same-material tiles read as continuous ground. No
 * stroked borders (they'd draw grid lines between abutting tiles).
 */

const T = require('../template-tile');
const { TILE_PAL, ACCENT } = require('../tilepalette');

const { fillCell, topLight, bottomShade, plainRect, scatter, circle, ellipse, path } = T;

/**
 * Common ground base: full fill only, NO per-cell top/bottom banding.
 * The banding creates visible seams when identical tiles stack vertically.
 * Seamless ground relies on scatter detail (seeded by tile name, wraps mod 32).
 */
function ground(pal) {
  return fillCell(pal.base);
}

/** A few flat speckles of `color` scattered deterministically across the cell. */
function speckles(name, n, color, opts) {
  return scatter(name, n, (x, y, r) => circle(x, y, r, color, { stroke: 'none' }), opts);
}

// --- Grass (3 variants differ only by their scatter seed → distinct but cohesive) ---
function grass(name) {
  return (
    ground(TILE_PAL.grass) +
    speckles(name + '_d', 9, TILE_PAL.grass.shade, { rMin: 0.8, rMax: 1.6 }) +
    speckles(name + '_l', 7, TILE_PAL.grass.light, { rMin: 0.7, rMax: 1.3 })
  );
}

function grassFlowers() {
  return (
    grass('GRASS_FLOWERS_base') +
    scatter('GRASS_FLOWERS', 5, (x, y) =>
      circle(x, y, 1.4, ACCENT.flowerWhite, { stroke: 'none' }) +
      circle(x, y, 0.6, ACCENT.flowerYellow, { stroke: 'none' }),
    { margin: 5 })
  );
}

function grassPatchy() {
  // grass with bald dirt patches showing through
  return (
    ground(TILE_PAL.grass) +
    scatter('GRASS_PATCHY_dirt', 4, (x, y, r) => ellipse(x, y, r * 2.2, r * 1.6, TILE_PAL.dirt.base, { stroke: 'none' }), { rMin: 1.6, rMax: 2.8, margin: 5 }) +
    speckles('GRASS_PATCHY_d', 6, TILE_PAL.grass.shade, { rMin: 0.8, rMax: 1.4 })
  );
}

// --- Dirt / mud ---
function dirt() {
  return ground(TILE_PAL.dirt) + speckles('DIRT', 10, TILE_PAL.dirt.shade, { rMin: 0.8, rMax: 1.8 });
}

function dirtTrampled() {
  // dirt with darker, flattened ruts
  return (
    ground(TILE_PAL.dirt) +
    plainRect(0, 14, 32, 4, TILE_PAL.dirt.shade, { opacity: 0.5 }) +
    speckles('DIRT_TRAMPLED', 8, TILE_PAL.dirt.shade, { rMin: 0.6, rMax: 1.3 })
  );
}

// --- Cobble / paved (stone gray) ---
function cobble() {
  // a scattered stone field: ~16 larger stones with deterministic pseudo-random placement
  // No regular grid alignment means no visible seams when tiled
  const c = TILE_PAL.cobble;
  return (
    ground(c) +
    scatter('COBBLE', 16, (x, y, r, i) => {
      // Alternate tone for visual variation
      const tone = i % 2 === 0 ? c.shade : c.accent;
      return ellipse(x, y, 4 + r * 0.5, 3.5 + r * 0.3, tone, { stroke: 'none' });
    }, { margin: 2, rMin: 1.2, rMax: 2.2 })
  );
}

function cobbleWorn() {
  // same stone grid, plus worn dark scuffs between the stones
  return cobble() + speckles('COBBLE_WORN', 6, TILE_PAL.cobble.shade, { rMin: 0.8, rMax: 1.6 });
}

function paved() {
  // smooth paving, fully seamless (no per-cell cross seams that grid the output)
  return ground(TILE_PAL.paved);
}

function pavedCrack() {
  return (
    paved() +
    T.path('M6 4 L12 13 L10 22 L16 28', 'none', { stroke: TILE_PAL.paved.shade, width: 1 }) +
    T.path('M22 5 L20 14 L26 20', 'none', { stroke: TILE_PAL.paved.shade, width: 1 })
  );
}

// --- Sand ---
function sand() {
  return ground(TILE_PAL.sand) + speckles('SAND', 12, TILE_PAL.sand.shade, { rMin: 0.5, rMax: 1.1 });
}

function sandRipple() {
  let out = ground(TILE_PAL.sand);
  for (let i = 0; i < 4; i++) {
    const y = 5 + i * 7;
    out += T.path(`M0 ${y} Q8 ${y - 2} 16 ${y} T32 ${y}`, 'none', { stroke: TILE_PAL.sand.shade, width: 1 });
  }
  return out;
}

// --- Mud ---
function mud() {
  return ground(TILE_PAL.mud) + speckles('MUD', 9, TILE_PAL.mud.shade, { rMin: 0.8, rMax: 1.8 });
}

function mudPuddle() {
  const shal = TILE_PAL.waterShallow;
  const wade = TILE_PAL.waterWade;
  return (
    ground(TILE_PAL.mud) +
    // A wet muddy rim ringing the pool so the water sits in a shallow basin.
    ellipse(16, 17, 11, 8, TILE_PAL.mud.shade, { stroke: 'none' }) +
    // The water body: a darker pool with a lighter, smaller surface (depth read).
    ellipse(16, 17, 9.5, 6.5, shal.shade, { stroke: 'none' }) +
    ellipse(16, 16.5, 8.5, 5.5, shal.base, { stroke: 'none' }) +
    ellipse(16, 16, 6.5, 4, wade.base, { stroke: 'none', opacity: 0.65 }) +
    // A single ripple line + a small surf-glint highlight on the near edge.
    path('M9 16 Q16 13.5 23 16', 'none', { stroke: wade.light, width: 1, opacity: 0.55 }) +
    ellipse(13, 14.5, 2.2, 0.9, wade.light, { stroke: 'none', opacity: 0.6 })
  );
}

// --- Water (full-bleed; deep is solid, shallow is wadeable) -------------------
//
// Both water tiles are SEAMLESS: every deep cell is byte-identical and every
// shallow cell is byte-identical, so the full-width horizontal wave bands below
// line up edge-to-edge across abutting cells into continuous waves (water reads
// as banded horizontally — that continuity is the desired look, not a seam). The
// "depth gradient" is faked with stacked translucent bands (NO gradients — librsvg
// rasterises those inconsistently). Each band is a full-width wave whose path
// returns to its start y at x=0 and x=32, so it also wraps horizontally.

/**
 * One full-width seamless wave STROKE at vertical position `y`. The quadratic
 * `M0 y Q(q) y-amp 2q y T S y` starts and ends at the same y (x=0 and x=32), so
 * the line is continuous across the left/right cell seam. `amp` is the crest
 * height, `q` the half-wavelength (S/q must be even for a clean T-chain to 32).
 */
function waveLine(y, amp, color, width, opacity) {
  const q = 8; // half-wavelength → one full wave per 16px, two per 32 → wraps at x=32
  const d = `M0 ${y} Q${q} ${y - amp} ${2 * q} ${y} T${4 * q} ${y}`;
  return path(d, 'none', { stroke: color, width, opacity });
}

/**
 * A full-width translucent wave BAND (a thick wave stroke) used to fake depth
 * banding. Same seamless geometry as waveLine; the thick stroke reads as a soft
 * trough/crest of darker or lighter water.
 */
function waveBand(y, amp, color, thickness, opacity) {
  return waveLine(y, amp, color, thickness, opacity);
}

function waterDeep() {
  const deep = TILE_PAL.waterDeep;
  const abyss = TILE_PAL.waterAbyss;
  let out = fillCell(deep.base);
  // Depth banding using the SAME wave vocabulary as waterShallow so the surface
  // texture is consistent: only base colour and opacity differ to show depth.
  // Full-width waves → seamless horizontally; identical neighbours → seamless
  // vertically. Bands sit toward the vertical centre so the field reads "deeper".
  out += waveBand(9, 2.5, deep.light, 6, 0.18);   // subtle lit band near top
  out += waveBand(22, 2.5, abyss.base, 6, 0.20);  // depth band in the middle (slightly darker)
  out += waveBand(28, 2, abyss.shade, 4, 0.12);   // faint shade trough at the bottom
  // Crisp ripple lines on top of the banding (the moving-surface read).
  out += waveLine(11, 2.5, deep.light, 1, 0.35);
  out += waveLine(24, 2.5, deep.light, 1, 0.25);
  // A few deterministic sparkle dashes for surface glint (seeded by tile name).
  out += scatter('WATER_DEEP', 4, (x, y) =>
    ellipse(x, y, 3.5, 1, deep.light, { stroke: 'none', opacity: 0.30 }), { margin: 5 });
  return out;
}

function waterShallow() {
  const shal = TILE_PAL.waterShallow;
  const wade = TILE_PAL.waterWade;
  let out = fillCell(shal.base);
  // Shallow uses the SAME wave vocabulary as waterDeep (same band positions, same
  // ripple density) so they tile together seamlessly with matching surface texture.
  // The difference is base colour (lighter) and opacity (slightly higher) to read
  // as "same water, just brighter/shallower". The wadeable light tone floats on top.
  out += waveBand(9, 2.5, wade.light, 6, 0.24);   // broad lit band near top (brighter)
  out += waveBand(22, 2.5, wade.base, 6, 0.22);   // mid-depth band (lighter than deep)
  out += waveBand(28, 2, shal.shade, 4, 0.14);    // faint shade trough at the bottom
  // Crisp ripple lines on top of the banding (same positions as deep).
  out += waveLine(5, 2, wade.light, 1, 0.40);
  out += waveLine(15, 2, wade.light, 1, 0.35);
  out += waveLine(25, 2, wade.light, 1, 0.30);
  // Deterministic light sparkle.
  out += scatter('WATER_SHALLOW', 5, (x, y) =>
    ellipse(x, y, 3.5, 1, wade.light, { stroke: 'none', opacity: 0.38 }), { margin: 5 });
  return out;
}

// --- Floors (interior) ---
function floorWood() {
  return planks(TILE_PAL.woodFloor);
}
function floorWoodDark() {
  return planks(TILE_PAL.woodFloorDark);
}
function planks(pal) {
  // horizontal plank floor: 4 boards with seam lines, offset so seams don't align to cell edge
  let out = fillCell(pal.base);
  const yStart = 4;  // offset so board seams don't fall on 0 or 31 (cell boundaries)
  for (let i = 0; i < 4; i++) {
    const y = yStart + i * 7;
    out += plainRect(0, y + 6, 32, 1, pal.shade, { opacity: 0.7 });
    // alternate slight tone so boards read distinctly
    if (i % 2 === 1) out += plainRect(0, y, 32, 6, pal.accent, { opacity: 0.25 });
  }
  return out;
}

function floorTile() {
  // 2x2 large ceramic tiles with grout seams, offset so they don't align to cell boundaries
  let out = fillCell(TILE_PAL.tileFloor.base);
  out += plainRect(0, 14, 32, 2, TILE_PAL.tileFloor.accent, { opacity: 0.8 });
  out += plainRect(14, 0, 2, 32, TILE_PAL.tileFloor.accent, { opacity: 0.8 });
  return out;
}

function floorTileChecker() {
  // checkerboard of the tile floor light/dark
  let out = fillCell(TILE_PAL.tileFloor.base);
  for (let gy = 0; gy < 2; gy++) {
    for (let gx = 0; gx < 2; gx++) {
      if ((gx + gy) % 2 === 0) continue;
      out += plainRect(gx * 16, gy * 16, 16, 16, TILE_PAL.tileFloor.accent);
    }
  }
  return out;
}

function floorConcrete() {
  return (
    fillCell(TILE_PAL.concrete.base) +
    speckles('FLOOR_CONCRETE', 8, TILE_PAL.concrete.shade, { rMin: 0.4, rMax: 0.9 })
  );
}

function penFloorStraw() {
  // concrete base littered with straw strokes
  let out = fillCell(TILE_PAL.concrete.base);
  out += scatter('PEN_FLOOR_STRAW', 14, (x, y, r, i) => {
    const len = 4 + (i % 3) * 2;
    const ang = (i % 2 === 0) ? 1 : -1;
    return T.path(`M${x} ${y} l${len * ang} ${ang}`, 'none', { stroke: TILE_PAL.straw.base, width: 1.2 });
  }, { margin: 4 });
  return out;
}

function penFloorConcrete() {
  // concrete with a drainage seam, offset from center so it doesn't align to cell edges
  return (
    fillCell(TILE_PAL.concrete.base) +
    plainRect(14, 0, 2, 32, TILE_PAL.concrete.shade, { opacity: 0.6 }) +
    speckles('PEN_FLOOR_CONCRETE', 6, TILE_PAL.concrete.shade, { rMin: 0.4, rMax: 0.9 })
  );
}

module.exports = {
  // shared so edge builders can reuse the exact materials
  ground,
  buildGrass: grass,
  buildGrassFlowers: grassFlowers,
  buildGrassPatchy: grassPatchy,
  buildDirt: dirt,
  buildDirtTrampled: dirtTrampled,
  buildCobble: cobble,
  buildCobbleWorn: cobbleWorn,
  buildPaved: paved,
  buildPavedCrack: pavedCrack,
  buildSand: sand,
  buildSandRipple: sandRipple,
  buildMud: mud,
  buildMudPuddle: mudPuddle,
  buildWaterDeep: waterDeep,
  buildWaterShallow: waterShallow,
  buildFloorWood: floorWood,
  buildFloorWoodDark: floorWoodDark,
  buildFloorTile: floorTile,
  buildFloorTileChecker: floorTileChecker,
  buildFloorConcrete: floorConcrete,
  buildPenFloorStraw: penFloorStraw,
  buildPenFloorConcrete: penFloorConcrete,
};
