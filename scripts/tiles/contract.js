'use strict';

/**
 * THE TILE-ART CONTRACT  (TINS 2026 — Escape AI)
 *
 * The CJS mirror of shared/src/tiles.ts `TILES`. The zero-dep tile-art generator
 * can't import the TypeScript source, so this file restates the registry's
 * ordered name+index+flags list. It is the tile analogue of
 * scripts/sprites/contract.js — the ONE place the generator, the tileset packer,
 * and the verifier all derive tile identity from.
 *
 * THE DRIFT GATE: verify-tileset.js parses the `TILES` block of
 * shared/src/tiles.ts with a narrow regex and asserts this list's names + indices
 * + order match it EXACTLY (see parseSharedTiles below). So if someone appends a
 * tile to the canonical TS registry without updating this mirror (or vice-versa),
 * the verifier fails — the tileset PNG's grid position (= index) is guaranteed to
 * line up with what world-gen emits.
 *
 * PACKING (LOCKED — matches client/src/render/phaser.ts buildWorld/buildCanopies):
 *   - 16 columns, 32px cells, NO margin/spacing.
 *   - A tile's grid slot IS its index: cell (index % 16, floor(index / 16)).
 *   - Index 0 (EMPTY) is a transparent cell — Phaser treats tile index 0 as
 *     "no tile". The packer leaves it blank.
 *
 * LIGHTING (LOCKED): every tile is TOP-LIT — the top edge reads lighter, the
 * bottom edge reads in shade. Builders use template-tile's topLight/bottomShade
 * bands + palette light/shade so the whole sheet has one consistent light source.
 */

const fs = require('fs');
const path = require('path');

/** Tile side length in px (square). Matches shared TILE_SIZE. */
const TILE_SIZE = 32;
/** Tileset grid width, in cells. Matches the renderer's hardcoded `cols = 16`. */
const COLS = 16;
/** SVG viewBox for one 32px tile cell. */
const VIEWBOX = `0 0 ${TILE_SIZE} ${TILE_SIZE}`;
/** The locked light direction: top-lit (light comes from the top of the cell). */
const LIGHT_DIR = { x: 0, y: -1 };

/**
 * THE ORDERED TILE LIST — a faithful mirror of shared/src/tiles.ts `TILES`.
 * Each entry: { name, index, layer, solid, ysort, build } where `build` is the
 * builder-function key in scripts/tiles/registry.js. The list MUST be in index
 * order (it is also declaration order in the TS source); verify-tileset asserts
 * names + indices + order against the TS file.
 *
 * `build` keys group naturally by category — many tiles in a set share one
 * parametric builder (e.g. all 12 PATH_* edges call buildPathEdge with the name).
 */
const TILE_LIST = [
  { name: 'EMPTY', index: 0, layer: 'ground', solid: false, ysort: 'none', build: 'buildEmpty' },

  // --- Terrain / ground (1..24) ---
  { name: 'GRASS_A', index: 1, layer: 'ground', solid: false, ysort: 'none', build: 'buildGrass' },
  { name: 'GRASS_B', index: 2, layer: 'ground', solid: false, ysort: 'none', build: 'buildGrass' },
  { name: 'GRASS_C', index: 3, layer: 'ground', solid: false, ysort: 'none', build: 'buildGrass' },
  { name: 'GRASS_FLOWERS', index: 4, layer: 'ground', solid: false, ysort: 'none', build: 'buildGrassFlowers' },
  { name: 'GRASS_PATCHY', index: 5, layer: 'ground', solid: false, ysort: 'none', build: 'buildGrassPatchy' },
  { name: 'DIRT', index: 6, layer: 'ground', solid: false, ysort: 'none', build: 'buildDirt' },
  { name: 'DIRT_TRAMPLED', index: 7, layer: 'ground', solid: false, ysort: 'none', build: 'buildDirtTrampled' },
  { name: 'COBBLE', index: 8, layer: 'ground', solid: false, ysort: 'none', build: 'buildCobble' },
  { name: 'COBBLE_WORN', index: 9, layer: 'ground', solid: false, ysort: 'none', build: 'buildCobbleWorn' },
  { name: 'PAVED', index: 10, layer: 'ground', solid: false, ysort: 'none', build: 'buildPaved' },
  { name: 'PAVED_CRACK', index: 11, layer: 'ground', solid: false, ysort: 'none', build: 'buildPavedCrack' },
  { name: 'SAND', index: 12, layer: 'ground', solid: false, ysort: 'none', build: 'buildSand' },
  { name: 'SAND_RIPPLE', index: 13, layer: 'ground', solid: false, ysort: 'none', build: 'buildSandRipple' },
  { name: 'MUD', index: 14, layer: 'ground', solid: false, ysort: 'none', build: 'buildMud' },
  { name: 'MUD_PUDDLE', index: 15, layer: 'ground', solid: false, ysort: 'none', build: 'buildMudPuddle' },
  { name: 'WATER_DEEP', index: 16, layer: 'ground', solid: true, ysort: 'none', build: 'buildWaterDeep' },
  { name: 'WATER_SHALLOW', index: 17, layer: 'ground', solid: false, ysort: 'none', build: 'buildWaterShallow' },
  { name: 'FLOOR_WOOD', index: 18, layer: 'ground', solid: false, ysort: 'none', build: 'buildFloorWood' },
  { name: 'FLOOR_WOOD_DARK', index: 19, layer: 'ground', solid: false, ysort: 'none', build: 'buildFloorWoodDark' },
  { name: 'FLOOR_TILE', index: 20, layer: 'ground', solid: false, ysort: 'none', build: 'buildFloorTile' },
  { name: 'FLOOR_TILE_CHECKER', index: 21, layer: 'ground', solid: false, ysort: 'none', build: 'buildFloorTileChecker' },
  { name: 'FLOOR_CONCRETE', index: 22, layer: 'ground', solid: false, ysort: 'none', build: 'buildFloorConcrete' },
  { name: 'PEN_FLOOR_STRAW', index: 23, layer: 'ground', solid: false, ysort: 'none', build: 'buildPenFloorStraw' },
  { name: 'PEN_FLOOR_CONCRETE', index: 24, layer: 'ground', solid: false, ysort: 'none', build: 'buildPenFloorConcrete' },

  // --- Edges / transitions (25..48) ---
  { name: 'PATH_EDGE_N', index: 25, layer: 'ground', solid: false, ysort: 'none', build: 'buildPathEdge' },
  { name: 'PATH_EDGE_E', index: 26, layer: 'ground', solid: false, ysort: 'none', build: 'buildPathEdge' },
  { name: 'PATH_EDGE_S', index: 27, layer: 'ground', solid: false, ysort: 'none', build: 'buildPathEdge' },
  { name: 'PATH_EDGE_W', index: 28, layer: 'ground', solid: false, ysort: 'none', build: 'buildPathEdge' },
  { name: 'PATH_CORNER_NE', index: 29, layer: 'ground', solid: false, ysort: 'none', build: 'buildPathEdge' },
  { name: 'PATH_CORNER_NW', index: 30, layer: 'ground', solid: false, ysort: 'none', build: 'buildPathEdge' },
  { name: 'PATH_CORNER_SE', index: 31, layer: 'ground', solid: false, ysort: 'none', build: 'buildPathEdge' },
  { name: 'PATH_CORNER_SW', index: 32, layer: 'ground', solid: false, ysort: 'none', build: 'buildPathEdge' },
  { name: 'PATH_ICORNER_NE', index: 33, layer: 'ground', solid: false, ysort: 'none', build: 'buildPathEdge' },
  { name: 'PATH_ICORNER_NW', index: 34, layer: 'ground', solid: false, ysort: 'none', build: 'buildPathEdge' },
  { name: 'PATH_ICORNER_SE', index: 35, layer: 'ground', solid: false, ysort: 'none', build: 'buildPathEdge' },
  { name: 'PATH_ICORNER_SW', index: 36, layer: 'ground', solid: false, ysort: 'none', build: 'buildPathEdge' },
  { name: 'WATER_EDGE_N', index: 37, layer: 'ground', solid: false, ysort: 'none', build: 'buildWaterEdge' },
  { name: 'WATER_EDGE_E', index: 38, layer: 'ground', solid: false, ysort: 'none', build: 'buildWaterEdge' },
  { name: 'WATER_EDGE_S', index: 39, layer: 'ground', solid: false, ysort: 'none', build: 'buildWaterEdge' },
  { name: 'WATER_EDGE_W', index: 40, layer: 'ground', solid: false, ysort: 'none', build: 'buildWaterEdge' },
  { name: 'WATER_CORNER_NE', index: 41, layer: 'ground', solid: false, ysort: 'none', build: 'buildWaterEdge' },
  { name: 'WATER_CORNER_NW', index: 42, layer: 'ground', solid: false, ysort: 'none', build: 'buildWaterEdge' },
  { name: 'WATER_CORNER_SE', index: 43, layer: 'ground', solid: false, ysort: 'none', build: 'buildWaterEdge' },
  { name: 'WATER_CORNER_SW', index: 44, layer: 'ground', solid: false, ysort: 'none', build: 'buildWaterEdge' },
  { name: 'WATER_ICORNER_NE', index: 45, layer: 'ground', solid: false, ysort: 'none', build: 'buildWaterEdge' },
  { name: 'WATER_ICORNER_NW', index: 46, layer: 'ground', solid: false, ysort: 'none', build: 'buildWaterEdge' },
  { name: 'WATER_ICORNER_SE', index: 47, layer: 'ground', solid: false, ysort: 'none', build: 'buildWaterEdge' },
  { name: 'WATER_ICORNER_SW', index: 48, layer: 'ground', solid: false, ysort: 'none', build: 'buildWaterEdge' },

  // --- Nature (49..74) ---
  { name: 'TREE_TRUNK', index: 49, layer: 'deco', solid: true, ysort: 'none', build: 'buildTreeTrunk' },
  { name: 'TREE_CANOPY', index: 50, layer: 'deco', solid: false, ysort: 'behind', build: 'buildTreeCanopy' },
  { name: 'TREE_CANOPY_L', index: 51, layer: 'deco', solid: false, ysort: 'behind', build: 'buildTreeCanopyL' },
  { name: 'TREE_CANOPY_R', index: 52, layer: 'deco', solid: false, ysort: 'behind', build: 'buildTreeCanopyR' },
  { name: 'TREE_CANOPY_TOP', index: 53, layer: 'deco', solid: false, ysort: 'behind', build: 'buildTreeCanopyTop' },
  { name: 'PINE_TRUNK', index: 54, layer: 'deco', solid: true, ysort: 'none', build: 'buildPineTrunk' },
  { name: 'PINE_CANOPY', index: 55, layer: 'deco', solid: false, ysort: 'behind', build: 'buildPineCanopy' },
  { name: 'BUSH_SM', index: 56, layer: 'deco', solid: true, ysort: 'none', build: 'buildBushSm' },
  { name: 'BUSH_LG', index: 57, layer: 'deco', solid: true, ysort: 'none', build: 'buildBushLg' },
  { name: 'BUSH_BERRY', index: 58, layer: 'deco', solid: true, ysort: 'none', build: 'buildBushBerry' },
  { name: 'ROCK_SM', index: 59, layer: 'deco', solid: false, ysort: 'none', build: 'buildRockSm' },
  { name: 'ROCK_LG', index: 60, layer: 'deco', solid: true, ysort: 'none', build: 'buildRockLg' },
  { name: 'ROCK_FLAT', index: 61, layer: 'deco', solid: false, ysort: 'none', build: 'buildRockFlat' },
  { name: 'BOULDER', index: 62, layer: 'deco', solid: true, ysort: 'none', build: 'buildBoulder' },
  { name: 'FLOWER_RED', index: 63, layer: 'deco', solid: false, ysort: 'none', build: 'buildFlowerRed' },
  { name: 'FLOWER_YELLOW', index: 64, layer: 'deco', solid: false, ysort: 'none', build: 'buildFlowerYellow' },
  { name: 'FLOWER_BLUE', index: 65, layer: 'deco', solid: false, ysort: 'none', build: 'buildFlowerBlue' },
  { name: 'FLOWER_BED', index: 66, layer: 'deco', solid: false, ysort: 'none', build: 'buildFlowerBed' },
  { name: 'GRASS_TALL', index: 67, layer: 'deco', solid: false, ysort: 'none', build: 'buildGrassTall' },
  { name: 'STUMP', index: 68, layer: 'deco', solid: false, ysort: 'none', build: 'buildStump' },
  { name: 'LOG', index: 69, layer: 'deco', solid: true, ysort: 'none', build: 'buildLog' },
  { name: 'LILY_PAD', index: 70, layer: 'deco', solid: false, ysort: 'none', build: 'buildLilyPad' },
  { name: 'LILY_FLOWER', index: 71, layer: 'deco', solid: false, ysort: 'none', build: 'buildLilyFlower' },
  { name: 'REEDS', index: 72, layer: 'deco', solid: false, ysort: 'behind', build: 'buildReeds' },
  { name: 'CATTAILS', index: 73, layer: 'deco', solid: false, ysort: 'behind', build: 'buildCattails' },
  { name: 'MUSHROOM', index: 74, layer: 'deco', solid: false, ysort: 'none', build: 'buildMushroom' },

  // --- Structures: walls / roofs / doors (75..102) ---
  { name: 'WALL_EXT_MID', index: 75, layer: 'deco', solid: true, ysort: 'none', build: 'buildWallExtMid' },
  { name: 'WALL_EXT_N_END', index: 76, layer: 'deco', solid: true, ysort: 'none', build: 'buildWallExtEnd' },
  { name: 'WALL_EXT_E_END', index: 77, layer: 'deco', solid: true, ysort: 'none', build: 'buildWallExtEnd' },
  { name: 'WALL_EXT_S_END', index: 78, layer: 'deco', solid: true, ysort: 'none', build: 'buildWallExtEnd' },
  { name: 'WALL_EXT_W_END', index: 79, layer: 'deco', solid: true, ysort: 'none', build: 'buildWallExtEnd' },
  { name: 'WALL_EXT_CORNER_NE', index: 80, layer: 'deco', solid: true, ysort: 'none', build: 'buildWallExtCorner' },
  { name: 'WALL_EXT_CORNER_NW', index: 81, layer: 'deco', solid: true, ysort: 'none', build: 'buildWallExtCorner' },
  { name: 'WALL_EXT_CORNER_SE', index: 82, layer: 'deco', solid: true, ysort: 'none', build: 'buildWallExtCorner' },
  { name: 'WALL_EXT_CORNER_SW', index: 83, layer: 'deco', solid: true, ysort: 'none', build: 'buildWallExtCorner' },
  { name: 'WALL_INT_MID', index: 84, layer: 'deco', solid: true, ysort: 'none', build: 'buildWallIntMid' },
  { name: 'WALL_INT_CORNER_NE', index: 85, layer: 'deco', solid: true, ysort: 'none', build: 'buildWallIntCorner' },
  { name: 'WALL_INT_CORNER_NW', index: 86, layer: 'deco', solid: true, ysort: 'none', build: 'buildWallIntCorner' },
  { name: 'WALL_INT_CORNER_SE', index: 87, layer: 'deco', solid: true, ysort: 'none', build: 'buildWallIntCorner' },
  { name: 'WALL_INT_CORNER_SW', index: 88, layer: 'deco', solid: true, ysort: 'none', build: 'buildWallIntCorner' },
  { name: 'WINDOW', index: 89, layer: 'deco', solid: true, ysort: 'none', build: 'buildWindow' },
  { name: 'DOOR_CLOSED', index: 90, layer: 'deco', solid: true, ysort: 'none', build: 'buildDoorClosed' },
  { name: 'DOOR_OPEN', index: 91, layer: 'deco', solid: false, ysort: 'none', build: 'buildDoorOpen' },
  { name: 'ROOF_RED_MID', index: 92, layer: 'roof', solid: false, ysort: 'none', build: 'buildRoofMid' },
  { name: 'ROOF_RED_EDGE_N', index: 93, layer: 'roof', solid: false, ysort: 'none', build: 'buildRoofEdge' },
  { name: 'ROOF_RED_EDGE_E', index: 94, layer: 'roof', solid: false, ysort: 'none', build: 'buildRoofEdge' },
  { name: 'ROOF_RED_EDGE_S', index: 95, layer: 'roof', solid: false, ysort: 'none', build: 'buildRoofEdge' },
  { name: 'ROOF_RED_EDGE_W', index: 96, layer: 'roof', solid: false, ysort: 'none', build: 'buildRoofEdge' },
  { name: 'ROOF_RED_CORNER_NE', index: 97, layer: 'roof', solid: false, ysort: 'none', build: 'buildRoofCorner' },
  { name: 'ROOF_RED_CORNER_NW', index: 98, layer: 'roof', solid: false, ysort: 'none', build: 'buildRoofCorner' },
  { name: 'ROOF_RED_CORNER_SE', index: 99, layer: 'roof', solid: false, ysort: 'none', build: 'buildRoofCorner' },
  { name: 'ROOF_RED_CORNER_SW', index: 100, layer: 'roof', solid: false, ysort: 'none', build: 'buildRoofCorner' },
  { name: 'ROOF_RIDGE', index: 101, layer: 'roof', solid: false, ysort: 'none', build: 'buildRoofRidge' },
  { name: 'ROOF_PEAK', index: 102, layer: 'roof', solid: false, ysort: 'none', build: 'buildRoofPeak' },

  // --- Fences / barriers (103..118) ---
  { name: 'FENCE_H', index: 103, layer: 'deco', solid: true, ysort: 'none', build: 'buildFenceH' },
  { name: 'FENCE_V', index: 104, layer: 'deco', solid: true, ysort: 'none', build: 'buildFenceV' },
  { name: 'FENCE_POST', index: 105, layer: 'deco', solid: true, ysort: 'none', build: 'buildFencePost' },
  { name: 'FENCE_CORNER_NE', index: 106, layer: 'deco', solid: true, ysort: 'none', build: 'buildFenceCorner' },
  { name: 'FENCE_CORNER_NW', index: 107, layer: 'deco', solid: true, ysort: 'none', build: 'buildFenceCorner' },
  { name: 'FENCE_CORNER_SE', index: 108, layer: 'deco', solid: true, ysort: 'none', build: 'buildFenceCorner' },
  { name: 'FENCE_CORNER_SW', index: 109, layer: 'deco', solid: true, ysort: 'none', build: 'buildFenceCorner' },
  { name: 'FENCE_T_N', index: 110, layer: 'deco', solid: true, ysort: 'none', build: 'buildFenceT' },
  { name: 'FENCE_T_E', index: 111, layer: 'deco', solid: true, ysort: 'none', build: 'buildFenceT' },
  { name: 'FENCE_T_S', index: 112, layer: 'deco', solid: true, ysort: 'none', build: 'buildFenceT' },
  { name: 'FENCE_T_W', index: 113, layer: 'deco', solid: true, ysort: 'none', build: 'buildFenceT' },
  { name: 'FENCE_GATE', index: 114, layer: 'deco', solid: false, ysort: 'none', build: 'buildFenceGate' },
  { name: 'CAGE_BARS_H', index: 115, layer: 'deco', solid: true, ysort: 'none', build: 'buildCageBarsH' },
  { name: 'CAGE_BARS_V', index: 116, layer: 'deco', solid: true, ysort: 'none', build: 'buildCageBarsV' },
  { name: 'CAGE_CORNER', index: 117, layer: 'deco', solid: true, ysort: 'none', build: 'buildCageCorner' },
  { name: 'CAGE_GATE', index: 118, layer: 'deco', solid: false, ysort: 'none', build: 'buildCageGate' },

  // --- Zoo housing (119..132) ---
  { name: 'ENCLOSURE_WALL_LOW', index: 119, layer: 'deco', solid: true, ysort: 'none', build: 'buildEnclosureWallLow' },
  { name: 'ENCLOSURE_GLASS', index: 120, layer: 'deco', solid: true, ysort: 'none', build: 'buildEnclosureGlass' },
  { name: 'MOAT_EDGE', index: 121, layer: 'deco', solid: true, ysort: 'none', build: 'buildMoatEdge' },
  { name: 'POND_DEEP', index: 122, layer: 'ground', solid: true, ysort: 'none', build: 'buildPondDeep' },
  { name: 'POND_EDGE', index: 123, layer: 'ground', solid: false, ysort: 'none', build: 'buildPondEdge' },
  { name: 'AVIARY_MESH', index: 124, layer: 'deco', solid: true, ysort: 'none', build: 'buildAviaryMesh' },
  { name: 'AVIARY_FRAME', index: 125, layer: 'deco', solid: true, ysort: 'none', build: 'buildAviaryFrame' },
  { name: 'ROCKY_DEN_MOUTH', index: 126, layer: 'deco', solid: true, ysort: 'none', build: 'buildRockyDenMouth' },
  { name: 'ROCKY_DEN_WALL', index: 127, layer: 'deco', solid: true, ysort: 'none', build: 'buildRockyDenWall' },
  { name: 'HEAT_LAMP_FLOOR', index: 128, layer: 'ground', solid: false, ysort: 'none', build: 'buildHeatLampFloor' },
  { name: 'NEST', index: 129, layer: 'deco', solid: false, ysort: 'none', build: 'buildNest' },
  { name: 'BURROW_MOUND', index: 130, layer: 'deco', solid: false, ysort: 'none', build: 'buildBurrowMound' },
  { name: 'SHADE_CLOTH', index: 131, layer: 'roof', solid: false, ysort: 'none', build: 'buildShadeCloth' },
  { name: 'KEEPER_GATE', index: 132, layer: 'deco', solid: false, ysort: 'none', build: 'buildKeeperGate' },

  // --- Props (133..144) ---
  { name: 'SIGN_BLANK', index: 133, layer: 'deco', solid: true, ysort: 'none', build: 'buildSignBlank' },
  { name: 'SIGN_ARROW', index: 134, layer: 'deco', solid: true, ysort: 'none', build: 'buildSignArrow' },
  { name: 'LAMP_POST', index: 135, layer: 'deco', solid: true, ysort: 'none', build: 'buildLampPost' },
  { name: 'BENCH', index: 136, layer: 'deco', solid: true, ysort: 'none', build: 'buildBench' },
  { name: 'TROUGH_FOOD', index: 137, layer: 'deco', solid: true, ysort: 'none', build: 'buildTroughFood' },
  { name: 'TROUGH_WATER', index: 138, layer: 'deco', solid: true, ysort: 'none', build: 'buildTroughWater' },
  { name: 'BARREL', index: 139, layer: 'deco', solid: true, ysort: 'none', build: 'buildBarrel' },
  { name: 'CRATE', index: 140, layer: 'deco', solid: true, ysort: 'none', build: 'buildCrate' },
  { name: 'HAY_BALE', index: 141, layer: 'deco', solid: true, ysort: 'none', build: 'buildHayBale' },
  { name: 'TRASH_BIN', index: 142, layer: 'deco', solid: true, ysort: 'none', build: 'buildTrashBin' },
  { name: 'BUSH_TRIMMED', index: 143, layer: 'deco', solid: true, ysort: 'none', build: 'buildBushTrimmed' },
  { name: 'BANNER', index: 144, layer: 'deco', solid: false, ysort: 'behind', build: 'buildBanner' },

  // --- Bridges (145..146) ---
  { name: 'BRIDGE_H', index: 145, layer: 'ground', solid: false, ysort: 'none', build: 'buildBridgeH' },
  { name: 'BRIDGE_V', index: 146, layer: 'ground', solid: false, ysort: 'none', build: 'buildBridgeV' },
];

/** Highest declared tile index (= TILE_LIST.length - 1, since indices are contiguous). */
const MAX_INDEX = TILE_LIST.reduce((m, t) => Math.max(m, t.index), 0);

/**
 * Parse the `TILES = { ... }` block of shared/src/tiles.ts into an ordered list of
 * { name, index, layer, solid, ysort }. The drift gate: the verifier diffs this
 * against TILE_LIST. Narrow on purpose — it ONLY understands the
 * `NAME: t(index, 'layer'[, solid][, 'ysort']),` shorthand the registry uses, so
 * a stray hand-rolled object literal would (correctly) make it disagree.
 *
 * @param {string} tsSource - contents of shared/src/tiles.ts
 * @returns {{name:string,index:number,layer:string,solid:boolean,ysort:string}[]}
 */
function parseSharedTiles(tsSource) {
  // Isolate the literal between `export const TILES = {` and the closing
  // `} as const`. (Keeps the regex from matching the type-def `t()` above it.)
  const blockMatch = tsSource.match(/export const TILES\s*=\s*\{([\s\S]*?)\}\s*as const/);
  if (!blockMatch) throw new Error('could not locate `export const TILES = { ... } as const` in tiles.ts');
  const block = blockMatch[1];

  // NAME: t(INDEX, 'LAYER'[, SOLID][, 'YSORT']),  — comments/whitespace tolerated.
  const rowRe = /([A-Z][A-Z0-9_]*)\s*:\s*t\(\s*(\d+)\s*,\s*'([a-z]+)'\s*(?:,\s*(true|false)\s*)?(?:,\s*'([a-z]+)'\s*)?\)/g;
  const out = [];
  let m;
  while ((m = rowRe.exec(block)) !== null) {
    out.push({
      name: m[1],
      index: Number(m[2]),
      layer: m[3],
      solid: m[4] === 'true', // absent → false (matches the t() default)
      ysort: m[5] || 'none', //  absent → 'none' (matches the t() default)
    });
  }
  return out;
}

/** Convenience: read + parse the canonical tiles.ts (path relative to this file). */
function readSharedTiles() {
  const tsPath = path.join(__dirname, '..', '..', 'shared', 'src', 'tiles.ts');
  return parseSharedTiles(fs.readFileSync(tsPath, 'utf8'));
}

module.exports = {
  TILE_SIZE,
  COLS,
  VIEWBOX,
  LIGHT_DIR,
  TILE_LIST,
  MAX_INDEX,
  parseSharedTiles,
  readSharedTiles,
};
