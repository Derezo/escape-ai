/**
 * Deterministic zoo world generation — the single source of the map.
 *
 * The server picks a per-room seed and calls {@link generateWorld}; it derives
 * its gameplay entities (gate, terminals, housing decoys, robot spawns, quest
 * objects) from the result and ships only the SEED to clients (see net.ts
 * `MapMsg`). Each client runs the IDENTICAL generateWorld(seed) to reconstruct
 * the same tilemap for rendering AND for collision-aware prediction. Because the
 * generator is pure + deterministic (no Math.random / Date.now — it uses the
 * seeded PRNG in rng.ts), client and server agree bit-for-bit. A
 * `version`/hash drift test (shared/test/world.test.ts) is the tripwire.
 *
 * Phase 0 ships the types + helpers + a SIMPLE generator (grass field, border
 * wall, a gate, spawns). Phase 1 expands generateWorld into the full plot/zone
 * layout (paths, buildings, per-species housing, nature, reachability) WITHOUT
 * changing these types or the net contract.
 */

import { mulberry32 } from './rng.js';
import { TILE_INDEX, TILE_SIZE, isSolidIndex } from './tiles.js';

/** Bump whenever generateWorld's OUTPUT changes, so client/server parity is asserted. */
export const WORLD_GEN_VERSION = 1;

/** Map size in tiles. 128×128 @ 32u = 4096×4096 world units (16× the old 1000²). */
export const MAP_W = 128;
export const MAP_H = 128;

/** One tile layer: a flat row-major index grid (0 = empty). */
export interface TileGrid {
  w: number;
  h: number;
  /** length w*h, indexed ty*w + tx; values are tile indices from tiles.ts. */
  data: Uint16Array;
}

/** An enterable building: walls + interior + a door, with a roof that fades on entry. */
export interface Building {
  id: string;
  /** Tile rect (includes the wall ring). */
  rx: number;
  ry: number;
  rw: number;
  rh: number;
  /** The door tile (a non-solid gap in the wall, path-reachable). */
  doorTx: number;
  doorTy: number;
  /** Which species this building serves (its quest target lives inside), if any. */
  species?: string;
}

/** The kinds of animal housing the zoo lays out, picked per species. */
export type HousingKind = 'cage' | 'pond' | 'aviary' | 'den' | 'pen' | 'paddock';

/** A species enclosure (open-air; buildings are tracked separately). */
export interface Housing {
  id: string;
  species: string;
  kind: HousingKind;
  /** World-unit center (decoy spawn anchor / "reach your den" target). */
  cx: number;
  cy: number;
  /** Tile rect. */
  rx: number;
  ry: number;
  rw: number;
  rh: number;
}

/** A gameplay entity the SERVER spawns from the map (not a tile). */
export interface WorldEntitySpec {
  id: string;
  kind: 'gate' | 'terminal' | 'questObject' | 'robotSpawn' | 'prop' | 'penAnchor';
  /** World-unit position. */
  x: number;
  y: number;
  /** For housing decoys / quest objects bound to a species. */
  species?: string;
  /** Extra small data (quest type, housing kind, …). Kept tiny + JSON-safe. */
  meta?: Record<string, number | string>;
}

/** The full generated world. Typed arrays are produced on BOTH sides (never wired). */
export interface WorldMap {
  version: number;
  seed: number;
  /** Tile size in world units (= TILE_SIZE). */
  tile: number;
  /** Map size in tiles. */
  w: number;
  h: number;
  ground: TileGrid;
  deco: TileGrid;
  roof: TileGrid;
  /** length w*h; 1 = solid (blocks movement). Derived from solid tiles. */
  collision: Uint8Array;
  buildings: Building[];
  housing: Housing[];
  /** Player spawn points (world units), just inside the gate. */
  spawns: { x: number; y: number }[];
  /** The escape gate (world units). */
  gate: { x: number; y: number };
  /** Gameplay entities the server materializes. */
  entitySpecs: WorldEntitySpec[];
}

// --- Helpers (used by collision, rendering, and the generator) ----------------

/** Flat index into a w-wide grid for tile (tx, ty). */
export function tileIndex(w: number, tx: number, ty: number): number {
  return ty * w + tx;
}

/** World-unit coordinate → tile coordinate. */
export function worldToTile(px: number, tile: number): number {
  return Math.floor(px / tile);
}

/**
 * Whether the collision cell at tile (tx, ty) is solid. OUT-OF-BOUNDS IS SOLID —
 * the world edge is a wall, so players can only leave through the gate. Used by
 * step.ts moveWithCollision (Phase 2).
 */
export function tileSolid(
  collision: Uint8Array,
  w: number,
  h: number,
  tx: number,
  ty: number,
): boolean {
  if (tx < 0 || ty < 0 || tx >= w || ty >= h) return true;
  return collision[ty * w + tx] === 1;
}

/** Whether world-unit position (px, py) sits on a solid tile. */
export function isSolidAt(map: WorldMap, px: number, py: number): boolean {
  return tileSolid(map.collision, map.w, map.h, worldToTile(px, map.tile), worldToTile(py, map.tile));
}

// --- Generation ---------------------------------------------------------------

/** Make a TileGrid filled with one tile index (default 0/empty). */
function makeGrid(w: number, h: number, fill = 0): TileGrid {
  const data = new Uint16Array(w * h);
  if (fill) data.fill(fill);
  return { w, h, data };
}

/** Set a tile in a grid (no-op if out of bounds). */
function setTile(grid: TileGrid, tx: number, ty: number, index: number): void {
  if (tx < 0 || ty < 0 || tx >= grid.w || ty >= grid.h) return;
  grid.data[ty * grid.w + tx] = index;
}

/** Build the collision Uint8Array from the deco + ground grids' solid tiles. */
export function buildCollision(ground: TileGrid, deco: TileGrid): Uint8Array {
  const { w, h } = ground;
  const collision = new Uint8Array(w * h);
  for (let i = 0; i < collision.length; i++) {
    if (isSolidIndex(deco.data[i]) || isSolidIndex(ground.data[i])) collision[i] = 1;
  }
  return collision;
}

/**
 * Generate the world from a seed.
 *
 * PHASE 0 (current): a simple but valid world — a grass field bordered by a solid
 * wall ring, with a gate gap on the east edge and spawns just inside it. This is
 * enough for the server to wire up (Phase 4) and for collision to be testable;
 * Phase 1 replaces the body with the full plot/zone zoo layout while keeping the
 * same WorldMap shape.
 */
export function generateWorld(seed: number): WorldMap {
  const w = MAP_W;
  const h = MAP_H;
  const tile = TILE_SIZE;
  // The PRNG is seeded now so Phase 1 can use it without changing the signature.
  const rng = mulberry32(seed);
  void rng; // (Phase 1 consumes this; referenced here to keep the seam explicit.)

  const ground = makeGrid(w, h, TILE_INDEX.GRASS_A);
  const deco = makeGrid(w, h, 0);
  const roof = makeGrid(w, h, 0);

  // Solid border wall ring (the world edge is also treated as solid by tileSolid,
  // but an explicit wall reads correctly and lets the gate be a real gap).
  for (let x = 0; x < w; x++) {
    setTile(deco, x, 0, TILE_INDEX.WALL_EXT_MID);
    setTile(deco, x, h - 1, TILE_INDEX.WALL_EXT_MID);
  }
  for (let y = 0; y < h; y++) {
    setTile(deco, 0, y, TILE_INDEX.WALL_EXT_MID);
    setTile(deco, w - 1, y, TILE_INDEX.WALL_EXT_MID);
  }

  // Gate gap on the east wall at the vertical center.
  const gateTy = Math.floor(h / 2);
  setTile(deco, w - 1, gateTy, 0); // clear the wall here so the gate is reachable
  const gate = { x: (w - 1) * tile + tile / 2, y: gateTy * tile + tile / 2 };

  // Spawns just inside the gate (a small column).
  const spawns: { x: number; y: number }[] = [];
  for (let i = 0; i < 8; i++) {
    spawns.push({
      x: (w - 4) * tile + tile / 2,
      y: (gateTy - 3 + i) * tile + tile / 2,
    });
  }

  const collision = buildCollision(ground, deco);

  const entitySpecs: WorldEntitySpec[] = [
    { id: 'gate-1', kind: 'gate', x: gate.x, y: gate.y },
  ];

  return {
    version: WORLD_GEN_VERSION,
    seed,
    tile,
    w,
    h,
    ground,
    deco,
    roof,
    collision,
    buildings: [],
    housing: [],
    spawns,
    gate,
    entitySpecs,
  };
}
