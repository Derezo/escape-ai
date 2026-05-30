'use strict';

/**
 * Environment palette for the tile library (TINS 2026 — Escape AI).
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
  // Single blue hue family: deep and shallow share ONE hue (203°) with consistent saturation;
  // only lightness varies so they read as one body of water at two depths, not two materials.
  // Shallow is bright (accessible), deep is darker (shows depth), abyss is subtle (not a hole).
  waterDeep: makePalette('#3d7fa8', { accent: '#2f6a94' }), // deep water, same hue as shallow
  waterShallow: makePalette('#5ba3d0', { accent: '#4a8fbf' }), // bright wadeable shallow
  // A subtle darkening for deep-water depth gradient (10% darker than waterDeep, not a near-black hole).
  waterAbyss: makePalette('#2e6a94', { accent: '#235485' }), // depth hint, same hue as deep
  // Light shimmer for the shallow surface (lighter than shallow base, still one hue).
  waterWade: makePalette('#6db5d8', { accent: '#5c9fbf' }),
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

// Extra tones for materials that need more than the base 3-tone family for depth.
// APPEND-ONLY: these add keys to existing families (never rename base/shade/light).
//   fence.grain — a darker mid-brown for wood-grain streaks on rails/posts.
//   fence.deep  — the deepest core shadow on the round side of a turned post.
//   metal.dark  — a darker steel for the shaded side of a round bar.
//   metal.hi    — a bright steel specular highlight down a bar's lit edge.
TILE_PAL.fence.grain = shade(TILE_PAL.fence.base, 0.34);
TILE_PAL.fence.deep = shade(TILE_PAL.fence.base, 0.5);
TILE_PAL.metal.dark = shade(TILE_PAL.metal.base, 0.34);
TILE_PAL.metal.hi = tint(TILE_PAL.metal.base, 0.42);

// NATURE/PROP detail tones (APPEND-ONLY — add keys to existing families).
//   rock.crack — dark line for facet edges / cracks on stone.
//   rock.grain — a mid tone for grain striations across a rock face.
//   bark.deep  — deepest heartwood ring / bark-crevice shadow (stump/log).
//   wood.grain — darker streak for plank wood-grain (barrel/crate/bench).
//   wood.deep  — core shadow on the round side of a barrel stave.
//   straw.grain— darker straw streak for hay-bale texture.
//   leafPine.deep — shaded underside of a conifer tier.
TILE_PAL.rock.crack = shade(TILE_PAL.rock.base, 0.5);
TILE_PAL.rock.grain = shade(TILE_PAL.rock.base, 0.18);
TILE_PAL.bark.deep = shade(TILE_PAL.bark.base, 0.5);
TILE_PAL.wood.grain = shade(TILE_PAL.wood.base, 0.32);
TILE_PAL.wood.deep = shade(TILE_PAL.wood.base, 0.5);
TILE_PAL.straw.grain = shade(TILE_PAL.straw.base, 0.34);
TILE_PAL.leafPine.deep = shade(TILE_PAL.leafPine.base, 0.34);
// Moss specks for stone/stump; cattail brown for seed-heads (full 3-tone families).
TILE_PAL.moss = makePalette('#5a7a36', { accent: '#43602a' });
TILE_PAL.cattail = makePalette('#7a4a26', { accent: '#5e3a1c' });
// Layered petal families (base/shade/light) for readable blooms; the accent
// hexes mirror ACCENT.flower* so a bloom and a flat dab still match in colour.
TILE_PAL.petalRed = makePalette('#d6485a');
TILE_PAL.petalYellow = makePalette('#e8c44a');
TILE_PAL.petalBlue = makePalette('#5a7ad6');
TILE_PAL.lily = makePalette('#e8d8e8');

// Terracotta shingle tones (roofRed). The 3-tone family is too flat for overlapping
// clay tabs, so add:
//   roofRed.mid  — an alternating-course clay (a touch deeper than base) for running-bond.
//   roofRed.deep — the lip-shadow under each tab's overhang (the row separation).
//   roofRed.hi   — a warm sun-catch along a tab's top edge (the highlight roll).
TILE_PAL.roofRed.mid = shade(TILE_PAL.roofRed.base, 0.12);
TILE_PAL.roofRed.deep = shade(TILE_PAL.roofRed.base, 0.42);
TILE_PAL.roofRed.hi = tint(TILE_PAL.roofRed.base, 0.3);

// Brick/stone coursing tones (wall, exterior stucco-brick). Add:
//   wall.mid    — an alternating brick face (every other course/brick reads distinct).
//   wall.mortar — the recessed joint colour (a real darker line, not a 1px ghost).
//   wall.deep   — the bottom-of-brick contact shadow under each course.
//   wall.quoin  — a bright dressed-stone block for terminating ends / corner quoins.
TILE_PAL.wall.mid = shade(TILE_PAL.wall.base, 0.12);
TILE_PAL.wall.mortar = shade(TILE_PAL.wall.base, 0.4);
TILE_PAL.wall.deep = shade(TILE_PAL.wall.base, 0.55);
TILE_PAL.wall.quoin = tint(TILE_PAL.wall.base, 0.26);

// Interior plaster-brick counterparts (lighter, lower contrast than exterior).
TILE_PAL.wallInt.mid = shade(TILE_PAL.wallInt.base, 0.1);
TILE_PAL.wallInt.mortar = shade(TILE_PAL.wallInt.base, 0.34);
TILE_PAL.wallInt.deep = shade(TILE_PAL.wallInt.base, 0.46);
TILE_PAL.wallInt.quoin = tint(TILE_PAL.wallInt.base, 0.24);

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
  // --- Shoreline / water detail ---
  foam: '#eaf4f8',        // near-white surf foam at the grass↔water line
  foamSoft: '#cfe6ef',    // a softer foam tint (the wet-sand fringe just inside the foam)
  pathWorn: '#7a6446',    // a trodden dirt margin where grass meets a path
};

module.exports = { TILE_PAL, ACCENT, EDGE, shade, tint };
