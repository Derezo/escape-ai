'use strict';

/**
 * BRIDGE builders (indices 145..146) — TINS 2026, Escape AI.
 *
 * Wooden bridge decks: a GROUND tile (full-bleed, walkable) that reads as planking
 * over water, so the river crossing looks like a bridge instead of bare PAVED. Both
 * are full-bleed (fillCell) so the deck tiles seamlessly along the span, with
 * darker plank SEAMS running ACROSS the direction of travel and two solid side
 * RAILS (a beam + posts) along the edges parallel to travel.
 *
 *   - BRIDGE_H spans an E-W path over N-S water: planks run vertically (seams are
 *     vertical lines across the E-W span), rails on the TOP + BOTTOM edges.
 *   - BRIDGE_V spans a N-S path over E-W water: planks run horizontally (seams are
 *     horizontal lines across the N-S span), rails on the LEFT + RIGHT edges.
 *
 * Top-lit + deterministic (no Math.random): plank seams + posts are at fixed
 * offsets, kept off the cell boundaries so the deck reads continuous when tiled.
 */

const T = require('../template-tile');
const { TILE_PAL } = require('../tilepalette');

const { fillCell, plainRect } = T;
const S = T.S; // 32

// Deck = warm plank floor; rails = the darker plank-floor family (posts/beam).
const DECK = TILE_PAL.woodFloor;
const RAIL = TILE_PAL.woodFloorDark;

/** Rail thickness (px) along an edge, and the post spacing/size along the beam. */
const RAIL_W = 5;
const POST_W = 2;

/**
 * BRIDGE_H — horizontal bridge deck (E-W travel, N-S water below).
 * Vertical planks (seams running across the E-W span) + rails top+bottom.
 */
function bridgeH() {
  let out = fillCell(DECK.base);

  // Vertical plank seams: 5 boards across, seams at x = 5,11,16,21,27 (off the
  // 0/31 cell edges so adjacent tiles read as continuous decking).
  for (const x of [5, 11, 16, 21, 27]) {
    out += plainRect(x, RAIL_W, 1, S - RAIL_W * 2, DECK.shade, { opacity: 0.7 });
  }
  // A soft top-lit highlight band just inside the top rail.
  out += plainRect(0, RAIL_W, S, 1.5, DECK.light, { opacity: 0.35 });

  // Side rails on the TOP and BOTTOM edges (parallel to E-W travel): a solid beam
  // with regularly spaced posts, top-lit.
  out += rail(0, 0, S, RAIL_W, 'h'); // top
  out += rail(0, S - RAIL_W, S, RAIL_W, 'h'); // bottom
  return out;
}

/**
 * BRIDGE_V — vertical bridge deck (N-S travel, E-W water below).
 * Horizontal planks (seams running across the N-S span) + rails left+right.
 */
function bridgeV() {
  let out = fillCell(DECK.base);

  // Horizontal plank seams: 5 boards down, seams at y = 5,11,16,21,27.
  for (const y of [5, 11, 16, 21, 27]) {
    out += plainRect(RAIL_W, y, S - RAIL_W * 2, 1, DECK.shade, { opacity: 0.7 });
  }
  // A soft highlight band just inside the left rail.
  out += plainRect(RAIL_W, 0, 1.5, S, DECK.light, { opacity: 0.35 });

  // Side rails on the LEFT and RIGHT edges (parallel to N-S travel).
  out += rail(0, 0, RAIL_W, S, 'v'); // left
  out += rail(S - RAIL_W, 0, RAIL_W, S, 'v'); // right
  return out;
}

/**
 * A single side rail: a solid darker beam filling (x,y,w,h), a top-lit highlight
 * along its outer face, plus evenly spaced posts. `dir` ('h' | 'v') picks whether
 * the posts march horizontally (top/bottom rails) or vertically (left/right rails).
 */
function rail(x, y, w, h, dir) {
  let out = plainRect(x, y, w, h, RAIL.base);
  if (dir === 'h') {
    // top-lit face along the rail's length
    out += plainRect(x, y, w, 1.5, RAIL.light, { opacity: 0.5 });
    // posts at fixed x offsets
    for (const px of [4, 11, 18, 25]) {
      out += plainRect(px, y, POST_W, h, RAIL.shade, { opacity: 0.8 });
    }
  } else {
    out += plainRect(x, y, 1.5, h, RAIL.light, { opacity: 0.5 });
    for (const py of [4, 11, 18, 25]) {
      out += plainRect(x, py, w, POST_W, RAIL.shade, { opacity: 0.8 });
    }
  }
  return out;
}

module.exports = {
  buildBridgeH: bridgeH,
  buildBridgeV: bridgeV,
};
