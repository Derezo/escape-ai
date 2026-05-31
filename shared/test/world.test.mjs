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

import { generateWorld, worldToTile, tileSolid, WORLD_GEN_VERSION } from '../dist/world.js';
import { hash32 } from '../dist/step.js';
import { SPECIES_KEYS } from '../dist/species.js';
import { TILE_INDEX } from '../dist/tiles.js';

// --- Pinned values (regenerate intentionally + bump WORLD_GEN_VERSION if these
// must change; they are computed from generateWorld(123)). -------------------
const PIN_SEED = 123;
// v17: DEN SPAWN-TRAP FIX. The three ROCKY_DEN_WALL tiles in each 'den' enclosure
// (skunk/mole/fox) move from flanking the spawn-center mound on W/E + N to a back-row
// backdrop on the (ccy-1) row, so the mound keeps open non-solid DIRT on W/E/S and a
// player AABB can slide off (was a 1-tile south-only pocket the body wedged into).
// ROCKY_DEN_WALL is solid, so the per-den cells that flip walkability move → the
// collision hash re-pins. The entitySpec hash also re-pins (the full-grid JSON shifts
// with the relocated deco). Both recomputed from generateWorld(123).
const PINNED_COLLISION_HASH = 3946684960;
const PINNED_ENTITYSPEC_HASH = 2090828514;

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

test('version: WORLD_GEN_VERSION is the expected value (bump deliberately)', () => {
  // v17: the den spawn-trap fix relocates each den's ROCKY_DEN_WALL backdrop, which
  // flips per-den collision cells. The bump is the deliberate cache-bust so old
  // clients (which assert msg.version === WORLD_GEN_VERSION) fail loud not desync.
  assert.equal(WORLD_GEN_VERSION, 17, 'version pinned at 17');
  assert.equal(generateWorld(PIN_SEED).version, WORLD_GEN_VERSION, 'map.version tracks the constant');
});

test('patrolRoute: a non-empty robot patrol loop in world units, derived from junctions', () => {
  const map = generateWorld(PIN_SEED);
  assert.ok(Array.isArray(map.patrolRoute), 'patrolRoute is an array');
  assert.ok(map.patrolRoute.length >= 2, `has at least a forecourt + one zone (len=${map.patrolRoute.length})`);
  // Every waypoint is a finite world-unit point inside the map bounds and on a
  // non-solid tile (junctions are force-paved by carveOrganicPaths).
  const worldMax = map.w * map.tile;
  for (const wp of map.patrolRoute) {
    assert.ok(Number.isFinite(wp.x) && Number.isFinite(wp.y), 'waypoint is finite');
    assert.ok(wp.x >= 0 && wp.x < worldMax && wp.y >= 0 && wp.y < worldMax, 'waypoint within bounds');
    assert.ok(
      !tileSolid(map.collision, map.w, map.h, tx(map, wp.x), tx(map, wp.y)),
      `waypoint (${wp.x},${wp.y}) sits on a walkable tile`,
    );
  }
  // Regenerated identically (it's seed-derived → free on the wire).
  assert.deepEqual(map.patrolRoute, generateWorld(PIN_SEED).patrolRoute, 'patrolRoute is deterministic');
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

test('den spawn-trap fix: every den mound has open W/E/S so a player AABB can slide off', () => {
  // Regression for the v17 den fix. A den's spawn-center BURROW_MOUND used to be
  // flanked by solid ROCKY_DEN_WALL on W/E + N, leaving a 1-tile south-only pocket
  // that the player's collision AABB wedged into (radius < half-tile, but a 3-walled
  // 1-tile cell cannot be slid out of). The fix moves the rocks to a back-row
  // backdrop on the (ccy-1) row, leaving the mound's W/E/S open. The mound itself
  // must stay walkable (it is reachTargets[1] / quest tile / decoy anchor / spawn).
  const map = generateWorld(PIN_SEED);
  const dens = map.housing.filter((hh) => hh.kind === 'den');
  assert.ok(dens.length >= 1, 'at least one den home exists (skunk/mole/fox)');
  for (const d of dens) {
    const cx = tx(map, d.cx);
    const cy = tx(map, d.cy);
    assert.ok(!tileSolid(map.collision, map.w, map.h, cx, cy), `${d.species} den mound (center) is walkable`);
    assert.ok(!tileSolid(map.collision, map.w, map.h, cx - 1, cy), `${d.species} den mound WEST neighbour is open`);
    assert.ok(!tileSolid(map.collision, map.w, map.h, cx + 1, cy), `${d.species} den mound EAST neighbour is open`);
    assert.ok(!tileSolid(map.collision, map.w, map.h, cx, cy + 1), `${d.species} den mound SOUTH neighbour is open`);
  }
});

test('coverage: every species has exactly one food source, with a foodKey', () => {
  const map = generateWorld(PIN_SEED);
  const foodCounts = new Map();
  for (const e of map.entitySpecs) {
    if (e.kind !== 'foodSource') continue;
    foodCounts.set(e.species, (foodCounts.get(e.species) ?? 0) + 1);
    assert.ok(e.meta && typeof e.meta.foodKey === 'string' && e.meta.foodKey, `food source ${e.species} carries a foodKey`);
  }
  for (const key of SPECIES_KEYS) {
    assert.equal(foodCounts.get(key), 1, `species ${key} should have exactly one food source`);
  }
  assert.equal(foodCounts.size, SPECIES_KEYS.length, 'no extra food sources beyond the roster');
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
    if (e.kind === 'foodSource') {
      assert.ok(reach(tx(map, e.x), tx(map, e.y)), `food source ${e.species} reachable`);
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
      if (e.kind === 'foodSource') {
        assert.ok(reach(tx(map, e.x), tx(map, e.y)), `seed ${seed}: food ${e.species} reachable`);
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
      ...map.buildings.map((b) => ({ name: `door:${b.species ?? b.auxKind ?? b.id}`, x: (b.doorTx + 0.5) * map.tile, y: (b.doorTy + 0.5) * map.tile })),
      ...map.housing.map((hh) => ({ name: `center:${hh.species}`, x: hh.cx, y: hh.cy })),
      ...map.entitySpecs.filter((e) => e.kind === 'questObject').map((e) => ({ name: `quest:${e.species}`, x: e.x, y: e.y })),
      // v10: food sources now live in aux buildings; they must also stay off deep
      // water (defensive — aux buildings are kept out of the wetland zone, so this
      // is belt-and-braces against a future placement change).
      ...map.entitySpecs.filter((e) => e.kind === 'foodSource').map((e) => ({ name: `food:${e.species}`, x: e.x, y: e.y })),
    ];
    for (const t of targets) {
      assert.ok(!nearDeep(map, t.x, t.y), `seed ${seed}: reach target ${t.name} is on/adjacent to deep water`);
      assert.ok(groundAt(map, t.x, t.y) !== TILE_INDEX.WATER_DEEP, `seed ${seed}: reach target ${t.name} is ON deep water`);
    }
  }
});

test('water is a SOLID barrier: every water-family ground tile is solid, every bridge is walkable', () => {
  // v15 invariant: the river/pond is impassable EXCEPT across bridges. Every
  // water-family ground tile — the DEEP/SHALLOW/POND cores AND the WATER_EDGE_* /
  // WATER_CORNER_* / WATER_ICORNER_* shore-blend ring blendGroundEdges paints over
  // the bank — must have collision === 1, so no robot/player can stand in the water.
  // The ONLY walkable water-crossing tiles are BRIDGE_H / BRIDGE_V. This is the
  // durable proof the shore ring (which is painted AFTER buildCollision) gets
  // re-solidified by the final reconciliation pass. The ONE sanctioned exception:
  // a gate-THRESHOLD cell directly inside a (south-facing) enclosure gate may be a
  // solidified shore tile that is force-reopened so the gate still works — those are
  // whitelisted here (they connect to the home interior, not the open river).
  const WATER_FAMILY = new Set([
    TILE_INDEX.WATER_DEEP, TILE_INDEX.WATER_SHALLOW, TILE_INDEX.POND_DEEP, TILE_INDEX.POND_EDGE,
    TILE_INDEX.WATER_EDGE_N, TILE_INDEX.WATER_EDGE_E, TILE_INDEX.WATER_EDGE_S, TILE_INDEX.WATER_EDGE_W,
    TILE_INDEX.WATER_CORNER_NE, TILE_INDEX.WATER_CORNER_NW, TILE_INDEX.WATER_CORNER_SE, TILE_INDEX.WATER_CORNER_SW,
    TILE_INDEX.WATER_ICORNER_NE, TILE_INDEX.WATER_ICORNER_NW, TILE_INDEX.WATER_ICORNER_SE, TILE_INDEX.WATER_ICORNER_SW,
  ]);
  const BRIDGE = new Set([TILE_INDEX.BRIDGE_H, TILE_INDEX.BRIDGE_V]);
  for (const seed of [0, 1, 2, 7, 123, 777, 9999, 424242]) {
    const map = generateWorld(seed);
    // The whitelisted gate-threshold cells: directly inside each home's south gate.
    const gateInside = new Set();
    for (const hh of map.housing) {
      const gx = hh.rx + Math.floor(hh.rw / 2);
      const gy = hh.ry + hh.rh - 1;
      gateInside.add((gy - 1) * map.w + gx);
      gateInside.add((gy - 1) * map.w + (gx - 1));
    }
    let waterCells = 0, bridgeCells = 0;
    for (let i = 0; i < map.collision.length; i++) {
      const g = map.ground.data[i];
      if (WATER_FAMILY.has(g)) {
        waterCells++;
        if (gateInside.has(i)) continue; // sanctioned gate-threshold reopen
        assert.equal(map.collision[i], 1, `seed ${seed}: water tile ${g} at index ${i} is walkable (should be solid)`);
      }
      if (BRIDGE.has(g)) {
        bridgeCells++;
        assert.equal(map.collision[i], 0, `seed ${seed}: bridge tile ${g} at index ${i} is solid (should be walkable)`);
      }
    }
    // Sanity: the map actually HAS water and at least one bridge (so the test bites).
    assert.ok(waterCells > 50, `seed ${seed}: expected a real river (got ${waterCells} water cells)`);
    assert.ok(bridgeCells > 0, `seed ${seed}: expected at least one bridge deck (got ${bridgeCells})`);
  }
});

// --- Phase B (entrance plaza + tile accuracy) invariants ---------------------

test('entrance plaza: a species-less gatehouse building exists with a reachable, non-solid door', () => {
  for (const seed of [0, 7, 123, 9999]) {
    const map = generateWorld(seed);
    // The gatehouse is the ONE species-less, NON-aux building (aux service buildings
    // are also species-less but carry an auxKind — see the aux-building test below).
    const gatehouses = map.buildings.filter((b) => b.species == null && !b.auxKind);
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

// --- Auxiliary service buildings + relocated food (v10) ----------------------

test('aux buildings: exactly 3 species-less service buildings (commissary/washroom/maintenance), reachable, large enough', () => {
  const KINDS = new Set(['commissary', 'washroom', 'maintenance']);
  for (const seed of [0, 1, 2, 7, 123, 777, 9999, 424242]) {
    const map = generateWorld(seed);
    const aux = map.buildings.filter((b) => b.auxKind);
    assert.equal(aux.length, 3, `seed ${seed}: exactly 3 aux buildings`);
    const kinds = new Set(aux.map((b) => b.auxKind));
    assert.equal(kinds.size, 3, `seed ${seed}: 3 distinct aux kinds`);
    for (const b of aux) {
      assert.ok(KINDS.has(b.auxKind), `seed ${seed}: ${b.auxKind} is a known aux kind`);
      assert.equal(b.species, undefined, `seed ${seed}: aux ${b.auxKind} is species-less`);
      // Interior big enough to hold its block of wall foods + a guard anchor.
      assert.ok(b.rw - 2 >= 8 && b.rh - 2 >= 6, `seed ${seed}: aux ${b.auxKind} interior ${b.rw - 2}x${b.rh - 2} too small (want >=8x6)`);
      // Door non-solid + reachable from spawn.
      assert.ok(!tileSolid(map.collision, map.w, map.h, b.doorTx, b.doorTy), `seed ${seed}: aux ${b.auxKind} door non-solid`);
    }
    const s0 = map.spawns[0];
    const seen = floodReachable(map, tx(map, s0.x), tx(map, s0.y));
    for (const b of aux) {
      assert.ok(seen[b.doorTy * map.w + b.doorTx], `seed ${seed}: aux ${b.auxKind} door reachable from spawn`);
    }
  }
});

test('aux buildings: every food source sits strictly inside some aux building interior (not in animal housing)', () => {
  for (const seed of [0, 1, 2, 7, 123, 777, 9999, 424242]) {
    const map = generateWorld(seed);
    const aux = map.buildings.filter((b) => b.auxKind);
    const foods = map.entitySpecs.filter((e) => e.kind === 'foodSource');
    assert.equal(foods.length, SPECIES_KEYS.length, `seed ${seed}: one food source per species`);
    for (const f of foods) {
      const ftx = tx(map, f.x);
      const fty = tx(map, f.y);
      // Strictly inside the wall ring of SOME aux building.
      const inAux = aux.some((b) => ftx > b.rx && ftx < b.rx + b.rw - 1 && fty > b.ry && fty < b.ry + b.rh - 1);
      assert.ok(inAux, `seed ${seed}: food ${f.species} at (${ftx},${fty}) is not inside any aux building interior`);
      // And NOT inside any animal home (housing or species building) — the whole point.
      const inHousing = map.housing.some((h) => ftx >= h.rx && ftx < h.rx + h.rw && fty >= h.ry && fty < h.ry + h.rh);
      const inSpeciesBld = map.buildings.some((b) => b.species != null && ftx >= b.rx && ftx < b.rx + b.rw && fty >= b.ry && fty < b.ry + b.rh);
      assert.ok(!inHousing && !inSpeciesBld, `seed ${seed}: food ${f.species} is inside an animal home — must be in an aux building`);
      // The food carries its owning aux building so the server can gate it.
      assert.ok(f.meta && typeof f.meta.buildingId === 'string' && f.meta.buildingId, `seed ${seed}: food ${f.species} carries a buildingId`);
    }
  }
});

test('aux buildings: each has a guard robot spec', () => {
  for (const seed of [0, 7, 123, 9999]) {
    const map = generateWorld(seed);
    const aux = map.buildings.filter((b) => b.auxKind);
    const guards = map.entitySpecs.filter((e) => e.kind === 'robotSpawn' && e.meta && e.meta.guard);
    assert.equal(guards.length, 3, `seed ${seed}: exactly 3 guard robots`);
    // Each aux building id is referenced by exactly one guard.
    for (const b of aux) {
      assert.equal(guards.filter((g) => g.meta.buildingId === b.id).length, 1, `seed ${seed}: ${b.id} has one guard robot`);
    }
  }
});

test('robot spawns: every robotSpawn anchor sits on a NON-SOLID tile (top-up guard)', () => {
  // The robot top-up loop offsets the anchor a few tiles off a junction. With the
  // river now a solid barrier, that offset could in principle land on water. The
  // generator falls back to the (always-paved) junction tile; this is the durable
  // regression guard that NO robot spawns inside a wall across many seeds.
  for (let i = 0; i < 200; i++) {
    const map = generateWorld(i);
    for (const e of map.entitySpecs) {
      if (e.kind !== 'robotSpawn') continue;
      const cx = tx(map, e.x);
      const cy = tx(map, e.y);
      assert.equal(
        map.collision[cy * map.w + cx],
        0,
        `seed ${i}: ${e.id} on a solid tile (${cx},${cy})`,
      );
    }
  }
});

test('aux buildings: food is SPREAD across buildings (not all in one)', () => {
  // v11 round-robins the 14 foods across the 3 aux buildings (was a flat-concat bug
  // that dumped all 14 in the commissary). Assert no building holds more than 6.
  for (const seed of [0, 1, 123, 9999, 424242]) {
    const map = generateWorld(seed);
    const aux = map.buildings.filter((b) => b.auxKind);
    const perBld = new Map();
    for (const e of map.entitySpecs) {
      if (e.kind !== 'foodSource') continue;
      const ftx = tx(map, e.x);
      const fty = tx(map, e.y);
      const b = aux.find((b) => ftx > b.rx && ftx < b.rx + b.rw - 1 && fty > b.ry && fty < b.ry + b.rh - 1);
      assert.ok(b, `seed ${seed}: food ${e.species} not inside any aux building`);
      perBld.set(b.auxKind, (perBld.get(b.auxKind) ?? 0) + 1);
    }
    assert.equal(perBld.size, 3, `seed ${seed}: foods touch all 3 aux buildings`);
    for (const [kind, n] of perBld) {
      assert.ok(n <= 6, `seed ${seed}: ${kind} holds ${n} foods (want spread, <= 6)`);
    }
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
