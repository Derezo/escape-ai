'use strict';

/**
 * PROP builders (indices 133..144) — TINS 2026, Escape AI.
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
  const w = TILE_PAL.wood;
  // a rounded post with a lit edge + a grain streak so it reads as turned wood
  return (
    plainRect(cx - 1.5, 14, 3, 14, w.shade) +
    plainRect(cx - 1.5, 14, 1, 14, w.base, { opacity: 0.7 }) +
    plainRect(cx + 0.5, 14, 0.6, 14, TILE_PAL.wood.deep, { opacity: 0.6 })
  );
}
function signBlank() {
  const w = TILE_PAL.wood;
  let out = signPost();
  out += T.rect(7, 4, 18, 12, w.base, { ...edge1, rx: 1 });
  out += plainRect(7, 4, 18, 3, w.light, { opacity: 0.6 });   // top-lit
  out += plainRect(7, 13, 18, 2, w.shade, { opacity: 0.5 });  // bottom shade
  // horizontal plank grain on the board
  for (let i = 0; i < 3; i++) {
    out += plainRect(9, 7 + i * 2.6, 14, 0.7, TILE_PAL.wood.grain, { opacity: 0.45 });
  }
  // two fixing nails
  out += circle(9.5, 5.6, 0.7, TILE_PAL.metal.shade, { stroke: 'none' });
  out += circle(22.5, 5.6, 0.7, TILE_PAL.metal.shade, { stroke: 'none' });
  return out;
}
function signArrow() {
  let out = signPost();
  out += polygon([[5, 10], [22, 10], [22, 6], [28, 12], [22, 18], [22, 14], [5, 14]], ACCENT.signYellow, edge1);
  out += plainRect(5, 10, 17, 1.5, '#fff3c0', { opacity: 0.7 });          // lit top edge
  out += polygon([[22, 14], [28, 12], [22, 18]], TILE_PAL.straw.shade, { stroke: 'none', opacity: 0.35 }); // arrow-head shade
  out += plainRect(5, 13.2, 17, 0.8, TILE_PAL.straw.shade, { opacity: 0.4 }); // bottom shade
  return out;
}

// --- Lamp post ---
function lampPost() {
  const m = TILE_PAL.metalDark;
  let out = '';
  // round pole: dark core, a bright vertical specular line, a dark edge
  out += plainRect(15, 8, 2.5, 22, m.base);
  out += plainRect(15.1, 8, 0.8, 22, TILE_PAL.metal.hi, { opacity: 0.55 }); // sheen
  out += plainRect(17, 8, 0.6, 22, m.shade, { opacity: 0.7 });             // shade edge
  // a ground footing
  out += ellipse(16, 29, 5.5, 2, m.shade, { stroke: 'none' });
  out += ellipse(16, 28.5, 4, 1.3, m.base, { stroke: 'none' });
  // the lamp head housing
  out += polygon([[11, 8], [21, 8], [19, 3], [13, 3]], m.base, edge1);
  out += polygon([[11, 8], [13, 3], [14.5, 3], [12.5, 8]], m.light, { stroke: 'none', opacity: 0.5 }); // lit facet
  // the glowing globe with a halo
  out += ellipse(16, 7, 5, 3.6, ACCENT.lamp, { stroke: 'none', opacity: 0.35 }); // halo
  out += ellipse(16, 7, 3.6, 2.8, ACCENT.lamp, { stroke: 'none', opacity: 0.95 });
  out += ellipse(15, 6, 1.4, 1, '#fffce8', { stroke: 'none', opacity: 0.9 }); // hot spot
  return out;
}

// --- Bench ---
function bench() {
  const w = TILE_PAL.wood;
  let out = '';
  // legs first (behind the seat)
  out += plainRect(6, 21, 3, 7, w.shade) + plainRect(23, 21, 3, 7, w.shade);
  out += plainRect(6, 21, 1, 7, TILE_PAL.wood.deep, { opacity: 0.5 }) + plainRect(23, 21, 1, 7, TILE_PAL.wood.deep, { opacity: 0.5 });
  // backrest: two slats
  out += plainRect(4, 8, 24, 2.6, w.base, { rx: 1 });
  out += plainRect(4, 11.5, 24, 2.6, w.shade, { rx: 1 });
  out += plainRect(4, 8, 24, 0.8, w.light, { opacity: 0.6 });
  // seat plank with a lit top, shaded front lip + a grain seam
  out += plainRect(4, 16, 24, 5, w.base, { rx: 1 });
  out += plainRect(4, 16, 24, 1.3, w.light, { opacity: 0.7 }); // lit top
  out += plainRect(4, 19.5, 24, 1.5, w.shade, { opacity: 0.6 }); // front shadow
  out += plainRect(4, 18.2, 24, 0.6, TILE_PAL.wood.grain, { opacity: 0.45 }); // grain seam
  return out;
}

// --- Troughs ---
// A wooden box (lit top rim, shaded inner wall, grain on the staves) holding a
// material. `fill` paints the contents; callers add the surface detail.
function troughBox(fill) {
  const w = TILE_PAL.wood;
  let out = T.rect(4, 12, 24, 14, w.base, { ...edge1, rx: 2 });
  out += plainRect(6, 14, 20, 9, fill);                       // contents
  out += plainRect(6, 14, 20, 1.5, EDGE, { opacity: 0.25 }); // inner-wall cast shadow
  out += plainRect(4, 12, 24, 2.5, w.light, { opacity: 0.65 }); // lit front rim
  out += plainRect(4, 23.5, 24, 2.5, w.shade, { opacity: 0.55 }); // shaded base
  // vertical stave grain on the box face
  for (const sx of [9, 14, 19, 24]) {
    out += plainRect(sx, 23.5, 0.8, 2.5, TILE_PAL.wood.grain, { opacity: 0.4 });
  }
  return out;
}
function troughFood() {
  let out = troughBox(ACCENT.food);
  // a mounded heap of feed: a darker base, lighter crown of pellets
  out += ellipse(16, 19, 9, 3, TILE_PAL.straw.shade, { stroke: 'none', opacity: 0.6 });
  out += T.scatter('TROUGH_FOOD', 14, (x, y, r) =>
    circle(x, 15 + (y - 14) * 0.45, r, (Math.round(x) % 2 ? TILE_PAL.straw.base : TILE_PAL.straw.shade), { stroke: 'none' }),
    { margin: 8, rMin: 0.8, rMax: 1.5 });
  // a few grain husks (lighter flecks) catching the light
  out += T.scatter('TROUGH_FOOD_hi', 5, (x, y, r) =>
    circle(x, 15 + (y - 14) * 0.4, r, TILE_PAL.straw.light, { stroke: 'none', opacity: 0.8 }),
    { margin: 9, rMin: 0.6, rMax: 1 });
  return out;
}
function troughWater() {
  // A water trough: a clearly blue water surface with a lighter reflective band
  // and a couple of ripple lines, set below the lit wood rim.
  const ws = TILE_PAL.waterShallow;
  let out = troughBox(ws.base);
  out += plainRect(6, 14, 20, 2, ws.light, { opacity: 0.7 });   // bright surface reflection
  out += plainRect(6, 21, 20, 1.5, ws.shade, { opacity: 0.5 }); // deeper water at the far wall
  // ripple lines
  out += path('M8 17.5 q4 -1 8 0 t8 0', 'none', { stroke: ws.light, width: 0.8, opacity: 0.7 });
  out += path('M8 19.5 q4 1 8 0 t8 0', 'none', { stroke: ws.shade, width: 0.8, opacity: 0.5 });
  // a small glint
  out += ellipse(11, 16, 2.2, 0.8, '#eaf4f8', { stroke: 'none', opacity: 0.75 });
  return out;
}

// --- Barrel / crate / hay / bin ---
function barrel() {
  const w = TILE_PAL.wood;
  const m = TILE_PAL.metal;
  // A coopered barrel: bulged staves (lit centre stave, dark right edge), vertical
  // stave seams, a domed top, and two banded steel hoops with a sheen.
  let out = T.rect(7, 4, 18, 24, w.base, { ...edge1, rx: 4 });
  out += plainRect(7, 4, 5, 24, w.light, { opacity: 0.45 });   // lit left curve
  out += plainRect(20, 4, 5, 24, TILE_PAL.wood.deep, { opacity: 0.4 }); // dark right curve
  out += plainRect(13, 4, 6, 24, w.light, { opacity: 0.18 });  // gentle centre highlight
  // vertical stave seams
  for (const sx of [11, 14.5, 18, 21.5]) {
    out += plainRect(sx, 5, 0.7, 22, TILE_PAL.wood.grain, { opacity: 0.4 });
  }
  // domed top (the open head)
  out += ellipse(16, 6, 9, 2.4, w.shade, { stroke: EDGE, width: 1 });
  out += ellipse(16, 5.6, 7.5, 1.7, w.light, { stroke: 'none', opacity: 0.6 });
  // two steel hoops with a top-lit sheen line
  for (const hy of [9, 21]) {
    out += plainRect(7, hy, 18, 2.4, m.dark);
    out += plainRect(7, hy, 18, 0.8, m.hi, { opacity: 0.7 });
  }
  return out;
}

function crate() {
  const w = TILE_PAL.wood;
  // A planked crate: a frame, three boards with grain + seams, a diagonal brace,
  // and corner nails so it reads as a built wooden box.
  let out = T.rect(5, 5, 22, 22, w.base, { ...edge1, rx: 1 });
  // three horizontal boards
  for (let i = 0; i < 3; i++) {
    const by = 6 + i * 6.8;
    out += plainRect(6, by, 20, 6, i % 2 ? w.shade : w.base, { rx: 0.5 });
    out += plainRect(6, by, 20, 0.8, w.light, { opacity: 0.5 });          // board top-light
    out += plainRect(6, by + 3, 20, 0.6, TILE_PAL.wood.grain, { opacity: 0.4 }); // grain
  }
  // diagonal brace
  out += path('M7 25 L25 8', 'none', { stroke: TILE_PAL.wood.deep, width: 2 });
  out += path('M7 24 L25 7', 'none', { stroke: w.light, width: 0.7, opacity: 0.4 });
  // frame outline + corner nails
  out += T.rect(5, 5, 22, 22, 'none', { stroke: TILE_PAL.wood.deep, width: 1.5 });
  for (const [nx, ny] of [[7.5, 7.5], [24.5, 7.5], [7.5, 24.5], [24.5, 24.5]]) {
    out += circle(nx, ny, 0.8, TILE_PAL.metal.shade, { stroke: 'none' });
  }
  return out;
}

function hayBale() {
  const s = TILE_PAL.straw;
  // A bound bale: rounded body, top-lit crown, two twine bindings (with a lit
  // edge), and a dense scatter of straw strands for texture.
  let out = T.rect(4, 9, 24, 18, s.base, { ...edge1, rx: 3 });
  out += plainRect(4, 9, 24, 3, s.light, { opacity: 0.6 });   // top-lit crown
  out += plainRect(4, 24, 24, 2, s.shade, { opacity: 0.5 });  // shaded base
  // straw strand texture (deterministic short dashes at varied tones)
  out += T.scatter('HAY_BALE', 22, (x, y, r, i) =>
    path(`M${x} ${(11 + (y - 6) * 0.78).toFixed(1)} l${(2 + (i % 3)).toFixed(1)} ${(i % 2 ? 0.6 : -0.6)}`, 'none',
      { stroke: i % 3 === 0 ? s.light : s.shade, width: 0.7, opacity: 0.6 }),
    { margin: 7 });
  // two twine bindings
  for (const bx of [11, 21]) {
    out += plainRect(bx, 9, 1.8, 18, TILE_PAL.cattail.base);
    out += plainRect(bx, 9, 0.6, 18, TILE_PAL.cattail.light, { opacity: 0.6 });
  }
  return out;
}

function trashBin() {
  const m = TILE_PAL.metalDark;
  // A steel bin: a tapered body with a bright sheen and dark edge, vertical ribs,
  // a domed lid with a highlight, and a handle.
  let out = polygon([[8, 9], [24, 9], [22, 28], [10, 28]], m.base, edge1); // tapered body
  out += polygon([[8, 9], [12, 9], [11, 28], [10, 28]], TILE_PAL.metal.hi, { stroke: 'none', opacity: 0.4 }); // sheen
  out += polygon([[21, 9], [24, 9], [22, 28], [20, 28]], m.shade, { stroke: 'none', opacity: 0.7 }); // dark edge
  // vertical ribs
  for (const rx of [13, 16, 19]) {
    out += plainRect(rx, 11, 1, 16, m.shade, { opacity: 0.55 });
  }
  // domed lid + handle
  out += ellipse(16, 7, 10, 3, m.shade, { stroke: EDGE, width: 1 });
  out += ellipse(16, 6.4, 8, 2, m.base, { stroke: 'none' });
  out += ellipse(14, 5.6, 3, 0.9, TILE_PAL.metal.hi, { stroke: 'none', opacity: 0.6 }); // lid highlight
  out += T.rect(14, 2.5, 4, 3, m.shade, { stroke: 'none', rx: 1 }); // handle knob
  return out;
}

// --- Trimmed topiary bush (a neat hedge cube) ---
function bushTrimmed() {
  const b = TILE_PAL.bush;
  // A clipped hedge cube: top-lit crown, shaded base, dense clipped-foliage stipple
  // (two-tone) so it reads as trimmed leaves rather than a flat green box.
  let out = T.rect(5, 6, 22, 22, b.base, { ...edge1, rx: 4 });
  out += plainRect(5, 6, 22, 4, b.light, { opacity: 0.5 });   // sunlit top
  out += plainRect(5, 24, 22, 3, b.shade, { opacity: 0.5 });  // shaded base
  out += T.scatter('BUSH_TRIMMED_d', 12, (x, y, r) => circle(x, y, r, b.shade, { stroke: 'none', opacity: 0.4 }), { margin: 7, rMin: 1, rMax: 2 });
  out += T.scatter('BUSH_TRIMMED_l', 10, (x, y, r) => circle(x, y, r, b.light, { stroke: 'none', opacity: 0.4 }), { margin: 7, rMin: 0.8, rMax: 1.6 });
  return out;
}

// --- Banner (ysort:'behind' — hangs above; draw in the upper cell) ---
function banner() {
  const r = TILE_PAL.roofRed;
  const m = TILE_PAL.metal;
  // A pennant on a steel crossbar: a swallow-tailed cloth with a lit top band, a
  // shaded fold down one side, gold trim, and a pale device.
  let out = plainRect(0, 2, S, 2.4, m.base);                   // crossbar
  out += plainRect(0, 2, S, 0.8, m.hi, { opacity: 0.6 });      // crossbar sheen
  // the cloth (swallow-tail)
  out += polygon([[6, 4], [26, 4], [26, 24], [16, 20], [6, 24]], r.base, edge1);
  out += plainRect(6, 4, 20, 3.5, r.light, { opacity: 0.5 }); // top-lit band
  out += polygon([[18, 4], [26, 4], [26, 24], [16, 20]], r.shade, { stroke: 'none', opacity: 0.35 }); // fold shade
  // gold trim along the tails
  out += path('M6 24 L16 20 L26 24', 'none', { stroke: ACCENT.signYellow, width: 1, opacity: 0.7 });
  // a pale device on the cloth
  out += circle(16, 12.5, 4, ACCENT.signYellow, { stroke: 'none', opacity: 0.9 });
  out += circle(16, 12.5, 2, '#fff3c0', { stroke: 'none', opacity: 0.7 });
  return out;
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
