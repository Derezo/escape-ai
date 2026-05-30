/**
 * Determinism + correctness gate for the global pathfinder (pathfind.ts).
 *
 * The headline property is the one steerAround structurally CANNOT do: find a
 * two-tile door gap from outside a walled enclosure and route through it. We also
 * pin determinism (same args → byte-identical tile path, across two fresh map
 * builds), prove real-map return-home routes are actually walkable, and check the
 * graceful-degrade contract (solid/OOB/over-budget → [] so callers fall back).
 * Zero deps: Node's runner over the compiled dist (built by `npm test`).
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  findPath,
  makeScratch,
  toWorldWaypoints,
  nextWaypoint,
  inBounds,
  gateInsideTile,
  DEFAULT_MAX_EXPAND,
} from '../dist/pathfind.js';
import { steerAround } from '../dist/movement.js';
import { moveWithCollision } from '../dist/step.js';
import { generateWorld, worldToTile, tileSolid } from '../dist/world.js';

const TILE = 32;
const RADIUS = 11; // ~ RECT_SIZE * 0.4 (server uses the same value)

/** A small open grid with no solids. */
function openGrid(w, h) {
  return new Uint8Array(w * h);
}

/**
 * A hand-built walled enclosure with a 2-tile south gate, inside a larger open
 * field. Rect is tiles [rx..rx+rw-1] × [ry..ry+rh-1]; the wall ring is solid except
 * the gate at (gateTx-1, gateTy) and (gateTx, gateTy) on the south edge — exactly
 * the world-gen geometry (gateTx = rx+floor(rw/2), gateTy = ry+rh-1).
 */
function enclosureGrid(w, h, rx, ry, rw, rh) {
  const c = openGrid(w, h);
  const set = (tx, ty, v) => { c[ty * w + tx] = v; };
  for (let dx = 0; dx < rw; dx++) {
    set(rx + dx, ry, 1);
    set(rx + dx, ry + rh - 1, 1);
  }
  for (let dy = 0; dy < rh; dy++) {
    set(rx, ry + dy, 1);
    set(rx + rw - 1, ry + dy, 1);
  }
  const gateTx = rx + Math.floor(rw / 2);
  const gateTy = ry + rh - 1;
  set(gateTx, gateTy, 0);
  set(gateTx - 1, gateTy, 0);
  return { collision: c, gateTx, gateTy };
}

/** Assert every consecutive tile pair is a non-solid 4-neighbour step (a real walk). */
function assertWalkable(path, collision, w, h) {
  assert.ok(path.length > 0, 'path is non-empty');
  for (let i = 0; i < path.length; i++) {
    const t = path[i];
    assert.ok(!tileSolid(collision, w, h, t.tx, t.ty), `tile ${i} (${t.tx},${t.ty}) is non-solid`);
    if (i > 0) {
      const p = path[i - 1];
      const md = Math.abs(t.tx - p.tx) + Math.abs(t.ty - p.ty);
      assert.equal(md, 1, `tiles ${i - 1}->${i} are 4-neighbour adjacent`);
    }
  }
}

// --- determinism -------------------------------------------------------------

test('findPath: identical args → byte-identical path, twice and across fresh maps', () => {
  const a = generateWorld(123);
  const b = generateWorld(123); // a second, independent build of the same seed
  const s = a.spawns[0];
  const startTx = worldToTile(s.x, a.tile);
  const startTy = worldToTile(s.y, a.tile);
  // Route to the inside of the first species enclosure's gate.
  const home = a.housing[0];
  const goal = gateInsideTile(home.rx + Math.floor(home.rw / 2), home.ry + home.rh - 1);

  const p1 = findPath(a.collision, a.w, a.h, startTx, startTy, goal.tx, goal.ty);
  const p2 = findPath(a.collision, a.w, a.h, startTx, startTy, goal.tx, goal.ty);
  const p3 = findPath(b.collision, b.w, b.h, startTx, startTy, goal.tx, goal.ty);
  assert.deepEqual(p1, p2, 'two runs on the same grid agree');
  assert.deepEqual(p1, p3, 'a fresh build of the same seed agrees (bit-identical)');
  assert.ok(p1.length > 0, 'found a route to the enclosure interior');
});

test('findPath: reused scratch yields the same path as a fresh one (gen reset is clean)', () => {
  const { collision, gateTx } = enclosureGrid(40, 40, 10, 10, 11, 9);
  const scratch = makeScratch(40, 40);
  const goal = gateInsideTile(gateTx, 10 + 9 - 1);
  // Run an unrelated search first to dirty the scratch, then the real one twice.
  findPath(collision, 40, 40, 2, 2, 5, 5, scratch);
  const a = findPath(collision, 40, 40, 2, 2, goal.tx, goal.ty, scratch);
  const b = findPath(collision, 40, 40, 2, 2, goal.tx, goal.ty); // fresh scratch
  assert.deepEqual(a, b, 'reused-scratch path equals fresh-scratch path');
});

// --- thread the door (the capability steerAround lacks) ----------------------

test('findPath: routes from OUTSIDE a walled enclosure through the 2-tile gate', () => {
  const w = 40, h = 40, rx = 10, ry = 10, rw = 11, rh = 9;
  const { collision, gateTx, gateTy } = enclosureGrid(w, h, rx, ry, rw, rh);
  const goal = gateInsideTile(gateTx, gateTy); // one tile inside the gate

  // Start well OUTSIDE the enclosure, south of the gate.
  const path = findPath(collision, w, h, gateTx, gateTy + 6, goal.tx, goal.ty);
  assertWalkable(path, collision, w, h);
  assert.deepEqual(path[path.length - 1], { tx: goal.tx, ty: goal.ty }, 'ends one tile inside the gate');
  // The path must pass through a gate tile (the only non-solid cells in the south wall).
  const throughGate = path.some((t) => t.ty === gateTy && (t.tx === gateTx || t.tx === gateTx - 1));
  assert.ok(throughGate, 'path passes through the south gate gap');
});

test('steerAround alone (the OLD behavior) does NOT reach the enclosure interior', () => {
  // Contrast: drive a body with ONLY steerAround + moveWithCollision toward the
  // interior center. Start NORTH of the enclosure (the gate is on the SOUTH side),
  // so reaching the interior requires routing all the way around to the far gate —
  // which one-tile-ahead local steering structurally cannot plan. It pins on the
  // north wall and never enters. This is exactly the bug the pathfinder fixes.
  const w = 40, h = 40, rx = 10, ry = 10, rw = 11, rh = 9;
  const { collision } = enclosureGrid(w, h, rx, ry, rw, rh);
  const centerTx = rx + Math.floor(rw / 2);
  const centerTy = ry + Math.floor(rh / 2);
  const centerX = centerTx * TILE + TILE / 2;
  const centerY = centerTy * TILE + TILE / 2;
  // Start directly NORTH of the enclosure center, outside the north wall.
  const e = { x: centerX, y: (ry - 5) * TILE + TILE / 2 };
  for (let i = 0; i < 800; i++) {
    const dx = centerX - e.x;
    const dy = centerY - e.y;
    const len = Math.hypot(dx, dy) || 1;
    const hd = steerAround(e, dx / len, dy / len, 1 / 20, 60, collision, w, h, TILE, RADIUS);
    if (hd.dirX !== 0 || hd.dirY !== 0) {
      moveWithCollision(e, hd.dirX, hd.dirY, 1 / 20, 60, collision, w, h, TILE, RADIUS);
    }
  }
  // It never reached the interior center — pure local steering can't find the far gate.
  const etx = worldToTile(e.x, TILE);
  const ety = worldToTile(e.y, TILE);
  const reachedCenter = etx === centerTx && ety === centerTy;
  assert.ok(!reachedCenter, `steerAround did NOT reach the interior center (ended at ${etx},${ety})`);
  // And a findPath from the SAME start DOES reach it — the capability contrast.
  const path = findPath(collision, w, h, centerTx, ry - 5, centerTx, centerTy);
  assert.ok(path.length > 0 && path[path.length - 1].tx === centerTx && path[path.length - 1].ty === centerTy,
    'findPath from the same start DOES reach the interior center');
});

// --- real-map return-home walkability ---------------------------------------

test('findPath: every species home is reachable via its gate from a spawn (walkable)', () => {
  const map = generateWorld(123);
  const s = map.spawns[0];
  const startTx = worldToTile(s.x, map.tile);
  const startTy = worldToTile(s.y, map.tile);
  for (const home of map.housing) {
    const goal = gateInsideTile(home.rx + Math.floor(home.rw / 2), home.ry + home.rh - 1);
    const path = findPath(map.collision, map.w, map.h, startTx, startTy, goal.tx, goal.ty);
    assert.ok(path.length > 0, `home ${home.species} is reachable`);
    assertWalkable(path, map.collision, map.w, map.h);
    assert.deepEqual(path[path.length - 1], goal, `home ${home.species} path ends at its gate-inside tile`);
  }
});

test('findPath: building doors are reachable too (aux + species buildings)', () => {
  const map = generateWorld(7);
  const s = map.spawns[0];
  const startTx = worldToTile(s.x, map.tile);
  const startTy = worldToTile(s.y, map.tile);
  for (const b of map.buildings) {
    const goal = gateInsideTile(b.doorTx, b.doorTy);
    const path = findPath(map.collision, map.w, map.h, startTx, startTy, goal.tx, goal.ty);
    assert.ok(path.length > 0, `building ${b.id} door-inside is reachable`);
    assertWalkable(path, map.collision, map.w, map.h);
  }
});

// --- waypoint following ------------------------------------------------------

test('nextWaypoint: advances through reached waypoints and reports done', () => {
  const wps = toWorldWaypoints([{ tx: 0, ty: 0 }, { tx: 1, ty: 0 }, { tx: 2, ty: 0 }], TILE);
  // Standing on the first waypoint → it advances past it to the second.
  const a = nextWaypoint(wps, 0, { x: TILE / 2, y: TILE / 2 }, TILE * 0.5);
  assert.equal(a.index, 1, 'advanced off the reached first waypoint');
  assert.equal(a.done, false);
  // Standing on the last → done.
  const b = nextWaypoint(wps, 2, { x: 2 * TILE + TILE / 2, y: TILE / 2 }, TILE * 0.5);
  assert.equal(b.done, true, 'route exhausted at the final waypoint');
});

test('nextWaypoint: empty list is a no-op done', () => {
  const r = nextWaypoint([], 0, { x: 5, y: 5 }, 16);
  assert.equal(r.done, true);
  assert.deepEqual(r.target, { x: 5, y: 5 });
});

// --- graceful degrade --------------------------------------------------------

test('findPath: solid / OOB start or goal returns []', () => {
  const { collision } = enclosureGrid(40, 40, 10, 10, 11, 9);
  // Goal on a solid wall tile (top edge of the enclosure).
  assert.deepEqual(findPath(collision, 40, 40, 2, 2, 10, 10), [], 'solid goal → []');
  // Start out of bounds.
  assert.deepEqual(findPath(collision, 40, 40, -1, 2, 20, 20), [], 'OOB start → []');
});

test('findPath: unreachable goal (sealed room) returns []', () => {
  // A fully sealed 5×5 box (NO gate) inside an open field; goal is its interior.
  const w = 30, h = 30;
  const c = openGrid(w, h);
  const rx = 10, ry = 10, rw = 5, rh = 5;
  for (let dx = 0; dx < rw; dx++) { c[ry * w + (rx + dx)] = 1; c[(ry + rh - 1) * w + (rx + dx)] = 1; }
  for (let dy = 0; dy < rh; dy++) { c[(ry + dy) * w + rx] = 1; c[(ry + dy) * w + (rx + rw - 1)] = 1; }
  const goalTx = rx + 2, goalTy = ry + 2; // interior, non-solid but sealed off
  assert.equal(c[goalTy * w + goalTx], 0, 'interior is non-solid');
  assert.deepEqual(findPath(c, w, h, 2, 2, goalTx, goalTy), [], 'sealed interior → []');
});

test('findPath: a tiny maxExpand budget degrades to [] (caller-fallback contract)', () => {
  const map = generateWorld(123);
  const s = map.spawns[0];
  const startTx = worldToTile(s.x, map.tile);
  const startTy = worldToTile(s.y, map.tile);
  const home = map.housing[map.housing.length - 1]; // a far one
  const goal = gateInsideTile(home.rx + Math.floor(home.rw / 2), home.ry + home.rh - 1);
  // Default (full-grid) budget finds it; a 1-cell budget cannot and must return [].
  assert.ok(findPath(map.collision, map.w, map.h, startTx, startTy, goal.tx, goal.ty).length > 0);
  assert.deepEqual(findPath(map.collision, map.w, map.h, startTx, startTy, goal.tx, goal.ty, undefined, 1), []);
  // The sentinel default is non-positive (means "one full grid sweep"), documented.
  assert.ok(DEFAULT_MAX_EXPAND <= 0, 'DEFAULT_MAX_EXPAND is the full-grid sentinel');
});

// --- radius-aware clearance --------------------------------------------------

test('findPath: clearance routes a body away from wall corners but never seals a 2-tile gate', () => {
  const w = 40, h = 40, rx = 10, ry = 10, rw = 11, rh = 9;
  const { collision, gateTx, gateTy } = enclosureGrid(w, h, rx, ry, rw, rh);
  const goal = gateInsideTile(gateTx, gateTy);
  const start = { tx: gateTx, ty: gateTy + 6 }; // outside, south of the gate

  // At the true entity clearance (RADIUS), the 2-tile gate must STILL be threadable.
  const clearance = { tile: TILE, radius: RADIUS };
  const path = findPath(collision, w, h, start.tx, start.ty, goal.tx, goal.ty, undefined, undefined, clearance);
  assert.ok(path.length > 0, 'clearance path still reaches the enclosure interior through the gate');
  assertWalkable(path, collision, w, h);
  const throughGate = path.some((t) => t.ty === gateTy && (t.tx === gateTx || t.tx === gateTx - 1));
  assert.ok(throughGate, 'clearance path still passes through the 2-tile gate');
});

test('findPath: clearance is deterministic and memoized (same path twice, reused scratch)', () => {
  const { collision, gateTx, gateTy } = enclosureGrid(40, 40, 10, 10, 11, 9);
  const goal = gateInsideTile(gateTx, gateTy);
  const scratch = makeScratch(40, 40);
  const clearance = { tile: TILE, radius: RADIUS };
  const a = findPath(collision, 40, 40, gateTx, gateTy + 6, goal.tx, goal.ty, scratch, undefined, clearance);
  const b = findPath(collision, 40, 40, gateTx, gateTy + 6, goal.tx, goal.ty, scratch, undefined, clearance);
  const c = findPath(collision, 40, 40, gateTx, gateTy + 6, goal.tx, goal.ty, undefined, undefined, clearance);
  assert.deepEqual(a, b, 'reused-scratch clearance path is stable');
  assert.deepEqual(a, c, 'fresh-scratch clearance path matches');
});

test('findPath: an over-radius clearance that would seal a gate yields [] (degrade contract)', () => {
  const { collision, gateTx, gateTy } = enclosureGrid(40, 40, 10, 10, 11, 9);
  const goal = gateInsideTile(gateTx, gateTy);
  // A radius wider than half a tile overlaps the gate's flanking wall at the tile
  // center → the gate cell fails clearance → the interior is unreachable for that
  // body. Returning [] (not a corner-clipping path) is the correct degrade.
  const tooWide = { tile: TILE, radius: TILE * 0.6 };
  const path = findPath(collision, 40, 40, gateTx, gateTy + 6, goal.tx, goal.ty, undefined, undefined, tooWide);
  assert.deepEqual(path, [], 'a body too wide for the gate gets [] (caller falls back), not a bad path');
});

// --- geometry helpers --------------------------------------------------------

test('inBounds: inside / edge / outside truth table', () => {
  const b = { minX: 10, minY: 20, maxX: 30, maxY: 40 };
  assert.ok(inBounds(20, 30, b), 'interior point inside');
  assert.ok(inBounds(10, 20, b), 'min corner inclusive');
  assert.ok(inBounds(30, 40, b), 'max corner inclusive');
  assert.ok(!inBounds(9, 30, b), 'left of min outside');
  assert.ok(!inBounds(20, 41, b), 'below max outside');
});

test('gateInsideTile: one row inside a south door', () => {
  assert.deepEqual(gateInsideTile(15, 18), { tx: 15, ty: 17 });
});
