'use strict';

/**
 * Environment palette for the tile library (TINS 2026 — The Caves of Steel).
 *
 * The tile analogue of scripts/sprites/palette.js: every fill in every tile
 * builder comes from here, so the whole tileset reads as one cohesive zoo. Each
 * material is a 3-tone family (base / shade / light) via the shared makePalette,
 * so a builder names a material (e.g. TILE_PAL.grass) and gets a consistent
 * top-lit highlight (light) and shadow (shade).
 *
 * Cohesion choices:
 *   - Greens warm and muted (a managed zoo lawn, not a jungle).
 *   - The cage/keeper METAL reuses the robot's steel (#9aa3ad) so the bars echo
 *     the keeper-robots.
 *   - Outlines are AVOIDED on full-bleed ground tiles (they'd draw grid lines as
 *     tiles abut) — see template-tile.fillCell. Deco objects DO get a soft edge
 *     via shade bands, not the heavy sprite OUTLINE.
 */

const { makePalette, shade, tint } = require('../sprites/palette');

/** A soft, near-black edge for deco object silhouettes (lighter than sprite OUTLINE). */
const EDGE = '#1a1c22';

/** Material families. Each is { base, shade, light, accent, eye } from makePalette. */
const TILE_PAL = {
  // --- Terrain ---
  grass: makePalette('#5a8a3c', { accent: '#3f6b2a' }), // managed lawn green
  grassDry: makePalette('#8a9a4a', { accent: '#6b7a38' }), // dry / patchy straw-green
  dirt: makePalette('#8a6038', { accent: '#6b4a2a' }), // bare earth
  mud: makePalette('#5e4a32', { accent: '#473726' }), // wet dark earth
  cobble: makePalette('#8b8b93', { accent: '#6e6e76' }), // stone gray (paths/cobble)
  paved: makePalette('#9a9aa2', { accent: '#7c7c84' }), // lighter poured paving
  concrete: makePalette('#a8a8ae', { accent: '#86868c' }), // floor concrete (warm gray)
  sand: makePalette('#d8c489', { accent: '#b8a468' }), // dry pale sand
  straw: makePalette('#c8a64e', { accent: '#a8863a' }), // pen straw bedding
  // --- Water ---
  waterDeep: makePalette('#2f5d8a', { accent: '#244a70' }), // deep water (solid)
  waterShallow: makePalette('#4f96c8', { accent: '#3f86b8' }), // wadeable shallow
  // --- Wood / floors ---
  woodFloor: makePalette('#b08a52', { accent: '#8a6a3c' }), // warm plank floor
  woodFloorDark: makePalette('#7a5a36', { accent: '#5e4528' }), // dark plank floor
  tileFloor: makePalette('#c8ccd2', { accent: '#a4a8b0' }), // pale ceramic floor
  // --- Nature ---
  leaf: makePalette('#3f7a32', { accent: '#2e5e24' }), // tree canopy
  leafPine: makePalette('#2f6b3a', { accent: '#234f2c' }), // darker pine needles
  bark: makePalette('#6b4a2a', { accent: '#4f3620' }), // trunk / log / stump
  bush: makePalette('#487a34', { accent: '#356026' }), // shrub green
  rock: makePalette('#8a857c', { accent: '#6b675f' }), // gray stone
  // --- Structures ---
  roofRed: makePalette('#b04a36', { accent: '#8a3a2a' }), // clay roof tile
  wall: makePalette('#c2a878', { accent: '#9c8458' }), // exterior stucco wall
  wallInt: makePalette('#d8c8a8', { accent: '#b4a484' }), // interior plaster
  glass: makePalette('#7fb8c8', { accent: '#5a98a8' }), // glass panel (enclosure/window)
  // --- Metal (cage bars / aviary / keeper gate) — reuse the robot steel ---
  metal: makePalette('#9aa3ad', { accent: '#6e7680' }),
  // --- Fence wood (tan rails) ---
  fence: makePalette('#b0894f', { accent: '#8a6a3a' }),
  // --- Prop accents ---
  metalDark: makePalette('#5a626c', { accent: '#444a52' }), // dark steel (bins/lamps)
  wood: makePalette('#9c7444', { accent: '#7a5a34' }), // generic prop wood (crate/barrel/bench)
};

/** Flower / accent spot colours (small dabs, not 3-tone families). */
const ACCENT = {
  flowerRed: '#d6485a',
  flowerYellow: '#e8c44a',
  flowerBlue: '#5a7ad6',
  flowerWhite: '#f0ecdc',
  berry: '#b03048',
  lilyFlower: '#e8d8e8',
  mushroomCap: '#c64838',
  signYellow: '#e8c44a',
  lamp: '#ffe9a8',
  food: '#caa24a',
};

module.exports = { TILE_PAL, ACCENT, EDGE, shade, tint };
