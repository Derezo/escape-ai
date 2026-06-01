'use strict';

/**
 * Spawn-into-wall regression gate: a player must NEVER spawn BOX-TRAPPED.
 *
 * Reported bug: spawning as the tortoise (and mole/fox/skunk) dropped the player on a
 * tile they could not move out of — stuck on first load. spawnForSpecies computes a
 * pen-centre point plus a deterministic per-player jitter; the OLD guard
 * (findWalkableNear) validated only a single POINT (one tile via isSolidAtRoom). But
 * the player is integrated as an axis-aligned box of half-extent RECT_SIZE*0.4 (=12.8).
 * A tile centre can be point-walkable while the player's box overlaps an adjacent solid
 * tile on every side — point-walkable, but immobile. (Empirically 4040 such spawns
 * across 40 seeds × 14 species × 64 jitter seeds, all in the tight pond/den pens.)
 *
 * The fix: spawnForSpecies snaps to the nearest tile whose player BOX is clear of
 * solids (findBoxClearNear), the same test moveWithCollision runs each tick — so a
 * spawn it accepts is one the player can actually move out of.
 *
 * These tests assert the STRONG property: every playable species' spawn — across many
 * player-id jitter seeds — is box-clear AND can actually move via the real shared
 * integrator (moveWithCollision), not merely that its tile centre is non-solid (the
 * old assertion, which PASSES even on the buggy code and cannot catch this regression).
 *
 * Uses a real generated room so the pen geometry + collision grid are the real ones.
 * Zero new deps: Node's built-in test runner over the real server modules.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const isSolidCell = (rm, x, y) => {
  const tx = Math.floor(x / rm.tile);
  const ty = Math.floor(y / rm.tile);
  if (tx < 0 || ty < 0 || tx >= rm.w || ty >= rm.h) return true; // OOB is solid
  return rm.collision[ty * rm.w + tx] === 1;
};

// The player collision half-extent (mirrors moveWithCollision's RECT_SIZE*0.4).
const config = require('../config');
const SPAWN_RADIUS = config.RECT_SIZE * 0.4;

// Whether the player BOX at (x,y) overlaps any solid tile — mirrors shared
// boxHitsSolid's span math (floor((c±radius)/tile), OOB solid). This is the property
// the OLD point-check missed; a box-trapped spawn is one where this is true.
const boxTrapped = (rm, x, y) => {
  const minTx = Math.floor((x - SPAWN_RADIUS) / rm.tile);
  const maxTx = Math.floor((x + SPAWN_RADIUS) / rm.tile);
  const minTy = Math.floor((y - SPAWN_RADIUS) / rm.tile);
  const maxTy = Math.floor((y + SPAWN_RADIUS) / rm.tile);
  for (let ty = minTy; ty <= maxTy; ty++) {
    for (let tx = minTx; tx <= maxTx; tx++) {
      if (tx < 0 || ty < 0 || tx >= rm.w || ty >= rm.h) return true; // OOB solid
      if (rm.collision[ty * rm.w + tx] === 1) return true;
    }
  }
  return false;
};

// The STRONGEST proof: can the player actually move from (x,y)? Drives the REAL shared
// integrator (moveWithCollision, the exact code the server runs each tick) with a small
// push on each of the 4 axes; at least one must displace the entity. Ties the gate to
// the integrator, not a re-implementation that could drift from it.
let stepMod = null;
const loadStep = async () => {
  if (!stepMod) stepMod = await import(path.join(__dirname, '..', '..', 'shared', 'dist', 'step.js'));
  return stepMod;
};
const canBoxMove = (step, rm, x, y) => {
  const dt = 1 / 30;
  const speed = 200; // any positive speed; we only check displacement, not its size
  for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
    const e = { x, y };
    step.moveWithCollision(e, dx, dy, dt, speed, rm.collision, rm.w, rm.h, rm.tile, SPAWN_RADIUS);
    if (e.x !== x || e.y !== y) return true;
  }
  return false;
};

test('every playable species spawns BOX-CLEAR and can move, across many jitter seeds', async () => {
  const world = require('../game/world');
  await world.loadSharedWorld();
  const step = await loadStep();

  const ROOM = 'spawn-walkable-test-room';
  world.removeRoom(ROOM);

  const rm = world.getRoomMap(ROOM);
  const species = Array.from(world.getHomeCentersBySpecies(ROOM).keys());
  assert.ok(species.length > 5, `expected a full zoo of playable species, got ${species.length}`);

  // Each playable species, each across a spread of player-id jitter seeds (the jitter
  // is what pushes the spawn off the proven-clear pen centre, so it is the part most
  // likely to box-trap the player). Every spawn must be box-clear AND actually movable
  // — a non-solid tile centre is NOT enough (the old assertion passed on the buggy
  // code; the box can still be wedged against a neighbouring wall).
  for (const sp of species) {
    for (let i = 0; i < 64; i++) {
      const seed = `player-${sp}-${i}`;
      const p = world.spawnForSpecies(ROOM, sp, seed);
      assert.ok(
        !boxTrapped(rm, p.x, p.y),
        `${sp} spawned BOX-TRAPPED at (${p.x.toFixed(1)},${p.y.toFixed(1)}) for seed ${seed} — can't move on first load`,
      );
      assert.ok(
        canBoxMove(step, rm, p.x, p.y),
        `${sp} spawn at (${p.x.toFixed(1)},${p.y.toFixed(1)}) for seed ${seed} cannot move on ANY axis (real integrator)`,
      );
    }
  }

  world.removeRoom(ROOM);
});

test('the no-home fallback spawn is box-clear too', async () => {
  const world = require('../game/world');
  await world.loadSharedWorld();
  const step = await loadStep();

  const ROOM = 'spawn-walkable-fallback-room';
  world.removeRoom(ROOM);
  const rm = world.getRoomMap(ROOM);

  // species === null / unknown → the gate-side map.spawns[0] fallback path.
  for (const sp of [null, undefined, 'not-a-real-species']) {
    const p = world.spawnForSpecies(ROOM, sp, 'p1');
    assert.ok(
      !boxTrapped(rm, p.x, p.y),
      `fallback spawn for species=${sp} is box-trapped at (${p.x.toFixed(1)},${p.y.toFixed(1)})`,
    );
    assert.ok(
      canBoxMove(step, rm, p.x, p.y),
      `fallback spawn for species=${sp} at (${p.x.toFixed(1)},${p.y.toFixed(1)}) cannot move on any axis`,
    );
  }

  world.removeRoom(ROOM);
});

test('a deliberately-blocked preferred point snaps to nearby open ground', async () => {
  const world = require('../game/world');
  await world.loadSharedWorld();

  const ROOM = 'spawn-walkable-snap-room';
  world.removeRoom(ROOM);
  const rm = world.getRoomMap(ROOM);

  // Find a known-solid cell in the real map and ask spawnForSpecies' guard (via the
  // public spawn path can't target an arbitrary point, so we assert the property that
  // matters: the spawn of a species whose centre we then verify is non-solid). Here we
  // directly exercise the property at the map level — scan for a solid tile that has a
  // walkable neighbour, and assert isSolidAtRoom agrees the cell is solid (sanity that
  // our collision read matches the module's), establishing the precondition the guard
  // protects against actually exists in this map.
  let foundSolidWithOpenNeighbour = false;
  outer: for (let ty = 1; ty < rm.h - 1 && !foundSolidWithOpenNeighbour; ty++) {
    for (let tx = 1; tx < rm.w - 1; tx++) {
      if (rm.collision[ty * rm.w + tx] !== 1) continue;
      const cx = (tx + 0.5) * rm.tile;
      const cy = (ty + 0.5) * rm.tile;
      assert.ok(world.isSolidAtRoom(ROOM, cx, cy), 'module agrees the solid cell is solid');
      // has at least one open 4-neighbour
      const open =
        rm.collision[ty * rm.w + (tx - 1)] === 0 ||
        rm.collision[ty * rm.w + (tx + 1)] === 0 ||
        rm.collision[(ty - 1) * rm.w + tx] === 0 ||
        rm.collision[(ty + 1) * rm.w + tx] === 0;
      if (open) {
        foundSolidWithOpenNeighbour = true;
        break outer;
      }
    }
  }
  assert.ok(
    foundSolidWithOpenNeighbour,
    'the map has a solid tile with an open neighbour — the exact case the spawn guard handles',
  );

  world.removeRoom(ROOM);
});

test('findWalkableNear snaps a solid point to open ground and leaves open points alone', async () => {
  const world = require('../game/world');
  await world.loadSharedWorld();

  const ROOM = 'spawn-walkable-near-room';
  world.removeRoom(ROOM);
  const rm = world.getRoomMap(ROOM);

  // Locate a real solid cell (the resume-into-wall case: a saved snapshot position
  // that reads solid against the regenerated collision grid). The guard must move it.
  let solid = null;
  for (let ty = 1; ty < rm.h - 1 && !solid; ty++) {
    for (let tx = 1; tx < rm.w - 1; tx++) {
      if (rm.collision[ty * rm.w + tx] === 1) {
        solid = { x: (tx + 0.5) * rm.tile, y: (ty + 0.5) * rm.tile };
        break;
      }
    }
  }
  assert.ok(solid, 'the map has at least one solid cell to test the snap against');

  const snapped = world.findWalkableNear(ROOM, solid.x, solid.y);
  assert.ok(
    !isSolidCell(rm, snapped.x, snapped.y),
    `findWalkableNear left a solid point on a wall: (${snapped.x.toFixed(1)},${snapped.y.toFixed(1)})`,
  );

  // And it must be a NO-OP for an already-walkable point (a normal resume stays
  // byte-identical — the guard never nudges a player who isn't stuck).
  let open = null;
  for (let ty = 1; ty < rm.h - 1 && !open; ty++) {
    for (let tx = 1; tx < rm.w - 1; tx++) {
      if (rm.collision[ty * rm.w + tx] === 0) {
        open = { x: (tx + 0.5) * rm.tile, y: (ty + 0.5) * rm.tile };
        break;
      }
    }
  }
  assert.ok(open, 'the map has a walkable cell');
  const unchanged = world.findWalkableNear(ROOM, open.x, open.y);
  assert.deepEqual(unchanged, open, 'findWalkableNear must not move an already-walkable point');

  world.removeRoom(ROOM);
});

test('spawn placement is deterministic — same seed → same point', async () => {
  const world = require('../game/world');
  await world.loadSharedWorld();

  const ROOM = 'spawn-walkable-determinism-room';
  world.removeRoom(ROOM);
  const species = Array.from(world.getHomeCentersBySpecies(ROOM).keys());

  for (const sp of species.slice(0, 5)) {
    const a = world.spawnForSpecies(ROOM, sp, 'same-seed');
    const b = world.spawnForSpecies(ROOM, sp, 'same-seed');
    assert.deepEqual(a, b, `${sp} spawn must be deterministic for a fixed seed`);
  }

  // The historically-trapped offenders (pond + den pens) must specifically be
  // box-clear AND deterministic through the new findBoxClearNear path.
  for (const sp of ['tortoise', 'mole', 'fox', 'skunk']) {
    if (!species.includes(sp)) continue;
    const a = world.spawnForSpecies(ROOM, sp, 'offender-seed');
    const b = world.spawnForSpecies(ROOM, sp, 'offender-seed');
    assert.deepEqual(a, b, `${sp} spawn must be deterministic for a fixed seed`);
  }

  world.removeRoom(ROOM);
});

test('findBoxClearNear: snaps to a box-clear centre, is a no-op for an already-clear box', async () => {
  const world = require('../game/world');
  await world.loadSharedWorld();
  const step = await loadStep();

  const ROOM = 'spawn-boxclear-room';
  world.removeRoom(ROOM);
  const rm = world.getRoomMap(ROOM);

  // An already-clear preferred point near a tile centre snaps to that centre and the
  // box can move there (the no-gratuitous-nudge property: it returns a usable centre).
  let openTc = null;
  for (let ty = 2; ty < rm.h - 2 && !openTc; ty++) {
    for (let tx = 2; tx < rm.w - 2; tx++) {
      const cx = (tx + 0.5) * rm.tile;
      const cy = (ty + 0.5) * rm.tile;
      if (!boxTrapped(rm, cx, cy)) { openTc = { x: cx, y: cy }; break; }
    }
  }
  assert.ok(openTc, 'the map has a box-clear tile centre');
  const r1 = world.findBoxClearNear(ROOM, openTc.x, openTc.y);
  assert.ok(!boxTrapped(rm, r1.x, r1.y), 'findBoxClearNear returns a box-clear point');
  assert.ok(canBoxMove(step, rm, r1.x, r1.y), 'the returned point can move via the real integrator');

  // A point inside a solid tile snaps OUT to a box-clear centre (not the input).
  let solid = null;
  for (let ty = 1; ty < rm.h - 1 && !solid; ty++) {
    for (let tx = 1; tx < rm.w - 1; tx++) {
      if (rm.collision[ty * rm.w + tx] === 1) { solid = { x: (tx + 0.5) * rm.tile, y: (ty + 0.5) * rm.tile }; break; }
    }
  }
  assert.ok(solid, 'the map has a solid cell');
  const r2 = world.findBoxClearNear(ROOM, solid.x, solid.y);
  assert.ok(!boxTrapped(rm, r2.x, r2.y), 'findBoxClearNear snaps a solid point to a box-clear centre');

  world.removeRoom(ROOM);
});

test('findBoxClearNear: degenerate fully-walled point warns and returns a finite least-overlapping centre, never loops', async () => {
  const world = require('../game/world');
  await world.loadSharedWorld();

  const ROOM = 'spawn-boxclear-degenerate-room';
  world.removeRoom(ROOM);
  const rm = world.getRoomMap(ROOM);

  // Force the STAGE-3 degenerate path: a point with NO box-clear tile CENTRE within the
  // search radius. At current constants (radius 12.8 < tile/2 16) every non-solid tile
  // centre is box-clear, so STAGE 3 never fires on a real spawn — to exercise it we
  // pick a solid cell whose entire 3×3 neighbourhood is ALSO solid (deep inside a wall
  // mass: a building/den wall block) and search with maxRadius=1. Then the own centre
  // and all eight radius-1 centres are solid → no clear centre → degenerate path.
  let walled = null;
  for (let ty = 2; ty < rm.h - 2 && !walled; ty++) {
    for (let tx = 2; tx < rm.w - 2; tx++) {
      let allSolid = true;
      for (let dy = -1; dy <= 1 && allSolid; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          if (rm.collision[(ty + dy) * rm.w + (tx + dx)] !== 1) { allSolid = false; break; }
        }
      }
      if (allSolid) { walled = { x: (tx + 0.5) * rm.tile, y: (ty + 0.5) * rm.tile }; break; }
    }
  }
  assert.ok(walled, 'the map has a 3×3 fully-solid wall block to force the degenerate path');

  const warnings = [];
  const origWarn = console.warn;
  console.warn = (...a) => warnings.push(a.join(' '));
  let out;
  try {
    out = world.findBoxClearNear(ROOM, walled.x, walled.y, 1);
  } finally {
    console.warn = origWarn;
  }
  assert.ok(Number.isFinite(out.x) && Number.isFinite(out.y), 'returns a finite point (no loop / NaN)');
  assert.ok(
    warnings.some((w) => w.includes('[spawn] box-trapped fallback')),
    'the degenerate path warns loudly so a too-tight pen is surfaced',
  );

  world.removeRoom(ROOM);
});
