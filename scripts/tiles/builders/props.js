'use strict';

/**
 * PROP builders (indices 133..144) — TINS 2026, The Caves of Steel.
 *
 * Small set-dressing objects, all DECO on a TRANSPARENT cell (ground shows around
 * them). Centred, top-lit, soft EDGE silhouette. BANNER is ysort:'behind' (it
 * hangs above the player like a canopy), so it's drawn in the upper part of the
 * cell as a hanging cloth.
 */

const T = require('../template-tile');
const { TILE_PAL, ACCENT, EDGE } = require('../tilepalette');

const { plainRect, ellipse, circle, polygon, path } = T;
const S = T.S; // 32
const H = S / 2;

const edge1 = { stroke: EDGE, width: 1 };

// --- Signs ---
function signPost(cx = H) {
  return plainRect(cx - 1.5, 14, 3, 14, TILE_PAL.wood.shade);
}
function signBlank() {
  return (
    signPost() +
    T.rect(7, 4, 18, 12, TILE_PAL.wood.base, { ...edge1, rx: 1 }) +
    plainRect(7, 4, 18, 3, TILE_PAL.wood.light, { opacity: 0.6 })
  );
}
function signArrow() {
  return (
    signPost() +
    polygon([[5, 10], [22, 10], [22, 6], [28, 12], [22, 18], [22, 14], [5, 14]], ACCENT.signYellow, edge1) +
    plainRect(5, 10, 17, 1.5, '#fff3c0', { opacity: 0.7 })
  );
}

// --- Lamp post ---
function lampPost() {
  const m = TILE_PAL.metalDark;
  return (
    plainRect(15, 8, 2, 22, m.base) +
    plainRect(15, 8, 1, 22, m.light, { opacity: 0.5 }) +
    ellipse(16, 28, 5, 2, m.shade, { stroke: 'none' }) + // base
    // the lamp head
    polygon([[11, 8], [21, 8], [19, 3], [13, 3]], m.base, edge1) +
    ellipse(16, 7, 4, 3, ACCENT.lamp, { stroke: 'none', opacity: 0.9 })
  );
}

// --- Bench ---
function bench() {
  const w = TILE_PAL.wood;
  return (
    plainRect(4, 16, 24, 5, w.base, { rx: 1 }) +     // seat
    plainRect(4, 16, 24, 2, w.light, { opacity: 0.6 }) +
    plainRect(4, 9, 24, 4, w.shade, { rx: 1 }) +     // backrest
    plainRect(6, 21, 3, 7, w.shade) + plainRect(23, 21, 3, 7, w.shade) // legs
  );
}

// --- Troughs ---
function troughBox(fill) {
  const w = TILE_PAL.wood;
  let out = T.rect(4, 12, 24, 14, w.base, { ...edge1, rx: 2 });
  out += plainRect(6, 14, 20, 8, fill); // contents
  out += plainRect(4, 12, 24, 3, w.light, { opacity: 0.6 });
  return out;
}
function troughFood() {
  let out = troughBox(ACCENT.food);
  // a heap of feed pellets
  out += T.scatter('TROUGH_FOOD', 8, (x, y, r) => circle(x, y, r, TILE_PAL.straw.shade, { stroke: 'none' }), { margin: 8, rMin: 0.8, rMax: 1.4 });
  return out;
}
function troughWater() {
  let out = troughBox(TILE_PAL.waterShallow.base);
  out += plainRect(6, 14, 20, 3, TILE_PAL.waterShallow.light, { opacity: 0.6 });
  return out;
}

// --- Barrel / crate / hay / bin ---
function barrel() {
  const w = TILE_PAL.wood;
  const m = TILE_PAL.metal;
  return (
    T.rect(8, 4, 16, 24, w.base, { ...edge1, rx: 3 }) +
    plainRect(8, 4, 4, 24, w.light, { opacity: 0.4 }) +
    plainRect(20, 4, 4, 24, w.shade, { opacity: 0.4 }) +
    plainRect(8, 9, 16, 2, m.base) + plainRect(8, 21, 16, 2, m.base) // hoops
  );
}

function crate() {
  const w = TILE_PAL.wood;
  let out = T.rect(5, 5, 22, 22, w.base, { ...edge1, rx: 1 });
  out += plainRect(5, 5, 22, 3, w.light, { opacity: 0.5 });
  // X-bracing planks
  out += path('M6 6 L26 26', 'none', { stroke: w.shade, width: 2 });
  out += path('M26 6 L6 26', 'none', { stroke: w.shade, width: 2 });
  out += T.rect(5, 5, 22, 22, 'none', { stroke: w.shade, width: 1.5 });
  return out;
}

function hayBale() {
  const s = TILE_PAL.straw;
  let out = T.rect(4, 9, 24, 18, s.base, { ...edge1, rx: 2 });
  out += plainRect(4, 9, 24, 3, s.light, { opacity: 0.6 });
  // binding twine + straw texture
  out += plainRect(11, 9, 1.5, 18, s.shade);
  out += plainRect(20, 9, 1.5, 18, s.shade);
  out += T.scatter('HAY_BALE', 10, (x, y) => path(`M${x} ${y} l3 0`, 'none', { stroke: s.shade, width: 0.8 }), { margin: 6 });
  return out;
}

function trashBin() {
  const m = TILE_PAL.metalDark;
  return (
    plainRect(7, 8, 18, 20, m.base, { rx: 2 }) +
    plainRect(7, 8, 4, 20, m.light, { opacity: 0.4 }) +
    plainRect(5, 5, 22, 4, m.shade, { rx: 1 }) + // lid
    plainRect(14, 3, 4, 3, m.shade) +            // handle
    plainRect(11, 12, 1.5, 14, m.shade, { opacity: 0.6 }) + // ribs
    plainRect(16, 12, 1.5, 14, m.shade, { opacity: 0.6 }) +
    plainRect(20, 12, 1.5, 14, m.shade, { opacity: 0.6 })
  );
}

// --- Trimmed topiary bush (a neat hedge cube) ---
function bushTrimmed() {
  const b = TILE_PAL.bush;
  let out = T.rect(5, 6, 22, 22, b.base, { ...edge1, rx: 4 });
  out += plainRect(5, 6, 22, 4, b.light, { opacity: 0.5 });
  out += T.scatter('BUSH_TRIMMED', 8, (x, y, r) => circle(x, y, r, b.shade, { stroke: 'none', opacity: 0.4 }), { margin: 8, rMin: 1, rMax: 2 });
  return out;
}

// --- Banner (ysort:'behind' — hangs above; draw in the upper cell) ---
function banner() {
  const r = TILE_PAL.roofRed;
  const m = TILE_PAL.metal;
  return (
    plainRect(0, 2, S, 2, m.base) + // the crossbar it hangs from
    // the cloth
    polygon([[6, 4], [26, 4], [26, 24], [16, 20], [6, 24]], r.base, edge1) +
    plainRect(6, 4, 20, 4, r.light, { opacity: 0.5 }) +
    // a pale device on the cloth
    circle(16, 13, 4, ACCENT.signYellow, { stroke: 'none', opacity: 0.85 })
  );
}

module.exports = {
  buildSignBlank: signBlank,
  buildSignArrow: signArrow,
  buildLampPost: lampPost,
  buildBench: bench,
  buildTroughFood: troughFood,
  buildTroughWater: troughWater,
  buildBarrel: barrel,
  buildCrate: crate,
  buildHayBale: hayBale,
  buildTrashBin: trashBin,
  buildBushTrimmed: bushTrimmed,
  buildBanner: banner,
};
