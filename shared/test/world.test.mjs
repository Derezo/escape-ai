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

// --- Pinned values (regenerate intentionally + bump WORLD_GEN_VERSION if these
// must change; they are computed from generateWorld(123)). -------------------
const PIN_SEED = 123;
const PINNED_COLLISION_HASH = 651189019;
// v5: re-pinned for the per-species `foodSource` specs (the animal-collection
// feature). Collision hash is UNCHANGED — food sources co-locate with the
// already-non-solid questObject tiles, so forcing them walkable is a no-op there.
const PINNED_ENTITYSPEC_HASH = 198123412;

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
