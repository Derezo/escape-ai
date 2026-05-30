'use strict';

/**
 * ZOO HOUSING builders (indices 119..132) — TINS 2026, Escape AI.
 *
 * The enclosure vocabulary: low walls, glass panels, moats/ponds, aviary mesh,
 * rocky dens, heat-lamp floor, nests, burrows, a shade cloth (roof) and the keeper
 * gate. Ground-layer tiles (POND_*, HEAT_LAMP_FLOOR) are full-bleed; the rest are
 * deco/roof drawn on transparent so the ground shows. Metal reuses the robot steel.
 */

const T = require('../template-tile');
const { TILE_PAL, ACCENT, EDGE } = require('../tilepalette');

const { plainRect, fillCell, topLight, bottomShade, ellipse, circle, polygon, scatter } = T;
const S = T.S; // 32
const H = S / 2;

// --- Low enclosure wall (a knee-high barrier) ---
function enclosureWallLow() {
  const p = TILE_PAL.wall;
  return (
    plainRect(0, 12, S, 16, p.base) +
    plainRect(0, 12, S, 3, p.light, { opacity: 0.7 }) +
    plainRect(0, 25, S, 3, p.shade, { opacity: 0.6 }) +
    // a flat cap rail
    plainRect(0, 10, S, 3, p.shade)
  );
}

// --- Glass viewing panel ---
function enclosureGlass() {
  const g = TILE_PAL.glass;
  const m = TILE_PAL.metal;
  let out = plainRect(2, 2, S - 4, S - 4, g.base, { opacity: 0.85 });
  // diagonal sheen
  out += polygon([[4, 26], [14, 4], [20, 4], [10, 26]], g.light, { stroke: 'none', opacity: 0.5 });
  // steel frame
  out += plainRect(2, 2, S - 4, 2, m.base) + plainRect(2, S - 4, S - 4, 2, m.base);
  out += plainRect(2, 2, 2, S - 4, m.base) + plainRect(S - 4, 2, 2, S - 4, m.base);
  return out;
}

// --- Moat edge (water meeting a stone lip) ---
function moatEdge() {
  let out = fillCell(TILE_PAL.waterDeep.base);
  out += plainRect(0, 0, S, 9, TILE_PAL.rock.base); // the stone lip along the top
  out += plainRect(0, 0, S, 3, TILE_PAL.rock.light, { opacity: 0.6 });
  out += plainRect(0, 9, S, 2, TILE_PAL.rock.shade);
  out += topLight(TILE_PAL.waterDeep.light, 2, 0.3);
  return out;
}

// --- Pond (ground layer, full-bleed) ---
function pondDeep() {
  return (
    fillCell(TILE_PAL.waterDeep.base) +
    topLight(TILE_PAL.waterDeep.light, 4, 0.35) +
    scatter('POND_DEEP', 3, (x, y) => ellipse(x, y, 4, 1.2, TILE_PAL.waterDeep.light, { stroke: 'none', opacity: 0.3 }), { margin: 6 })
  );
}
function pondEdge() {
  // shallow water meeting a sandy/muddy shore
  let out = fillCell(TILE_PAL.waterShallow.base);
  out += plainRect(0, S - 8, S, 8, TILE_PAL.sand.base, { opacity: 0.9 });
  out += plainRect(0, S - 8, S, 2, TILE_PAL.sand.light, { opacity: 0.6 });
  return out;
}

// --- Aviary (mesh + frame, steel) ---
function aviaryMesh() {
  const m = TILE_PAL.metal;
  let out = '';
  // a fine diagonal lattice (hatch both ways)
  for (let i = -1; i < 6; i++) {
    out += T.path(`M${i * 6} 0 L${i * 6 + 32} 32`, 'none', { stroke: m.base, width: 0.8, opacity: 0.8 });
    out += T.path(`M${i * 6 + 32} 0 L${i * 6} 32`, 'none', { stroke: m.shade, width: 0.8, opacity: 0.6 });
  }
  return out;
}
function aviaryFrame() {
  const m = TILE_PAL.metal;
  return (
    aviaryMesh() +
    plainRect(0, 0, S, 3, m.base) + plainRect(0, S - 3, S, 3, m.base) +
    plainRect(0, 0, 3, S, m.base) + plainRect(S - 3, 0, 3, S, m.base) +
    plainRect(0, 0, S, 1.5, m.light, { opacity: 0.7 })
  );
}

// --- Rocky den (an artificial rock structure) ---
function rockyDenMouth() {
  const r = TILE_PAL.rock;
  let out = plainRect(0, 0, S, S, r.base);
  out += topLight(r.light, 4, 0.5);
  // the dark cave opening
  out += ellipse(16, 22, 11, 10, '#0c0e12', { stroke: 'none' });
  out += ellipse(16, 20, 9, 7, '#1a1c22', { stroke: 'none' });
  out += scatter('ROCKY_DEN_MOUTH', 6, (x, y, rr) => circle(x, y, rr, r.shade, { stroke: 'none', opacity: 0.4 }), { margin: 4, rMax: 1.6 });
  return out;
}
function rockyDenWall() {
  const r = TILE_PAL.rock;
  let out = plainRect(0, 0, S, S, r.base);
  out += topLight(r.light, 4, 0.5) + bottomShade(r.shade, 5, 0.5);
  // chunky rock facets
  out += polygon([[2, 10], [12, 4], [16, 12], [6, 16]], r.light, { stroke: 'none', opacity: 0.4 });
  out += polygon([[18, 6], [30, 10], [28, 20], [18, 16]], r.shade, { stroke: 'none', opacity: 0.4 });
  out += scatter('ROCKY_DEN_WALL', 6, (x, y, rr) => circle(x, y, rr, r.shade, { stroke: 'none', opacity: 0.35 }), { margin: 4, rMax: 1.6 });
  return out;
}

// --- Heat lamp floor (ground; warm glow on concrete) ---
function heatLampFloor() {
  let out = fillCell(TILE_PAL.concrete.base);
  out += ellipse(16, 16, 13, 13, ACCENT.lamp, { stroke: 'none', opacity: 0.45 });
  out += ellipse(16, 16, 8, 8, ACCENT.lamp, { stroke: 'none', opacity: 0.5 });
  out += circle(16, 16, 3, '#ffcf6a', { stroke: 'none', opacity: 0.8 });
  return out;
}

// --- Nest (a ring of twigs with eggs) ---
function nest() {
  const b = TILE_PAL.bark;
  let out = ellipse(16, 18, 12, 9, b.shade, { stroke: EDGE, width: 1 });
  out += ellipse(16, 18, 8, 6, b.base, { stroke: 'none' });
  out += ellipse(16, 17, 6, 4, TILE_PAL.dirt.shade, { stroke: 'none' });
  // a couple of pale eggs
  out += ellipse(14, 17, 2, 2.6, '#efe7d2', { stroke: 'none' });
  out += ellipse(18, 18, 2, 2.6, '#efe7d2', { stroke: 'none' });
  return out;
}

// --- Burrow mound (a dirt hill with a hole) ---
function burrowMound() {
  const d = TILE_PAL.dirt;
  let out = ellipse(16, 20, 13, 9, d.base, { stroke: EDGE, width: 1 });
  out += ellipse(16, 17, 10, 6, d.light, { stroke: 'none', opacity: 0.5 });
  out += ellipse(16, 21, 5, 4, '#14100a', { stroke: 'none' }); // the hole
  return out;
}

// --- Shade cloth (roof layer; a stretched canopy) ---
function shadeCloth() {
  const c = TILE_PAL.metalDark;
  let out = fillCell(c.base);
  // sag lines suggesting fabric
  for (let i = 0; i < 4; i++) {
    const y = 4 + i * 8;
    out += T.path(`M0 ${y} Q16 ${y + 3} 32 ${y}`, 'none', { stroke: c.shade, width: 1, opacity: 0.7 });
  }
  out += topLight(c.light, 2, 0.3);
  return out;
}

// --- Keeper gate (a steel service gate; walkable) ---
function keeperGate() {
  const m = TILE_PAL.metal;
  let out = plainRect(3, 3, 26, 26, 'none');
  // frame
  out += plainRect(3, 3, 26, 2, m.base) + plainRect(3, 27, 26, 2, m.base);
  out += plainRect(3, 3, 2, 26, m.base) + plainRect(27, 3, 2, 26, m.base);
  // a hazard chevron + bars
  out += plainRect(8, 6, 16, 20, m.shade, { opacity: 0.4 });
  out += polygon([[8, 26], [14, 6], [18, 6], [12, 26]], ACCENT.signYellow, { stroke: 'none', opacity: 0.85 });
  out += circle(16, 16, 2, m.light, { stroke: EDGE, width: 1 }); // latch
  return out;
}

module.exports = {
  buildEnclosureWallLow: enclosureWallLow,
  buildEnclosureGlass: enclosureGlass,
  buildMoatEdge: moatEdge,
  buildPondDeep: pondDeep,
  buildPondEdge: pondEdge,
  buildAviaryMesh: aviaryMesh,
  buildAviaryFrame: aviaryFrame,
  buildRockyDenMouth: rockyDenMouth,
  buildRockyDenWall: rockyDenWall,
  buildHeatLampFloor: heatLampFloor,
  buildNest: nest,
  buildBurrowMound: burrowMound,
  buildShadeCloth: shadeCloth,
  buildKeeperGate: keeperGate,
};
