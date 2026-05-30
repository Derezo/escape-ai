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
 *  a fresh bump, not max(7,5).
 *  v9: additive `patrolRoute` field (robot patrol loop) on WorldMap.
 *  v10: AUXILIARY service buildings (commissary / washroom / maintenance) added, and
 *  the 14 food sources RELOCATED out of animal housing onto the aux buildings'
 *  interior walls; each aux building also emits a guard robot + a door-terminal spec.
 *  Collision + entitySpecs both change, so both pinned hashes are re-pinned.
 *  v11: drops the door-terminals (food is freely collectable now) and round-robins the
 *  14 food sources across the 3 aux buildings (was all in the first one).
 *  v12: trees are now a 2×2 crown over a center-bottom trunk (was single-canopy-over-
 *  trunk). The trunk moves from (anchor+1) to the anchor cell, so the collision grid
 *  shifts where tree trunks sit → collision hash re-pinned. entitySpecs unchanged.
 *  v13: zoo overhaul — BRIDGE tiles + enhanced tile art (roofs/walls/water/fences/
 *  nature/props) + rewritten zoo placement (pens/paths/gates/pond/river/buildings,
 *  unused tiles wired in). Both pinned hashes re-pinned. */
export const WORLD_GEN_VERSION = 13;

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

/**
 * The kinds of AUXILIARY (service) building the zoo lays out — domed-megacity
 * facilities (Caves of Steel flavor) that hold the dispersed food sources rather
 * than the animal housing. Stable set; positions/sizes jitter per seed.
 */
export type AuxKind = 'commissary' | 'washroom' | 'maintenance';

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
  /**
   * For AUXILIARY service buildings (commissary / washroom / maintenance) that
   * hold the relocated food sources. Undefined for species homes + the gatehouse.
   * The door is a normal non-solid DOOR_OPEN tile (so reachability holds); food
   * inside is freely collectable. Carried on the seed-derived map (zero wire cost;
   * the server reads map.buildings directly).
   */
  auxKind?: AuxKind;
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

/**
 * The fixed AUXILIARY service buildings the zoo lays out (stable set; only their
 * positions/sizes jitter per seed). Each holds a block of the relocated food
 * sources along its interior walls, a guard robot, and a terminal-gated door. The
 * `zonePrefs` are the NON-WETLAND zones this building prefers (in order); aux
 * buildings stay OUT of the wetland so their south door never lands on/adjacent to
 * the river (the deep-water reach-target invariant iterates building doors). The
 * footprint is generous (interior >= 8x6) so ~5 wall food slots + a guard anchor
 * fit without colliding. Floor is fixed per kind (no rng) for a stable read.
 */
interface AuxBuildingDef {
  kind: AuxKind;
  floor: number;
  /** Footprint incl. wall ring; interior is (tw-2)x(th-2) >= 8x6. */
  tw: number;
  th: number;
  /** Preferred zones (never 'wetland'); first that fits wins. */
  zonePrefs: ZoneId[];
}
const AUX_BUILDINGS: AuxBuildingDef[] = [
  { kind: 'commissary', floor: TILE_INDEX.FLOOR_TILE, tw: 11, th: 8, zonePrefs: ['savanna', 'aviary', 'forest', 'rockyDen'] },
  { kind: 'washroom', floor: TILE_INDEX.FLOOR_CONCRETE, tw: 10, th: 8, zonePrefs: ['aviary', 'rockyDen', 'forest', 'savanna'] },
  { kind: 'maintenance', floor: TILE_INDEX.FLOOR_CONCRETE, tw: 11, th: 8, zonePrefs: ['rockyDen', 'forest', 'savanna', 'aviary'] },
];

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
  // edge (and thus never an enclosure or the wall). A 5-wide band: a 2-tile WATER_
  // SHALLOW margin on each side wraps a 1-wide WATER_DEEP core, so even as the
  // channel meanders ±1 per row the deep core stays surrounded (8-neighbour) by
  // water — enforceWaterCohesion then never has to demote the core, keeping the
  // river a real deep barrier instead of an all-shallow puddle.
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
    // 2-wide shallow shore on each side (walkable) + a deep core tile (solid).
    setTile(ground, col - 2, ty, TILE_INDEX.WATER_SHALLOW);
    setTile(ground, col - 1, ty, TILE_INDEX.WATER_SHALLOW);
    setTile(ground, col + 1, ty, TILE_INDEX.WATER_SHALLOW);
    setTile(ground, col + 2, ty, TILE_INDEX.WATER_SHALLOW);
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
  protectedTiles: Set<number>,
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
  // SMOOTHING: the cross-axis wobble is only APPLIED every other step (the rng is
  // still drawn EVERY step, so the deterministic draw count is unchanged), so the
  // walkway curves gently in 2-tile runs instead of sawtoothing ±1 every tile —
  // it reads as a deliberate zoo path, not striations.
  let step = 0;
  const pave = (px: number, py: number) => {
    const i = tileIndex(w, px, py);
    if (riverDeep.has(i)) return; // don't pave the river bed; bridges handle crossings
    if (protectedTiles.has(i)) return; // never pave over a pen/building footprint
    setTile(ground, px, py, road);
  };
  if (horizontal) {
    const stepX = tx >= fx ? 1 : -1;
    while (x !== tx) {
      const wob = randInt(rng, -1, 1) + (y < ty ? 1 : y > ty ? -1 : 0);
      // Apply the wobble only on even steps; on odd steps just keep converging
      // toward the target line. Halves the wiggle frequency → smoother path.
      if (step % 2 === 0) y = clampInt(y + (wob < -1 ? -1 : wob > 1 ? 1 : wob), 1, ground.h - 2);
      else if (y !== ty) y = clampInt(y + (y < ty ? 1 : -1), 1, ground.h - 2);
      x += stepX;
      step++;
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
      if (step % 2 === 0) x = clampInt(x + (wob < -1 ? -1 : wob > 1 ? 1 : wob), 1, w - 2);
      else if (x !== tx) x = clampInt(x + (x < tx ? 1 : -1), 1, w - 2);
      y += stepY;
      step++;
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
  protectedTiles: Set<number>,
  rng: () => number,
): { junctions: Junction[] } {
  const road = TILE_INDEX.PAVED;
  // Gate spur: straight PAVED run from the gate gap to the forecourt root (kept
  // straight + 3-wide so the entrance is unambiguous and always road-connected).
  // The plaza band is reserved (no homes there), so no protection check is needed.
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
    carveWindingPath(ground, riverDeep, protectedTiles, a.tx, a.ty, b.tx, b.ty, rng);
  }

  const junctions: Junction[] = [forecourt, ...zones.map((z) => ({ tx: z.cx, ty: z.cy }))];
  // Force-pave each junction tile (and a small plus) so a terminal/robot anchored
  // there always sits on a walkable tile — even if a zone center landed on the
  // river bed (the junction becomes a bridge). Drops bridged tiles from riverDeep.
  // A junction can land INSIDE a home (a zone center may fall on a pen). To keep the
  // pen path-free, never pave a protected footprint cell; instead RELOCATE the
  // junction outward (spiralling deterministically) to the nearest non-protected
  // tile so its anchor/patrol waypoint stays walkable without clobbering the pen.
  for (const j of junctions) {
    if (protectedTiles.has(tileIndex(ground.w, j.tx, j.ty))) {
      // Deterministic outward search (increasing Chebyshev radius, fixed scan order)
      // for a non-protected, in-bounds tile to host this junction.
      let moved = false;
      for (let r = 1; r <= 12 && !moved; r++) {
        for (let dy = -r; dy <= r && !moved; dy++) {
          for (let dx = -r; dx <= r && !moved; dx++) {
            if (Math.abs(dx) !== r && Math.abs(dy) !== r) continue; // ring only
            const px = clampInt(j.tx + dx, 1, ground.w - 2);
            const py = clampInt(j.ty + dy, 1, ground.h - 2);
            if (protectedTiles.has(tileIndex(ground.w, px, py))) continue;
            j.tx = px;
            j.ty = py;
            moved = true;
          }
        }
      }
    }
    for (const [dx, dy] of [[0, 0], [1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const px = clampInt(j.tx + dx, 1, ground.w - 2);
      const py = clampInt(j.ty + dy, 1, ground.h - 2);
      if (protectedTiles.has(tileIndex(ground.w, px, py))) continue;
      setTile(ground, px, py, road);
      riverDeep.delete(tileIndex(ground.w, px, py));
    }
  }
  return { junctions };
}

/**
 * Lay BRIDGE tiles where the path net wants to cross the river: any deep-water tile
 * with PAVED on opposite sides (E+W or N+S) is a place a winding path ran up to the
 * bank on both shores — deck it with a walkable BRIDGE tile (chosen by orientation)
 * so the crossing reads as an intentional bridge instead of bare PAVED, and the
 * reachability fallback never has to carve an ugly road across open water.
 *
 * Orientation contract (from tiles.ts / the bridge builders): BRIDGE_H spans an
 * E-W path over N-S water (the river runs vertically here, the path crosses going
 * east-west → PAVED on the E+W sides); BRIDGE_V spans a N-S path over E-W water.
 * The flanking shore tiles the path already paved at the crossing row/column are
 * re-decked to the same bridge tile so the whole span reads as one deck.
 *
 * Pure (no rng), row-major over the snapshot. The decked tile leaves `riverDeep`
 * (it's a non-solid BRIDGE now), so buildCollision treats it as walkable.
 */
function bridgeRiverCrossings(ground: TileGrid, riverDeep: Set<number>): void {
  const w = ground.w;
  const road = TILE_INDEX.PAVED;
  const isWalk = (tx: number, ty: number): boolean => {
    const idx = ground.data[tileIndex(w, tx, ty)];
    return idx === road || idx === TILE_INDEX.WATER_SHALLOW || idx === TILE_INDEX.BRIDGE_H || idx === TILE_INDEX.BRIDGE_V;
  };
  const isPaved = (tx: number, ty: number) => ground.data[tileIndex(w, tx, ty)] === road;
  // Snapshot to an array first: insertion order (fixed row-major from carveRiver)
  // so the scan is deterministic, and we mutate the set inside the loop.
  for (const i of [...riverDeep]) {
    const tx = i % w;
    const ty = (i - tx) / w;
    const ew = isPaved(tx - 1, ty) && isPaved(tx + 1, ty);
    const ns = isPaved(tx, ty - 1) && isPaved(tx, ty + 1);
    if (!ew && !ns) continue;
    // EW crossing (path runs east-west over the N-S river) → BRIDGE_H; otherwise a
    // N-S path over an E-W stretch → BRIDGE_V. EW wins ties (the river is N-S here).
    const deck = ew ? TILE_INDEX.BRIDGE_H : TILE_INDEX.BRIDGE_V;
    setTile(ground, tx, ty, deck);
    riverDeep.delete(i);
    // Re-deck the flanking shore tiles the path already crossed so the span reads as
    // one continuous bridge (only where they are walkable path/shore, not dry land).
    if (ew) {
      if (isWalk(tx - 1, ty)) setTile(ground, tx - 1, ty, deck);
      if (isWalk(tx + 1, ty)) setTile(ground, tx + 1, ty, deck);
    } else {
      if (isWalk(tx, ty - 1)) setTile(ground, tx, ty - 1, deck);
      if (isWalk(tx, ty + 1)) setTile(ground, tx, ty + 1, deck);
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
 * (n/e/s/ww) and 4 diagonal neighbours (ne/se/sw/nw) are of `target` class. Outer
 * corner (two adjacent edges) > straight edge > inner corner (a single diagonal,
 * orthogonals clear → a concave notch where grass pokes into the region). Returns
 * 0 to leave the cell unchanged (opposite edges N+S, all-four, or a fully isolated
 * cell — those read fine as base grass).
 */
function pickBlendTile(
  target: 'path' | 'water',
  n: boolean,
  e: boolean,
  s: boolean,
  ww: boolean,
  ne: boolean,
  se: boolean,
  sw: boolean,
  nw: boolean,
): number {
  const P = TILE_INDEX;
  const E = target === 'path'
    ? { N: P.PATH_EDGE_N, E: P.PATH_EDGE_E, S: P.PATH_EDGE_S, W: P.PATH_EDGE_W,
        CNE: P.PATH_CORNER_NE, CNW: P.PATH_CORNER_NW, CSE: P.PATH_CORNER_SE, CSW: P.PATH_CORNER_SW,
        INE: P.PATH_ICORNER_NE, INW: P.PATH_ICORNER_NW, ISE: P.PATH_ICORNER_SE, ISW: P.PATH_ICORNER_SW }
    : { N: P.WATER_EDGE_N, E: P.WATER_EDGE_E, S: P.WATER_EDGE_S, W: P.WATER_EDGE_W,
        CNE: P.WATER_CORNER_NE, CNW: P.WATER_CORNER_NW, CSE: P.WATER_CORNER_SE, CSW: P.WATER_CORNER_SW,
        INE: P.WATER_ICORNER_NE, INW: P.WATER_ICORNER_NW, ISE: P.WATER_ICORNER_SE, ISW: P.WATER_ICORNER_SW };
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
  // Inner (concave) corners: no orthogonal target, exactly one diagonal of target.
  // The cell is a grass nub jutting into the region; the ICORNER tile rounds it.
  if (!n && !e && !s && !ww) {
    if (ne && !se && !sw && !nw) return E.INE;
    if (se && !ne && !sw && !nw) return E.ISE;
    if (sw && !ne && !se && !nw) return E.ISW;
    if (nw && !ne && !se && !sw) return E.INW;
  }
  return 0; // opposite pair, all-four, or ambiguous diagonals → leave as grass
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
        const ne = at(tx + 1, ty - 1) === target;
        const se = at(tx + 1, ty + 1) === target;
        const sw = at(tx - 1, ty + 1) === target;
        const nw = at(tx - 1, ty - 1) === target;
        if (!n && !e && !s && !ww && !ne && !se && !sw && !nw) continue;
        const blend = pickBlendTile(target, n, e, s, ww, ne, se, sw, nw);
        if (blend) {
          data[ty * w + tx] = blend;
          break; // path wins; don't also water-blend this cell
        }
      }
    }
  }
}

/** Whether a ground tile index counts as WATER for the cohesion/edge passes. */
function isWaterIndex(idx: number): boolean {
  return (
    idx === TILE_INDEX.WATER_DEEP ||
    idx === TILE_INDEX.WATER_SHALLOW ||
    idx === TILE_INDEX.POND_DEEP ||
    idx === TILE_INDEX.POND_EDGE
  );
}

/** Whether a ground tile index is DEEP (solid) water. */
function isDeepWaterIndex(idx: number): boolean {
  return idx === TILE_INDEX.WATER_DEEP || idx === TILE_INDEX.POND_DEEP;
}

/**
 * Enforce the water-cohesion invariant over the WHOLE ground grid: every DEEP water
 * tile must be surrounded (8-neighbour) ONLY by water — any DEEP tile that touches
 * a non-water tile (grass/dirt/path/floor) is demoted to WATER_SHALLOW so a deep
 * core always wears a shallow margin and never meets dry land directly. Pure (no
 * rng), snapshot-based so demotions don't cascade within a single pass; iterated to
 * a fixed point (each pass can only demote, so it terminates). Used after the river
 * and the pond are carved so both obey "deep only beside shallow".
 */
function enforceWaterCohesion(ground: TileGrid): void {
  const { w, h, data } = ground;
  for (;;) {
    const demote: number[] = [];
    for (let ty = 0; ty < h; ty++) {
      for (let tx = 0; tx < w; tx++) {
        const i = ty * w + tx;
        if (!isDeepWaterIndex(data[i])) continue;
        let touchesDry = false;
        for (let dy = -1; dy <= 1 && !touchesDry; dy++) {
          for (let dx = -1; dx <= 1 && !touchesDry; dx++) {
            if (dx === 0 && dy === 0) continue;
            const nx = tx + dx;
            const ny = ty + dy;
            // Out of bounds reads as the (solid) world wall, not water — but the
            // deep cores never reach the border, so this only matters defensively.
            if (nx < 0 || ny < 0 || nx >= w || ny >= h) {
              touchesDry = true;
              break;
            }
            if (!isWaterIndex(data[ny * w + nx])) touchesDry = true;
          }
        }
        if (touchesDry) demote.push(i);
      }
    }
    if (demote.length === 0) break;
    for (const i of demote) {
      data[i] = data[i] === TILE_INDEX.POND_DEEP ? TILE_INDEX.POND_EDGE : TILE_INDEX.WATER_SHALLOW;
    }
  }
}

/**
 * Feather a fenced pond's interior shore: any NON-water interior cell that borders
 * shallow water gets the matching WATER_EDGE / CORNER / ICORNER tile so the
 * rounded pond reads with proper shoreline tiles (blendGroundEdges only feathers
 * GRASS cells, and the pond floor margin is PEN floor inside a fence ring, so it is
 * handled here). Operates only within the given interior rect. Pure (no rng),
 * snapshot-based. `floorIdx` is the margin floor the edge tiles replace.
 */
function blendPondShore(
  ground: TileGrid,
  ix0: number,
  iy0: number,
  ix1: number,
  iy1: number,
  floorIdx: number,
): void {
  const { w, data } = ground;
  const isShallow = (tx: number, ty: number): boolean => {
    if (tx < ix0 || ty < iy0 || tx > ix1 || ty > iy1) return false;
    return data[ty * w + tx] === TILE_INDEX.WATER_SHALLOW;
  };
  const writes: { i: number; v: number }[] = [];
  for (let ty = iy0; ty <= iy1; ty++) {
    for (let tx = ix0; tx <= ix1; tx++) {
      const i = ty * w + tx;
      if (data[i] !== floorIdx) continue; // only feather the dry margin floor
      const n = isShallow(tx, ty - 1);
      const e = isShallow(tx + 1, ty);
      const s = isShallow(tx, ty + 1);
      const ww = isShallow(tx - 1, ty);
      const ne = isShallow(tx + 1, ty - 1);
      const se = isShallow(tx + 1, ty + 1);
      const sw = isShallow(tx - 1, ty + 1);
      const nw = isShallow(tx - 1, ty - 1);
      if (!n && !e && !s && !ww && !ne && !se && !sw && !nw) continue;
      const blend = pickBlendTile('water', n, e, s, ww, ne, se, sw, nw);
      if (blend) writes.push({ i, v: blend });
    }
  }
  for (const wr of writes) data[wr.i] = wr.v;
}

/** A gate cell that must be (re)stamped with a walkable gate tile after carving. */
interface GateStamp {
  tx: number;
  ty: number;
  tile: number;
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
  /**
   * Visible gate/door cells (the enclosure gate, the building door) that must be
   * RE-STAMPED after the reachability carve — `carveCorridor` zeros deco on the
   * cells it touches, which would erase the FENCE_GATE / CAGE_GATE / DOOR_OPEN
   * marker. Re-stamping (like TROUGH_FOOD) keeps the gate VISIBLE while leaving the
   * cell non-solid + reachable. Empty for homes whose gate is never a carve cell.
   */
  gateStamps: GateStamp[];
}

/**
 * Stamp a building SHELL into a `rw×rh` rect at (rx,ry): a DIRECTIONAL exterior
 * wall ring (corner glyphs on the four corners, *_END caps where a run would end,
 * WALL_EXT_MID on the straight runs), interior floor, and a DIRECTIONAL hip roof
 * (corner glyphs on roof corners, edge glyphs on the roof perimeter, a RIDGE down
 * the centre with a PEAK at its midpoint, ROOF_RED_MID for the field). WINDOWs are
 * punched into the long walls. Shared by stampBuilding + stampAuxBuilding so both
 * read as proper buildings, not flat squares. Pure (no rng); the door + interior
 * dressing are the caller's job.
 */
function stampBuildingShell(
  ground: TileGrid,
  deco: TileGrid,
  roof: TileGrid,
  rx: number,
  ry: number,
  rw: number,
  rh: number,
  floor: number,
): void {
  const P = TILE_INDEX;
  for (let dy = 0; dy < rh; dy++) {
    for (let dx = 0; dx < rw; dx++) {
      const tx = rx + dx;
      const ty = ry + dy;
      const left = dx === 0;
      const right = dx === rw - 1;
      const top = dy === 0;
      const bot = dy === rh - 1;
      const edge = left || right || top || bot;
      if (edge) {
        // Corners get the matching directional corner; straight runs get MID.
        let wall = P.WALL_EXT_MID;
        if (top && left) wall = P.WALL_EXT_CORNER_NW;
        else if (top && right) wall = P.WALL_EXT_CORNER_NE;
        else if (bot && left) wall = P.WALL_EXT_CORNER_SW;
        else if (bot && right) wall = P.WALL_EXT_CORNER_SE;
        setTile(deco, tx, ty, wall);
      } else {
        setTile(ground, tx, ty, floor);
        // Directional hip roof: corners → CORNER, perimeter → EDGE, a central
        // RIDGE line (with a PEAK at the middle) → RIDGE/PEAK, else field MID.
        const ir = dx === 1; // first interior column
        const il = dx === rw - 2; // last interior column
        const it = dy === 1; // first interior row
        const ib = dy === rh - 2; // last interior row
        const ridgeRow = dy === Math.floor(rh / 2);
        let r = P.ROOF_RED_MID;
        if (it && ir) r = P.ROOF_RED_CORNER_NW;
        else if (it && il) r = P.ROOF_RED_CORNER_NE;
        else if (ib && ir) r = P.ROOF_RED_CORNER_SW;
        else if (ib && il) r = P.ROOF_RED_CORNER_SE;
        else if (it) r = P.ROOF_RED_EDGE_N;
        else if (ib) r = P.ROOF_RED_EDGE_S;
        else if (ir) r = P.ROOF_RED_EDGE_W;
        else if (il) r = P.ROOF_RED_EDGE_E;
        else if (ridgeRow) r = dx === Math.floor(rw / 2) ? P.ROOF_PEAK : P.ROOF_RIDGE;
        setTile(roof, tx, ty, r);
      }
    }
  }
  // WINDOWs punched into the side walls (W + E), one per wall, kept off the corners.
  const winRow = ry + Math.floor(rh / 2);
  setTile(deco, rx, winRow, P.WINDOW);
  setTile(deco, rx + rw - 1, winRow, P.WINDOW);
  // A WINDOW on the north wall flanking the centre (off the corners).
  if (rw >= 6) setTile(deco, rx + 1, ry, P.WINDOW);
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

  stampBuildingShell(ground, deco, roof, rx, ry, rw, rh, floor);

  // Door on the south wall, road-facing, walkable. TWO tiles wide (64px) so the
  // player's collision AABB (radius ~13) passes through comfortably — a 1-tile
  // gap leaves only ~6px clearance and is effectively impassable. A CLOSED door
  // flanks the open pair so the entrance reads as a real doorway, not a gap.
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
    // Re-stamp the 2-wide DOOR_OPEN threshold after the reachability carve so a
    // corridor open() can't blank the doorway deco.
    gateStamps: [
      { tx: doorTx, ty: doorTy, tile: TILE_INDEX.DOOR_OPEN },
      { tx: doorTx - 1, ty: doorTy, tile: TILE_INDEX.DOOR_OPEN },
    ],
  };
}

/** What stampAuxBuilding hands back: the Building, its center, and the ordered
 *  interior wall-slot tiles food sources are placed on (a fixed traversal → the
 *  food→slot assignment is byte-stable). */
interface PlacedAux {
  building: Building;
  /** Walkable interior center tile (the guard-robot anchor). */
  centerTx: number;
  centerTy: number;
  /** Interior tiles adjacent to the wall ring, in a FIXED traversal order (north
   *  wall L→R, then east, south, west), each a food-source slot. No rng. */
  wallSlots: { tx: number; ty: number }[];
}

/**
 * Stamp an AUXILIARY service building (commissary / washroom / maintenance) into a
 * plot: wall ring + per-kind floor + fade-on-enter roof + a 2-wide DOOR_OPEN south
 * door + a little dressing. Mirrors stampBuilding's geometry but is SPECIES-LESS
 * (carries auxKind instead) and does NOT stamp food — the generator stamps the
 * TROUGH_FOOD markers onto the returned wallSlots AFTER the reachability carve.
 *
 * The door is a normal non-solid DOOR_OPEN tile so reachability holds; food inside
 * is freely collectable. Pure except the floor is fixed per kind (no rng here) — the
 * only rng aux placement spends is findFreeRect (none) so this function draws ZERO
 * rng, keeping the stream shift confined to the plot scan.
 */
function stampAuxBuilding(
  ground: TileGrid,
  deco: TileGrid,
  roof: TileGrid,
  plot: Plot,
  def: AuxBuildingDef,
): PlacedAux {
  const rx = plot.tx;
  const ry = plot.ty;
  const rw = Math.min(plot.tw, def.tw);
  const rh = Math.min(plot.th, def.th);

  // Directional walls + hip roof + windows (same shell as the species buildings).
  stampBuildingShell(ground, deco, roof, rx, ry, rw, rh, def.floor);

  // 2-wide DOOR_OPEN south door (matches stampBuilding so the player AABB fits).
  const doorTx = rx + Math.floor(rw / 2);
  const doorTy = ry + rh - 1;
  setTile(deco, doorTx, doorTy, TILE_INDEX.DOOR_OPEN);
  setTile(deco, doorTx - 1, doorTy, TILE_INDEX.DOOR_OPEN);
  setTile(roof, doorTx, doorTy, 0);
  setTile(roof, doorTx - 1, doorTy, 0);

  // Light dressing in two interior corners (BENCH/CRATE flavor); kept off the wall
  // slots that hold food (top-left + top-right corners are slot 0 / first east run,
  // so dress the BOTTOM corners instead).
  setTile(deco, rx + 1, ry + rh - 2, TILE_INDEX.BENCH);
  setTile(deco, rx + rw - 2, ry + rh - 2, TILE_INDEX.CRATE);

  const centerTx = rx + Math.floor(rw / 2);
  const centerTy = ry + Math.floor(rh / 2);

  // Interior wall-slot tiles: the ring of interior cells adjacent to the wall, in a
  // FIXED clockwise-then-back traversal (north row L→R, east column top→bottom,
  // south row R→L, west column bottom→top), skipping the door threshold cells, the
  // dressing corners, and the center (guard anchor). Deterministic; no rng. Yields
  // >= 14 slots for an 8x6+ interior so the 3 buildings together cover all 14 foods.
  const ix0 = rx + 1;
  const iy0 = ry + 1;
  const ix1 = rx + rw - 2;
  const iy1 = ry + rh - 2;
  const skip = new Set<number>();
  skip.add(tileIndex(ground.w, doorTx, doorTy - 1)); // inside the door
  skip.add(tileIndex(ground.w, doorTx - 1, doorTy - 1));
  skip.add(tileIndex(ground.w, rx + 1, ry + rh - 2)); // BENCH
  skip.add(tileIndex(ground.w, rx + rw - 2, ry + rh - 2)); // CRATE
  skip.add(tileIndex(ground.w, centerTx, centerTy)); // guard anchor
  const wallSlots: { tx: number; ty: number }[] = [];
  const push = (tx: number, ty: number) => {
    if (tx < ix0 || tx > ix1 || ty < iy0 || ty > iy1) return;
    if (skip.has(tileIndex(ground.w, tx, ty))) return;
    skip.add(tileIndex(ground.w, tx, ty)); // dedupe corners shared between runs
    wallSlots.push({ tx, ty });
  };
  for (let tx = ix0; tx <= ix1; tx++) push(tx, iy0); // north
  for (let ty = iy0; ty <= iy1; ty++) push(ix1, ty); // east
  for (let tx = ix1; tx >= ix0; tx--) push(tx, iy1); // south
  for (let ty = iy1; ty >= iy0; ty--) push(ix0, ty); // west

  const building: Building = {
    id: `aux-${def.kind}`,
    rx,
    ry,
    rw,
    rh,
    doorTx,
    doorTy,
    auxKind: def.kind,
  };
  return { building, centerTx, centerTy, wallSlots };
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

  // Interior floor by kind. A pond's interior starts as a SAND beach margin; the
  // rounded water body (shallow ring + deep core + shoreline edges) is carved into
  // it below so the pond reads as a body of water sitting in a sandy enclosure
  // rather than a square tub of shallow water.
  const interiorFloor =
    kind === 'pond'
      ? TILE_INDEX.SAND
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

  // Perimeter barrier tiles by kind, with DIRECTIONAL pieces so the fence reads as
  // a continuous connected rectangle: H pieces on the N/S runs, V pieces on the
  // W/E runs, the matching corner piece in each of the four corners. Cages use the
  // CAGE bars (H/V) + a single CAGE_CORNER glyph for all four corners; aviaries use
  // the mesh (non-directional art) but still get the directional pass for
  // consistency; paddocks keep the low enclosure wall. The continuous ring is what
  // makes the gate read as the one intentional opening.
  const cage = kind === 'cage';
  const aviary = kind === 'aviary';
  const paddock = kind === 'paddock';
  // Edge tiles: [horizontal-run tile, vertical-run tile].
  const hBar = cage
    ? TILE_INDEX.CAGE_BARS_H
    : aviary
      ? TILE_INDEX.AVIARY_MESH
      : paddock
        ? TILE_INDEX.ENCLOSURE_WALL_LOW
        : TILE_INDEX.FENCE_H;
  const vBar = cage
    ? TILE_INDEX.CAGE_BARS_V
    : aviary
      ? TILE_INDEX.AVIARY_MESH
      : paddock
        ? TILE_INDEX.ENCLOSURE_WALL_LOW
        : TILE_INDEX.FENCE_V;
  // Corner pieces: fences have 4 distinct corners; cages share one CAGE_CORNER; the
  // aviary/paddock barriers have no corner art so reuse their edge tile.
  const cNW = cage ? TILE_INDEX.CAGE_CORNER : aviary ? TILE_INDEX.AVIARY_MESH : paddock ? TILE_INDEX.ENCLOSURE_WALL_LOW : TILE_INDEX.FENCE_CORNER_NW;
  const cNE = cage ? TILE_INDEX.CAGE_CORNER : aviary ? TILE_INDEX.AVIARY_MESH : paddock ? TILE_INDEX.ENCLOSURE_WALL_LOW : TILE_INDEX.FENCE_CORNER_NE;
  const cSW = cage ? TILE_INDEX.CAGE_CORNER : aviary ? TILE_INDEX.AVIARY_MESH : paddock ? TILE_INDEX.ENCLOSURE_WALL_LOW : TILE_INDEX.FENCE_CORNER_SW;
  const cSE = cage ? TILE_INDEX.CAGE_CORNER : aviary ? TILE_INDEX.AVIARY_MESH : paddock ? TILE_INDEX.ENCLOSURE_WALL_LOW : TILE_INDEX.FENCE_CORNER_SE;
  const barrierGate = cage ? TILE_INDEX.CAGE_GATE : aviary ? TILE_INDEX.KEEPER_GATE : TILE_INDEX.FENCE_GATE;

  // North + south runs (horizontal bars); skip the 4 corners (stamped after).
  for (let dx = 1; dx < rw - 1; dx++) {
    setTile(deco, rx + dx, ry, hBar);
    setTile(deco, rx + dx, ry + rh - 1, hBar);
  }
  // West + east runs (vertical bars); skip the 4 corners.
  for (let dy = 1; dy < rh - 1; dy++) {
    setTile(deco, rx, ry + dy, vBar);
    setTile(deco, rx + rw - 1, ry + dy, vBar);
  }
  // Four corners (orientation named by which two walls they join).
  setTile(deco, rx, ry, cNW);
  setTile(deco, rx + rw - 1, ry, cNE);
  setTile(deco, rx, ry + rh - 1, cSW);
  setTile(deco, rx + rw - 1, ry + rh - 1, cSE);

  // Two-tile-wide opening (64px) so the player's collision AABB fits through. The
  // gate tiles are RE-STAMPED after the reachability carve (gateStamps) so the
  // corridor open() can't erase them; here we stamp them once so the deco reads
  // right pre-carve and so collision is correct (gate tiles are non-solid).
  setTile(deco, gateTx, gateTy, barrierGate);
  setTile(deco, gateTx - 1, gateTy, barrierGate);

  const reachTargets: { tx: number; ty: number }[] = [
    { tx: gateTx, ty: gateTy },
    { tx: ccx, ty: ccy },
  ];
  const gateStamps: GateStamp[] = [
    { tx: gateTx, ty: gateTy, tile: barrierGate },
    { tx: gateTx - 1, ty: gateTy, tile: barrierGate },
  ];

  if (kind === 'pond') {
    // A LARGE ROUNDED pond: an elliptical body of water carved into the SAND beach
    // interior, with a WATER_SHALLOW margin ring around a WATER_DEEP centre. The
    // shape is an integer ellipse (no trig — bit-stable on both V8s), centred on the
    // interior, sized to fill most of the enclosure while leaving a sandy shore.
    const ix0 = rx + 1;
    const iy0 = ry + 1;
    const ix1 = rx + rw - 2;
    const iy1 = ry + rh - 2;
    const pcx = rx + Math.floor(rw / 2);
    const pcy = ry + Math.floor(rh / 2);
    // Ellipse half-axes: fill the interior minus a 1-tile sand shore on each side.
    const ax = Math.max(2, Math.floor((rw - 2) / 2) - 1); // half-width in tiles
    const ay = Math.max(2, Math.floor((rh - 2) / 2) - 1); // half-height in tiles
    // Normalised integer ellipse test, scaled by 1000 to stay in ints. A cell is in
    // the WATER body when (dx/ax)^2 + (dy/ay)^2 <= 1; the DEEP core uses a tighter
    // ratio (~0.45) so a full shallow ring always wraps the deep centre.
    const SCALE = 1000;
    const ellipse = (dx: number, dy: number): number => {
      const ex = ax > 0 ? Math.floor((dx * dx * SCALE) / (ax * ax)) : SCALE * 2;
      const ey = ay > 0 ? Math.floor((dy * dy * SCALE) / (ay * ay)) : SCALE * 2;
      return ex + ey; // <= SCALE → inside the water body
    };
    const DEEP_RATIO = Math.floor(SCALE * 0.45); // tighter core
    for (let ty = iy0; ty <= iy1; ty++) {
      for (let tx = ix0; tx <= ix1; tx++) {
        const e = ellipse(tx - pcx, ty - pcy);
        if (e <= DEEP_RATIO) {
          setTile(ground, tx, ty, TILE_INDEX.WATER_DEEP);
        } else if (e <= SCALE) {
          setTile(ground, tx, ty, TILE_INDEX.WATER_SHALLOW);
        }
        // else: leave the SAND beach margin.
      }
    }
    // Shore tiles: feather the sand margin where it borders shallow water into the
    // matching WATER_EDGE_*/CORNER_*/ICORNER_* tile (proper rounded edges).
    blendPondShore(ground, ix0, iy0, ix1, iy1, TILE_INDEX.SAND);
    // Deep-only-beside-shallow: demote any DEEP tile that touches a non-water cell
    // (incl. the freshly-written shore edge tiles, which are non-water) to shallow,
    // so the deep core is always wrapped by a shallow margin.
    enforceWaterCohesion(ground);
    // Water dressing on the shallow ring (non-blocking flora): lily pad + flower on
    // the pond, cattails/reeds on the shore. Placed deterministically near the rim.
    setTile(deco, clampInt(pcx - ax + 1, ix0, ix1), pcy, TILE_INDEX.LILY_PAD);
    setTile(deco, clampInt(pcx + ax - 1, ix0, ix1), pcy, TILE_INDEX.LILY_FLOWER);
    setTile(deco, pcx, clampInt(pcy - ay, iy0, iy1), TILE_INDEX.CATTAILS);
    setTile(deco, pcx, clampInt(pcy + ay, iy0, iy1), TILE_INDEX.REEDS);
    // The reach target (= housing center + quest tile) is the NW interior CORNER —
    // sandy beach, guaranteed non-water and (being the farthest interior cell from
    // the centred deep core) never adjacent to deep water, satisfying the
    // no-reach-target-beside-deep-water invariant.
    reachTargets[1] = { tx: ix0, ty: iy0 };
  } else if (kind === 'den') {
    // A rocky den cluster with a walkable mouth at the center.
    setTile(deco, ccx - 1, ccy, TILE_INDEX.ROCKY_DEN_WALL);
    setTile(deco, ccx + 1, ccy, TILE_INDEX.ROCKY_DEN_WALL);
    setTile(deco, ccx, ccy - 1, TILE_INDEX.ROCKY_DEN_WALL);
    setTile(deco, ccx, ccy, TILE_INDEX.BURROW_MOUND); // walkable den mound = reach target
    // A spare burrow mound + a water trough in the den corners (off the reach tile).
    setTile(deco, rx + 1, ry + 1, TILE_INDEX.BURROW_MOUND);
    setTile(deco, rx + rw - 2, ry + 1, TILE_INDEX.TROUGH_WATER);
  } else if (kind === 'aviary') {
    // Aviary dressing: a nest + a water trough in the upper corners (off center).
    setTile(deco, rx + 1, ry + 1, TILE_INDEX.NEST);
    setTile(deco, rx + rw - 2, ry + 1, TILE_INDEX.TROUGH_WATER);
  } else {
    // Pen / paddock dressing: hay + food/water troughs in the corners, off the
    // center reach tile (ccx,ccy) so the decoy/anchor stays walkable.
    setTile(deco, rx + 1, ry + 1, TILE_INDEX.TROUGH_FOOD);
    setTile(deco, rx + rw - 2, ry + 1, TILE_INDEX.HAY_BALE);
    setTile(deco, rx + 1, ry + rh - 2, TILE_INDEX.TROUGH_WATER);
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
    gateStamps,
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

/** Whether tile (tx,ty) is inside the named zone's rect. */
function inZone(zone: Zone | undefined, tx: number, ty: number): boolean {
  if (!zone) return false;
  return tx >= zone.tx && tx < zone.tx + zone.tw && ty >= zone.ty && ty < zone.ty + zone.th;
}

/** Whether any 4-neighbour of (tx,ty) is shallow/deep water (a shoreline cell). */
function nearWater(ground: TileGrid, w: number, tx: number, ty: number): boolean {
  for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
    const idx = ground.data[tileIndex(w, tx + dx, ty + dy)];
    if (idx === TILE_INDEX.WATER_SHALLOW || idx === TILE_INDEX.WATER_DEEP) return true;
  }
  return false;
}

/** Whether any 4-neighbour of (tx,ty) is a paved/cobble path (a roadside cell). */
function nearPath(ground: TileGrid, w: number, tx: number, ty: number): boolean {
  for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
    const idx = ground.data[tileIndex(w, tx + dx, ty + dy)];
    if (idx === TILE_INDEX.PAVED || idx === TILE_INDEX.PAVED_CRACK || idx === TILE_INDEX.COBBLE || idx === TILE_INDEX.COBBLE_WORN) return true;
  }
  return false;
}

/**
 * Scatter trees / bushes / rocks / flowers on remaining open grass, with a coarse
 * occupancy grid for minimum spacing so they don't clump. Deterministic via rng;
 * never placed on roads, structures, housing, or reserved tiles.
 *
 * BIOME-AWARE richness (uses the otherwise-unused tiles): in the FOREST zone trees
 * become PINEs and the litter pass adds STUMP/LOG/MUSHROOM/GRASS_TALL/ROCK_SM/
 * ROCK_FLAT; shoreline grass gets CATTAILS/LILY_FLOWER; and a final ROADSIDE pass
 * dresses grass next to the main paths with BENCH/LAMP_POST/SIGN_ARROW/TRASH_BIN/
 * BUSH_TRIMMED/FLOWER_BED. Roadside props sit on grass ADJACENT to a path, never on
 * the path itself, so the 2-wide walkways stay clear (the reachability carve also
 * runs after and clears anything that would block a required target).
 */
function scatterNature(
  ground: TileGrid,
  deco: TileGrid,
  w: number,
  h: number,
  reserved: Set<number>,
  zones: Zone[],
  rng: () => number,
): void {
  const forest = zones.find((z) => z.id === 'forest');
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
    const inForest = inZone(forest, tx, ty);
    const shoreline = nearWater(ground, w, tx, ty);
    const roll = rng();
    if (shoreline && roll < 0.6) {
      // Waterside flora (non-solid): cattails / a lily flower on the bank.
      setTile(deco, tx, ty, pick(rng, [TILE_INDEX.CATTAILS, TILE_INDEX.LILY_FLOWER, TILE_INDEX.GRASS_TALL]));
      occupied.add(idx);
    } else if (roll < 0.45) {
      // Tree: a full canopy crown at (tx,ty) over a trunk at (tx,ty+1). In the
      // FOREST zone it's a PINE; elsewhere a broadleaf. Trunk solid; canopy 'behind'.
      if (ty + 1 >= h - 1 || !isOpenGrass(ground, deco, tx, ty + 1)) continue;
      if (occupied.has(tileIndex(w, tx, ty + 1))) continue;
      if (inForest) {
        setTile(deco, tx, ty, TILE_INDEX.PINE_CANOPY);
        setTile(deco, tx, ty + 1, TILE_INDEX.PINE_TRUNK);
      } else {
        setTile(deco, tx, ty, TILE_INDEX.TREE_CANOPY);
        setTile(deco, tx, ty + 1, TILE_INDEX.TREE_TRUNK);
      }
      markOccupied(tx, ty);
    } else if (roll < 0.7) {
      if (inForest) {
        // Forest litter: a mix of walkable + solid woodland detail.
        setTile(deco, tx, ty, pick(rng, [TILE_INDEX.STUMP, TILE_INDEX.LOG, TILE_INDEX.MUSHROOM, TILE_INDEX.GRASS_TALL, TILE_INDEX.BUSH_BERRY]));
      } else {
        setTile(deco, tx, ty, pick(rng, [TILE_INDEX.BUSH_SM, TILE_INDEX.BUSH_LG, TILE_INDEX.BUSH_BERRY]));
      }
      markOccupied(tx, ty);
    } else if (roll < 0.85) {
      if (inForest) {
        setTile(deco, tx, ty, pick(rng, [TILE_INDEX.ROCK_SM, TILE_INDEX.ROCK_FLAT, TILE_INDEX.ROCK_LG, TILE_INDEX.BOULDER]));
      } else {
        setTile(deco, tx, ty, pick(rng, [TILE_INDEX.ROCK_LG, TILE_INDEX.BOULDER]));
      }
      markOccupied(tx, ty);
    } else {
      setTile(deco, tx, ty, pick(rng, [TILE_INDEX.FLOWER_RED, TILE_INDEX.FLOWER_YELLOW, TILE_INDEX.FLOWER_BLUE]));
      // Flowers are non-solid detail — looser spacing.
      occupied.add(idx);
    }
  }

  // ROADSIDE props: a second deterministic pass dressing grass cells that sit NEXT
  // to a main path (never on it), spaced out so they read as deliberate zoo
  // furniture. Uses the props the entrance plaza otherwise monopolised.
  const PROPS = [
    TILE_INDEX.BENCH,
    TILE_INDEX.LAMP_POST,
    TILE_INDEX.SIGN_ARROW,
    TILE_INDEX.TRASH_BIN,
    TILE_INDEX.BUSH_TRIMMED,
    TILE_INDEX.FLOWER_BED,
  ];
  const PROP_TRIES = 240;
  for (let n = 0; n < PROP_TRIES; n++) {
    const tx = randInt(rng, 2, w - 3);
    const ty = randInt(rng, 2, h - 3);
    const idx = tileIndex(w, tx, ty);
    if (occupied.has(idx) || reserved.has(idx)) continue;
    if (!isOpenGrass(ground, deco, tx, ty)) continue;
    if (!nearPath(ground, w, tx, ty)) continue;
    setTile(deco, tx, ty, pick(rng, PROPS));
    markOccupied(tx, ty);
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
  // Every cell that belongs to a pen/building FOOTPRINT (interior + wall ring). The
  // path carver NEVER paves a protected cell, so pens stay path-free (no cobble
  // inside an enclosure) and a winding spine that grazes a home routes around it.
  const protectedTiles = new Set<number>();
  // Gate/door cells to RE-STAMP after the reachability carve (carveCorridor zeros
  // deco on the cells it touches, which would erase a gate/door glyph). Collected
  // from every home + aux building; replayed after the carve like TROUGH_FOOD.
  const gateStamps: GateStamp[] = [];
  /** Mark a stamped home rect [rx,ry,rw,rh] as protected from path paving. */
  const protectRect = (rx: number, ry: number, rw: number, rh: number): void => {
    for (let dy = 0; dy < rh; dy++) {
      for (let dx = 0; dx < rw; dx++) {
        protectedTiles.add(tileIndex(w, rx + dx, ry + dy));
      }
    }
  };
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
      if (placed.building) {
        buildings.push(placed.building);
        protectRect(placed.building.rx, placed.building.ry, placed.building.rw, placed.building.rh);
      }
    } else {
      placed = stampHousing(ground, deco, plot, species, kind);
      if (placed.housing) {
        placed.housing.cx = tileCenter(placed.centerTx, tile);
        placed.housing.cy = tileCenter(placed.centerTy, tile);
        housing.push(placed.housing);
        protectRect(placed.housing.rx, placed.housing.ry, placed.housing.rw, placed.housing.rh);
      }
    }
    // Re-stamp the gate/door glyphs after the carve so the corridor can't erase them.
    for (const gs of placed.gateStamps) gateStamps.push(gs);
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

  // 5b. AUXILIARY service buildings (commissary / washroom / maintenance). These
  //     are SPECIES-LESS (auxKind only) so the one-home-per-species invariant holds;
  //     they hold the relocated food sources along their interior walls, plus a
  //     guard robot + a terminal-gated door (wired in the entitySpecs block). Placed
  //     AFTER all homes (so findFreeRect avoids them) and BEFORE the spawn block.
  //     stampAuxBuilding draws NO rng, but findFreeRect/claim consume none either —
  //     so the only stream effect here is none directly; the downstream re-pin comes
  //     from the new homes/nature interplay. Each kept OUT of the wetland zone so its
  //     south door never lands on/adjacent to the river (deep-water reach invariant).
  const auxPlaced: PlacedAux[] = [];
  for (const def of AUX_BUILDINGS) {
    const prefs = def.zonePrefs.filter((id) => id !== 'wetland');
    let plot: Plot | null = null;
    for (const id of prefs) {
      const z = zones.find((zz) => zz.id === id);
      if (z) plot = findFreeRect(z, def.tw, def.th, claimed, w);
      if (plot) break;
    }
    if (!plot) {
      // Fallback: any non-wetland zone that can fit it.
      for (const z of zones) {
        if (z.id === 'wetland') continue;
        plot = findFreeRect(z, def.tw, def.th, claimed, w);
        if (plot) break;
      }
    }
    if (!plot) {
      // Last resort: a smaller footprint anywhere non-wetland (interior still >= 6×6).
      for (const z of zones) {
        if (z.id === 'wetland') continue;
        plot = findFreeRect(z, 9, 8, claimed, w);
        if (plot) break;
      }
    }
    if (!plot) {
      throw new Error(`generateWorld(${seed}): no room to place aux building "${def.kind}"`);
    }
    const aux = stampAuxBuilding(ground, deco, roof, plot, def);
    auxPlaced.push(aux);
    buildings.push(aux.building);
    protectRect(aux.building.rx, aux.building.ry, aux.building.rw, aux.building.rh);
    // Re-stamp the aux door glyph after the carve (same as the species buildings).
    gateStamps.push({ tx: aux.building.doorTx, ty: aux.building.doorTy, tile: TILE_INDEX.DOOR_OPEN });
    gateStamps.push({ tx: aux.building.doorTx - 1, ty: aux.building.doorTy, tile: TILE_INDEX.DOOR_OPEN });
    claimPlot(claimed, plot, w);
    for (let dy = -1; dy <= plot.th; dy++) {
      for (let dx = -1; dx <= plot.tw; dx++) {
        reserved.add(tileIndex(w, plot.tx + dx, plot.ty + dy));
      }
    }
    // The door must be reachable from spawn.
    reachTargets.push({ tx: aux.building.doorTx, ty: aux.building.doorTy });
  }

  // Food → aux-building wall-slot assignment (DETERMINISTIC). Iterate the UNSHUFFLED
  // SPECIES_KEYS and hand each species the next free wall slot, walking the aux
  // buildings in their fixed AUX_BUILDINGS order (contiguous blocks). The result is a
  // total species→tile map the entitySpecs loop reads, so JSON.stringify(entitySpecs)
  // is byte-stable. Buildings together yield >= 14 slots (each interior >= 8×6).
  const foodPos = new Map<string, { tx: number; ty: number; buildingId: string; auxKind: AuxKind }>();
  {
    // ROUND-ROBIN across the buildings (not a flat concat) so the 14 foods SPREAD
    // ~evenly (≈5/5/4) instead of all landing in the first building whose wall ring
    // is big enough to hold 14. Each building keeps its own next-free-slot cursor;
    // species i goes to building (i % nBuildings), taking that building's next slot.
    // Deterministic + unshuffled SPECIES_KEYS order, so the spec ordering is stable.
    const nBld = auxPlaced.length;
    const cursor = new Array(nBld).fill(0);
    const totalSlots = auxPlaced.reduce((n, aux) => n + aux.wallSlots.length, 0);
    if (totalSlots < SPECIES_KEYS.length) {
      throw new Error(
        `generateWorld(${seed}): aux buildings yielded ${totalSlots} food slots, need ${SPECIES_KEYS.length}`,
      );
    }
    SPECIES_KEYS.forEach((species, i) => {
      // Pick the next building in round-robin that still has a free slot (skip any
      // that filled up — won't happen at 14 foods / 3 buildings, but keeps it total).
      let b = i % nBld;
      for (let n = 0; n < nBld && cursor[b] >= auxPlaced[b].wallSlots.length; n++) {
        b = (b + 1) % nBld;
      }
      const aux = auxPlaced[b];
      const s = aux.wallSlots[cursor[b]++];
      const slot = { tx: s.tx, ty: s.ty, buildingId: aux.building.id, auxKind: aux.building.auxKind! };
      foodPos.set(species, slot);
      // Each food slot is a reach target so the interior food is guaranteed walkable
      // + reachable on every seed.
      reachTargets.push({ tx: slot.tx, ty: slot.ty });
    });
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
  // tile just inside the gate.
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
      // Last-resort tile just inside the gate. The widen loop above found nothing
      // non-solid, so this tile may itself be solid — carve it walkable here (the
      // same idiom the corridor/reachability carve uses) so the spawn is non-solid
      // by construction, not merely by relying on the later reachability pass.
      const sx = clampInt(gateTx - SPAWN_INSET, 2, w - 3);
      const i = tileIndex(w, sx, gateTy);
      if (isSolidIndex(deco.data[i]) || isSolidIndex(ground.data[i])) {
        deco.data[i] = 0;
        setTile(ground, sx, gateTy, TILE_INDEX.PAVED);
      }
      spawns.push({ x: tileCenter(sx, tile), y: tileCenter(gateTy, tile) });
      spawnTiles.push({ tx: sx, ty: gateTy });
    }
  }

  // 6. Organic path network: a winding spine through the zone centers + the gate
  //    spur, plus a spur from each enclosure gate to the nearest spine tile so
  //    every home is path-connected before the reachability backstop runs. Bridges
  //    span the river where a path meets both banks. `junctions` (forecourt + zone
  //    centers) anchor the terminals + robot spawns (replacing the old avenues).
  const { junctions } = carveOrganicPaths(ground, zones, forecourt, gateTx, riverDeep, protectedTiles, rng);
  // The robot patrol loop in world units: the junctions in carve order. Robots are
  // anchored at these exact junctions (see robotSpawn specs below), so each spawns
  // on its route; walking them in order traces the carved spine. tileCenter matches
  // the transform used to place the robots/terminals, so the route lands on pavement.
  const patrolRoute = junctions.map((j) => ({ x: tileCenter(j.tx, tile), y: tileCenter(j.ty, tile) }));
  // Spur each home's gate/door reach target to the spine (deterministic; draws rng
  // inside carveWindingPath). reachTargets[0] of each home is its gate/door tile.
  // protectedTiles keeps these spurs from paving back over a pen/building footprint.
  for (const rt of reachTargets) {
    carveWindingPath(ground, riverDeep, protectedTiles, rt.tx, rt.ty, forecourt.tx, forecourt.ty, rng);
  }
  bridgeRiverCrossings(ground, riverDeep);
  // Water cohesion: every DEEP tile must wear a shallow margin. The river + pond are
  // carved wide enough to satisfy this, but path paving near a bank can leave a deep
  // tile touching pavement — demote any such tile to shallow (deep-only-beside-
  // shallow). Run before buildCollision so collision reflects the final water.
  enforceWaterCohesion(ground);

  // 7. Scatter nature on the leftover grass (biome-aware; uses the unused tiles).
  scatterNature(ground, deco, w, h, reserved, zones, rng);

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
  // Guard robots: one per aux building, anchored at the building interior center.
  // Emitted AFTER the patrol robots (so robot-1..6 stay byte-identical) in fixed
  // AUX_BUILDINGS order. meta.guard flags the server to contain it to the building
  // (behavior='guard') rather than send it out on the patrol loop.
  for (const aux of auxPlaced) {
    entitySpecs.push({
      id: `robot-guard-${aux.building.auxKind}`,
      kind: 'robotSpawn',
      x: tileCenter(aux.centerTx, tile),
      y: tileCenter(aux.centerTy, tile),
      meta: { guard: '1', buildingId: aux.building.id, auxKind: aux.building.auxKind! },
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
    // Food source: one per species, now DISPERSED into the auxiliary buildings
    // (commissary / washroom / maintenance) along their interior walls — NOT in the
    // animal's own housing. foodPos holds the deterministic species→wall-slot tile
    // (assigned from unshuffled SPECIES_KEYS). Emitted at a FIXED position in the loop
    // (penAnchor → foodSource → questObject) so JSON.stringify(entitySpecs) is stable.
    // We push only the SPEC here; the on-map TROUGH_FOOD marker is stamped AFTER the
    // reachability carve (below). meta carries the foodKey + the owning aux building
    // (informational; food is freely collectable).
    const fp = foodPos.get(species)!;
    entitySpecs.push({
      id: `food-${species}`,
      kind: 'foodSource',
      x: tileCenter(fp.tx, tile),
      y: tileCenter(fp.ty, tile),
      species,
      meta: { foodKey: foodForSpecies(species).key, buildingId: fp.buildingId, auxKind: fp.auxKind },
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
  //    onto each aux-building wall slot AFTER the reachability carve so no corridor
  //    carve can erase it, and explicitly KEEP the cell non-solid (force collision = 0)
  //    — TROUGH_FOOD is normally solid, but a feeder must be able to stand on the food
  //    tile to collect. Deterministic: fixed SPECIES_KEYS order, no rng, on the
  //    foodPos wall-slot tile (already added to reachTargets → proven reachable; the
  //    only deco/collision discrepancy, confined to 14 tiles inside the aux buildings).
  for (const species of SPECIES_KEYS) {
    const fp = foodPos.get(species);
    if (!fp) continue;
    const fi = tileIndex(w, fp.tx, fp.ty);
    deco.data[fi] = TILE_INDEX.TROUGH_FOOD; // visual feeding-spot marker
    collision[fi] = 0; // override TROUGH_FOOD solidity — the tile stays walkable
  }

  // 9b. Gate/door markers: RE-STAMP every enclosure gate + building door glyph AFTER
  //     the reachability carve (carveCorridor zeros deco on the cells it touches, so
  //     a gate/door cell that a corridor ran through would otherwise be blanked). All
  //     gate/door tiles are NON-SOLID, so force collision = 0 to keep the cell
  //     walkable. Deterministic: fixed insertion order, no rng. The gate is now both
  //     VISIBLE in the deco layer and passable, on every seed.
  for (const gs of gateStamps) {
    const gi = tileIndex(w, gs.tx, gs.ty);
    deco.data[gi] = gs.tile;
    collision[gi] = 0;
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
