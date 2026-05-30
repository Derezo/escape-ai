'use strict';

/**
 * NATURE deco builders (indices 49..74) — TINS 2026, Escape AI.
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
  // Use a darker shade of the leaf color instead of near-black EDGE for softer definition
  return { stroke: TILE_PAL.leaf.shade, width: 1, opacity: 0.7, ...opts };
}

// --- Trunks ---
function treeTrunk() {
  const b = TILE_PAL.bark;
  // Trunk fills the upper part of its cell (y=0..top) so the canopy cell directly
  // ABOVE overlaps it with no grass gap, then narrows with a root flare at the base.
  return (
    plainRect(13, 0, 6, 26, b.base) +
    plainRect(13, 0, 2, 26, b.light, { opacity: 0.6 }) +
    plainRect(17, 0, 2, 26, b.shade, { opacity: 0.6 }) +
    // root flare at the bottom
    polygon([[9, 30], [13, 24], [13, 30]], b.shade, { stroke: 'none' }) +
    polygon([[23, 30], [19, 24], [19, 30]], b.shade, { stroke: 'none' }) +
    plainRect(13, 24, 6, 6, b.base)
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

// --- Canopies ---
// A tree is ONE canopy cell directly above ONE trunk cell (world-gen places
// TREE_CANOPY over TREE_TRUNK). Each canopy tile is therefore a complete, self-
// contained round crown that fills its own cell: it reaches the cell bottom (y~31)
// so the trunk below meets it with no gap, and stays within the cell width so
// neighbouring trees never overlap. The crown is layered (base silhouette + light
// foliage lobes + shade pockets) so it reads as foliage, not a flat blob.
// _L/_R/_TOP are alternate standalone crowns (seeded differently) kept as valid
// tiles for variety; they are not assembled into a multi-cell tree.
function fullCrown(seed) {
  const p = TILE_PAL.leaf;
  // Base silhouette: a round crown centred high, plus a lower lobe that fills down
  // toward the trunk join so there is no grass gap at the canopy/trunk seam.
  let out =
    ellipse(16, 15, 15, 14, p.base, leaf()) +
    ellipse(16, 25, 12, 8, p.base, { stroke: 'none' });
  // Light foliage lobes — deterministic per seed so the 4 canopy tiles look distinct.
  out += scatter('TREECROWN_l_' + seed, 5, (x, y, r) =>
    ellipse(x, y, r * 1.7, r * 1.5, p.light, { stroke: 'none', opacity: 0.8 }),
    { rMin: 2.6, rMax: 4, margin: 7 });
  // Shade pockets for depth — fewer, biased low.
  out += scatter('TREECROWN_s_' + seed, 3, (x, y, r) =>
    ellipse(x, y, r * 1.5, r * 1.4, p.shade, { stroke: 'none', opacity: 0.4 }),
    { rMin: 2, rMax: 3, margin: 8 });
  return out;
}
function treeCanopy() {
  return fullCrown(0);
}
function treeCanopyTop() {
  return fullCrown(1);
}
function treeCanopyL() {
  return fullCrown(2);
}
function treeCanopyR() {
  return fullCrown(3);
}

function pineCanopy() {
  const p = TILE_PAL.leafPine;
  // a stacked conifer triangle with soft outline
  const softEdge = { stroke: p.shade, width: 1, opacity: 0.7 };
  return (
    polygon([[16, 1], [27, 14], [5, 14]], p.base, softEdge) +
    polygon([[16, 9], [29, 26], [3, 26]], p.base, softEdge) +
    polygon([[16, 1], [20, 6], [12, 6]], p.light, { stroke: 'none' }) +
    polygon([[16, 9], [22, 17], [10, 17]], p.light, { stroke: 'none', opacity: 0.5 })
  );
}

// --- Bushes ---
function bush(name, rx, ry, pal) {
  const cy = S - ry - 2;
  const softEdge = { stroke: pal.shade, width: 1, opacity: 0.7 };
  return (
    ellipse(16, cy, rx, ry, pal.base, softEdge) +
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
