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
import { foodForSpecies } from './food.js';
import { TILE_INDEX, TILE_SIZE, isSolidIndex } from './tiles.js';

/** Bump whenever generateWorld's OUTPUT changes, so client/server parity is asserted.
 *  v8: merge of the organic-layout map overhaul (zones/river/plaza/per-pen animals,
 *  v5→7) and the animal-collection food sources (one `foodSource` spec per species,
 *  co-located with the quest tile). The merged output differs from both, so this is
 *  a fresh bump, not max(7,5). */
export const WORLD_GEN_VERSION = 9;

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
  kind: 'gate' | 'terminal' | 'questObject' | 'robotSpawn' | 'prop' | 'penAnchor' | 'foodSource';
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
  /**
   * Robot patrol loop in WORLD UNITS: the path-network junctions (forecourt root
   * first, then zone centers in fixed carve order). Consecutive points are
   * connected by the carved spine, so a robot walking them in order patrols the
   * paved avenues. Additive + derived from the junctions carveOrganicPaths already
   * computes — never serialized (the client regenerates it from the seed), so it
   * costs zero wire bytes. May be empty on a degenerate seed (caller falls back to
   * ambient wander).
   */
  patrolRoute: { x: number; y: number }[];
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

/** Stamp the solid perimeter wall ring (deco), no openings. */
function stampPerimeterRing(deco: TileGrid, w: number, h: number): void {
  for (let x = 0; x < w; x++) {
    setTile(deco, x, 0, TILE_INDEX.WALL_EXT_MID);
    setTile(deco, x, h - 1, TILE_INDEX.WALL_EXT_MID);
  }
  for (let y = 0; y < h; y++) {
    setTile(deco, 0, y, TILE_INDEX.WALL_EXT_MID);
    setTile(deco, w - 1, y, TILE_INDEX.WALL_EXT_MID);
  }
}

/** What stampEntrancePlaza produces for generateWorld to wire up. */
interface EntrancePlaza {
  gateTx: number;
  gateTy: number;
  /** The forecourt root tile the spine connects to (just west of the gatehouse). */
  forecourt: Junction;
  /** The gatehouse structure (a species-less Building → fade-on-enter roof). */
  gatehouse: Building;
  /** Tile rect [x0,y0,x1,y1] the plaza owns; the layout reserves it. */
  reservedRect: { x0: number; y0: number; x1: number; y1: number };
}

/**
 * Upgrade the bare east gate into a believable MAIN GATEHOUSE + paved forecourt.
 *
 * Geometry (east edge, vertical center with the same single jitter draw the old
 * stampPerimeter used, so the rng stream's draw count is preserved):
 *   - ONE gate gap in the perimeter wall (the escape point — checkEscape targets
 *     `gate = tileCenter(w-1, gateTy)`, kept byte-stable). The gatehouse straddles
 *     the wall just inside it.
 *   - A roofed gatehouse hall (a Building: wall ring + floor + a south/north door,
 *     DOOR_OPEN threshold) — the fade-on-enter roof reads as walking through the
 *     entrance. The east wall stays SOLID except the one gate tile, so the hall
 *     has exactly one way OUT of the zoo (single chokepoint).
 *   - A COBBLE forecourt west of the hall (the open plaza), framed with signage
 *     (SIGN_ARROW pointing in), a BANNER over the arch, LAMP_POSTs, a BENCH, a
 *     TRASH_BIN, trimmed bushes + a flower bed for dressing.
 *
 * Returns the forecourt root (spine anchor), the gatehouse Building, and the
 * reserved rect so the organic layout keeps its zones out of the entrance band.
 */
function stampEntrancePlaza(
  ground: TileGrid,
  deco: TileGrid,
  roof: TileGrid,
  w: number,
  h: number,
  rng: () => number,
): EntrancePlaza {
  // Same single jitter draw as the old gate placement (preserve draw count).
  const gateTy = Math.floor(h / 2) + randInt(rng, -6, 6);
  const gateTx = w - 1;
  // Open exactly ONE tile in the east wall — the escape gate.
  setTile(deco, gateTx, gateTy, TILE_INDEX.DOOR_OPEN);

  // Gatehouse hall: a 6-wide × 7-tall roofed block whose EAST wall sits one tile
  // inside the perimeter, centered on the gate row. Floors are tile; the roof
  // fades on enter (it's a Building). The hall's east side aligns with the gate so
  // you pass gate → hall → forecourt.
  const hw = 6;
  const hh = 7;
  const hx = w - 1 - hw; // east wall of the hall one tile inside the perimeter
  const hy = clampInt(gateTy - Math.floor(hh / 2), 2, h - 3 - hh);

  for (let dy = 0; dy < hh; dy++) {
    for (let dx = 0; dx < hw; dx++) {
      const tx = hx + dx;
      const ty = hy + dy;
      const edge = dx === 0 || dy === 0 || dx === hw - 1 || dy === hh - 1;
      if (edge) {
        setTile(deco, tx, ty, TILE_INDEX.WALL_EXT_MID);
      } else {
        setTile(ground, tx, ty, TILE_INDEX.FLOOR_TILE);
        setTile(roof, tx, ty, TILE_INDEX.ROOF_RED_MID);
      }
    }
  }
  // East passage: align the hall's east wall opening with the gate row so the gate
  // → hall threshold is continuous and walkable (2-wide for the collision AABB).
  const eGateRow = clampInt(gateTy, hy + 1, hy + hh - 2);
  setTile(deco, hx + hw - 1, eGateRow, TILE_INDEX.DOOR_OPEN);
  setTile(roof, hx + hw - 1, eGateRow, 0);
  // West door (out of the hall onto the forecourt), 2-wide, walkable.
  const wDoorTy = hy + hh - 2;
  setTile(deco, hx, wDoorTy, TILE_INDEX.DOOR_OPEN);
  setTile(deco, hx, wDoorTy - 1, TILE_INDEX.DOOR_OPEN);
  setTile(roof, hx, wDoorTy, 0);
  setTile(roof, hx, wDoorTy - 1, 0);

  // Forecourt: a cobble plaza west of the hall. Keep it clear of the perimeter and
  // a tile shy of the hall. Width scales the entrance band but stays modest.
  const fcW = 12;
  const fcx0 = hx - fcW;
  const fcy0 = clampInt(gateTy - 5, 2, h - 12);
  const fcy1 = clampInt(gateTy + 5, fcy0 + 6, h - 3);
  for (let ty = fcy0; ty <= fcy1; ty++) {
    for (let tx = fcx0; tx < hx; tx++) {
      // Subtle 2-tone cobble checker so the plaza isn't a flat slab (no rng — a
      // fixed parity pattern keeps it deterministic).
      const worn = (tx + ty) % 5 === 0;
      setTile(ground, tx, ty, worn ? TILE_INDEX.COBBLE_WORN : TILE_INDEX.COBBLE);
    }
  }

  // Dressing (all non-blocking visual flavor except posts/signs which are solid —
  // kept off the central walk lane at gateTy so the path through stays clear).
  const lane = wDoorTy; // the walkable lane out of the west door
  setTile(deco, fcx0, fcy0, TILE_INDEX.LAMP_POST);
  setTile(deco, fcx0, fcy1, TILE_INDEX.LAMP_POST);
  setTile(deco, hx - 1, fcy0, TILE_INDEX.SIGN_ARROW);
  setTile(deco, hx - 1, fcy1, TILE_INDEX.BANNER);
  if (fcy1 - 1 !== lane) setTile(deco, fcx0 + 2, fcy1 - 1, TILE_INDEX.BENCH);
  if (fcy0 + 1 !== lane) setTile(deco, fcx0 + 2, fcy0 + 1, TILE_INDEX.TRASH_BIN);
  if (fcy0 !== lane) setTile(deco, fcx0 + 4, fcy0, TILE_INDEX.BUSH_TRIMMED);
  if (fcy1 !== lane) setTile(deco, fcx0 + 4, fcy1, TILE_INDEX.FLOWER_BED);

  // The gatehouse Building: rx/ry/rw/rh is the ROOFED HALL only (not the open
  // forecourt) so the renderer's roof-fade rect covers just the hall. species
  // omitted → excluded from the coverage test's home counts. door = the west door.
  const gatehouse: Building = {
    id: 'gatehouse',
    rx: hx,
    ry: hy,
    rw: hw,
    rh: hh,
    doorTx: hx,
    doorTy: wDoorTy,
  };

  return {
    gateTx,
    gateTy,
    forecourt: { tx: clampInt(fcx0 + 1, 2, w - 3), ty: lane },
    gatehouse,
    reservedRect: { x0: fcx0 - 1, y0: Math.min(fcy0, hy) - 1, x1: w - 1, y1: Math.max(fcy1, hy + hh) + 1 },
  };
}

/** Integer clamp (the float `clamp` from step.ts isn't imported to keep deps tight). */
function clampInt(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

// --- Organic layout: biome zones --------------------------------------------
//
// The old rigid 3×3 avenue grid is gone. The interior west of the entrance band
// is partitioned into a few THEMED ZONES (savanna / wetland / forest / rockyDen /
// aviary). Each species' home lands in a sensible zone, paths wind between zone
// centers, and a river meanders through the wetland. Everything stays pure +
// deterministic (one mulberry32 thread, fixed iteration order, integer math only).

/** The themed biome zones the zoo is partitioned into. */
type ZoneId = 'savanna' | 'wetland' | 'forest' | 'rockyDen' | 'aviary';

/** A biome zone: a tile rect plus its theme. Species homes are placed inside. */
interface Zone {
  id: ZoneId;
  /** Tile rect (the carve-able interior of this zone). */
  tx: number;
  ty: number;
  tw: number;
  th: number;
  /** Zone center tile (a path junction / spine waypoint). */
  cx: number;
  cy: number;
}

/**
 * The fixed species → zone assignment. STABLE (not rng-driven) so the zoo always
 * reads the same way; kept consistent with SPECIES_HOUSING so a pond-dweller
 * lands in the wetland, a denner in the forest/rocky ground, a flier in the
 * aviary cluster, and the big grazers/runners on the savanna. Buildings
 * (ape/chameleon/owl) sit in the forest fringe (owl) / savanna (ape) as written.
 */
const SPECIES_ZONE: Record<string, ZoneId> = {
  tortoise: 'wetland', // pond
  skunk: 'forest', // den
  fox: 'forest', // den
  chameleon: 'forest', // building
  owl: 'forest', // building
  mole: 'rockyDen', // den
  rat: 'rockyDen', // cage
  bird: 'aviary', // aviary
  peacock: 'aviary', // aviary
  parrot: 'aviary', // aviary
  elephant: 'savanna', // paddock
  cheetah: 'savanna', // paddock
  kangaroo: 'savanna', // pen
  ape: 'savanna', // building
};

/**
 * Partition the interior (west of the reserved entrance band) into five biome
 * zones via a fixed-topology, jittered split. The TOPOLOGY is constant (so the
 * theme of each region is stable); only the cut positions jitter per seed, so
 * zone shapes/sizes vary while the map still reads the same way.
 *
 * Layout (within the playable box [2..eastLimit] × [2..h-3]):
 *   ┌──────────────┬──────────────┐
 *   │   savanna    │   aviary     │   top band split L/R
 *   ├──────────────┼──────────────┤
 *   │   forest     │   wetland    │   mid band split L/R
 *   ├──────────────┴──────────────┤
 *   │          rockyDen           │   bottom full-width band
 *   └─────────────────────────────┘
 *
 * `eastLimit` is the western edge of the entrance/plaza band (kept clear here so
 * Phase B owns it). Draws exactly 3 jitter values, unconditionally.
 */
function partitionZones(h: number, eastLimit: number, rng: () => number): Zone[] {
  const x0 = 2;
  const y0 = 2;
  const x1 = eastLimit; // exclusive-ish western edge of the entrance band
  const y1 = h - 3;
  const iw = x1 - x0;
  const ih = y1 - y0;

  // Jittered horizontal band cuts (top band / mid band / bottom band) and the
  // vertical cut splitting the top + mid bands into L/R. All integer, clamped.
  const topCut = clampInt(y0 + Math.floor(ih * 0.34) + randInt(rng, -4, 4), y0 + 8, y0 + ih - 16);
  const midCut = clampInt(topCut + Math.floor(ih * 0.34) + randInt(rng, -4, 4), topCut + 8, y1 - 8);
  const vCut = clampInt(x0 + Math.floor(iw * 0.5) + randInt(rng, -5, 5), x0 + 12, x1 - 12);

  const mk = (id: ZoneId, tx: number, ty: number, tw: number, th: number): Zone => ({
    id,
    tx,
    ty,
    tw,
    th,
    cx: tx + Math.floor(tw / 2),
    cy: ty + Math.floor(th / 2),
  });

  // Fixed order: savanna, aviary, forest, wetland, rockyDen (also the order the
  // spine visits, so the path topology is stable).
  return [
    mk('savanna', x0, y0, vCut - x0, topCut - y0),
    mk('aviary', vCut, y0, x1 - vCut, topCut - y0),
    mk('forest', x0, topCut, vCut - x0, midCut - topCut),
    mk('wetland', vCut, topCut, x1 - vCut, midCut - topCut),
    mk('rockyDen', x0, midCut, x1 - x0, y1 - midCut),
  ];
}

/** The zone a species belongs to (falls back to savanna for any unmapped key). */
function zoneFor(zones: Zone[], species: string): Zone {
  const id = SPECIES_ZONE[species] ?? 'savanna';
  return zones.find((z) => z.id === id) ?? zones[0];
}

// --- Organic enclosure placement --------------------------------------------

/**
 * A free-rect finder within a zone. Scans the zone for the first axis-aligned
 * `tw×th` rectangle (row-major from the zone's top-left, stepping by 1) that does
 * not overlap any already-claimed tile and stays a tile clear of the zone edge.
 * Deterministic (no rng); returns null if the zone can't fit the rect.
 */
function findFreeRect(zone: Zone, tw: number, th: number, claimed: Set<number>, w: number): Plot | null {
  const m = 1; // keep a tile of breathing room inside the zone
  const xEnd = zone.tx + zone.tw - tw - m;
  const yEnd = zone.ty + zone.th - th - m;
  for (let ty = zone.ty + m; ty <= yEnd; ty++) {
    for (let tx = zone.tx + m; tx <= xEnd; tx++) {
      let ok = true;
      for (let dy = -1; dy <= th && ok; dy++) {
        for (let dx = -1; dx <= tw && ok; dx++) {
          if (claimed.has(tileIndex(w, tx + dx, ty + dy))) ok = false;
        }
      }
      if (ok) return { tx, ty, tw, th };
    }
  }
  return null;
}

/** Mark a plot's footprint (plus a 1-tile halo) as claimed, so homes don't touch. */
function claimPlot(claimed: Set<number>, plot: Plot, w: number): void {
  for (let dy = -1; dy <= plot.th; dy++) {
    for (let dx = -1; dx <= plot.tw; dx++) {
      claimed.add(tileIndex(w, plot.tx + dx, plot.ty + dy));
    }
  }
}

// --- River (the water feature) ----------------------------------------------
//
// A meandering channel through the wetland zone. INTEGER MATH ONLY (no trig —
// Math.sin/cos are not bit-stable across the browser's V8 and the server's, which
// would desync the deterministic generation). The walk is a vertical sweep with a
// per-row ±1 jitter biased back toward a target column, so it wanders but always
// stays inside the zone and converges. WATER_DEEP is solid; a SHALLOW margin makes
// the shore walkable and gives blendWaterEdges something to feather.

/**
 * Carve a meandering river down through the wetland `zone`. Records every deep
 * (solid) water tile in `riverDeep` so later passes can keep reach targets and
 * the entrance band clear of it (the carve fallback must never have to pave across
 * the river). Returns the channel's center column per row (for optional bridges)
 * and the set of all water tiles. Draws exactly one rng value per row.
 */
function carveRiver(
  ground: TileGrid,
  zone: Zone,
  riverDeep: Set<number>,
  rng: () => number,
): void {
  const w = ground.w;
  // Channel runs the zone's vertical extent, inset so it never touches the zone
  // edge (and thus never an enclosure or the wall). Half-width 1 → 3-wide shallow
  // band with a 1-wide deep core where the band is wide enough.
  const top = zone.ty + 1;
  const bot = zone.ty + zone.th - 2;
  const colMin = zone.tx + 3;
  const colMax = zone.tx + zone.tw - 4;
  if (colMax <= colMin || bot <= top) return;
  let col = clampInt(zone.cx, colMin, colMax);
  const target = clampInt(zone.tx + Math.floor(zone.tw / 2), colMin, colMax);
  for (let ty = top; ty <= bot; ty++) {
    // Meander: ±1 jitter biased back toward the target column (integer only).
    const bias = col < target ? 1 : col > target ? -1 : 0;
    const j = randInt(rng, -1, 1) + bias;
    col = clampInt(col + (j < -1 ? -1 : j > 1 ? 1 : j), colMin, colMax);
    // Shallow band (walkable shore) + a deep core tile (solid).
    setTile(ground, col - 1, ty, TILE_INDEX.WATER_SHALLOW);
    setTile(ground, col + 1, ty, TILE_INDEX.WATER_SHALLOW);
    setTile(ground, col, ty, TILE_INDEX.WATER_DEEP);
    riverDeep.add(tileIndex(w, col, ty));
  }
}

// --- Organic path network ----------------------------------------------------

/** A path junction (zone center / forecourt root) — terminals + robots anchor here. */
interface Junction {
  tx: number;
  ty: number;
}

/**
 * Lay a winding PAVED corridor from (fx,fy) to (tx,ty): walk the dominant axis one
 * tile at a time, taking a ±1 wobble on the cross axis (biased back to the target
 * line) so the path curves instead of running ruler-straight. Pure integer math;
 * draws one rng value per step. Never paves over a deep-water tile (routes the
 * wobble around it) so the river is crossed only where a bridge is laid.
 */
function carveWindingPath(
  ground: TileGrid,
  riverDeep: Set<number>,
  fx: number,
  fy: number,
  tx: number,
  ty: number,
  rng: () => number,
): void {
  const w = ground.w;
  const road = TILE_INDEX.PAVED;
  const horizontal = Math.abs(tx - fx) >= Math.abs(ty - fy);
  let x = fx;
  let y = fy;
  const pave = (px: number, py: number) => {
    const i = tileIndex(w, px, py);
    if (riverDeep.has(i)) return; // don't pave the river bed; bridges handle crossings
    setTile(ground, px, py, road);
  };
  if (horizontal) {
    const stepX = tx >= fx ? 1 : -1;
    while (x !== tx) {
      const wob = randInt(rng, -1, 1) + (y < ty ? 1 : y > ty ? -1 : 0);
      y = clampInt(y + (wob < -1 ? -1 : wob > 1 ? 1 : wob), 1, ground.h - 2);
      x += stepX;
      pave(x, y);
      pave(x, clampInt(y + 1, 1, ground.h - 2)); // 2-wide so collision AABB fits
    }
    while (y !== ty) {
      y += ty > y ? 1 : -1;
      pave(x, y);
      pave(clampInt(x + 1, 1, w - 2), y);
    }
  } else {
    const stepY = ty >= fy ? 1 : -1;
    while (y !== ty) {
      const wob = randInt(rng, -1, 1) + (x < tx ? 1 : x > tx ? -1 : 0);
      x = clampInt(x + (wob < -1 ? -1 : wob > 1 ? 1 : wob), 1, w - 2);
      y += stepY;
      pave(x, y);
      pave(clampInt(x + 1, 1, w - 2), y);
    }
    while (x !== tx) {
      x += tx > x ? 1 : -1;
      pave(x, y);
      pave(x, clampInt(y + 1, 1, ground.h - 2));
    }
  }
}

/**
 * Build the organic path network: a winding spine loop visiting the forecourt
 * root then every zone center in order and back, plus the gate spur. Returns the
 * junction list (forecourt + zone centers) for terminal/robot anchoring. Draws rng
 * inside carveWindingPath (one per step) in a fixed waypoint order.
 */
function carveOrganicPaths(
  ground: TileGrid,
  zones: Zone[],
  forecourt: Junction,
  gateTx: number,
  riverDeep: Set<number>,
  rng: () => number,
): { junctions: Junction[] } {
  const road = TILE_INDEX.PAVED;
  // Gate spur: straight PAVED run from the gate gap to the forecourt root (kept
  // straight + 3-wide so the entrance is unambiguous and always road-connected).
  for (let tx = gateTx; tx >= forecourt.tx; tx--) {
    for (let d = -1; d <= 1; d++) setTile(ground, tx, clampInt(forecourt.ty + d, 1, ground.h - 2), road);
  }

  // Spine: forecourt → each zone center (fixed order) → back to forecourt. The
  // waypoint order is fixed, so the rng consumption inside carveWindingPath is
  // deterministic across client/server.
  const waypoints: Junction[] = [forecourt, ...zones.map((z) => ({ tx: z.cx, ty: z.cy })), forecourt];
  for (let i = 0; i < waypoints.length - 1; i++) {
    const a = waypoints[i];
    const b = waypoints[i + 1];
    carveWindingPath(ground, riverDeep, a.tx, a.ty, b.tx, b.ty, rng);
  }

  const junctions: Junction[] = [forecourt, ...zones.map((z) => ({ tx: z.cx, ty: z.cy }))];
  // Force-pave each junction tile (and a small plus) so a terminal/robot anchored
  // there always sits on a walkable tile — even if a zone center landed on the
  // river bed (the junction becomes a bridge). Drops bridged tiles from riverDeep.
  for (const j of junctions) {
    for (const [dx, dy] of [[0, 0], [1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const px = clampInt(j.tx + dx, 1, ground.w - 2);
      const py = clampInt(j.ty + dy, 1, ground.h - 2);
      setTile(ground, px, py, road);
      riverDeep.delete(tileIndex(ground.w, px, py));
    }
  }
  return { junctions };
}

/**
 * Lay bridges where the path net wants to cross the river: any deep-water tile
 * with PAVED on opposite sides (E+W or N+S) is a place a winding path ran up to
 * the bank on both shores — pave it (a bridge) so the crossing is intentional and
 * the reachability fallback never has to carve an ugly road across open water.
 * Pure (no rng), row-major. The bridged tile leaves `riverDeep` (it's PAVED now,
 * non-solid), so buildCollision treats it as walkable.
 */
function bridgeRiverCrossings(ground: TileGrid, riverDeep: Set<number>): void {
  const w = ground.w;
  const road = TILE_INDEX.PAVED;
  const isPaved = (tx: number, ty: number) => ground.data[tileIndex(w, tx, ty)] === road;
  // Snapshot to an array first: insertion order (fixed row-major from carveRiver)
  // so the scan is deterministic, and we mutate the set inside the loop.
  for (const i of [...riverDeep]) {
    const tx = i % w;
    const ty = (i - tx) / w;
    const ew = isPaved(tx - 1, ty) && isPaved(tx + 1, ty);
    const ns = isPaved(tx, ty - 1) && isPaved(tx, ty + 1);
    if (ew || ns) {
      setTile(ground, tx, ty, road);
      riverDeep.delete(i);
    }
  }
}

// --- Tile-style accuracy: autotiled edges (the unused blend tiles 25-48) ------
//
// The blend tiles PATH_EDGE_*/CORNER/ICORNER (25-36) and WATER_EDGE_*/… (37-48)
// were defined but never written by world-gen, so grass met path/water with a
// hard seam. blendGroundEdges feathers those seams: it rewrites a GRASS cell that
// borders a path/water region into the matching edge/corner tile, chosen by an
// 8-neighbour mask. Pure (no rng), row-major, first-match priority → deterministic.
// All blend tiles are non-solid, and the pass never rewrites a solid water/wall
// tile, so collision is UNCHANGED (verified: tiles 25-48 carry no solid flag).

type EdgeClass = 'grass' | 'path' | 'water';

/** Classify a ground tile index for the edge-blend pass. */
function classOf(idx: number): EdgeClass {
  if (
    idx === TILE_INDEX.PAVED ||
    idx === TILE_INDEX.PAVED_CRACK ||
    idx === TILE_INDEX.COBBLE ||
    idx === TILE_INDEX.COBBLE_WORN
  )
    return 'path';
  if (
    idx === TILE_INDEX.WATER_DEEP ||
    idx === TILE_INDEX.WATER_SHALLOW ||
    idx === TILE_INDEX.POND_DEEP ||
    idx === TILE_INDEX.POND_EDGE
  )
    return 'water';
  return 'grass';
}

/** Whether a ground index is a plain grass variant (the only cells we feather). */
function isGrassIndex(idx: number): boolean {
  return (
    idx === TILE_INDEX.GRASS_A ||
    idx === TILE_INDEX.GRASS_B ||
    idx === TILE_INDEX.GRASS_C ||
    idx === TILE_INDEX.GRASS_FLOWERS ||
    idx === TILE_INDEX.GRASS_PATCHY
  );
}

/**
 * Pick the blend tile for a grass cell given which of its 4 orthogonal neighbours
 * are of `target` class. Outer corner (two adjacent edges) > straight edge > inner
 * corner (diagonal only). Returns 0 to leave the cell unchanged (e.g. opposite
 * edges N+S, or all-four — those read fine as base grass).
 */
function pickBlendTile(target: 'path' | 'water', n: boolean, e: boolean, s: boolean, ww: boolean): number {
  const P = TILE_INDEX;
  const E = target === 'path'
    ? { N: P.PATH_EDGE_N, E: P.PATH_EDGE_E, S: P.PATH_EDGE_S, W: P.PATH_EDGE_W,
        CNE: P.PATH_CORNER_NE, CNW: P.PATH_CORNER_NW, CSE: P.PATH_CORNER_SE, CSW: P.PATH_CORNER_SW }
    : { N: P.WATER_EDGE_N, E: P.WATER_EDGE_E, S: P.WATER_EDGE_S, W: P.WATER_EDGE_W,
        CNE: P.WATER_CORNER_NE, CNW: P.WATER_CORNER_NW, CSE: P.WATER_CORNER_SE, CSW: P.WATER_CORNER_SW };
  // Outer corners: two orthogonally-adjacent edges of the target.
  if (n && e) return E.CNE;
  if (n && ww) return E.CNW;
  if (s && e) return E.CSE;
  if (s && ww) return E.CSW;
  // Straight edges (exactly one side, or opposite sides → pick the first).
  if (n && !s) return E.N;
  if (s && !n) return E.S;
  if (e && !ww) return E.E;
  if (ww && !e) return E.W;
  return 0; // opposite pair or none → leave as grass
}

/**
 * Feather every grass cell that borders a path or water region into the matching
 * blend tile. Path takes priority over water on a cell touching both (shoreline
 * paths are rare and one must win deterministically). Idempotent: a second run
 * finds no plain-grass borders left to change, so it's a no-op (asserted in test).
 */
function blendGroundEdges(ground: TileGrid): void {
  const { w, h, data } = ground;
  const at = (tx: number, ty: number): EdgeClass => {
    if (tx < 0 || ty < 0 || tx >= w || ty >= h) return 'grass';
    return classOf(data[ty * w + tx]);
  };
  // Snapshot the grass cells first so reads see the ORIGINAL field (writing blend
  // tiles must not cascade — a freshly-written edge is not grass, so it wouldn't
  // re-trigger anyway, but snapshotting makes the pass order-independent + truly
  // idempotent).
  for (let ty = 1; ty < h - 1; ty++) {
    for (let tx = 1; tx < w - 1; tx++) {
      const idx = data[ty * w + tx];
      if (!isGrassIndex(idx)) continue;
      for (const target of ['path', 'water'] as const) {
        const n = at(tx, ty - 1) === target;
        const e = at(tx + 1, ty) === target;
        const s = at(tx, ty + 1) === target;
        const ww = at(tx - 1, ty) === target;
        if (!n && !e && !s && !ww) continue;
        const blend = pickBlendTile(target, n, e, s, ww);
        if (blend) {
          data[ty * w + tx] = blend;
          break; // path wins; don't also water-blend this cell
        }
      }
    }
  }
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

/** A spawn slot for one NPC animal inside its home (world units). */
interface AnimalSpot {
  x: number;
  y: number;
}

/**
 * Choose up to `count` distinct, non-solid interior tiles of a home for NPC animal
 * spawns, deterministically. Scans the interior (inside the wall/barrier ring),
 * skips solid tiles (deep-water core, den walls, interior props) and the home's
 * quest tile, shuffles the candidates ONCE, and returns the first `count` as
 * world-unit centers. Exactly one rng draw-set (the shuffle) per home, so the
 * stream stays fixed regardless of interior shape.
 *
 * @param rect  the home's tile rect (rx,ry,rw,rh — includes the wall ring)
 */
function populateEnclosure(
  ground: TileGrid,
  deco: TileGrid,
  rect: { rx: number; ry: number; rw: number; rh: number },
  questTx: number,
  questTy: number,
  count: number,
  tile: number,
  rng: () => number,
): AnimalSpot[] {
  const candidates: { tx: number; ty: number }[] = [];
  for (let dy = 1; dy < rect.rh - 1; dy++) {
    for (let dx = 1; dx < rect.rw - 1; dx++) {
      const tx = rect.rx + dx;
      const ty = rect.ry + dy;
      if (tx === questTx && ty === questTy) continue; // leave the quest tile clear
      const i = tileIndex(ground.w, tx, ty);
      if (isSolidIndex(ground.data[i]) || isSolidIndex(deco.data[i])) continue;
      candidates.push({ tx, ty });
    }
  }
  // One deterministic shuffle, then take the first `count` (so the animals don't
  // all clump in the top-left and the choice still varies per seed).
  shuffle(rng, candidates);
  const spots: AnimalSpot[] = [];
  for (let i = 0; i < candidates.length && spots.length < count; i++) {
    spots.push({ x: tileCenter(candidates[i].tx, tile), y: tileCenter(candidates[i].ty, tile) });
  }
  return spots;
}

/** How many NPC animals a home of interior area `iw*ih` gets: 2..3, scaled. */
function animalCountFor(iw: number, ih: number): number {
  return clampInt(2 + Math.floor((iw * ih) / 24), 2, 3);
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

  // 2. Perimeter wall ring + the gatehouse entrance plaza. The plaza OWNS the east
  //    band: it opens the single escape gate, stamps the roofed gatehouse hall +
  //    cobble forecourt, and hands back the forecourt root (spine anchor) + the
  //    reserved rect so the organic zones stay clear of the entrance.
  stampPerimeterRing(deco, w, h);
  const plaza = stampEntrancePlaza(ground, deco, roof, w, h, rng);
  const { gateTx, gateTy, forecourt } = plaza;
  const gate = { x: tileCenter(gateTx, tile), y: tileCenter(gateTy, tile) };

  // The zones live west of the entrance band the plaza reserved.
  const eastLimit = plaza.reservedRect.x0;

  // 3. Biome zones (replaces the rigid avenue grid).
  const zones = partitionZones(h, eastLimit, rng);

  // 4. River (the water feature) meanders down the wetland zone. riverDeep tracks
  //    every solid water tile so reach targets + paths stay clear of the bed.
  const riverDeep = new Set<number>();
  const wetland = zones.find((z) => z.id === 'wetland');
  if (wetland) carveRiver(ground, wetland, riverDeep, rng);

  // 5. Species → home assignment. Roster is shuffled deterministically (keeps the
  //    same rng draw as before — one shuffle here), but each species is PLACED in
  //    its fixed zone via a deterministic free-rect scan, so homes cluster by biome
  //    while still varying per seed.
  const speciesOrder = shuffle(rng, [...SPECIES_KEYS]);

  const buildings: Building[] = [plaza.gatehouse]; // gatehouse first (species-less)
  const housing: Housing[] = [];
  const reserved = new Set<number>(); // tiles nature must avoid (homes + halos)
  const claimed = new Set<number>(); // tiles already taken by a home (placement)
  // Reserve the plaza footprint so enclosure placement + nature stay out of it.
  for (let ty = plaza.reservedRect.y0; ty <= plaza.reservedRect.y1; ty++) {
    for (let tx = plaza.reservedRect.x0; tx <= plaza.reservedRect.x1; tx++) {
      claimed.add(tileIndex(w, tx, ty));
      reserved.add(tileIndex(w, tx, ty));
    }
  }
  const reachTargets: { tx: number; ty: number }[] = [];
  const questPos = new Map<string, { tx: number; ty: number }>();
  const animalSpots = new Map<string, AnimalSpot[]>(); // per species: NPC animal slots
  // The gatehouse door must be reachable (the reachability test iterates every
  // building). Its west door opens onto the forecourt → the gate.
  reachTargets.push({ tx: plaza.gatehouse.doorTx, ty: plaza.gatehouse.doorTy });

  for (let i = 0; i < speciesOrder.length; i++) {
    const species = speciesOrder[i];
    const kind = SPECIES_HOUSING[species];
    const zone = zoneFor(zones, species);

    // Varied footprint: jitter w/h, but keep interior ≥6×6 (CRIT-2 containment —
    // a smaller box collapses the wander bias zone and freezes animals). Two rng
    // draws per species, unconditionally, so the stream is fixed.
    const tw = 8 + randInt(rng, 0, 3); // 8..11 → interior 6..9
    const th = 8 + randInt(rng, 0, 2); // 8..10 → interior 6..8

    // Find a free rect in the species' zone; fall back to any zone, then to a
    // coarse interior scan, so placement never silently drops a species.
    let plot = findFreeRect(zone, tw, th, claimed, w);
    if (!plot) {
      for (const z of zones) {
        plot = findFreeRect(z, tw, th, claimed, w);
        if (plot) break;
      }
    }
    if (!plot) {
      // Last resort: smallest viable home anywhere west of the entrance band.
      const anyZone: Zone = { id: 'savanna', tx: 2, ty: 2, tw: eastLimit - 2, th: h - 5, cx: 0, cy: 0 };
      plot = findFreeRect(anyZone, 8, 8, claimed, w);
    }
    if (!plot) {
      // No room for this species' home after all fallbacks. This would silently
      // break the one-home-per-species invariant the parity test relies on, so
      // FAIL LOUD instead (mirrors the reachability-non-convergence throw below).
      // Unreachable at 128² with 14 homes ≤ 11×10 each, but enforced not assumed.
      throw new Error(`generateWorld(${seed}): no room to place a home for "${species}"`);
    }

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
    claimPlot(claimed, plot, w);
    // Reserve the whole plot footprint so nature doesn't intrude.
    for (let dy = -1; dy <= plot.th; dy++) {
      for (let dx = -1; dx <= plot.tw; dx++) {
        reserved.add(tileIndex(w, plot.tx + dx, plot.ty + dy));
      }
    }
    for (const rt of placed.reachTargets) reachTargets.push(rt);
    questPos.set(species, { tx: placed.questTx, ty: placed.questTy });

    // Phase C: pick this home's NPC-animal spawn slots NOW (interior is fully
    // stamped, rng is in roster order → one shuffle per home, fixed stream). The
    // home rect is the housing rect, or the building's interior wall ring.
    const rect = placed.housing
      ? { rx: placed.housing.rx, ry: placed.housing.ry, rw: placed.housing.rw, rh: placed.housing.rh }
      : placed.building
        ? { rx: placed.building.rx, ry: placed.building.ry, rw: placed.building.rw, rh: placed.building.rh }
        : null;
    if (rect) {
      // Total animals = animalCountFor (2..3); animal 1 is the canonical pen anchor
      // at the home center, so we need (n-1) EXTRA interior slots here.
      const n = animalCountFor(rect.rw - 2, rect.rh - 2);
      animalSpots.set(species, populateEnclosure(ground, deco, rect, placed.questTx, placed.questTy, n - 1, tile, rng));
    }
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

  // 6. Organic path network: a winding spine through the zone centers + the gate
  //    spur, plus a spur from each enclosure gate to the nearest spine tile so
  //    every home is path-connected before the reachability backstop runs. Bridges
  //    span the river where a path meets both banks. `junctions` (forecourt + zone
  //    centers) anchor the terminals + robot spawns (replacing the old avenues).
  const { junctions } = carveOrganicPaths(ground, zones, forecourt, gateTx, riverDeep, rng);
  // The robot patrol loop in world units: the junctions in carve order. Robots are
  // anchored at these exact junctions (see robotSpawn specs below), so each spawns
  // on its route; walking them in order traces the carved spine. tileCenter matches
  // the transform used to place the robots/terminals, so the route lands on pavement.
  const patrolRoute = junctions.map((j) => ({ x: tileCenter(j.tx, tile), y: tileCenter(j.ty, tile) }));
  // Spur each home's gate/door reach target to the spine (deterministic; draws rng
  // inside carveWindingPath). reachTargets[0] of each home is its gate/door tile.
  for (const rt of reachTargets) {
    carveWindingPath(ground, riverDeep, rt.tx, rt.ty, forecourt.tx, forecourt.ty, rng);
  }
  bridgeRiverCrossings(ground, riverDeep);

  // 7. Scatter nature on the leftover grass.
  scatterNature(ground, deco, w, h, reserved, rng);

  // 8. Entity specs. Build in a FIXED order so JSON.stringify is stable.
  const entitySpecs: WorldEntitySpec[] = [];
  entitySpecs.push({ id: 'gate-1', kind: 'gate', x: gate.x, y: gate.y });

  // The disguise prop (Clipboard) near the first spawn.
  const propTile = spawnTiles[0] ?? { tx: gateTx - 2, ty: gateTy };
  entitySpecs.push({ id: 'prop-1', kind: 'prop', x: tileCenter(propTile.tx, tile), y: tileCenter(propTile.ty, tile) });

  // Terminals at path junctions (forecourt + zone centers). The junction order is
  // fixed by carveOrganicPaths, so this is deterministic. One terminal per
  // junction after the forecourt (the forecourt itself is the spawn area, no
  // terminal there) — up to 4, matching the old count.
  let tnum = 0;
  for (let j = 1; j < junctions.length && tnum < 4; j++) {
    const jp = junctions[j];
    tnum++;
    entitySpecs.push({ id: `terminal-${tnum}`, kind: 'terminal', x: tileCenter(jp.tx, tile), y: tileCenter(jp.ty, tile) });
  }

  // Robot spawns: spread across the path junctions (non-solid spine tiles). Anchor
  // one per zone center plus the forecourt, deterministically, so keepers patrol
  // the avenues between zones. Up to 6, matching the old count.
  let rnum = 0;
  for (let j = 0; j < junctions.length && rnum < 6; j++) {
    const jp = junctions[j];
    rnum++;
    entitySpecs.push({ id: `robot-${rnum}`, kind: 'robotSpawn', x: tileCenter(jp.tx, tile), y: tileCenter(jp.ty, tile) });
  }
  // Top up to 6 robots with extra anchors near the busiest junctions so the keeper
  // count is preserved even though we have fewer junctions than the old 6 avenues.
  for (let j = 1; j < junctions.length && rnum < 6; j++) {
    const jp = junctions[j];
    rnum++;
    const off = 3; // a few tiles off the junction along the spine
    entitySpecs.push({
      id: `robot-${rnum}`,
      kind: 'robotSpawn',
      x: tileCenter(clampInt(jp.tx + off, 2, w - 3), tile),
      y: tileCenter(jp.ty, tile),
    });
  }

  // Pen anchors (decoy spawn points) + quest objects, one per species, in roster
  // order so the list is stable. A pen anchor uses the home center; for buildings
  // (no Housing) we anchor on the quest tile inside.
  for (const species of SPECIES_KEYS) {
    const home = housing.find((hh) => hh.species === species);
    const qp = questPos.get(species);
    if (!qp) continue; // species without a placed plot (shouldn't happen with 14 plots)
    // The CANONICAL pen anchor (id `pen-${species}`) stays exactly as before — the
    // home center for housing, the quest tile for a building. It is the species'
    // primary decoy animal (the test counts homes/quests, never penAnchors).
    const kindMeta = home ? home.kind : 'building';
    const anchorX = home ? home.cx : tileCenter(qp.tx, tile);
    const anchorY = home ? home.cy : tileCenter(qp.ty, tile);
    if (home || buildings.find((bb) => bb.species === species)) {
      entitySpecs.push({
        id: `pen-${species}`,
        kind: 'penAnchor',
        x: anchorX,
        y: anchorY,
        species,
        meta: { kind: kindMeta },
      });
      // Phase C: extra NPC animals (pen-${species}-2..N) at the populateEnclosure
      // slots, so each enclosure reads as inhabited. One penAnchor per slot; the
      // server materializes each via the SAME penAnchor case (no new spec kind).
      // animalCountFor already capped the total at 2..3, so we emit (n-1) extras.
      const spots = animalSpots.get(species) ?? [];
      let an = 1;
      for (const spot of spots) {
        an++;
        entitySpecs.push({
          id: `pen-${species}-${an}`,
          kind: 'penAnchor',
          x: spot.x,
          y: spot.y,
          species,
          meta: { kind: kindMeta },
        });
        if (an >= 3) break; // hard cap: at most 3 animals/home (1 canonical + 2)
      }
    }
    // Food source: one per species, co-located with the quest object on the same
    // already-proven-reachable home tile (so all 14 foods are findable + reachable
    // with NO new reachability target). Emitted at a FIXED position in the loop
    // (penAnchor → foodSource → questObject) so JSON.stringify(entitySpecs) is
    // stable. We push only the SPEC here; the on-map TROUGH_FOOD marker tile is
    // stamped AFTER the reachability carve (below) so the carve can't erase it.
    entitySpecs.push({
      id: `food-${species}`,
      kind: 'foodSource',
      x: tileCenter(qp.tx, tile),
      y: tileCenter(qp.ty, tile),
      species,
      meta: { foodKey: foodForSpecies(species).key },
    });
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

  // 9. Food-source markers (animal-collection feature): stamp the TROUGH_FOOD tile
  //    AFTER the reachability carve so no corridor carve can erase it, and explicitly
  //    KEEP the cell non-solid (force collision = 0) — TROUGH_FOOD is normally solid,
  //    but a feeder must be able to stand on the food tile to collect. Deterministic:
  //    fixed SPECIES_KEYS order, no rng, co-located with the questObject tile (already
  //    proven reachable; the only deco/collision discrepancy, confined to 14 tiles).
  for (const species of SPECIES_KEYS) {
    const qp = questPos.get(species);
    if (!qp) continue;
    const fi = tileIndex(w, qp.tx, qp.ty);
    deco.data[fi] = TILE_INDEX.TROUGH_FOOD; // visual feeding-spot marker
    collision[fi] = 0; // override TROUGH_FOOD solidity — the tile stays walkable
  }

  // 10. Tile-style accuracy: feather grass↔path and grass↔water seams with the blend
  //     tiles (25-48). Runs AFTER the carve (so fallback corridors blend too) and
  //     after the food stamp — it only rewrites GRASS ground cells, never the deco
  //     TROUGH_FOOD markers or collision, so the two passes are independent.
  blendGroundEdges(ground);

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
    patrolRoute,
  };
}
