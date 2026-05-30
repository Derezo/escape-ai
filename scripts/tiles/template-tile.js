'use strict';

/**
 * Tile-specific SVG helpers, layered on scripts/sprites/template.js (TINS 2026 —
 * Escape AI).
 *
 * The sprite primitives (rect/ellipse/circle/polygon/path, n1) are reused; these
 * add the tile idioms:
 *   - fillCell(color)  — a full-bleed 32x32 rect with NO stroke. Tiles ABUT, so a
 *                        stroked border would draw a grid of dark lines across the
 *                        ground. Ground tiles call this; deco tiles draw on the
 *                        transparent cell instead.
 *   - topLight/bottomShade — thin bands at the top/bottom edge implementing the
 *                        LOCKED top-lit lighting rule, applied seamlessly (full
 *                        width) so adjacent tiles of the same material still tile.
 *   - scatter(name,n,fn) — a DETERMINISTIC small-feature scatter. Keyed on the tile
 *                        NAME via an LCG (NOT Math.random), so regenerating the
 *                        sheet is byte-stable. Coordinates wrap mod 32 so detail
 *                        tiles seamlessly.
 *   - svgDocTile(inner) — a 32px transparent-background SVG document for one tile.
 *
 * Determinism: all coords go through n1 (one-decimal rounding) like the sprite
 * pipeline; no gradients/filters (librsvg rasterises those inconsistently).
 */

const { TILE_SIZE, VIEWBOX } = require('./contract');
const tmpl = require('../sprites/template');

const { n1 } = tmpl;
const S = TILE_SIZE; // 32

/** A bare (un-stroked) rect — the building block for full-bleed ground + flat fills. */
function plainRect(x, y, w, h, fill, opts = {}) {
  const rx = opts.rx != null ? `rx="${n1(opts.rx)}" ` : '';
  const op = opts.opacity != null ? `opacity="${n1(opts.opacity)}" ` : '';
  return `<rect x="${n1(x)}" y="${n1(y)}" width="${n1(w)}" height="${n1(h)}" ${rx}${op}fill="${fill}"/>`;
}

/** Full-bleed cell fill (the whole 32x32), NO stroke — for ground/floor/water tiles. */
function fillCell(color) {
  return plainRect(0, 0, S, S, color);
}

/** A thin lighter band along the TOP edge (the top-lit highlight). Seamless full-width. */
function topLight(color, h = 3, opacity = 1) {
  return plainRect(0, 0, S, h, color, { opacity });
}

/** A thin darker band along the BOTTOM edge (contact shadow). Seamless full-width. */
function bottomShade(color, h = 3, opacity = 1) {
  return plainRect(0, S - h, S, h, color, { opacity });
}

/**
 * A tiny deterministic LCG keyed on a string seed. Returns a function yielding
 * floats in [0,1). Same seed → same stream, so the committed tileset is stable.
 */
function rng(seed) {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  let state = (h || 1) >>> 0;
  return function next() {
    // Numerical Recipes LCG, then normalise to [0,1).
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 4294967296;
  };
}

/**
 * Deterministically scatter `n` features across the cell, calling
 * `fn(x, y, r, i)` for each. x/y land inside [margin, 32-margin]; r is a small
 * radius in [rMin, rMax]. Seeded by the tile NAME so output is byte-stable, and
 * coords are kept inside the cell (callers that want seamless wrap can mod 32).
 *
 * @param {string} seed   the tile name (the determinism key)
 * @param {number} n      how many features
 * @param {(x:number,y:number,r:number,i:number)=>string} fn  emits SVG for one
 * @param {{margin?:number,rMin?:number,rMax?:number}} [opts]
 */
function scatter(seed, n, fn, opts = {}) {
  const { margin = 3, rMin = 1, rMax = 2.5 } = opts;
  const next = rng(seed);
  const span = S - margin * 2;
  let out = '';
  for (let i = 0; i < n; i++) {
    const x = margin + next() * span;
    const y = margin + next() * span;
    const r = rMin + next() * (rMax - rMin);
    out += fn(n1Num(x), n1Num(y), n1Num(r), i);
  }
  return out;
}

/** Round a number to one decimal (numeric), so scatter coords are stable + terse. */
function n1Num(v) {
  return Math.round(v * 10) / 10;
}

/**
 * Wrap a tile's inner SVG fragment in a complete, transparent-background 32px SVG
 * document. Ground builders draw fillCell first (opaque); deco builders leave the
 * background transparent so the ground layer shows through.
 */
function svgDocTile(inner) {
  return (
    `<?xml version="1.0" encoding="UTF-8"?>\n` +
    `<svg xmlns="http://www.w3.org/2000/svg" width="${S}" height="${S}" viewBox="${VIEWBOX}">\n` +
    `  ${inner}\n` +
    `</svg>\n`
  );
}

module.exports = {
  S,
  n1,
  n1Num,
  plainRect,
  fillCell,
  topLight,
  bottomShade,
  rng,
  scatter,
  svgDocTile,
  // re-export the sprite primitives deco builders use
  ellipse: tmpl.ellipse,
  circle: tmpl.circle,
  rect: tmpl.rect,
  polygon: tmpl.polygon,
  path: tmpl.path,
};
