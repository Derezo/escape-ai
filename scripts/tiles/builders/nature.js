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
  // A short barked stub with a lit/shaded side, bark grain, and a small root flare
  // so the conifer above has a believable base.
  let out = plainRect(14, 6, 4, 22, b.base);
  out += plainRect(14, 6, 1.4, 22, b.light, { opacity: 0.6 });   // lit side
  out += plainRect(16.6, 6, 1.4, 22, b.shade, { opacity: 0.6 }); // shade side
  // bark grain striations
  for (let i = 0; i < 4; i++) {
    out += path(`M15 ${(9 + i * 5).toFixed(1)} l2 1`, 'none', { stroke: TILE_PAL.bark.deep, width: 0.6, opacity: 0.5 });
  }
  // root flare
  out += polygon([[11, 28], [14, 23], [14, 28]], b.shade, { stroke: 'none' });
  out += polygon([[21, 28], [18, 23], [18, 28]], b.shade, { stroke: 'none' });
  return out;
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
  // A layered conifer: three overlapping green tiers (widening downward), each with
  // a shaded base band, a lit left flank, and a serrated lower edge so the boughs
  // read as needled tiers rather than flat triangles. Soft outline (no hard black).
  const softEdge = { stroke: TILE_PAL.leafPine.deep, width: 1, opacity: 0.75 };
  // serrated bottom for a tier: a row of little notches along the base line.
  const tier = (apexY, baseY, halfW, cy) => {
    const xl = 16 - halfW, xr = 16 + halfW;
    let pts = [[16, apexY], [xr, baseY]];
    // serrate the base from right to left
    const teeth = 5;
    for (let i = 0; i <= teeth; i++) {
      const t = i / teeth;
      const bx = xr - t * (xr - xl);
      const by = baseY - (i % 2 === 0 ? 0 : 1.6);
      pts.push([bx, by]);
    }
    pts.push([xl, baseY]);
    let s = polygon(pts, p.base, softEdge);
    // shaded base band (depth where the next tier sits on it)
    s += polygon([[xl + 1, baseY - 2], [xr - 1, baseY - 2], [xr - 2, baseY - 0.5], [xl + 2, baseY - 0.5]], p.shade, { stroke: 'none', opacity: 0.7 });
    // lit left flank
    s += polygon([[16, apexY], [16 - halfW * 0.5, (apexY + baseY) / 2], [16 - halfW * 0.2, (apexY + baseY) / 2]], p.light, { stroke: 'none', opacity: 0.7 });
    return s;
  };
  let out = tier(1, 12, 7, 6);     // top tier
  out += tier(7, 20, 10, 13);      // middle tier
  out += tier(14, 27, 13, 20);     // bottom tier
  // a tiny snow-free green crown tuft at the very tip
  out += circle(16, 2, 1.4, p.light, { stroke: 'none', opacity: 0.6 });
  return out;
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
// A faceted stone: a base ellipse, then a hard-edged top facet (lit) and a lower
// facet (shaded) split by a crack line, plus grain striations and moss specks —
// so it reads as cracked stone, not a smooth pebble. Deterministic per `name`.
function rock(name, rx, ry) {
  const p = TILE_PAL.rock;
  const cy = S - ry - 2;
  let out = ellipse(16, cy, rx, ry, p.base, { stroke: EDGE, width: 1 });
  // A hard upper facet (the lit plane) — a polygon, not a soft blob.
  out += polygon([
    [16 - rx * 0.7, cy - ry * 0.15], [16 - rx * 0.2, cy - ry * 0.8],
    [16 + rx * 0.55, cy - ry * 0.55], [16 + rx * 0.2, cy + ry * 0.1],
  ], p.light, { stroke: 'none' });
  // A lower-right facet in shade for volume.
  out += polygon([
    [16 + rx * 0.2, cy + ry * 0.1], [16 + rx * 0.85, cy - ry * 0.1],
    [16 + rx * 0.6, cy + ry * 0.6], [16 - rx * 0.1, cy + ry * 0.55],
  ], p.shade, { stroke: 'none', opacity: 0.7 });
  // Crack + grain striations across the face (the facet seam, then thinner grain).
  out += path(`M${(16 - rx * 0.2).toFixed(1)} ${(cy - ry * 0.8).toFixed(1)} L${(16 + rx * 0.2).toFixed(1)} ${(cy + ry * 0.1).toFixed(1)} L${(16 - rx * 0.1).toFixed(1)} ${(cy + ry * 0.55).toFixed(1)}`,
    'none', { stroke: TILE_PAL.rock.crack, width: 0.8, opacity: 0.8 });
  out += scatter(name + '_g', 3, (x, y) =>
    path(`M${x} ${y} l${(rx * 0.3).toFixed(1)} ${(ry * 0.12).toFixed(1)}`, 'none', { stroke: TILE_PAL.rock.grain, width: 0.6, opacity: 0.7 }),
    { margin: rx > 8 ? 11 : 12, rMin: 0, rMax: 0 });
  // Moss specks clinging low on the stone.
  out += scatter(name + '_m', 4, (x, y, r) =>
    circle(x, cy + (y - 16) * 0.3 + ry * 0.3, r, TILE_PAL.moss.base, { stroke: 'none', opacity: 0.7 }),
    { margin: 9, rMin: 0.8, rMax: 1.6 });
  return out;
}
function rockSm() {
  return rock('ROCK_SM', 6, 5);
}
function rockLg() {
  return rock('ROCK_LG', 11, 9);
}
function rockFlat() {
  const p = TILE_PAL.rock;
  // A low slab: base disc, a lit top plane, a crack across it, grain + moss.
  let out = ellipse(16, 18, 12, 6, p.base, { stroke: EDGE, width: 1 });
  out += ellipse(16, 16, 10, 4, p.light, { stroke: 'none', opacity: 0.7 });
  // a few cracks fanning across the slab
  out += path('M7 17 L15 15 L22 18', 'none', { stroke: TILE_PAL.rock.crack, width: 0.8, opacity: 0.8 });
  out += path('M19 14 L21 19', 'none', { stroke: TILE_PAL.rock.crack, width: 0.7, opacity: 0.6 });
  // grain striations along the slab
  out += scatter('ROCK_FLAT_g', 4, (x, y) =>
    path(`M${x} ${(15 + (y - 16) * 0.2).toFixed(1)} l5 0.8`, 'none', { stroke: TILE_PAL.rock.grain, width: 0.6, opacity: 0.6 }),
    { margin: 8, rMin: 0, rMax: 0 });
  // moss on the shaded near edge
  out += scatter('ROCK_FLAT_m', 4, (x) =>
    circle(x, 20 + (x % 3), 1.2, TILE_PAL.moss.base, { stroke: 'none', opacity: 0.7 }),
    { margin: 8, rMin: 0, rMax: 0 });
  return out;
}
function boulder() {
  const p = TILE_PAL.rock;
  // A big angular boulder built from hard facets: a lit top-left plane, a darker
  // right plane, and a shaded base, seamed by cracks with grain + moss for texture.
  let out = polygon([[5, 26], [4, 14], [12, 6], [22, 7], [28, 16], [26, 26]], p.base, { stroke: EDGE, width: 1, 'stroke-linejoin': 'round' });
  // top-left lit facet
  out += polygon([[12, 6], [22, 7], [18, 14], [9, 13], [6, 16], [4, 14]], p.light, { stroke: 'none' });
  // right shaded facet
  out += polygon([[28, 16], [22, 7], [18, 14], [20, 26], [26, 26]], p.shade, { stroke: 'none', opacity: 0.7 });
  // base shadow wedge
  out += polygon([[5, 26], [4, 14], [9, 13], [10, 26]], p.shade, { stroke: 'none', opacity: 0.35 });
  // facet-seam cracks
  out += path('M18 14 L9 13 M18 14 L20 26 M18 14 L22 7', 'none', { stroke: TILE_PAL.rock.crack, width: 0.9, opacity: 0.8 });
  out += path('M12 6 L10 13 M6 16 L11 18', 'none', { stroke: TILE_PAL.rock.crack, width: 0.7, opacity: 0.6 });
  // grain striations across the lit plane
  out += scatter('BOULDER_g', 4, (x, y) =>
    path(`M${x} ${y} l4 1`, 'none', { stroke: TILE_PAL.rock.grain, width: 0.6, opacity: 0.6 }),
    { margin: 9, rMin: 0, rMax: 0 });
  // moss specks low on the stone
  out += scatter('BOULDER_m', 5, (x, y, r) =>
    circle(x, 18 + (y - 16) * 0.4, r, TILE_PAL.moss.base, { stroke: 'none', opacity: 0.7 }),
    { margin: 8, rMin: 0.9, rMax: 1.6 });
  return out;
}

// --- Flowers (a stem + leaves + a layered, readable bloom) ---
// A bloom = 6 overlapping petal circles in a ring (in petal.shade so adjacent
// petals separate), each topped with a smaller petal.light dab, then a centre.
// `pal` is a 3-tone family from the palette so the bloom shades consistently.
function bloom(name, cx, cy, R, pal) {
  let out = '';
  const N = 6;
  // back ring (shade) — the petals' undersides peeking between the front petals.
  for (let i = 0; i < N; i++) {
    const a = (i / N) * Math.PI * 2 + 0.5;
    const px = cx + Math.cos(a) * R * 0.95;
    const py = cy + Math.sin(a) * R * 0.95;
    out += ellipse(px, py, R * 0.62, R * 0.5, pal.shade, { stroke: 'none' });
  }
  // front ring (base) — the visible petal faces, offset slightly toward centre.
  for (let i = 0; i < N; i++) {
    const a = (i / N) * Math.PI * 2 + 0.5;
    const px = cx + Math.cos(a) * R * 0.7;
    const py = cy + Math.sin(a) * R * 0.7;
    out += ellipse(px, py, R * 0.58, R * 0.46, pal.base, { stroke: 'none' });
    // a light glint on each petal toward the top (top-lit).
    out += circle(px - R * 0.1, py - R * 0.18, R * 0.2, pal.light, { stroke: 'none', opacity: 0.85 });
  }
  // centre disc.
  out += circle(cx, cy, R * 0.42, ACCENT.flowerYellow, { stroke: 'none' });
  out += circle(cx, cy, R * 0.22, TILE_PAL.bark.base, { stroke: 'none', opacity: 0.6 });
  return out;
}
function flower(name, pal) {
  const stem = TILE_PAL.bush;
  // curved stem
  let out = path('M16 29 Q14 22 16 16', 'none', { stroke: stem.shade, width: 1.6 });
  // two leaves with a little vein
  out += ellipse(11.5, 22, 3, 1.6, stem.base, { stroke: 'none' });
  out += path('M9 22 L14 21.5', 'none', { stroke: stem.shade, width: 0.6, opacity: 0.7 });
  out += ellipse(20.5, 24, 3, 1.6, stem.base, { stroke: 'none' });
  out += path('M23 24 L18 23.5', 'none', { stroke: stem.shade, width: 0.6, opacity: 0.7 });
  // the bloom, centred high
  out += bloom(name, 16, 12, 5.4, pal);
  return out;
}
function flowerRed() {
  return flower('FLOWER_RED', TILE_PAL.petalRed);
}
function flowerYellow() {
  return flower('FLOWER_YELLOW', TILE_PAL.petalYellow);
}
function flowerBlue() {
  return flower('FLOWER_BLUE', TILE_PAL.petalBlue);
}
function flowerBed() {
  // a tended bed: dark soil with a raised lip, rows of little layered blooms.
  let out = T.rect(3, 8, 26, 18, TILE_PAL.dirt.shade, { stroke: EDGE, width: 1, rx: 2 });
  out += plainRect(4, 9, 24, 2, TILE_PAL.dirt.base, { opacity: 0.5 }); // lit top lip
  // tilled soil grooves
  out += scatter('FLOWER_BED_soil', 5, (x, y) =>
    path(`M${x} ${y} l5 0`, 'none', { stroke: TILE_PAL.dirt.base, width: 0.6, opacity: 0.4 }),
    { margin: 6, rMin: 0, rMax: 0 });
  const pals = [TILE_PAL.petalRed, TILE_PAL.petalYellow, TILE_PAL.petalBlue];
  // six small blooms in two rows.
  const spots = [[8, 14], [16, 13], [24, 14], [10, 21], [18, 22], [25, 21]];
  for (let i = 0; i < spots.length; i++) {
    out += bloom('FLOWER_BED_' + i, spots[i][0], spots[i][1], 2.8, pals[i % 3]);
  }
  return out;
}

// --- Tall grass / stump / log / pond plants ---
function grassTall() {
  const p = TILE_PAL.bush;
  // A dense tuft: a small clump of base at the root, then a fan of tapered blades
  // (two-tone, leaning out from the centre) so it reads as a grass clump.
  let out = ellipse(16, 28, 8, 2.5, p.shade, { stroke: 'none', opacity: 0.6 });
  const blades = [
    { x: 16, lean: 0, top: 4 },
    { x: 13, lean: -4, top: 6 }, { x: 19, lean: 4, top: 6 },
    { x: 10, lean: -7, top: 10 }, { x: 22, lean: 7, top: 10 },
    { x: 14, lean: -2, top: 5 }, { x: 18, lean: 2, top: 5 },
    { x: 8, lean: -9, top: 14 }, { x: 24, lean: 9, top: 14 },
  ];
  for (let i = 0; i < blades.length; i++) {
    const b = blades[i];
    const tip = b.x + b.lean;
    const col = i % 3 === 0 ? p.shade : i % 3 === 1 ? p.base : p.light;
    // a filled tapered blade (wide at the root, point at the tip)
    out += polygon([
      [b.x - 1.2, 29], [b.x + 1.2, 29], [tip, b.top],
    ], col, { stroke: 'none' });
  }
  return out;
}

function stump() {
  const b = TILE_PAL.bark;
  // A cut stump seen slightly from above: a side wall (bark), a lit top ellipse,
  // and concentric growth RINGS with a couple of radial cracks + moss at the base.
  let out = '';
  // side wall (the bark, dropping below the top face)
  out += T.rect(7, 16, 18, 9, b.shade, { stroke: EDGE, width: 1, rx: 3 });
  out += plainRect(7, 23, 18, 2, TILE_PAL.bark.deep, { opacity: 0.6 }); // contact shadow
  // bark texture striations on the wall
  out += scatter('STUMP_bark', 4, (x) =>
    path(`M${x} 17 l0 7`, 'none', { stroke: TILE_PAL.bark.deep, width: 0.7, opacity: 0.5 }),
    { margin: 8, rMin: 0, rMax: 0 });
  // the cut top face
  out += ellipse(16, 15, 9, 6, b.light, { stroke: EDGE, width: 1 });
  // growth rings (concentric, alternating shade/base toward a dark heart)
  out += ellipse(16, 15, 6.8, 4.5, b.base, { stroke: 'none' });
  out += ellipse(16, 15, 5, 3.3, b.light, { stroke: 'none', opacity: 0.8 });
  out += ellipse(16, 15, 3.2, 2.1, b.shade, { stroke: 'none', opacity: 0.7 });
  out += ellipse(16, 15, 1.3, 0.9, TILE_PAL.bark.deep, { stroke: 'none' });
  // two radial cracks across the rings
  out += path('M16 15 L9 12', 'none', { stroke: TILE_PAL.bark.deep, width: 0.7, opacity: 0.7 });
  out += path('M16 15 L22 18', 'none', { stroke: TILE_PAL.bark.deep, width: 0.7, opacity: 0.7 });
  // moss creeping at the base
  out += scatter('STUMP_moss', 3, (x, y, r) =>
    circle(x, 24 + (y - 16) * 0.1, r, TILE_PAL.moss.base, { stroke: 'none', opacity: 0.7 }),
    { margin: 9, rMin: 1, rMax: 1.6 });
  return out;
}

function log() {
  const b = TILE_PAL.bark;
  // A fallen log: a barked cylinder with a lit top stripe + shade underside, end
  // caps showing rings, and length-wise bark grain so it reads as timber.
  let out = T.rect(3, 12, 26, 11, b.base, { stroke: EDGE, width: 1, rx: 5 });
  out += plainRect(4, 13, 24, 2.5, b.light, { opacity: 0.6 });          // top-lit stripe
  out += plainRect(4, 20, 24, 2, TILE_PAL.bark.deep, { opacity: 0.5 }); // shaded underside
  // length-wise bark grain
  out += scatter('LOG_grain', 5, (x) =>
    path(`M5 ${(15 + (x % 5)).toFixed(1)} l22 0`, 'none', { stroke: TILE_PAL.bark.deep, width: 0.6, opacity: 0.4 }),
    { margin: 6, rMin: 0, rMax: 0 });
  // left end cap with rings
  out += ellipse(5, 17.5, 2.6, 5, b.shade, { stroke: EDGE, width: 1 });
  out += ellipse(5, 17.5, 1.7, 3.2, b.base, { stroke: 'none' });
  out += ellipse(5, 17.5, 0.8, 1.5, b.light, { stroke: 'none' });
  // a knot on the bark
  out += ellipse(20, 17, 1.6, 2.4, TILE_PAL.bark.deep, { stroke: 'none', opacity: 0.6 });
  return out;
}

function lilyPad() {
  const p = TILE_PAL.leaf;
  // A round pad with the classic wedge notch, radial vein lines and a lit rim.
  let out = circle(16, 16, 8.5, p.base, { stroke: EDGE, width: 1 });
  out += circle(16, 16, 8.5, p.shade, { stroke: 'none', opacity: 0.0 });
  // lit upper-left rim
  out += path('M9 13 A8.5 8.5 0 0 1 18 9', 'none', { stroke: p.light, width: 1.4, opacity: 0.8 });
  // the pie-slice notch (cut to the water)
  out += polygon([[16, 16], [24.5, 12.5], [24.5, 19.5]], TILE_PAL.waterShallow.base, { stroke: 'none' });
  // radial veins
  out += path('M16 16 L11 9 M16 16 L10 16 M16 16 L12 22 M16 16 L18 23', 'none', { stroke: p.shade, width: 0.7, opacity: 0.7 });
  out += ellipse(12.5, 12.5, 2.6, 1.6, p.light, { stroke: 'none', opacity: 0.6 });
  return out;
}

function lilyFlower() {
  // A distinct waterlily bloom sitting ON a pad: an outer ring of pale petals,
  // an inner ring, and a golden centre — clearly a flower, not just a dot.
  let out = lilyPad();
  const lp = TILE_PAL.lily;
  // outer petals (pointed, in a ring)
  const N = 6;
  for (let i = 0; i < N; i++) {
    const a = (i / N) * Math.PI * 2;
    const px = 16 + Math.cos(a) * 3.6;
    const py = 16 + Math.sin(a) * 3.6;
    out += ellipse(px, py, 2.4, 1.5, lp.shade, { stroke: 'none' });
  }
  for (let i = 0; i < N; i++) {
    const a = (i / N) * Math.PI * 2 + Math.PI / N;
    const px = 16 + Math.cos(a) * 2.6;
    const py = 16 + Math.sin(a) * 2.6;
    out += ellipse(px, py, 2.2, 1.4, lp.base, { stroke: 'none' });
  }
  out += circle(16, 16, 1.8, ACCENT.flowerYellow, { stroke: 'none' });
  out += circle(16, 15.4, 0.9, '#fff3c0', { stroke: 'none', opacity: 0.8 });
  return out;
}

function reeds() {
  const p = TILE_PAL.bush;
  // A clustered stand of upright blades springing from a common root clump.
  let out = ellipse(16, 30, 7, 2, p.shade, { stroke: 'none', opacity: 0.6 });
  const blades = [
    { x: 16, lean: 0 }, { x: 12, lean: -2 }, { x: 20, lean: 2 },
    { x: 9, lean: -3 }, { x: 23, lean: 3 }, { x: 14, lean: -1 }, { x: 18, lean: 1 },
  ];
  for (let i = 0; i < blades.length; i++) {
    const b = blades[i];
    const col = i % 3 === 0 ? p.shade : i % 3 === 1 ? p.base : p.light;
    const top = 3 + (i % 2) * 2;
    out += path(`M${b.x} 30 Q${(b.x + b.lean).toFixed(1)} 16 ${(b.x + b.lean * 1.6).toFixed(1)} ${top}`,
      'none', { stroke: col, width: 1.6 });
  }
  return out;
}

function cattails() {
  const p = TILE_PAL.bush;
  const c = TILE_PAL.cattail;
  // Reed blades + two distinct brown seed-head spikes on their own stalks, each
  // with a lit edge and the little point tip — the cattail silhouette.
  let out = reeds();
  // stalks for the heads
  out += path('M11 28 L11 13', 'none', { stroke: p.shade, width: 1.4 });
  out += path('M21 28 L21 15', 'none', { stroke: p.base, width: 1.4 });
  // seed-heads (rounded sausages)
  out += T.rect(9.4, 4, 3.2, 9, c.base, { stroke: 'none', rx: 1.6 });
  out += plainRect(9.8, 4.5, 1, 8, c.light, { opacity: 0.6 });   // lit edge
  out += plainRect(11.4, 4.5, 0.9, 8, c.shade, { opacity: 0.6 }); // shade edge
  out += path('M11 4 L11 2', 'none', { stroke: p.base, width: 1 }); // tip spike
  out += T.rect(19.4, 6, 3.2, 8, c.base, { stroke: 'none', rx: 1.6 });
  out += plainRect(19.8, 6.5, 1, 7, c.light, { opacity: 0.6 });
  out += plainRect(21.4, 6.5, 0.9, 7, c.shade, { opacity: 0.6 });
  out += path('M21 6 L21 4', 'none', { stroke: p.base, width: 1 });
  return out;
}

function mushroom() {
  const cap = ACCENT.mushroomCap;
  // A toadstool: a curved stem with a little base bulge, a domed red cap with a
  // shaded underside lip and the classic white spots, plus a smaller second cap.
  let out = '';
  // second (smaller) mushroom behind
  out += plainRect(21, 19, 2, 6, TILE_PAL.tileFloor.base);
  out += ellipse(22, 18.5, 3.5, 2.4, TILE_PAL.cattail.base, { stroke: EDGE, width: 1 });
  out += circle(21, 17.8, 0.7, '#ffffff', { stroke: 'none' });
  // main stem (slightly bulged base)
  out += polygon([[14.5, 26], [13.8, 19], [18.2, 19], [17.5, 26]], TILE_PAL.tileFloor.light, { stroke: EDGE, width: 1 });
  out += plainRect(14.6, 19, 1, 7, TILE_PAL.tileFloor.base, { opacity: 0.5 });
  // gills / underside lip beneath the cap
  out += ellipse(16, 18, 7, 2.2, '#b58a6a', { stroke: 'none', opacity: 0.7 });
  // domed cap
  out += path('M9 17.5 A7 6 0 0 1 23 17.5 Z', cap, { stroke: EDGE, width: 1 });
  out += path('M10.5 16 A6 5 0 0 1 18 12', 'none', { stroke: '#e0705e', width: 1.6, opacity: 0.7 }); // lit dome
  // white spots
  out += circle(12.5, 15, 1.3, '#fff3ea', { stroke: 'none' });
  out += circle(18.5, 14.5, 1.1, '#fff3ea', { stroke: 'none' });
  out += circle(15.5, 12.6, 0.9, '#fff3ea', { stroke: 'none' });
  out += circle(20, 16.2, 0.8, '#fff3ea', { stroke: 'none' });
  return out;
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
