/**
 * THE TILE-IDENTITY CONTRACT  (TINS 2026 — Escape AI)
 *
 * Every semantic tile the zoo is built from is named here exactly once, with a
 * stable numeric index. This is the canonical, TS-first source of truth, the
 * tile analogue of scripts/sprites/contract.js `frameKey()`. Three consumers
 * agree on these names + indices:
 *   - shared/src/world.ts  — the deterministic world-gen writes maps by name→index
 *     (TILE_INDEX), so client and server stamp identical tiles.
 *   - client/src/render/phaser.ts — routes tiles to ground/deco/roof/canopy layers
 *     and marks collision by index (TILE_BY_INDEX, SOLID_INDICES, CANOPY_INDICES).
 *   - scripts/tiles/contract.js — a CJS MIRROR of this ordered list (the zero-dep
 *     art generator can't import TS); verify-tileset.js gates that the mirror's
 *     names + order + flags match this file, so the tileset PNG's grid position
 *     (= index) lines up with what world-gen emits.
 *
 * RULES (verify-tileset enforces):
 *   - Index 0 is reserved EMPTY — Phaser treats tile index 0 as "no tile".
 *   - Indices are contiguous from 1, in declaration order (= packing order in the
 *     tileset PNG, row-major). NEVER reorder or reuse an index; APPEND new tiles
 *     at the end of their category's run so existing maps stay valid.
 *   - `layer` decides which Phaser TilemapLayer a tile lands on.
 *   - `solid` tiles block movement (consumed by world-gen's collision grid).
 *   - `ysort:'behind'` tiles (tree canopies) render ABOVE the player so you can
 *     walk "under" them; `'sort'` is the per-sprite depth-sort escape hatch.
 */

/** Tile side length in world units AND pixels (square). The whole grid is on 32s. */
export const TILE_SIZE = 32;

/** Which tilemap layer a tile belongs on. Drives renderer layer assembly + depth. */
export type TileLayer = 'ground' | 'deco' | 'roof';

/** How a tile participates in Y-sort depth (the walk-behind-trees effect). */
export type TileYSort = 'none' | 'behind' | 'sort';

/** One tile's identity + gameplay/render flags. */
export interface TileDef {
  /** 1-based, contiguous, row-major packing order. 0 = empty/no-tile. */
  index: number;
  /** Ground (terrain/floor), deco (trees/walls/fences/rocks), or roof (fades on enter). */
  layer: TileLayer;
  /** Blocks movement. World-gen sets the collision grid from this. */
  solid: boolean;
  /** Y-sort behavior: 'behind' = canopy drawn over the player; 'sort' = per-sprite. */
  ysort: TileYSort;
}

/** Shorthand for the registry literal below — keeps each row terse. */
function t(index: number, layer: TileLayer, solid = false, ysort: TileYSort = 'none'): TileDef {
  return { index, layer, solid, ysort };
}

/**
 * THE REGISTRY. Names are SCREAMING_SNAKE; the value's `index` IS the tileset
 * grid slot. Grouped by category; indices run contiguously 1..N across the whole
 * table (the groups are just for readability). `as const` so TileName is a precise
 * union and indices are literal types.
 */
export const TILES = {
  EMPTY: t(0, 'ground'),

  // --- Terrain / ground (1..24) ----------------------------------------------
  GRASS_A: t(1, 'ground'),
  GRASS_B: t(2, 'ground'),
  GRASS_C: t(3, 'ground'),
  GRASS_FLOWERS: t(4, 'ground'),
  GRASS_PATCHY: t(5, 'ground'),
  DIRT: t(6, 'ground'),
  DIRT_TRAMPLED: t(7, 'ground'),
  COBBLE: t(8, 'ground'),
  COBBLE_WORN: t(9, 'ground'),
  PAVED: t(10, 'ground'),
  PAVED_CRACK: t(11, 'ground'),
  SAND: t(12, 'ground'),
  SAND_RIPPLE: t(13, 'ground'),
  MUD: t(14, 'ground'),
  MUD_PUDDLE: t(15, 'ground'),
  WATER_DEEP: t(16, 'ground', true), // solid: can't wade into deep water
  WATER_SHALLOW: t(17, 'ground'),
  FLOOR_WOOD: t(18, 'ground'),
  FLOOR_WOOD_DARK: t(19, 'ground'),
  FLOOR_TILE: t(20, 'ground'),
  FLOOR_TILE_CHECKER: t(21, 'ground'),
  FLOOR_CONCRETE: t(22, 'ground'),
  PEN_FLOOR_STRAW: t(23, 'ground'),
  PEN_FLOOR_CONCRETE: t(24, 'ground'),

  // --- Edges / transitions (25..48) ------------------------------------------
  // Grass↔path: 4 edges + 4 outer corners + 4 inner corners (12-tile manual set).
  PATH_EDGE_N: t(25, 'ground'),
  PATH_EDGE_E: t(26, 'ground'),
  PATH_EDGE_S: t(27, 'ground'),
  PATH_EDGE_W: t(28, 'ground'),
  PATH_CORNER_NE: t(29, 'ground'),
  PATH_CORNER_NW: t(30, 'ground'),
  PATH_CORNER_SE: t(31, 'ground'),
  PATH_CORNER_SW: t(32, 'ground'),
  PATH_ICORNER_NE: t(33, 'ground'),
  PATH_ICORNER_NW: t(34, 'ground'),
  PATH_ICORNER_SE: t(35, 'ground'),
  PATH_ICORNER_SW: t(36, 'ground'),
  // Land↔water shoreline: same 12-tile pattern.
  WATER_EDGE_N: t(37, 'ground'),
  WATER_EDGE_E: t(38, 'ground'),
  WATER_EDGE_S: t(39, 'ground'),
  WATER_EDGE_W: t(40, 'ground'),
  WATER_CORNER_NE: t(41, 'ground'),
  WATER_CORNER_NW: t(42, 'ground'),
  WATER_CORNER_SE: t(43, 'ground'),
  WATER_CORNER_SW: t(44, 'ground'),
  WATER_ICORNER_NE: t(45, 'ground'),
  WATER_ICORNER_NW: t(46, 'ground'),
  WATER_ICORNER_SE: t(47, 'ground'),
  WATER_ICORNER_SW: t(48, 'ground'),

  // --- Nature (49..74) -------------------------------------------------------
  // Trees are a TRUNK (solid, on deco below mobile) + a CANOPY (ysort:'behind',
  // routed to the high canopy layer so you walk under it). World-gen places the
  // canopy at (tx,ty) and the trunk at (tx,ty+1).
  TREE_TRUNK: t(49, 'deco', true),
  TREE_CANOPY: t(50, 'deco', false, 'behind'),
  TREE_CANOPY_L: t(51, 'deco', false, 'behind'),
  TREE_CANOPY_R: t(52, 'deco', false, 'behind'),
  TREE_CANOPY_TOP: t(53, 'deco', false, 'behind'),
  PINE_TRUNK: t(54, 'deco', true),
  PINE_CANOPY: t(55, 'deco', false, 'behind'),
  BUSH_SM: t(56, 'deco', true),
  BUSH_LG: t(57, 'deco', true),
  BUSH_BERRY: t(58, 'deco', true),
  ROCK_SM: t(59, 'deco'), // small rock: walkable detail
  ROCK_LG: t(60, 'deco', true),
  ROCK_FLAT: t(61, 'deco'),
  BOULDER: t(62, 'deco', true),
  FLOWER_RED: t(63, 'deco'),
  FLOWER_YELLOW: t(64, 'deco'),
  FLOWER_BLUE: t(65, 'deco'),
  FLOWER_BED: t(66, 'deco'),
  GRASS_TALL: t(67, 'deco'),
  STUMP: t(68, 'deco'),
  LOG: t(69, 'deco', true),
  LILY_PAD: t(70, 'deco'),
  LILY_FLOWER: t(71, 'deco'),
  REEDS: t(72, 'deco', false, 'behind'),
  CATTAILS: t(73, 'deco', false, 'behind'),
  MUSHROOM: t(74, 'deco'),

  // --- Structures: walls / roofs / doors (75..102) ---------------------------
  WALL_EXT_MID: t(75, 'deco', true),
  WALL_EXT_N_END: t(76, 'deco', true),
  WALL_EXT_E_END: t(77, 'deco', true),
  WALL_EXT_S_END: t(78, 'deco', true),
  WALL_EXT_W_END: t(79, 'deco', true),
  WALL_EXT_CORNER_NE: t(80, 'deco', true),
  WALL_EXT_CORNER_NW: t(81, 'deco', true),
  WALL_EXT_CORNER_SE: t(82, 'deco', true),
  WALL_EXT_CORNER_SW: t(83, 'deco', true),
  WALL_INT_MID: t(84, 'deco', true),
  WALL_INT_CORNER_NE: t(85, 'deco', true),
  WALL_INT_CORNER_NW: t(86, 'deco', true),
  WALL_INT_CORNER_SE: t(87, 'deco', true),
  WALL_INT_CORNER_SW: t(88, 'deco', true),
  WINDOW: t(89, 'deco', true),
  DOOR_CLOSED: t(90, 'deco', true),
  DOOR_OPEN: t(91, 'deco'), // walkable threshold
  ROOF_RED_MID: t(92, 'roof'),
  ROOF_RED_EDGE_N: t(93, 'roof'),
  ROOF_RED_EDGE_E: t(94, 'roof'),
  ROOF_RED_EDGE_S: t(95, 'roof'),
  ROOF_RED_EDGE_W: t(96, 'roof'),
  ROOF_RED_CORNER_NE: t(97, 'roof'),
  ROOF_RED_CORNER_NW: t(98, 'roof'),
  ROOF_RED_CORNER_SE: t(99, 'roof'),
  ROOF_RED_CORNER_SW: t(100, 'roof'),
  ROOF_RIDGE: t(101, 'roof'),
  ROOF_PEAK: t(102, 'roof'),

  // --- Fences / barriers (103..118) ------------------------------------------
  FENCE_H: t(103, 'deco', true),
  FENCE_V: t(104, 'deco', true),
  FENCE_POST: t(105, 'deco', true),
  FENCE_CORNER_NE: t(106, 'deco', true),
  FENCE_CORNER_NW: t(107, 'deco', true),
  FENCE_CORNER_SE: t(108, 'deco', true),
  FENCE_CORNER_SW: t(109, 'deco', true),
  FENCE_T_N: t(110, 'deco', true),
  FENCE_T_E: t(111, 'deco', true),
  FENCE_T_S: t(112, 'deco', true),
  FENCE_T_W: t(113, 'deco', true),
  FENCE_GATE: t(114, 'deco'), // walkable opening
  CAGE_BARS_H: t(115, 'deco', true),
  CAGE_BARS_V: t(116, 'deco', true),
  CAGE_CORNER: t(117, 'deco', true),
  CAGE_GATE: t(118, 'deco'),

  // --- Zoo housing (119..132) ------------------------------------------------
  ENCLOSURE_WALL_LOW: t(119, 'deco', true),
  ENCLOSURE_GLASS: t(120, 'deco', true),
  MOAT_EDGE: t(121, 'deco', true),
  POND_DEEP: t(122, 'ground', true),
  POND_EDGE: t(123, 'ground'),
  AVIARY_MESH: t(124, 'deco', true),
  AVIARY_FRAME: t(125, 'deco', true),
  ROCKY_DEN_MOUTH: t(126, 'deco', true),
  ROCKY_DEN_WALL: t(127, 'deco', true),
  HEAT_LAMP_FLOOR: t(128, 'ground'),
  NEST: t(129, 'deco'),
  BURROW_MOUND: t(130, 'deco'),
  SHADE_CLOTH: t(131, 'roof'),
  KEEPER_GATE: t(132, 'deco'),

  // --- Props (133..144) ------------------------------------------------------
  SIGN_BLANK: t(133, 'deco', true),
  SIGN_ARROW: t(134, 'deco', true),
  LAMP_POST: t(135, 'deco', true),
  BENCH: t(136, 'deco', true),
  TROUGH_FOOD: t(137, 'deco', true),
  TROUGH_WATER: t(138, 'deco', true),
  BARREL: t(139, 'deco', true),
  CRATE: t(140, 'deco', true),
  HAY_BALE: t(141, 'deco', true),
  TRASH_BIN: t(142, 'deco', true),
  BUSH_TRIMMED: t(143, 'deco', true),
  BANNER: t(144, 'deco', false, 'behind'),
} as const satisfies Record<string, TileDef>;

/** Every semantic tile name (a precise union, e.g. 'GRASS_A' | 'TREE_TRUNK' | …). */
export type TileName = keyof typeof TILES;

/** Total tile count INCLUDING EMPTY (so the highest index is TILE_COUNT - 1). */
export const TILE_COUNT = Object.keys(TILES).length;

/** name → index. The one mapping world-gen writes maps with. */
export const TILE_INDEX = Object.fromEntries(
  Object.entries(TILES).map(([k, v]) => [k, v.index]),
) as Record<TileName, number>;

/** index → def (+ name). For the renderer: layer routing + collision marking. */
export const TILE_BY_INDEX: Record<number, TileDef & { name: TileName }> = Object.fromEntries(
  Object.entries(TILES).map(([k, v]) => [v.index, { ...v, name: k as TileName }]),
);

/** All solid tile indices — the renderer marks these collidable; world-gen mirrors them. */
export const SOLID_INDICES: number[] = Object.values(TILES)
  .filter((d) => d.solid)
  .map((d) => d.index);

/** Canopy ('behind') tile indices — routed to the high canopy layer for walk-behind. */
export const CANOPY_INDICES: number[] = Object.values(TILES)
  .filter((d) => d.ysort === 'behind')
  .map((d) => d.index);

/** Whether a tile index is solid (blocks movement). Index 0 / unknown → not solid. */
export function isSolidIndex(index: number): boolean {
  const def = TILE_BY_INDEX[index];
  return def ? def.solid : false;
}
