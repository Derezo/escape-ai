'use strict';

/**
 * SVG primitive vocabulary for the sprite library (TINS 2026 — Caves of Steel).
 *
 * Every species builder draws with these helpers so all 14 animals share one
 * stroke weight, one shading scheme, one coordinate idiom — the visual cohesion
 * is structural, not a matter of each author remembering the conventions.
 *
 * Conventions (LOCKED):
 *   - Stroke colour is PALETTE.outline, width 2 at 64px, round join + round cap.
 *   - Flat fills + 3-tone shading (base/shade/light). NO gradients, NO filters —
 *     librsvg (sharp's backend) rasterises those inconsistently and they bloat
 *     determinism.
 *   - All coordinates are rounded to one decimal (n1) so the emitted SVG text is
 *     byte-stable run-to-run (a committed atlas.png that churns on every regen is
 *     bad for diffs).
 */

const { CANVAS, VIEWBOX } = require('./contract');
const { OUTLINE } = require('./palette');

const STROKE_WIDTH = 2;

/** Round to one decimal place — keeps emitted SVG byte-stable. */
function n1(v) {
  return Number(v).toFixed(1);
}

/** The common stroke attribute string for a filled, outlined shape. */
function strokeAttrs(fill, { stroke = OUTLINE, width = STROKE_WIDTH } = {}) {
  return `fill="${fill}" stroke="${stroke}" stroke-width="${width}" stroke-linejoin="round" stroke-linecap="round"`;
}

/** An axis-aligned ellipse. */
function ellipse(cx, cy, rx, ry, fill, opts) {
  return `<ellipse cx="${n1(cx)}" cy="${n1(cy)}" rx="${n1(rx)}" ry="${n1(ry)}" ${strokeAttrs(fill, opts)}/>`;
}

/** A circle. */
function circle(cx, cy, r, fill, opts) {
  return `<circle cx="${n1(cx)}" cy="${n1(cy)}" r="${n1(r)}" ${strokeAttrs(fill, opts)}/>`;
}

/** A rounded rect (rx defaults to a gentle corner). */
function rect(x, y, w, h, fill, opts = {}) {
  const rx = opts.rx != null ? opts.rx : Math.min(w, h) * 0.25;
  return `<rect x="${n1(x)}" y="${n1(y)}" width="${n1(w)}" height="${n1(h)}" rx="${n1(rx)}" ${strokeAttrs(fill, opts)}/>`;
}

/** A polygon from an array of [x,y] points. */
function polygon(points, fill, opts) {
  const pts = points.map(([x, y]) => `${n1(x)},${n1(y)}`).join(' ');
  return `<polygon points="${pts}" ${strokeAttrs(fill, opts)}/>`;
}

/** A free path (caller supplies a `d` string; coords should already be n1-ish). */
function path(d, fill, opts) {
  return `<path d="${d}" ${strokeAttrs(fill, opts)}/>`;
}

/**
 * A limb / appendage as a stroked capsule from (x1,y1) to (x2,y2). Drawn as a
 * thick round-capped line so legs/arms/tails read as solid limbs without a
 * separate fill shape. `thickness` is the limb width in px.
 */
function limb(x1, y1, x2, y2, fill, thickness = 6, opts = {}) {
  // A capsule = a wide round-capped stroke. We draw it as a <path> line with a
  // fat stroke of the FILL colour, plus a thin outline by overdrawing. Simplest
  // robust capsule: a stroked line in fill colour, then the same line stroked
  // thinner in outline is wrong (it'd cover the fill). Instead use a rounded
  // rect rotated — but rotation breaks byte-stability of mirror. So: a polygon
  // capsule approximated by a thick line in outline UNDER a slightly thinner
  // line in fill, giving a clean outlined capsule.
  const half = thickness / 2;
  return (
    `<line x1="${n1(x1)}" y1="${n1(y1)}" x2="${n1(x2)}" y2="${n1(y2)}" ` +
    `stroke="${opts.stroke || OUTLINE}" stroke-width="${n1(thickness + STROKE_WIDTH)}" stroke-linecap="round"/>` +
    `<line x1="${n1(x1)}" y1="${n1(y1)}" x2="${n1(x2)}" y2="${n1(y2)}" ` +
    `stroke="${fill}" stroke-width="${n1(thickness)}" stroke-linecap="round"/>` +
    // suppress unused-var lint for `half` while keeping the documented intent
    (half < 0 ? '' : '')
  );
}

/** Wrap a fragment in a <g> (optionally with a transform). */
function group(inner, transform) {
  return transform ? `<g transform="${transform}">${inner}</g>` : `<g>${inner}</g>`;
}

/**
 * Horizontally mirror a fragment about the canvas centre. Used by the generator
 * to emit the 3 mirrored directions (w/sw/nw) from the authored (e/se/ne). A
 * builder never calls this — the pipeline does.
 */
function mirrorX(inner) {
  return `<g transform="translate(${CANVAS},0) scale(-1,1)">${inner}</g>`;
}

/** Points string for a regular n-gon (absorbed from the old generator). */
function polyPoints(cx, cy, radius, n, start) {
  const pts = [];
  for (let i = 0; i < n; i++) {
    const ang = start + (i * 2 * Math.PI) / n;
    pts.push(`${n1(cx + Math.cos(ang) * radius)},${n1(cy + Math.sin(ang) * radius)}`);
  }
  return pts.join(' ');
}

/** Points string for a star (absorbed from the old generator). */
function starPoints(cx, cy, outer, inner, points) {
  const pts = [];
  const step = Math.PI / points;
  for (let i = 0; i < points * 2; i++) {
    const rad = i % 2 === 0 ? outer : inner;
    const ang = i * step - Math.PI / 2;
    pts.push(`${n1(cx + Math.cos(ang) * rad)},${n1(cy + Math.sin(ang) * rad)}`);
  }
  return pts.join(' ');
}

/** A regular polygon shape (uses polyPoints) — handy for robot chassis, crests. */
function ngon(cx, cy, radius, n, start, fill, opts) {
  return `<polygon points="${polyPoints(cx, cy, radius, n, start)}" ${strokeAttrs(fill, opts)}/>`;
}

/**
 * Wrap an inner fragment in a complete, transparent-background SVG document for
 * one frame. (Generalised from the old generator's buildSvg, minus the label.)
 */
function svgDoc(inner) {
  return (
    `<?xml version="1.0" encoding="UTF-8"?>\n` +
    `<svg xmlns="http://www.w3.org/2000/svg" width="${CANVAS}" height="${CANVAS}" viewBox="${VIEWBOX}">\n` +
    `  <rect width="${CANVAS}" height="${CANVAS}" fill="none"/>\n` +
    `  ${inner}\n` +
    `</svg>\n`
  );
}

module.exports = {
  n1,
  STROKE_WIDTH,
  strokeAttrs,
  ellipse,
  circle,
  rect,
  polygon,
  path,
  limb,
  group,
  mirrorX,
  polyPoints,
  starPoints,
  ngon,
  svgDoc,
};
