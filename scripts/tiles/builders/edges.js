'use strict';

/**
 * EDGE / transition tile builders (indices 25..48) — TINS 2026, Escape AI.
 *
 * Two 12-tile sets, both grass-based with a second material banded onto a side or
 * corner:
 *   - PATH_*  : path (cobble gray) over grass, with a soft trodden dirt margin at
 *               the grass↔path line (so the join reads as a worn footpath edge,
 *               not a hard gray rectangle / striation).
 *   - WATER_* : water (shallow blue) over grass — a SHORELINE. The grass↔water line
 *               gets a foam band: a strip of lighter shallow water plus small white
 *               surf specks, so it reads as a beach/foam line. Corner + inner-corner
 *               variants round the shoreline so the coast curves instead of stepping.
 *
 * Naming → geometry (read the suffix):
 *   EDGE_<D>      : a full band of the overlay material along side D.
 *   CORNER_<DD>   : the overlay fills the OUTER corner quadrant DD (an outside bend,
 *                   so the material wraps a convex corner — two-thirds of the cell).
 *   ICORNER_<DD>  : the overlay covers everything EXCEPT the inner corner quadrant DD
 *                   (a concave bend — the grass is a small notch in corner DD).
 *
 * Each builder is one parametric function keyed on the tile NAME (mirrors the
 * sprite-pipeline idea of one builder serving a whole set). Full-bleed + seamless
 * (the overlay is a flat material rect, no stroke), so edges abut their neighbours
 * cleanly.
 */

const T = require('../template-tile');
const { TILE_PAL, ACCENT } = require('../tilepalette');
const terrain = require('./terrain');

const { plainRect, ellipse, circle, scatter, path } = T;
const S = T.S; // 32
const H = S / 2; // 16

/** The base layer both sets sit on: grass. */
function grassBase() {
  return terrain.buildGrass('EDGE_GRASS');
}

/** A flat band/quadrant of the overlay material, top-lit for cohesion. */
function overlay(x, y, w, h, pal) {
  let out = plainRect(x, y, w, h, pal.base);
  // a thin highlight on the overlay's own top edge + shade on its bottom edge
  out += plainRect(x, y, w, 2, pal.light, { opacity: 0.5 });
  out += plainRect(x, y + h - 2, w, 2, pal.shade, { opacity: 0.45 });
  return out;
}

// --- Boundary detail ---------------------------------------------------------
//
// After the overlay rect lands, a "kind"-specific detail pass softens the
// grass↔overlay seam. WATER paints a foam line (lighter shallow band + white surf
// specks); PATH paints a trodden dirt margin (a worn band straddling the join).
// `kind` is 'water' | 'path'. Detail is deterministic — foam specks are seeded by
// the tile NAME via scatter, so the committed tileset stays byte-stable.

/** Lighter shallow tone for the foam-side band (pale, between water and white). */
function foamShallow() {
  return TILE_PAL.waterWade;
}

/**
 * A straight foam/worn band centred on a boundary line. `axis` is 'h' (a
 * horizontal join at y=`at`) or 'v' (a vertical join at x=`at`). For water this
 * is a lighter shallow strip + white surf specks on the water side; for path a
 * soft dirt margin straddling the line.
 */
function straightBand(name, kind, axis, at, side = 1) {
  const band = 5; // total band thickness across the join
  let out = '';
  if (kind === 'water') {
    const pale = foamShallow();
    // `wstart` is the top/left edge of a 3px-wide fringe rect sitting on the WATER
    // side of the join; `fstart` is the wet-sand soft fringe just inside the foam,
    // on the GRASS side. The bright foam ridge straddles the join itself.
    const wstart = side > 0 ? at : at - 3;       // water-side shallow band
    const fstart = side > 0 ? at - 2 : at;        // grass-side wet fringe
    if (axis === 'h') {
      out += plainRect(0, wstart, S, 3, pale.base, { opacity: 0.55 });   // paler shallow on the water side
      out += plainRect(0, fstart, S, 2, ACCENT.foamSoft, { opacity: 0.4 }); // wet-sand fringe inside the foam
      out += plainRect(0, at - 1.1, S, 2.1, ACCENT.foam, { opacity: 0.62 }); // bright foam ridge on the line
      out += foamSpecks(name, 'h', at, side);
    } else {
      out += plainRect(wstart, 0, 3, S, pale.base, { opacity: 0.55 });
      out += plainRect(fstart, 0, 2, S, ACCENT.foamSoft, { opacity: 0.4 });
      out += plainRect(at - 1.1, 0, 2.1, S, ACCENT.foam, { opacity: 0.62 });
      out += foamSpecks(name, 'v', at, side);
    }
  } else {
    // path: a worn dirt margin straddling the join — soft, low-contrast
    const worn = ACCENT.pathWorn;
    if (axis === 'h') {
      out += plainRect(0, at - band / 2, S, band, TILE_PAL.dirt.base, { opacity: 0.30 });
      out += plainRect(0, at - 0.6, S, 1.2, worn, { opacity: 0.35 });
      out += scuffSpecks(name, 'h', at);
    } else {
      out += plainRect(at - band / 2, 0, band, S, TILE_PAL.dirt.base, { opacity: 0.30 });
      out += plainRect(at - 0.6, 0, 1.2, S, worn, { opacity: 0.35 });
      out += scuffSpecks(name, 'v', at);
    }
  }
  return out;
}

/** Small white surf specks scattered ALONG a straight foam line, biased water-side. */
function foamSpecks(name, axis, at, side = 1) {
  // place along the line, jittered toward the water `side` (most specks) with a few
  // washing onto the beach; deterministic by name.
  return scatter(name + '_foam', 6, (x, y, r, i) => {
    const off = i % 3 === 0 ? -1.0 * side : (0.6 + r) * side; // 1-in-3 washes ashore
    const px = axis === 'h' ? x : at + off;
    const py = axis === 'h' ? at + off : y;
    return circle(px, py, 0.7 + r * 0.4, ACCENT.foam, { stroke: 'none', opacity: 0.75 });
  }, { margin: 2, rMin: 0.4, rMax: 1.0 });
}

/** Small dark dirt scuffs scattered along a straight path join (worn footpath). */
function scuffSpecks(name, axis, at) {
  return scatter(name + '_scuff', 5, (x, y, r, i) => {
    const px = axis === 'h' ? x : at + (i % 2 ? 1.2 : -1.2);
    const py = axis === 'h' ? at + (i % 2 ? 1.2 : -1.2) : y;
    return circle(px, py, 0.6 + r * 0.4, TILE_PAL.dirt.shade, { stroke: 'none', opacity: 0.4 });
  }, { margin: 2, rMin: 0.4, rMax: 1.0 });
}

// --- Rounded shoreline corners ----------------------------------------------
//
// On WATER corners/inner-corners the shoreline should CURVE, not step.
//
//   CONVEX (CORNER_*): water wraps the corner; grass fills the opposite quadrant
//     as a square. We repaint that quadrant water, then stamp a grass quarter-disc
//     anchored at the cell corner (radius H) so the grass becomes a rounded
//     headland and the coast curves out.
//
//   CONCAVE (ICORNER_*): grass is a small square notch in quadrant gq; water wraps
//     around it. We stamp a water/foam quarter-disc anchored at the CELL CENTRE
//     that bites the notch's protruding corner, rounding the cove.
//
// Both arcs are traced with a foam stroke so the curved coast reads as surf.

/** The cell corner (the 0/32 extreme) for quadrant `q`. */
function quadCorner(q) {
  return { x: q.includes('W') ? 0 : S, y: q.includes('N') ? 0 : S };
}

/**
 * Bulge direction (bx,by ∈ {-1,+1}, screen coords, y-down) for a CELL-CORNER
 * anchored disc: the wedge opens toward the cell INTERIOR (away from the corner).
 * For quadrant SW (corner bottom-left) the interior is up-right → (+1,-1).
 */
function bulge(q) {
  return { bx: q.includes('W') ? 1 : -1, by: q.includes('N') ? 1 : -1 };
}

/**
 * Bulge direction for a CELL-CENTRE anchored disc that opens toward quadrant `q`'s
 * own screen direction (NE → up-right, SW → down-left, …). This is the negation of
 * `bulge(q)` (which points toward the interior from a corner).
 */
function towardQuad(q) {
  return { bx: q.includes('W') ? -1 : 1, by: q.includes('N') ? -1 : 1 };
}

/**
 * A quarter-disc centred at (ax,ay) bulging in direction (bx,by) (each ±1),
 * radius `r`. The two endpoints sit on the two axes — (ax+bx·r, ay) and
 * (ax, ay+by·r) — and the convex arc joins them. Built without rotation so the
 * emitted path is byte-stable. `sweep = (bx===by) ? 0 : 1` selects the bulge that
 * opens toward (bx,by) (derived from the known-good CORNER cases).
 */
function discPath(ax, ay, bx, by, r) {
  const sx = ax + bx * r, sy = ay;
  const ex = ax, ey = ay + by * r;
  const sweep = bx === by ? 0 : 1;
  return { sx, sy, ex, ey, sweep, ax, ay, r };
}

/** Filled quarter-disc at (ax,ay) bulging in direction `dir` ({bx,by}), radius r. */
function quarterDiscAt(ax, ay, dir, r, fill, opts = {}) {
  const p = discPath(ax, ay, dir.bx, dir.by, r);
  const d = `M${p.ax} ${p.ay} L${p.sx} ${p.sy} A${p.r} ${p.r} 0 0 ${p.sweep} ${p.ex} ${p.ey} Z`;
  return path(d, fill, { stroke: 'none', ...opts });
}

/** Foam arc stroke hugging the quarter-disc edge at (ax,ay) bulging in `dir`. */
function arcFoamAt(ax, ay, dir, r, color, width, opacity) {
  const p = discPath(ax, ay, dir.bx, dir.by, r);
  const d = `M${p.sx} ${p.sy} A${p.r} ${p.r} 0 0 ${p.sweep} ${p.ex} ${p.ey}`;
  return path(d, 'none', { stroke: color, width, opacity });
}

// --- Geometry of a single edge/corner tile -----------------------------------

/** Fill one 16x16 quadrant with the overlay material. dd in {NE,NW,SE,SW}. */
function quad(dd, pal) {
  const x = dd.includes('W') ? 0 : H;
  const y = dd.includes('N') ? 0 : H;
  return overlay(x, y, H, H, pal);
}

/**
 * OUTER corner DD: the overlay material wraps the convex corner, covering the two
 * edge-bands adjacent to DD (an L), leaving grass in the opposite quadrant.
 * e.g. CORNER_NE → path along N and E, grass in the SW quadrant.
 */
function outerCorner(dd, pal) {
  const opp = { NE: 'SW', NW: 'SE', SE: 'NW', SW: 'NE' }[dd];
  let out = '';
  for (const q of ['NE', 'NW', 'SE', 'SW']) {
    if (q !== opp) out += quad(q, pal);
  }
  return out;
}

/**
 * INNER corner DD: concave bend — overlay covers everything except a single
 * grass notch in quadrant DD.
 */
function innerCorner(dd, pal) {
  let out = '';
  for (const q of ['NE', 'NW', 'SE', 'SW']) {
    if (q !== dd) out += quad(q, pal);
  }
  return out;
}

/** Build one edge/corner tile: overlay `pal` onto grass per the NAME's suffix. */
function edge(name, pal, kind) {
  let out = grassBase();
  const suffix = name.replace(/^(PATH|WATER)_/, ''); // EDGE_N / CORNER_NE / ICORNER_SW

  if (suffix.startsWith('EDGE_')) {
    const d = suffix.slice(5); // N/E/S/W
    // `side` = +1 if the overlay (water/path) lies on the POSITIVE side of the join
    // line (greater coord), -1 if the negative side. The foam/shallow fringe hugs it.
    if (d === 'N') { out += overlay(0, 0, S, H, pal); out += straightBand(name, kind, 'h', H, -1); }
    else if (d === 'S') { out += overlay(0, H, S, H, pal); out += straightBand(name, kind, 'h', H, +1); }
    else if (d === 'W') { out += overlay(0, 0, H, S, pal); out += straightBand(name, kind, 'v', H, -1); }
    else if (d === 'E') { out += overlay(H, 0, H, S, pal); out += straightBand(name, kind, 'v', H, +1); }
  } else if (suffix.startsWith('CORNER_')) {
    // OUTER corner: overlay wraps the convex corner; the opposite quadrant is grass.
    const dd = suffix.slice(7); // NE/NW/SE/SW
    const opp = { NE: 'SW', NW: 'SE', SE: 'NW', SW: 'NE' }[dd];
    out += outerCorner(dd, pal);
    out += cornerDetail(name, kind, pal, opp, /* convex */ true);
  } else if (suffix.startsWith('ICORNER_')) {
    // INNER corner: overlay covers all but a small grass notch in quadrant DD.
    const dd = suffix.slice(8);
    out += innerCorner(dd, pal);
    out += cornerDetail(name, kind, pal, dd, /* convex */ false);
  }
  return out;
}

/**
 * Boundary detail at a corner tile. `gq` is the grass quadrant (the opposite
 * quadrant for CORNER, the notch quadrant for ICORNER). For WATER we round the
 * shoreline there and trace foam along the arc; for PATH we straddle the bend's
 * two straight legs with a worn dirt margin.
 */
function cornerDetail(name, kind, pal, gq, convex) {
  const corner = quadCorner(gq);
  if (kind === 'water') {
    const pale = foamShallow();
    let out = '';
    if (convex) {
      // CORNER_*: water wraps the corner; grass is a square in quadrant gq. Repaint
      // that quadrant water, then carve a grass quarter-disc anchored at gq's CELL
      // CORNER, bulging toward the interior (bulge(gq)), radius H — so the grass
      // headland rounds out into the water. A pale shallow halo + foam trace the coast.
      const dir = bulge(gq);
      out += quad(gq, pal);                                  // overpaint the square grass with water
      out += quarterDiscAt(corner.x, corner.y, dir, H + 1, pale.base, { opacity: 0.45 }); // shallow halo
      out += quarterDiscAt(corner.x, corner.y, dir, H, TILE_PAL.grass.base);              // rounded grass
      out += grassFleck(name, corner.x, corner.y, gq, H);    // re-texture the rounded lawn
      out += arcFoamAt(corner.x, corner.y, dir, H, pale.base, 3, 0.5);
      out += arcFoamAt(corner.x, corner.y, dir, H, ACCENT.foam, 1.4, 0.7);
    } else {
      // ICORNER_*: grass notch is a square in quadrant gq, water around it. Bite the
      // notch's protruding corner with a quarter-disc anchored at the CELL CENTRE,
      // bulging toward the notch (towardQuad(gq)): solid water cleanly rounds the cove,
      // a pale shallow halo + foam stroke trace the concave arc.
      const dir = towardQuad(gq);
      const r = 8;
      out += quarterDiscAt(H, H, dir, r, pal.base);                       // solid water bite
      out += quarterDiscAt(H, H, dir, r - 1.5, pale.base, { opacity: 0.5 }); // shallow halo inside
      out += arcFoamAt(H, H, dir, r, ACCENT.foam, 1.4, 0.7);
      // a slim shallow band along the notch's two straight legs (the rest of the shore)
      out += notchLegFoam(name, gq);
    }
    return out;
  }
  // PATH: straddle the two straight legs of the bend (which meet at the cell centre)
  // with a soft worn dirt margin so the footpath edge softens at the corner too.
  const worn = ACCENT.pathWorn;
  let out = '';
  out += plainRect(0, H - 2.5, S, 5, TILE_PAL.dirt.base, { opacity: 0.22 });
  out += plainRect(H - 2.5, 0, 5, S, TILE_PAL.dirt.base, { opacity: 0.22 });
  out += plainRect(0, H - 0.6, S, 1.2, worn, { opacity: 0.28 });
  out += plainRect(H - 0.6, 0, 1.2, S, worn, { opacity: 0.28 });
  out += scatter(name + '_cscuff', 5, (x, y, r) =>
    circle(x, y, 0.6 + r * 0.4, TILE_PAL.dirt.shade, { stroke: 'none', opacity: 0.35 }),
  { margin: 3, rMin: 0.4, rMax: 1.0 });
  return out;
}

/** Re-texture the rounded grass headland with a few lawn flecks (matches grass()). */
function grassFleck(name, ax, ay, q, r) {
  // confine flecks to the quarter-disc bounding box so they land on the grass
  const x0 = q.includes('W') ? ax : ax - r;
  const y0 = q.includes('N') ? ay : ay - r;
  return scatter(name + '_gflk', 6, (x, y, rr, i) => {
    const px = x0 + (x / S) * r;
    const py = y0 + (y / S) * r;
    const col = i % 2 ? TILE_PAL.grass.light : TILE_PAL.grass.shade;
    return circle(px, py, 0.7 + rr * 0.3, col, { stroke: 'none', opacity: 0.7 });
  }, { margin: 2, rMin: 0.5, rMax: 1.2 });
}

/** A thin pale-shallow + foam stroke along the two straight legs of an ICORNER notch. */
function notchLegFoam(name, gq) {
  const pale = foamShallow();
  // The notch occupies quadrant gq; its two straight shore legs lie on x=16 (over
  // the notch's y-span) and y=16 (over its x-span). Draw faint shallow + foam there.
  const nx0 = gq.includes('W') ? 0 : H;
  const ny0 = gq.includes('N') ? 0 : H;
  let out = '';
  out += plainRect(H - 1.5, ny0, 3, H, pale.base, { opacity: 0.4 });
  out += plainRect(nx0, H - 1.5, H, 3, pale.base, { opacity: 0.4 });
  out += plainRect(H - 0.8, ny0, 1.4, H, ACCENT.foam, { opacity: 0.45 });
  out += plainRect(nx0, H - 0.8, H, 1.4, ACCENT.foam, { opacity: 0.45 });
  // Surf specks confined to hug the two legs (water side of x=16 / y=16), not the
  // open water. Each speck sits within ~2px of a leg, jittered deterministically.
  const sideX = gq.includes('W') ? 2 : -2; // water is on the far side of x=16 from the notch
  const sideY = gq.includes('N') ? 2 : -2;
  out += scatter(name + '_vleg', 2, (x, y) =>
    circle(H + sideX, ny0 + (y / S) * H, 0.8, ACCENT.foam, { stroke: 'none', opacity: 0.65 }),
  { margin: 3 });
  out += scatter(name + '_hleg', 2, (x) =>
    circle(nx0 + (x / S) * H, H + sideY, 0.8, ACCENT.foam, { stroke: 'none', opacity: 0.65 }),
  { margin: 3 });
  return out;
}

/** PATH_* : path (cobble gray) band on grass, softened with a worn dirt margin. */
function buildPathEdge(name) {
  return edge(name, TILE_PAL.cobble, 'path');
}

/** WATER_* : shallow-water band on grass (a shoreline) with a foam line. */
function buildWaterEdge(name) {
  return edge(name, TILE_PAL.waterShallow, 'water');
}

module.exports = { buildPathEdge, buildWaterEdge };
