'use strict';

/**
 * NATURE deco builders (indices 49..74) — TINS 2026, The Caves of Steel.
 *
 * All DECO: drawn on a TRANSPARENT cell so the ground layer shows through. The
 * object is centred (or positioned per its role). Top-lit: highlights toward the
 * top, shade toward the bottom. Soft EDGE silhouette (lighter than the sprite
 * OUTLINE) so plants read as objects, not flat blobs.
 *
 * Tree composition (world-gen places these in a 2x2-ish cluster): TREE_TRUNK sits
 * one tile BELOW the canopy. The canopy is a 2x2 crown split across four cells —
 * TREE_CANOPY (bottom-centre / main), _L (bottom-left), _R (bottom-right), _TOP
 * (the upper dome) — each cell drawing the slice of crown that overlaps it, with
 * leaf detail biased to that corner so the four tiles assemble into one tree.
 */

const T = require('../template-tile');
const { TILE_PAL, ACCENT, EDGE } = require('../tilepalette');

const { ellipse, circle, polygon, path, scatter, plainRect } = T;
const S = T.S; // 32

/** A soft leaf-edge stroke (override-able), so plant blobs read as objects. */
function leaf(opts = {}) {
  return { stroke: EDGE, width: 1, ...opts };
}

// --- Trunks ---
function treeTrunk() {
  const b = TILE_PAL.bark;
  // a solid trunk in the lower-centre, roots flaring at the base
  return (
    plainRect(13, 4, 6, 24, b.base) +
    plainRect(13, 4, 2, 24, b.light, { opacity: 0.6 }) +
    plainRect(17, 4, 2, 24, b.shade, { opacity: 0.6 }) +
    // root flare
    polygon([[10, 28], [13, 22], [13, 28]], b.shade, { stroke: 'none' }) +
    polygon([[22, 28], [19, 22], [19, 28]], b.shade, { stroke: 'none' })
  );
}

function pineTrunk() {
  const b = TILE_PAL.bark;
  return (
    plainRect(14, 8, 4, 20, b.base) +
    plainRect(14, 8, 1.5, 20, b.light, { opacity: 0.6 }) +
    plainRect(16.5, 8, 1.5, 20, b.shade, { opacity: 0.6 })
  );
}

// --- Canopies (the 2x2 crown split into 4 cells) ---
function crownBlob(cx, cy, rx, ry, pal) {
  return (
    ellipse(cx, cy, rx, ry, pal.base, leaf()) +
    ellipse(cx - rx * 0.3, cy - ry * 0.35, rx * 0.5, ry * 0.45, pal.light, { stroke: 'none' }) +
    ellipse(cx + rx * 0.35, cy + ry * 0.4, rx * 0.45, ry * 0.4, pal.shade, { stroke: 'none', opacity: 0.6 })
  );
}

// TREE_CANOPY = main/bottom-centre slice (slightly overflows to feel continuous).
function treeCanopy() {
  const p = TILE_PAL.leaf;
  return crownBlob(16, 12, 17, 15, p);
}
// bottom-left slice — crown biased to the right/up so it meets _CANOPY and _TOP.
function treeCanopyL() {
  const p = TILE_PAL.leaf;
  return crownBlob(24, 12, 16, 15, p);
}
// bottom-right slice — biased to the left/up.
function treeCanopyR() {
  const p = TILE_PAL.leaf;
  return crownBlob(8, 12, 16, 15, p);
}
// upper dome — biased downward so it caps the lower three.
function treeCanopyTop() {
  const p = TILE_PAL.leaf;
  return crownBlob(16, 22, 16, 14, p);
}

function pineCanopy() {
  const p = TILE_PAL.leafPine;
  // a stacked conifer triangle
  return (
    polygon([[16, 1], [27, 14], [5, 14]], p.base, leaf()) +
    polygon([[16, 9], [29, 26], [3, 26]], p.base, leaf()) +
    polygon([[16, 1], [20, 6], [12, 6]], p.light, { stroke: 'none' }) +
    polygon([[16, 9], [22, 17], [10, 17]], p.light, { stroke: 'none', opacity: 0.5 })
  );
}

// --- Bushes ---
function bush(name, rx, ry, pal) {
  const cy = S - ry - 2;
  return (
    ellipse(16, cy, rx, ry, pal.base, leaf()) +
    ellipse(16 - rx * 0.3, cy - ry * 0.4, rx * 0.5, ry * 0.4, pal.light, { stroke: 'none' }) +
    ellipse(16 + rx * 0.3, cy + ry * 0.3, rx * 0.4, ry * 0.3, pal.shade, { stroke: 'none', opacity: 0.6 }) +
    scatter(name, 4, (x, y, r) => circle(x, cy + (y - 16) * 0.4, r, pal.shade, { stroke: 'none', opacity: 0.4 }), { margin: 8, rMin: 1, rMax: 2 })
  );
}
function bushSm() {
  return bush('BUSH_SM', 9, 8, TILE_PAL.bush);
}
function bushLg() {
  return bush('BUSH_LG', 13, 11, TILE_PAL.bush);
}
function bushBerry() {
  return (
    bush('BUSH_BERRY', 12, 10, TILE_PAL.bush) +
    scatter('BUSH_BERRY_b', 6, (x, y) => circle(x, y, 1.4, ACCENT.berry, { stroke: 'none' }), { margin: 8 })
  );
}

// --- Rocks ---
function rock(name, rx, ry) {
  const p = TILE_PAL.rock;
  const cy = S - ry - 2;
  return (
    ellipse(16, cy, rx, ry, p.base, { stroke: EDGE, width: 1 }) +
    ellipse(16 - rx * 0.25, cy - ry * 0.35, rx * 0.5, ry * 0.4, p.light, { stroke: 'none' }) +
    ellipse(16 + rx * 0.3, cy + ry * 0.3, rx * 0.4, ry * 0.3, p.shade, { stroke: 'none', opacity: 0.6 })
  );
}
function rockSm() {
  return rock('ROCK_SM', 6, 5);
}
function rockLg() {
  return rock('ROCK_LG', 11, 9);
}
function rockFlat() {
  const p = TILE_PAL.rock;
  return (
    ellipse(16, 18, 12, 6, p.base, { stroke: EDGE, width: 1 }) +
    ellipse(16, 16, 10, 4, p.light, { stroke: 'none', opacity: 0.6 })
  );
}
function boulder() {
  const p = TILE_PAL.rock;
  return (
    polygon([[5, 26], [4, 14], [12, 6], [22, 7], [28, 16], [26, 26]], p.base, { stroke: EDGE, width: 1, 'stroke-linejoin': 'round' }) +
    polygon([[12, 6], [22, 7], [18, 14], [10, 13]], p.light, { stroke: 'none' }) +
    polygon([[26, 26], [28, 16], [22, 18], [20, 26]], p.shade, { stroke: 'none', opacity: 0.6 })
  );
}

// --- Flowers (a stem + petal cluster, walkable detail) ---
function flower(name, color) {
  const stem = TILE_PAL.bush.base;
  let out = path('M16 28 L16 18', 'none', { stroke: stem, width: 1.5 });
  // a 5-petal bloom at the top
  out += circle(16, 15, 3.2, color, { stroke: EDGE, width: 1 });
  out += circle(16, 15, 1.2, ACCENT.flowerYellow, { stroke: 'none' });
  // two leaves
  out += ellipse(13, 22, 2.5, 1.4, stem, { stroke: 'none' });
  out += ellipse(19, 24, 2.5, 1.4, stem, { stroke: 'none' });
  return out;
}
function flowerRed() {
  return flower('FLOWER_RED', ACCENT.flowerRed);
}
function flowerYellow() {
  return flower('FLOWER_YELLOW', ACCENT.flowerYellow);
}
function flowerBlue() {
  return flower('FLOWER_BLUE', ACCENT.flowerBlue);
}
function flowerBed() {
  // a tended bed: dark soil rectangle dotted with blooms
  let out = T.rect(3, 8, 26, 18, TILE_PAL.dirt.shade, { stroke: EDGE, width: 1, rx: 2 });
  const cols = [ACCENT.flowerRed, ACCENT.flowerYellow, ACCENT.flowerBlue];
  out += scatter('FLOWER_BED', 7, (x, y, r, i) => circle(x, y, 1.8, cols[i % 3], { stroke: 'none' }), { margin: 7 });
  return out;
}

// --- Tall grass / stump / log / pond plants ---
function grassTall() {
  const p = TILE_PAL.bush;
  let out = '';
  for (let i = 0; i < 7; i++) {
    const x = 6 + i * 3;
    const lean = (i % 2 === 0 ? 2 : -2);
    out += path(`M${x} 28 Q${x + lean} 18 ${x + lean * 1.5} 8`, 'none', { stroke: i % 2 ? p.base : p.shade, width: 1.5 });
  }
  return out;
}

function stump() {
  const b = TILE_PAL.bark;
  return (
    ellipse(16, 18, 9, 7, b.base, { stroke: EDGE, width: 1 }) +
    ellipse(16, 16, 7.5, 5, b.light, { stroke: 'none' }) +
    circle(16, 16, 4, b.shade, { stroke: 'none', opacity: 0.5 }) +
    circle(16, 16, 1.5, b.shade, { stroke: 'none' })
  );
}

function log() {
  const b = TILE_PAL.bark;
  return (
    T.rect(3, 12, 26, 10, b.base, { stroke: EDGE, width: 1, rx: 4 }) +
    plainRect(3, 13, 26, 2, b.light, { opacity: 0.6 }) +
    ellipse(5, 17, 2.5, 4, b.shade, { stroke: 'none' }) +
    circle(5, 17, 1.5, b.light, { stroke: 'none', opacity: 0.5 })
  );
}

function lilyPad() {
  const p = TILE_PAL.leaf;
  return (
    circle(16, 16, 8, p.base, { stroke: EDGE, width: 1 }) +
    // the pie-slice notch
    polygon([[16, 16], [24, 12], [24, 20]], TILE_PAL.waterShallow.base, { stroke: 'none' }) +
    ellipse(13, 13, 3, 2, p.light, { stroke: 'none' })
  );
}

function lilyFlower() {
  return (
    lilyPad() +
    circle(16, 16, 3.5, ACCENT.lilyFlower, { stroke: EDGE, width: 1 }) +
    circle(16, 16, 1.3, ACCENT.flowerYellow, { stroke: 'none' })
  );
}

function reeds() {
  const p = TILE_PAL.bush;
  let out = '';
  for (let i = 0; i < 5; i++) {
    const x = 8 + i * 4;
    const lean = (i % 2 === 0 ? 1.5 : -1.5);
    out += path(`M${x} 30 Q${x + lean} 16 ${x + lean} 3`, 'none', { stroke: i % 2 ? p.base : p.shade, width: 1.6 });
  }
  return out;
}

function cattails() {
  const p = TILE_PAL.bush;
  const b = TILE_PAL.bark;
  let out = reeds();
  // the brown seed-head spikes
  out += T.rect(10, 4, 2.5, 7, b.base, { stroke: 'none', rx: 1.2 });
  out += T.rect(19, 6, 2.5, 7, b.base, { stroke: 'none', rx: 1.2 });
  return out;
}

function mushroom() {
  const cap = ACCENT.mushroomCap;
  return (
    plainRect(14.5, 18, 3, 8, TILE_PAL.tileFloor.light) +
    ellipse(16, 17, 7, 5, cap, { stroke: EDGE, width: 1 }) +
    circle(13, 15, 1.2, '#ffffff', { stroke: 'none' }) +
    circle(19, 16, 1, '#ffffff', { stroke: 'none' })
  );
}

module.exports = {
  buildTreeTrunk: treeTrunk,
  buildTreeCanopy: treeCanopy,
  buildTreeCanopyL: treeCanopyL,
  buildTreeCanopyR: treeCanopyR,
  buildTreeCanopyTop: treeCanopyTop,
  buildPineTrunk: pineTrunk,
  buildPineCanopy: pineCanopy,
  buildBushSm: bushSm,
  buildBushLg: bushLg,
  buildBushBerry: bushBerry,
  buildRockSm: rockSm,
  buildRockLg: rockLg,
  buildRockFlat: rockFlat,
  buildBoulder: boulder,
  buildFlowerRed: flowerRed,
  buildFlowerYellow: flowerYellow,
  buildFlowerBlue: flowerBlue,
  buildFlowerBed: flowerBed,
  buildGrassTall: grassTall,
  buildStump: stump,
  buildLog: log,
  buildLilyPad: lilyPad,
  buildLilyFlower: lilyFlower,
  buildReeds: reeds,
  buildCattails: cattails,
  buildMushroom: mushroom,
};
