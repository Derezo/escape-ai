'use strict';

/**
 * EDGE / transition tile builders (indices 25..48) — TINS 2026, Caves of Steel.
 *
 * Two 12-tile sets, both grass-based with a second material banded onto a side or
 * corner:
 *   - PATH_*  : path (cobble gray) over grass.
 *   - WATER_* : water (shallow blue) over grass (a shoreline).
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
const { TILE_PAL } = require('../tilepalette');
const terrain = require('./terrain');

const { plainRect } = T;
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

/** Build one edge/corner tile: overlay `pal` onto grass per the NAME's suffix. */
function edge(name, pal) {
  let out = grassBase();
  const suffix = name.replace(/^(PATH|WATER)_/, ''); // EDGE_N / CORNER_NE / ICORNER_SW

  if (suffix.startsWith('EDGE_')) {
    const d = suffix.slice(5); // N/E/S/W
    if (d === 'N') out += overlay(0, 0, S, H, pal);
    else if (d === 'S') out += overlay(0, H, S, H, pal);
    else if (d === 'W') out += overlay(0, 0, H, S, pal);
    else if (d === 'E') out += overlay(H, 0, H, S, pal);
  } else if (suffix.startsWith('CORNER_')) {
    // OUTER corner: the overlay wraps the corner — fill the L-shape covering the two
    // sides that meet at DD (i.e. everything except the OPPOSITE quadrant).
    const dd = suffix.slice(7); // NE/NW/SE/SW
    out += outerCorner(dd, pal);
  } else if (suffix.startsWith('ICORNER_')) {
    // INNER corner: overlay everywhere except a small notch quadrant at DD.
    const dd = suffix.slice(8);
    out += innerCorner(dd, pal);
  }
  return out;
}

/** Fill one 16x16 quadrant. dd in {NE,NW,SE,SW}. */
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
  // Opposite quadrant stays grass; fill the other three quadrants.
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

/** PATH_* : path (cobble gray) band on grass. */
function buildPathEdge(name) {
  return edge(name, TILE_PAL.cobble);
}

/** WATER_* : shallow-water band on grass (a shoreline). */
function buildWaterEdge(name) {
  return edge(name, TILE_PAL.waterShallow);
}

module.exports = { buildPathEdge, buildWaterEdge };
