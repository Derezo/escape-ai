/**
 * Determinism + reachability gate for the deterministic zoo world generator.
 *
 * This is the client/server PARITY tripwire: the server generates the world from
 * a seed and ships ONLY the seed; every client regenerates the identical world.
 * If generateWorld's output ever drifts, the pinned hashes below trip — forcing a
 * conscious WORLD_GEN_VERSION bump rather than a silent desync between sides.
 *
 * Zero new deps: Node's built-in test runner over the COMPILED dist. Run with
 * `npm test` (which builds first). Uses the shared FNV-1a hash32 so the pin is
 * the same byte-stable hash the rest of the codebase trusts.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { generateWorld, worldToTile, tileSolid } from '../dist/world.js';
import { hash32 } from '../dist/step.js';
import { SPECIES_KEYS } from '../dist/species.js';
import { TILE_INDEX } from '../dist/tiles.js';

// --- Pinned values (regenerate intentionally + bump WORLD_GEN_VERSION if these
// must change; they are computed from generateWorld(123)). -------------------
const PIN_SEED = 123;
const PINNED_COLLISION_HASH = 3073572579;
const PINNED_ENTITYSPEC_HASH = 3800431151;

/** Hash the collision grid bytes (the cross-side movement-parity surface). */
function collisionHash(map) {
  return hash32(Array.from(map.collision).join(','));
}

/** Deterministic 4-neighbour flood fill over non-solid tiles, mirroring the
 *  generator's own invariant check (independent reimplementation = real test). */
function floodReachable(map, sx, sy) {
  const { w, h, collision } = map;
  const seen = new Uint8Array(w * h);
  const start = sy * w + sx;
  if (sx < 0 || sy < 0 || sx >= w || sy >= h || collision[start] === 1) return seen;
  const queue = [start];
  seen[start] = 1;
  while (queue.length) {
    const cur = queue.shift();
    const cx = cur % w;
    const cy = (cur - cx) / w;
    const neighbours = [
      cx + 1 < w ? cur + 1 : -1,
      cx - 1 >= 0 ? cur - 1 : -1,
      cy + 1 < h ? cur + w : -1,
      cy - 1 >= 0 ? cur - w : -1,
    ];
    for (const nb of neighbours) {
      if (nb < 0 || seen[nb] || collision[nb] === 1) continue;
      seen[nb] = 1;
      queue.push(nb);
    }
  }
  return seen;
}

const tx = (map, wx) => worldToTile(wx, map.tile);

test('determinism: two runs of the same seed are byte-identical', () => {
  const a = generateWorld(PIN_SEED);
  const b = generateWorld(PIN_SEED);
  assert.equal(a.collision.length, b.collision.length, 'collision lengths match');
  assert.deepEqual(Array.from(a.collision), Array.from(b.collision), 'collision bytes identical');
  assert.equal(
    JSON.stringify(a.entitySpecs),
    JSON.stringify(b.entitySpecs),
    'entitySpecs identical across runs',
  );
});

test('drift tripwire: pinned hashes (bump WORLD_GEN_VERSION if these change)', () => {
  const map = generateWorld(PIN_SEED);
  assert.equal(
    collisionHash(map),
    PINNED_COLLISION_HASH,
    'collision grid drifted — client/server parity broken; re-pin + bump version on purpose',
  );
  assert.equal(
    hash32(JSON.stringify(map.entitySpecs)),
    PINNED_ENTITYSPEC_HASH,
    'entitySpecs drifted — re-pin + bump WORLD_GEN_VERSION on purpose',
  );
});

test('coverage: every species has exactly one home and exactly one quest object', () => {
  const map = generateWorld(PIN_SEED);
  const housingSpecies = map.housing.map((hh) => hh.species);
  const buildingSpecies = map.buildings.map((b) => b.species).filter((s) => s != null);
  const homeCounts = new Map();
  for (const s of [...housingSpecies, ...buildingSpecies]) {
    homeCounts.set(s, (homeCounts.get(s) ?? 0) + 1);
  }
  const questCounts = new Map();
  for (const e of map.entitySpecs) {
    if (e.kind === 'questObject') questCounts.set(e.species, (questCounts.get(e.species) ?? 0) + 1);
  }
  for (const key of SPECIES_KEYS) {
    assert.equal(homeCounts.get(key), 1, `species ${key} should have exactly one home`);
    assert.equal(questCounts.get(key), 1, `species ${key} should have exactly one quest object`);
  }
  // No stray homes/quests for non-roster keys.
  assert.equal(homeCounts.size, SPECIES_KEYS.length, 'no extra homes beyond the roster');
  assert.equal(questCounts.size, SPECIES_KEYS.length, 'no extra quest objects beyond the roster');
});

test('validity: gate and every spawn sit on non-solid tiles; exactly one gate spec', () => {
  const map = generateWorld(PIN_SEED);
  assert.ok(
    !tileSolid(map.collision, map.w, map.h, tx(map, map.gate.x), tx(map, map.gate.y)),
    'gate tile is non-solid',
  );
  assert.ok(map.spawns.length >= 1, 'at least one spawn');
  for (const s of map.spawns) {
    assert.ok(
      !tileSolid(map.collision, map.w, map.h, tx(map, s.x), tx(map, s.y)),
      `spawn (${s.x},${s.y}) is non-solid`,
    );
  }
  const gateSpecs = map.entitySpecs.filter((e) => e.kind === 'gate');
  assert.equal(gateSpecs.length, 1, 'exactly one gate entity spec');
});

test('reachability: gate, every door, every housing center and every quest object are reachable from spawn', () => {
  const map = generateWorld(PIN_SEED);
  const s0 = map.spawns[0];
  const seen = floodReachable(map, tx(map, s0.x), tx(map, s0.y));
  const reach = (cx, cy) => !!seen[cy * map.w + cx];

  assert.ok(reach(tx(map, map.gate.x), tx(map, map.gate.y)), 'gate reachable');

  for (const b of map.buildings) {
    assert.ok(reach(b.doorTx, b.doorTy), `building ${b.species} door reachable`);
  }
  for (const hh of map.housing) {
    assert.ok(reach(tx(map, hh.cx), tx(map, hh.cy)), `housing ${hh.species} center reachable`);
  }
  for (const e of map.entitySpecs) {
    if (e.kind === 'questObject') {
      assert.ok(reach(tx(map, e.x), tx(map, e.y)), `quest object ${e.species} reachable`);
    }
  }
  for (const s of map.spawns) {
    assert.ok(reach(tx(map, s.x), tx(map, s.y)), 'spawn reachable from spawn[0]');
  }
});

test('reachability holds across several seeds (not just the pinned one)', () => {
  for (const seed of [0, 1, 2, 7, 777, 9999, 424242]) {
    const map = generateWorld(seed);
    const s0 = map.spawns[0];
    const seen = floodReachable(map, tx(map, s0.x), tx(map, s0.y));
    const reach = (cx, cy) => !!seen[cy * map.w + cx];
    assert.ok(reach(tx(map, map.gate.x), tx(map, map.gate.y)), `seed ${seed}: gate reachable`);
    for (const b of map.buildings) {
      assert.ok(reach(b.doorTx, b.doorTy), `seed ${seed}: door ${b.species} reachable`);
    }
    for (const hh of map.housing) {
      assert.ok(reach(tx(map, hh.cx), tx(map, hh.cy)), `seed ${seed}: center ${hh.species} reachable`);
    }
    for (const e of map.entitySpecs) {
      if (e.kind === 'questObject') {
        assert.ok(reach(tx(map, e.x), tx(map, e.y)), `seed ${seed}: quest ${e.species} reachable`);
      }
    }
  }
});

// --- Phase A (organic layout) invariants ------------------------------------

/** Tile index at a world-unit position via the map's ground grid. */
function groundAt(map, wx, wy) {
  const gx = tx(map, wx);
  const gy = tx(map, wy);
  if (gx < 0 || gy < 0 || gx >= map.w || gy >= map.h) return -1;
  return map.ground.data[gy * map.w + gx];
}

test('water feature: no reach target sits on or adjacent to deep water', () => {
  // The reachability flood-carve is a backstop that paves through anything (incl.
  // open water). To keep it from carving an ugly road across the river, the
  // generator must never place a REACH TARGET (gate / door / housing center /
  // quest object) on or next to a WATER_DEEP/POND_DEEP tile. Checked across seeds.
  const DEEP = new Set([TILE_INDEX.WATER_DEEP, TILE_INDEX.POND_DEEP]);
  const nearDeep = (map, wx, wy) => {
    const gx = tx(map, wx);
    const gy = tx(map, wy);
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        const x = gx + dx;
        const y = gy + dy;
        if (x < 0 || y < 0 || x >= map.w || y >= map.h) continue;
        if (DEEP.has(map.ground.data[y * map.w + x])) return true;
      }
    }
    return false;
  };
  for (const seed of [0, 1, 2, 7, 123, 777, 9999, 424242]) {
    const map = generateWorld(seed);
    const targets = [
      { name: 'gate', x: map.gate.x, y: map.gate.y },
      ...map.buildings.map((b) => ({ name: `door:${b.species}`, x: (b.doorTx + 0.5) * map.tile, y: (b.doorTy + 0.5) * map.tile })),
      ...map.housing.map((hh) => ({ name: `center:${hh.species}`, x: hh.cx, y: hh.cy })),
      ...map.entitySpecs.filter((e) => e.kind === 'questObject').map((e) => ({ name: `quest:${e.species}`, x: e.x, y: e.y })),
    ];
    for (const t of targets) {
      assert.ok(!nearDeep(map, t.x, t.y), `seed ${seed}: reach target ${t.name} is on/adjacent to deep water`);
      assert.ok(groundAt(map, t.x, t.y) !== TILE_INDEX.WATER_DEEP, `seed ${seed}: reach target ${t.name} is ON deep water`);
    }
  }
});

// --- Phase B (entrance plaza + tile accuracy) invariants ---------------------

test('entrance plaza: a species-less gatehouse building exists with a reachable, non-solid door', () => {
  for (const seed of [0, 7, 123, 9999]) {
    const map = generateWorld(seed);
    const gatehouses = map.buildings.filter((b) => b.species == null);
    assert.equal(gatehouses.length, 1, `seed ${seed}: exactly one species-less gatehouse`);
    const gh = gatehouses[0];
    // Door is non-solid (DOOR_OPEN) so the reachability test can reach it.
    assert.ok(
      !tileSolid(map.collision, map.w, map.h, gh.doorTx, gh.doorTy),
      `seed ${seed}: gatehouse door is non-solid`,
    );
    // Door reachable from spawn[0].
    const s0 = map.spawns[0];
    const seen = floodReachable(map, tx(map, s0.x), tx(map, s0.y));
    assert.ok(seen[gh.doorTy * map.w + gh.doorTx], `seed ${seed}: gatehouse door reachable from spawn`);
    // The escape gate is the single perimeter opening and is non-solid.
    assert.ok(
      !tileSolid(map.collision, map.w, map.h, tx(map, map.gate.x), tx(map, map.gate.y)),
      `seed ${seed}: gate tile non-solid`,
    );
  }
});

test('tile accuracy: every single-edge/corner grass border gets a blend tile (idempotent pass)', () => {
  // blendGroundEdges feathers a grass cell that borders a path/water region into
  // the matching edge/corner tile — EXCEPT the ambiguous configs it deliberately
  // leaves as base grass (target on OPPOSITE sides N+S or E+W, i.e. a 1-tile grass
  // sliver between two regions, which no single edge tile can represent). So: a
  // grass cell whose path/water neighbours form a single edge or an outer corner
  // MUST have been blended; only the opposite-pair / all-four slivers may remain.
  // This proves the pass is total over the cases it claims and thus idempotent
  // (re-running finds only the same ambiguous cells, which it leaves alone).
  const GRASS = new Set([
    TILE_INDEX.GRASS_A, TILE_INDEX.GRASS_B, TILE_INDEX.GRASS_C,
    TILE_INDEX.GRASS_FLOWERS, TILE_INDEX.GRASS_PATCHY,
  ]);
  const cls = (idx) => {
    if (idx === TILE_INDEX.PAVED || idx === TILE_INDEX.PAVED_CRACK || idx === TILE_INDEX.COBBLE || idx === TILE_INDEX.COBBLE_WORN) return 'path';
    if (idx === TILE_INDEX.WATER_DEEP || idx === TILE_INDEX.WATER_SHALLOW || idx === TILE_INDEX.POND_DEEP || idx === TILE_INDEX.POND_EDGE) return 'water';
    return 'grass';
  };
  for (const seed of [0, 1, 123, 777, 424242]) {
    const map = generateWorld(seed);
    const g = map.ground.data;
    for (let ty = 1; ty < map.h - 1; ty++) {
      for (let tx2 = 1; tx2 < map.w - 1; tx2++) {
        if (!GRASS.has(g[ty * map.w + tx2])) continue;
        for (const target of ['path', 'water']) {
          const n = cls(g[(ty - 1) * map.w + tx2]) === target;
          const s = cls(g[(ty + 1) * map.w + tx2]) === target;
          const ww = cls(g[ty * map.w + tx2 - 1]) === target;
          const e = cls(g[ty * map.w + tx2 + 1]) === target;
          // Single edge or outer corner → should have been blended (not plain grass).
          const singleEdge = (n && !s) || (s && !n) || (e && !ww) || (ww && !e);
          const outerCorner = (n && e) || (n && ww) || (s && e) || (s && ww);
          assert.ok(
            !(singleEdge || outerCorner),
            `seed ${seed}: plain grass at (${tx2},${ty}) borders ${target} on a single edge/corner — blend missed it`,
          );
        }
      }
    }
  }
});

// --- Phase C (per-pen NPC animals + containment) invariants ------------------

/** A species' home rect (housing or building), or null (e.g. the gatehouse). */
function homeRectOf(map, species) {
  const h = map.housing.find((hh) => hh.species === species);
  if (h) return { rx: h.rx, ry: h.ry, rw: h.rw, rh: h.rh };
  const b = map.buildings.find((bb) => bb.species === species);
  if (b) return { rx: b.rx, ry: b.ry, rw: b.rw, rh: b.rh };
  return null;
}

test('animals: every species gets 2–3 pen anchors (NPC animals), scaled', () => {
  for (const seed of [0, 7, 123, 9999, 424242]) {
    const map = generateWorld(seed);
    const counts = new Map();
    for (const e of map.entitySpecs) {
      if (e.kind === 'penAnchor') counts.set(e.species, (counts.get(e.species) ?? 0) + 1);
    }
    for (const key of SPECIES_KEYS) {
      const c = counts.get(key) ?? 0;
      assert.ok(c >= 2 && c <= 3, `seed ${seed}: species ${key} has ${c} animals (want 2..3)`);
    }
  }
});

test('animals: every pen anchor sits on a non-solid INTERIOR tile of its home (contained, off the gate row)', () => {
  for (const seed of [0, 1, 123, 777, 9999]) {
    const map = generateWorld(seed);
    for (const e of map.entitySpecs) {
      if (e.kind !== 'penAnchor') continue;
      const gx = tx(map, e.x);
      const gy = tx(map, e.y);
      // Non-solid (a robot/animal can stand here).
      assert.ok(!tileSolid(map.collision, map.w, map.h, gx, gy), `seed ${seed}: animal ${e.id} on a solid tile`);
      const rect = homeRectOf(map, e.species);
      assert.ok(rect, `seed ${seed}: ${e.species} has a home rect`);
      // Strictly INSIDE the wall ring (so the wander clamp keeps it off the gate
      // ring entirely → it can never drift out the 2-tile enclosure gate).
      assert.ok(
        gx > rect.rx && gx < rect.rx + rect.rw - 1 && gy > rect.ry && gy < rect.ry + rect.rh - 1,
        `seed ${seed}: animal ${e.id} at (${gx},${gy}) is outside its home interior [${rect.rx},${rect.ry},${rect.rw},${rect.rh}]`,
      );
    }
  }
});

test('animals: home interior is large enough that containment wander cannot freeze (>= 6x6)', () => {
  // CRIT-2: a home interior smaller than ~2*EDGE_MARGIN collapses the wander bias
  // zone and an animal pins to a wall / jitters. Every home interior must be >= 6
  // tiles on both axes (192u > 2*40u margin) so the animal has room to drift.
  for (const seed of [0, 1, 2, 7, 123, 777, 9999, 424242]) {
    const map = generateWorld(seed);
    for (const key of SPECIES_KEYS) {
      const rect = homeRectOf(map, key);
      const iw = rect.rw - 2;
      const ih = rect.rh - 2;
      assert.ok(iw >= 6 && ih >= 6, `seed ${seed}: ${key} interior ${iw}x${ih} too small (want >=6x6)`);
    }
  }
});
