'use strict';

/**
 * TERRAIN / ground tile builders (indices 1..24) — TINS 2026, The Caves of Steel.
 *
 * All are FULL-BLEED (fillCell) + seamless: the top-lit band is full-width and
 * scatter detail is deterministic (seeded by tile name) and kept off the cell
 * seams, so neighbouring same-material tiles read as continuous ground. No
 * stroked borders (they'd draw grid lines between abutting tiles).
 */

const T = require('../template-tile');
const { TILE_PAL, ACCENT } = require('../tilepalette');

const { fillCell, topLight, bottomShade, plainRect, scatter, circle, ellipse } = T;

/** Common ground base: full fill + top-lit highlight + bottom contact shade. */
function ground(pal) {
  return fillCell(pal.base) + topLight(pal.light, 3, 0.5) + bottomShade(pal.shade, 3, 0.45);
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
  // a grid of rounded stones
  let out = ground(TILE_PAL.cobble);
  const c = TILE_PAL.cobble;
  for (let gy = 0; gy < 4; gy++) {
    for (let gx = 0; gx < 4; gx++) {
      const x = gx * 8 + 4;
      const y = gy * 8 + 4;
      const tone = (gx + gy) % 2 === 0 ? c.shade : c.accent;
      out += ellipse(x, y, 3.2, 3, tone, { stroke: 'none' });
    }
  }
  return out;
}

function cobbleWorn() {
  // same stone grid, plus worn dark scuffs between the stones
  return cobble() + speckles('COBBLE_WORN', 6, TILE_PAL.cobble.shade, { rMin: 0.8, rMax: 1.6 });
}

function paved() {
  // smooth paving with a faint seam grid
  return (
    ground(TILE_PAL.paved) +
    plainRect(0, 15, 32, 1, TILE_PAL.paved.shade, { opacity: 0.4 }) +
    plainRect(15, 0, 1, 32, TILE_PAL.paved.shade, { opacity: 0.4 })
  );
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
  return (
    ground(TILE_PAL.mud) +
    ellipse(16, 17, 10, 7, TILE_PAL.waterShallow.base, { stroke: 'none' }) +
    ellipse(16, 16, 9, 6, TILE_PAL.waterShallow.light, { stroke: 'none', opacity: 0.5 })
  );
}

// --- Water (full-bleed; deep is solid, shallow is wadeable) ---
function waterDeep() {
  return (
    fillCell(TILE_PAL.waterDeep.base) +
    topLight(TILE_PAL.waterDeep.light, 4, 0.4) +
    scatter('WATER_DEEP', 4, (x, y) => ellipse(x, y, 4, 1.2, TILE_PAL.waterDeep.light, { stroke: 'none', opacity: 0.35 }), { margin: 5 })
  );
}

function waterShallow() {
  return (
    fillCell(TILE_PAL.waterShallow.base) +
    topLight(TILE_PAL.waterShallow.light, 4, 0.5) +
    scatter('WATER_SHALLOW', 5, (x, y) => ellipse(x, y, 4.5, 1.3, TILE_PAL.waterShallow.light, { stroke: 'none', opacity: 0.4 }), { margin: 5 })
  );
}

// --- Floors (interior) ---
function floorWood() {
  return planks(TILE_PAL.woodFloor);
}
function floorWoodDark() {
  return planks(TILE_PAL.woodFloorDark);
}
function planks(pal) {
  // horizontal plank floor: 4 boards with seam lines
  let out = fillCell(pal.base);
  for (let i = 0; i < 4; i++) {
    const y = i * 8;
    out += plainRect(0, y + 7, 32, 1, pal.shade, { opacity: 0.7 });
    // alternate slight tone so boards read distinctly
    if (i % 2 === 1) out += plainRect(0, y, 32, 7, pal.accent, { opacity: 0.25 });
  }
  out += topLight(pal.light, 2, 0.4);
  return out;
}

function floorTile() {
  // 2x2 large ceramic tiles with grout seams
  let out = fillCell(TILE_PAL.tileFloor.base);
  out += plainRect(0, 15, 32, 2, TILE_PAL.tileFloor.accent, { opacity: 0.8 });
  out += plainRect(15, 0, 2, 32, TILE_PAL.tileFloor.accent, { opacity: 0.8 });
  out += topLight(TILE_PAL.tileFloor.light, 2, 0.5);
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
    topLight(TILE_PAL.concrete.light, 2, 0.4) +
    bottomShade(TILE_PAL.concrete.shade, 2, 0.4) +
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
  // concrete with a drainage seam down the middle
  return (
    fillCell(TILE_PAL.concrete.base) +
    topLight(TILE_PAL.concrete.light, 2, 0.4) +
    plainRect(15, 0, 2, 32, TILE_PAL.concrete.shade, { opacity: 0.6 }) +
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
