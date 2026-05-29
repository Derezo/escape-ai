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

import { mulberry32, randInt, pick, shuffle } from './rng.js';
import { SPECIES_KEYS } from './species.js';
import { TILE_INDEX, TILE_SIZE, isSolidIndex } from './tiles.js';

/** Bump whenever generateWorld's OUTPUT changes, so client/server parity is asserted. */
export const WORLD_GEN_VERSION = 4;

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

// --- Generator internals ------------------------------------------------------
//
// Everything below is PRIVATE to the generator (not exported), so the WorldMap /
// helper surface above stays stable. The whole layout is driven by a single
// seeded `rng` thread (mulberry32) and iterated in a fixed, explicit order, so
// generateWorld(seed) is byte-identical on server and client (the parity test in
// shared/test/world.test.ts pins a hash of the output).

/** World-unit center of a tile. */
function tileCenter(t: number, tile: number): number {
  return t * tile + tile / 2;
}

/**
 * The fixed species → housing-kind assignment. Every species in SPECIES_KEYS has
 * an entry; this table is the single place that decides what each animal lives in
 * (a `building` here means an enterable structure rather than open housing). Kept
 * sensible-by-biome so the zoo reads right, and STABLE so the layout never drifts.
 */
const SPECIES_HOUSING: Record<string, HousingKind | 'building'> = {
  ape: 'building',
  bird: 'aviary',
  rat: 'cage',
  elephant: 'paddock',
  chameleon: 'building',
  peacock: 'aviary',
  skunk: 'den',
  mole: 'den',
  cheetah: 'paddock',
  parrot: 'aviary',
  tortoise: 'pond',
  kangaroo: 'pen',
  owl: 'building',
  fox: 'den',
};

/** A rectangular plot in tile coordinates (the carve-able interior of one cell). */
interface Plot {
  tx: number;
  ty: number;
  tw: number;
  th: number;
}

/** Subtle deterministic grass variation so the field isn't a flat color. */
function scatterGrassVariants(ground: TileGrid, rng: () => number): void {
  const variants = [TILE_INDEX.GRASS_B, TILE_INDEX.GRASS_C, TILE_INDEX.GRASS_FLOWERS, TILE_INDEX.GRASS_PATCHY];
  for (let ty = 1; ty < ground.h - 1; ty++) {
    for (let tx = 1; tx < ground.w - 1; tx++) {
      // ~8% of interior grass gets a variant; rng is consumed every cell so the
      // stream advances deterministically regardless of the branch taken.
      const r = rng();
      if (r < 0.08) setTile(ground, tx, ty, pick(rng, variants));
    }
  }
}

/** Stamp the perimeter wall ring (deco) and clear a single gate gap on the east edge. */
function stampPerimeter(
  deco: TileGrid,
  w: number,
  h: number,
  rng: () => number,
): { gateTx: number; gateTy: number } {
  for (let x = 0; x < w; x++) {
    setTile(deco, x, 0, TILE_INDEX.WALL_EXT_MID);
    setTile(deco, x, h - 1, TILE_INDEX.WALL_EXT_MID);
  }
  for (let y = 0; y < h; y++) {
    setTile(deco, 0, y, TILE_INDEX.WALL_EXT_MID);
    setTile(deco, w - 1, y, TILE_INDEX.WALL_EXT_MID);
  }
  // Gate near the east-edge vertical center, with small deterministic jitter.
  const gateTy = Math.floor(h / 2) + randInt(rng, -6, 6);
  const gateTx = w - 1;
  setTile(deco, gateTx, gateTy, 0); // open the wall so the gate is a real gap
  return { gateTx, gateTy };
}

/**
 * Carve the avenue skeleton (PAVED roads) and return the interior grid lines that
 * partition the map into plots. Roads are walkable; they also connect the gate
 * inward. The avenue positions are jittered via rng but kept sorted + deduped so
 * the plot grid is stable.
 */
function carveAvenues(
  ground: TileGrid,
  w: number,
  h: number,
  gateTy: number,
  rng: () => number,
): { vLines: number[]; hLines: number[] } {
  const road = TILE_INDEX.PAVED;
  const ROAD_HALF = 1; // 3-tile-wide avenues

  // Vertical avenues at roughly even columns with jitter.
  const vBase = [Math.floor(w * 0.28), Math.floor(w * 0.5), Math.floor(w * 0.72)];
  const hBase = [Math.floor(h * 0.28), Math.floor(h * 0.5), Math.floor(h * 0.72)];
  const vLines = vBase.map((c) => clampInt(c + randInt(rng, -4, 4), 4, w - 5)).sort((a, b) => a - b);
  const hLines = hBase.map((c) => clampInt(c + randInt(rng, -4, 4), 4, h - 5)).sort((a, b) => a - b);

  for (const cx of vLines) {
    for (let ty = 1; ty < h - 1; ty++) {
      for (let d = -ROAD_HALF; d <= ROAD_HALF; d++) setTile(ground, cx + d, ty, road);
    }
  }
  for (const cy of hLines) {
    for (let tx = 1; tx < w - 1; tx++) {
      for (let d = -ROAD_HALF; d <= ROAD_HALF; d++) setTile(ground, tx, cy + d, road);
    }
  }
  // Spur from the gate inward to the nearest horizontal avenue row, so the
  // entrance is always road-connected to the skeleton.
  for (let tx = w - 2; tx >= vLines[vLines.length - 1]; tx--) {
    for (let d = -ROAD_HALF; d <= ROAD_HALF; d++) setTile(ground, tx, gateTy + d, road);
  }
  return { vLines, hLines };
}

/** Integer clamp (the float `clamp` from step.ts isn't imported to keep deps tight). */
function clampInt(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

/**
 * Build the list of plots from the avenue grid: the rectangular cells between
 * consecutive avenue lines (and the wall), shrunk by a margin so housing never
 * abuts a road or wall. Returned in a fixed row-major order.
 */
function buildPlots(w: number, h: number, vLines: number[], hLines: number[]): Plot[] {
  const colBounds = [2, ...vLines, w - 2];
  const rowBounds = [2, ...hLines, h - 2];
  const MARGIN = 2; // keep clear of the road edge and walls
  const plots: Plot[] = [];
  for (let r = 0; r < rowBounds.length - 1; r++) {
    for (let c = 0; c < colBounds.length - 1; c++) {
      const x0 = colBounds[c] + MARGIN;
      const y0 = rowBounds[r] + MARGIN;
      const x1 = colBounds[c + 1] - MARGIN;
      const y1 = rowBounds[r + 1] - MARGIN;
      const tw = x1 - x0;
      const th = y1 - y0;
      if (tw >= 6 && th >= 6) plots.push({ tx: x0, ty: y0, tw, th });
    }
  }
  return plots;
}

/** Result of stamping one species' housing/building into a plot. */
interface PlacedHome {
  housing?: Housing;
  building?: Building;
  /** Tiles that must be reachable for this home (door / center / quest object). */
  reachTargets: { tx: number; ty: number }[];
  /** Where this species' quest object sits (a guaranteed non-solid tile). */
  questTx: number;
  questTy: number;
  /**
   * The WALKABLE anchor tile for this home's decoy/center. For most kinds this is
   * the geometric center, but for a pond it is the shore tile (the geometric
   * center is deep water = solid), so `Housing.cx/cy` always lands somewhere a
   * decoy can stand and the reachability invariant holds for the center.
   */
  centerTx: number;
  centerTy: number;
}

/** Stamp an enterable building (wall ring + floor + door + roof) into a plot. */
function stampBuilding(
  ground: TileGrid,
  deco: TileGrid,
  roof: TileGrid,
  plot: Plot,
  species: string,
  rng: () => number,
): PlacedHome {
  // Use most of the plot, leaving a tile of grass around it.
  const rx = plot.tx;
  const ry = plot.ty;
  const rw = Math.min(plot.tw, 10);
  const rh = Math.min(plot.th, 9);
  const floors = [TILE_INDEX.FLOOR_WOOD, TILE_INDEX.FLOOR_TILE, TILE_INDEX.FLOOR_CONCRETE];
  const floor = pick(rng, floors);

  for (let dy = 0; dy < rh; dy++) {
    for (let dx = 0; dx < rw; dx++) {
      const tx = rx + dx;
      const ty = ry + dy;
      const edge = dx === 0 || dy === 0 || dx === rw - 1 || dy === rh - 1;
      if (edge) {
        setTile(deco, tx, ty, TILE_INDEX.WALL_EXT_MID);
      } else {
        setTile(ground, tx, ty, floor);
        setTile(roof, tx, ty, TILE_INDEX.ROOF_RED_MID);
      }
    }
  }
  // Door on the south wall, road-facing, walkable. TWO tiles wide (64px) so the
  // player's collision AABB (radius ~13) passes through comfortably — a 1-tile
  // gap leaves only ~6px clearance and is effectively impassable.
  const doorTx = rx + Math.floor(rw / 2);
  const doorTy = ry + rh - 1;
  setTile(deco, doorTx, doorTy, TILE_INDEX.DOOR_OPEN);
  setTile(deco, doorTx - 1, doorTy, TILE_INDEX.DOOR_OPEN);
  // Keep the threshold roof-free so entering reads as "inside".
  setTile(roof, doorTx, doorTy, 0);
  setTile(roof, doorTx - 1, doorTy, 0);

  // Interior props + the quest terminal tile (the quest object sits just inside
  // the door so it is reliably reachable once the door is reachable).
  const questTx = doorTx;
  const questTy = doorTy - 1;
  setTile(deco, rx + 1, ry + 1, TILE_INDEX.CRATE);
  setTile(deco, rx + rw - 2, ry + 1, TILE_INDEX.BARREL);

  const building: Building = { id: `bld-${species}`, rx, ry, rw, rh, doorTx, doorTy, species };
  return {
    building,
    reachTargets: [
      { tx: doorTx, ty: doorTy },
      { tx: questTx, ty: questTy },
    ],
    questTx,
    questTy,
    centerTx: questTx,
    centerTy: questTy,
  };
}

/**
 * Stamp open-air housing of `kind` into a plot. Returns a Housing record plus the
 * tiles that must stay reachable (the enclosure interior center + the gate gap).
 */
function stampHousing(
  ground: TileGrid,
  deco: TileGrid,
  plot: Plot,
  species: string,
  kind: HousingKind,
): PlacedHome {
  const rw = Math.min(plot.tw, 10);
  const rh = Math.min(plot.th, 9);
  const rx = plot.tx;
  const ry = plot.ty;
  const ccx = rx + Math.floor(rw / 2);
  const ccy = ry + Math.floor(rh / 2);
  // Enclosure gate on the south edge, road-facing.
  const gateTx = rx + Math.floor(rw / 2);
  const gateTy = ry + rh - 1;

  // Interior floor by kind.
  const interiorFloor =
    kind === 'pond'
      ? TILE_INDEX.WATER_SHALLOW
      : kind === 'aviary'
        ? TILE_INDEX.PEN_FLOOR_STRAW
        : kind === 'paddock' || kind === 'pen'
          ? TILE_INDEX.PEN_FLOOR_STRAW
          : TILE_INDEX.DIRT; // cage / den use dirt

  for (let dy = 1; dy < rh - 1; dy++) {
    for (let dx = 1; dx < rw - 1; dx++) {
      setTile(ground, rx + dx, ry + dy, interiorFloor);
    }
  }

  // Perimeter barrier tile by kind.
  const barrier =
    kind === 'aviary'
      ? TILE_INDEX.AVIARY_MESH
      : kind === 'cage'
        ? TILE_INDEX.CAGE_BARS_H
        : kind === 'paddock'
          ? TILE_INDEX.ENCLOSURE_WALL_LOW
          : TILE_INDEX.FENCE_H; // pen / den fence
  const barrierGate =
    kind === 'cage' ? TILE_INDEX.CAGE_GATE : kind === 'aviary' ? TILE_INDEX.KEEPER_GATE : TILE_INDEX.FENCE_GATE;

  for (let dx = 0; dx < rw; dx++) {
    setTile(deco, rx + dx, ry, barrier);
    setTile(deco, rx + dx, ry + rh - 1, barrier);
  }
  for (let dy = 0; dy < rh; dy++) {
    setTile(deco, rx, ry + dy, barrier);
    setTile(deco, rx + rw - 1, ry + dy, barrier);
  }
  // Two-tile-wide opening (64px) so the player's collision AABB fits through.
  setTile(deco, gateTx, gateTy, barrierGate);
  setTile(deco, gateTx - 1, gateTy, barrierGate);

  const reachTargets: { tx: number; ty: number }[] = [
    { tx: gateTx, ty: gateTy },
    { tx: ccx, ty: ccy },
  ];

  if (kind === 'pond') {
    // Deep (solid) water core, shallow ring already laid as the floor. Keep a
    // walkable shallow margin so the center "reach" target is a shore tile.
    for (let dy = 2; dy < rh - 2; dy++) {
      for (let dx = 2; dx < rw - 2; dx++) {
        setTile(ground, rx + dx, ry + dy, TILE_INDEX.WATER_DEEP);
      }
    }
    setTile(deco, rx + 1, ry + 1, TILE_INDEX.LILY_PAD);
    setTile(deco, rx + rw - 2, ry + rh - 2, TILE_INDEX.REEDS);
    // The reach target is a shallow shore tile (non-solid), not the deep core.
    reachTargets[1] = { tx: rx + 1, ty: ry + 1 };
  } else if (kind === 'den') {
    // A rocky den cluster with a walkable mouth at the center.
    setTile(deco, ccx - 1, ccy, TILE_INDEX.ROCKY_DEN_WALL);
    setTile(deco, ccx + 1, ccy, TILE_INDEX.ROCKY_DEN_WALL);
    setTile(deco, ccx, ccy - 1, TILE_INDEX.ROCKY_DEN_WALL);
    setTile(deco, ccx, ccy, TILE_INDEX.BURROW_MOUND); // walkable den mound = reach target
  } else {
    // A bit of dressing (food/water trough) inside, off the center reach tile.
    setTile(deco, rx + 1, ry + 1, TILE_INDEX.TROUGH_FOOD);
  }

  // The quest object + decoy anchor sit on the enclosure's walkable center tile
  // (for a pond this is the shore tile reachTargets[1], not the deep core), so it
  // is guaranteed non-solid and reachable.
  const home: Housing = {
    id: `home-${species}`,
    species,
    kind,
    cx: 0, // filled in by caller (needs `tile`)
    cy: 0,
    rx,
    ry,
    rw,
    rh,
  };
  const center = reachTargets[1];
  return {
    housing: home,
    reachTargets,
    questTx: center.tx,
    questTy: center.ty,
    centerTx: center.tx,
    centerTy: center.ty,
  };
}

/** Whether a tile is free grass suitable for scattering nature (no road/structure). */
function isOpenGrass(ground: TileGrid, deco: TileGrid, tx: number, ty: number): boolean {
  const i = tileIndex(ground.w, tx, ty);
  return (
    deco.data[i] === 0 &&
    (ground.data[i] === TILE_INDEX.GRASS_A ||
      ground.data[i] === TILE_INDEX.GRASS_B ||
      ground.data[i] === TILE_INDEX.GRASS_C ||
      ground.data[i] === TILE_INDEX.GRASS_FLOWERS ||
      ground.data[i] === TILE_INDEX.GRASS_PATCHY)
  );
}

/**
 * Scatter trees / bushes / rocks / flowers on remaining open grass, with a coarse
 * occupancy grid for minimum spacing so they don't clump. Deterministic via rng;
 * never placed on roads, structures, housing, or reserved tiles.
 */
function scatterNature(
  ground: TileGrid,
  deco: TileGrid,
  w: number,
  h: number,
  reserved: Set<number>,
  rng: () => number,
): void {
  const occupied = new Set<number>();
  const SPACING = 3;
  const markOccupied = (tx: number, ty: number) => {
    for (let dy = -SPACING; dy <= SPACING; dy++) {
      for (let dx = -SPACING; dx <= SPACING; dx++) {
        occupied.add(tileIndex(w, tx + dx, ty + dy));
      }
    }
  };
  const TRIES = 600;
  for (let n = 0; n < TRIES; n++) {
    const tx = randInt(rng, 2, w - 3);
    const ty = randInt(rng, 2, h - 3);
    const idx = tileIndex(w, tx, ty);
    if (occupied.has(idx) || reserved.has(idx)) continue;
    if (!isOpenGrass(ground, deco, tx, ty)) continue;
    const roll = rng();
    if (roll < 0.45) {
      // Tree: canopy at (tx,ty), trunk at (tx,ty+1). Trunk is solid; need the
      // trunk tile open too.
      if (ty + 1 >= h - 1 || !isOpenGrass(ground, deco, tx, ty + 1)) continue;
      if (occupied.has(tileIndex(w, tx, ty + 1))) continue;
      setTile(deco, tx, ty, TILE_INDEX.TREE_CANOPY);
      setTile(deco, tx, ty + 1, TILE_INDEX.TREE_TRUNK);
      markOccupied(tx, ty);
    } else if (roll < 0.7) {
      setTile(deco, tx, ty, pick(rng, [TILE_INDEX.BUSH_SM, TILE_INDEX.BUSH_LG, TILE_INDEX.BUSH_BERRY]));
      markOccupied(tx, ty);
    } else if (roll < 0.85) {
      setTile(deco, tx, ty, pick(rng, [TILE_INDEX.ROCK_LG, TILE_INDEX.BOULDER]));
      markOccupied(tx, ty);
    } else {
      setTile(deco, tx, ty, pick(rng, [TILE_INDEX.FLOWER_RED, TILE_INDEX.FLOWER_YELLOW, TILE_INDEX.FLOWER_BLUE]));
      // Flowers are non-solid detail — looser spacing.
      occupied.add(idx);
    }
  }
}

/** A deterministic 4-neighbour flood fill over non-solid tiles from `(sx,sy)`. */
function floodReachable(collision: Uint8Array, w: number, h: number, sx: number, sy: number): Uint8Array {
  const seen = new Uint8Array(w * h);
  const start = sy * w + sx;
  if (sx < 0 || sy < 0 || sx >= w || sy >= h || collision[start] === 1) return seen;
  // A flat ring queue (FIFO) keyed by flat index — order is fully determined by
  // the fixed neighbour push order, so the fill is deterministic.
  const queue = new Int32Array(w * h);
  let head = 0;
  let tail = 0;
  queue[tail++] = start;
  seen[start] = 1;
  while (head < tail) {
    const cur = queue[head++];
    const cx = cur % w;
    const cy = (cur - cx) / w;
    // Fixed neighbour order: E, W, S, N.
    const neighbours = [
      cx + 1 < w ? cur + 1 : -1,
      cx - 1 >= 0 ? cur - 1 : -1,
      cy + 1 < h ? cur + w : -1,
      cy - 1 >= 0 ? cur - w : -1,
    ];
    for (const nb of neighbours) {
      if (nb < 0 || seen[nb] || collision[nb] === 1) continue;
      seen[nb] = 1;
      queue[tail++] = nb;
    }
  }
  return seen;
}

/**
 * Carve a deterministic L-shaped corridor from `(fx,fy)` to `(tx,ty)`, clearing
 * deco and stamping a PAVED ground tile so the cells become walkable, and zeroing
 * the matching collision cells. Horizontal leg first, then vertical.
 */
function carveCorridor(
  ground: TileGrid,
  deco: TileGrid,
  collision: Uint8Array,
  w: number,
  fx: number,
  fy: number,
  tx: number,
  ty: number,
): void {
  const open = (x: number, y: number) => {
    const i = tileIndex(w, x, y);
    deco.data[i] = 0;
    // Don't pave the destination if it's a special non-solid tile (door, water
    // shore, den mound); just ensure it's walkable. For corridor cells, pave.
    if (!(x === tx && y === ty)) setTile(ground, x, y, TILE_INDEX.PAVED);
    collision[i] = 0;
  };
  const stepX = fx < tx ? 1 : -1;
  for (let x = fx; x !== tx; x += stepX) open(x, fy);
  const stepY = fy < ty ? 1 : -1;
  for (let y = fy; y !== ty; y += stepY) open(tx, y);
  open(tx, ty);
}

/** Find the reachable tile nearest (Manhattan) to a target — for corridor carving. */
function nearestReachable(
  seen: Uint8Array,
  w: number,
  h: number,
  tx: number,
  ty: number,
): { x: number; y: number } | null {
  let best: { x: number; y: number } | null = null;
  let bestD = Infinity;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (!seen[y * w + x]) continue;
      const d = Math.abs(x - tx) + Math.abs(y - ty);
      if (d < bestD) {
        bestD = d;
        best = { x, y };
      }
    }
  }
  return best;
}

/**
 * Generate the world from a seed.
 *
 * Produces the full plot/zone zoo: a grass field inside a walled perimeter with a
 * single escape gate, a PAVED avenue skeleton partitioning the interior into
 * plots, one home (enclosure or enterable building) per species drawn from a fixed
 * species→kind table, scattered nature on the leftover grass, and a set of
 * gameplay entity specs (gate, robot spawns, terminals, the disguise prop, a decoy
 * anchor + quest object per species). A deterministic reachability pass then
 * guarantees the gate, every door, every enclosure center, every spawn and every
 * quest object can be walked to from spawn — carving corridors until they are.
 *
 * PURE + DETERMINISTIC: the only entropy is the seeded mulberry32 stream, threaded
 * through every helper; all iteration order is fixed. Same seed → byte-identical
 * output on server and client. The parity test pins a hash of the result.
 */
export function generateWorld(seed: number): WorldMap {
  const w = MAP_W;
  const h = MAP_H;
  const tile = TILE_SIZE;
  const rng = mulberry32(seed);

  const ground = makeGrid(w, h, TILE_INDEX.GRASS_A);
  const deco = makeGrid(w, h, 0);
  const roof = makeGrid(w, h, 0);

  scatterGrassVariants(ground, rng);

  // 2. Perimeter wall + gate.
  const { gateTx, gateTy } = stampPerimeter(deco, w, h, rng);
  const gate = { x: tileCenter(gateTx, tile), y: tileCenter(gateTy, tile) };

  // 3. Avenue skeleton + plot grid.
  const { vLines, hLines } = carveAvenues(ground, w, h, gateTy, rng);
  const plots = buildPlots(w, h, vLines, hLines);

  // 4. Species → plot assignment (shuffle the roster deterministically).
  const speciesOrder = shuffle(rng, [...SPECIES_KEYS]);

  // 5. Stamp homes. We need at least one plot per species; buildPlots yields a
  // coarse grid that comfortably exceeds 14 cells at 128² with 3+3 avenues.
  const buildings: Building[] = [];
  const housing: Housing[] = [];
  const reserved = new Set<number>(); // tiles nature must avoid (homes + roads margins)
  const reachTargets: { tx: number; ty: number }[] = [];
  const questPos = new Map<string, { tx: number; ty: number }>();

  const homeCount = Math.min(speciesOrder.length, plots.length);
  for (let i = 0; i < homeCount; i++) {
    const species = speciesOrder[i];
    const plot = plots[i];
    const kind = SPECIES_HOUSING[species];
    let placed: PlacedHome;
    if (kind === 'building') {
      placed = stampBuilding(ground, deco, roof, plot, species, rng);
      if (placed.building) buildings.push(placed.building);
    } else {
      placed = stampHousing(ground, deco, plot, species, kind);
      if (placed.housing) {
        placed.housing.cx = tileCenter(placed.centerTx, tile);
        placed.housing.cy = tileCenter(placed.centerTy, tile);
        housing.push(placed.housing);
      }
    }
    // Reserve the whole plot footprint so nature doesn't intrude.
    for (let dy = -1; dy <= plot.th; dy++) {
      for (let dx = -1; dx <= plot.tw; dx++) {
        reserved.add(tileIndex(w, plot.tx + dx, plot.ty + dy));
      }
    }
    for (const rt of placed.reachTargets) reachTargets.push(rt);
    questPos.set(species, { tx: placed.questTx, ty: placed.questTy });
  }

  // Spawns: a small block inside the gate, set back ~half a viewport from the
  // east wall so the camera (which clamps to the world edge) can frame the player
  // on join instead of pinning at the boundary. Still clearly "by the gate" — the
  // gate is a short walk east — but off the edge where follow would look frozen.
  const SPAWN_INSET = 20; // tiles west of the gate (≈640px ≈ half a 1280 viewport)
  const spawns: { x: number; y: number }[] = [];
  const spawnTiles: { tx: number; ty: number }[] = [];
  // Scan a small block of tiles centered SPAWN_INSET west of the gate and collect
  // the first ~10 non-solid, unreserved cells as spawn points (row-major, so the
  // order is stable). A block (not a single column) reliably yields enough slots
  // even when a road/plot clips the ideal column.
  const spawnCx = gateTx - SPAWN_INSET;
  for (let dy = -4; dy <= 4 && spawns.length < 10; dy++) {
    for (let dx = -3; dx <= 3 && spawns.length < 10; dx++) {
      const sx = spawnCx + dx;
      const sy = gateTy + dy;
      if (sx < 2 || sy < 2 || sx >= w - 2 || sy > h - 3) continue;
      const i = tileIndex(w, sx, sy);
      if (deco.data[i] !== 0 || reserved.has(i)) continue;
      spawns.push({ x: tileCenter(sx, tile), y: tileCenter(sy, tile) });
      spawnTiles.push({ tx: sx, ty: sy });
      reserved.add(i);
    }
  }
  // Guarantee at least one spawn: if the block was fully occupied (rare seed),
  // widen the search to any non-solid tile near the gate row, then fall back to a
  // tile just inside the gate. The reachability pass below makes it walkable.
  if (spawns.length === 0) {
    let found = false;
    for (let r = 1; r <= w && !found; r++) {
      const sx = clampInt(gateTx - r, 2, w - 3);
      const sy = clampInt(gateTy, 2, h - 3);
      const i = tileIndex(w, sx, sy);
      if (deco.data[i] === 0) {
        spawns.push({ x: tileCenter(sx, tile), y: tileCenter(sy, tile) });
        spawnTiles.push({ tx: sx, ty: sy });
        found = true;
      }
    }
    if (!found) {
      const sx = clampInt(gateTx - SPAWN_INSET, 2, w - 3);
      spawns.push({ x: tileCenter(sx, tile), y: tileCenter(gateTy, tile) });
      spawnTiles.push({ tx: sx, ty: gateTy });
    }
  }

  // 6. Scatter nature on the leftover grass.
  scatterNature(ground, deco, w, h, reserved, rng);

  // 7. Entity specs. Build in a FIXED order so JSON.stringify is stable.
  const entitySpecs: WorldEntitySpec[] = [];
  entitySpecs.push({ id: 'gate-1', kind: 'gate', x: gate.x, y: gate.y });

  // The disguise prop (Clipboard) near the first spawn.
  const propTile = spawnTiles[0] ?? { tx: gateTx - 2, ty: gateTy };
  entitySpecs.push({ id: 'prop-1', kind: 'prop', x: tileCenter(propTile.tx, tile), y: tileCenter(propTile.ty, tile) });

  // Terminals on road tiles at fixed avenue intersections (deterministic).
  const terminalTiles: { tx: number; ty: number }[] = [];
  const interIdx = [
    { c: 0, r: 0 },
    { c: 1, r: 1 },
    { c: 2, r: 1 },
    { c: 1, r: 2 },
  ];
  for (const { c, r } of interIdx) {
    if (c < vLines.length && r < hLines.length) {
      terminalTiles.push({ tx: vLines[c], ty: hLines[r] });
    }
  }
  let tnum = 0;
  for (const tt of terminalTiles) {
    tnum++;
    entitySpecs.push({ id: `terminal-${tnum}`, kind: 'terminal', x: tileCenter(tt.tx, tile), y: tileCenter(tt.ty, tile) });
  }

  // Robot spawns: spread across the avenue grid (road tiles, non-solid). Pick a
  // fixed set of points along the avenues so the spread is deterministic + sane.
  const robotTiles: { tx: number; ty: number }[] = [
    { tx: vLines[0], ty: Math.floor(h * 0.18) },
    { tx: vLines[1], ty: Math.floor(h * 0.4) },
    { tx: vLines[2], ty: Math.floor(h * 0.62) },
    { tx: Math.floor(w * 0.4), ty: hLines[0] },
    { tx: Math.floor(w * 0.6), ty: hLines[2] },
    { tx: vLines[1], ty: Math.floor(h * 0.85) },
  ];
  let rnum = 0;
  for (const rt of robotTiles) {
    rnum++;
    entitySpecs.push({ id: `robot-${rnum}`, kind: 'robotSpawn', x: tileCenter(rt.tx, tile), y: tileCenter(rt.ty, tile) });
  }

  // Pen anchors (decoy spawn points) + quest objects, one per species, in roster
  // order so the list is stable. A pen anchor uses the home center; for buildings
  // (no Housing) we anchor on the quest tile inside.
  for (const species of SPECIES_KEYS) {
    const home = housing.find((hh) => hh.species === species);
    const qp = questPos.get(species);
    if (!qp) continue; // species without a placed plot (shouldn't happen with 14 plots)
    if (home) {
      entitySpecs.push({
        id: `pen-${species}`,
        kind: 'penAnchor',
        x: home.cx,
        y: home.cy,
        species,
        meta: { kind: home.kind },
      });
    } else {
      const bld = buildings.find((bb) => bb.species === species);
      if (bld) {
        entitySpecs.push({
          id: `pen-${species}`,
          kind: 'penAnchor',
          x: tileCenter(qp.tx, tile),
          y: tileCenter(qp.ty, tile),
          species,
          meta: { kind: 'building' },
        });
      }
    }
    entitySpecs.push({
      id: `quest-${species}`,
      kind: 'questObject',
      x: tileCenter(qp.tx, tile),
      y: tileCenter(qp.ty, tile),
      species,
      meta: { species },
    });
  }

  // 8. Collision from solid tiles.
  const collision = buildCollision(ground, deco);

  // --- REACHABILITY: carve until every required target is reachable from spawn ---
  // Required targets: gate gap, every building door, every housing center (its
  // reach tile), every quest object tile, every spawn tile.
  const required: { tx: number; ty: number }[] = [];
  required.push({ tx: gateTx, ty: gateTy });
  for (const rt of reachTargets) required.push(rt);
  for (const st of spawnTiles) required.push(st);
  for (const [, qp] of questPos) required.push(qp);

  const startTile = spawnTiles[0] ?? { tx: gateTx - 2, ty: gateTy };
  const MAX_ITERS = required.length + 8;
  let iter = 0;
  for (;;) {
    const seen = floodReachable(collision, w, h, startTile.tx, startTile.ty);
    let carvedAny = false;
    for (const tgt of required) {
      if (seen[tgt.ty * w + tgt.tx]) continue;
      const from = nearestReachable(seen, w, h, tgt.tx, tgt.ty);
      if (!from) {
        // Start tile itself is solid — clear it and retry next iteration.
        const si = tileIndex(w, startTile.tx, startTile.ty);
        deco.data[si] = 0;
        setTile(ground, startTile.tx, startTile.ty, TILE_INDEX.PAVED);
        collision[si] = 0;
        carvedAny = true;
        break;
      }
      carveCorridor(ground, deco, collision, w, from.x, from.y, tgt.tx, tgt.ty);
      carvedAny = true;
    }
    if (!carvedAny) break;
    if (++iter > MAX_ITERS) {
      throw new Error(
        `generateWorld(${seed}): reachability did not converge after ${MAX_ITERS} carve passes`,
      );
    }
  }

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
    buildings,
    housing,
    spawns,
    gate,
    entitySpecs,
  };
}
