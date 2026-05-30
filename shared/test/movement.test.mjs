/**
 * Determinism + behavior gate for the NPC steering/behavior primitives
 * (movement.ts) and the species locomotion registry (locomotion.ts).
 *
 * These run on BOTH sides (server authority + any client prediction), so the
 * core property under test is PURITY/DETERMINISM: identical inputs → bit-identical
 * outputs. We also assert the steering actually un-sticks an NPC against a wall
 * (the bug this refactor fixes) and that the gaits modify speed as designed.
 * Zero deps: Node's runner over the compiled dist (built by `npm test`).
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  steerAround,
  patrolStep,
  chainFollowStep,
  speedBoost,
  wanderAvoid,
  BOOST,
} from '../dist/movement.js';
import {
  locomotionFor,
  gaitSpeed,
  locomotionStep,
  DEFAULT_LOCOMOTION,
} from '../dist/locomotion.js';
import {
  homeBiasedWanderStep,
  facingFromVec,
  facingFromVecDeadband,
  WANDER,
} from '../dist/step.js';

const TILE = 32;
const RADIUS = 11; // ~ RECT_SIZE * 0.4 (server uses the same value)
const DT = 1 / 20;

/** An open grid with no solids. */
function openGrid(w, h) {
  return new Uint8Array(w * h);
}
/** A grid with one solid vertical wall column. */
function wallGrid(w, h, wallTx) {
  const c = new Uint8Array(w * h);
  for (let ty = 0; ty < h; ty++) c[ty * w + wallTx] = 1;
  return c;
}

// --- steerAround -------------------------------------------------------------

test('steerAround: clear path keeps the desired heading', () => {
  const c = openGrid(10, 10);
  const e = { x: 5 * TILE, y: 5 * TILE };
  const h = steerAround(e, 1, 0, DT, 120, c, 10, 10, TILE, RADIUS);
  assert.ok(Math.abs(h.dirX - 1) < 1e-9 && Math.abs(h.dirY) < 1e-9, 'east heading unchanged');
});

test('steerAround: turns away from a wall instead of returning {0,0}', () => {
  const w = 12, h = 12, wallTx = 6;
  const c = wallGrid(w, h, wallTx);
  // Pressed up against the wall, wanting to go straight east (blocked).
  const e = { x: wallTx * TILE - RADIUS - 1, y: 5 * TILE };
  const out = steerAround(e, 1, 0, DT, 120, c, w, h, TILE, RADIUS);
  assert.ok(out.dirX !== 0 || out.dirY !== 0, 'found a clear tangential heading, not boxed in');
  // The clear heading should have a vertical component (slide along the wall).
  assert.ok(Math.abs(out.dirY) > 0.5, `steered along the wall face (dirY=${out.dirY})`);
});

test('steerAround: deterministic — same inputs, same output', () => {
  const w = 12, h = 12;
  const c = wallGrid(w, h, 6);
  const e = { x: 6 * TILE - RADIUS - 1, y: 5 * TILE };
  const a = steerAround(e, 1, 0, DT, 120, c, w, h, TILE, RADIUS);
  const b = steerAround(e, 1, 0, DT, 120, c, w, h, TILE, RADIUS);
  assert.deepEqual(a, b, 'two probes identical');
});

test('steerAround: zero desired heading → {0,0}', () => {
  const c = openGrid(10, 10);
  const out = steerAround({ x: 100, y: 100 }, 0, 0, DT, 120, c, 10, 10, TILE, RADIUS);
  assert.deepEqual(out, { dirX: 0, dirY: 0 });
});

// --- wanderAvoid un-sticks against a wall ------------------------------------

test('wanderAvoid: an NPC pinned at a wall makes progress over time (no permanent stall)', () => {
  const w = 16, h = 16, wallTx = 8;
  const c = wallGrid(w, h, wallTx);
  // Start flush against the wall's left face.
  const e = { id: 'pin-test', x: wallTx * TILE - RADIUS - 1, y: 8 * TILE };
  const start = { x: e.x, y: e.y };
  let moved = 0;
  for (let t = 0; t < 200; t++) {
    const before = { x: e.x, y: e.y };
    wanderAvoid(e, t, DT, 60, c, w, h, TILE, RADIUS);
    moved += Math.hypot(e.x - before.x, e.y - before.y);
  }
  // It must have travelled some real distance (not pinned in place the whole time).
  assert.ok(moved > TILE, `wanderer made cumulative progress (moved=${moved.toFixed(1)})`);
  // And it never tunneled through the wall.
  assert.ok(e.x + RADIUS <= wallTx * TILE + 0.001, 'stayed on its side of the wall');
  void start;
});

test('wanderAvoid: deterministic across two identical runs', () => {
  const w = 16, h = 16;
  const c = wallGrid(w, h, 8);
  const run = () => {
    const e = { id: 'det', x: 4 * TILE, y: 8 * TILE };
    for (let t = 0; t < 100; t++) wanderAvoid(e, t, DT, 60, c, w, h, TILE, RADIUS);
    return e;
  };
  assert.deepEqual(run(), run(), 'identical wander trajectories');
});

// --- patrolStep --------------------------------------------------------------

test('patrolStep: advances toward a waypoint and loops the index', () => {
  const c = openGrid(40, 40);
  const route = [
    { x: 5 * TILE, y: 5 * TILE },
    { x: 30 * TILE, y: 5 * TILE },
  ];
  // Start ON waypoint 0 → should mark arrived and retarget index 1.
  let e = { id: 'r1', x: route[0].x, y: route[0].y };
  let res = patrolStep(e, route, 0, DT, 120, c, 40, 40, TILE, RADIUS);
  assert.equal(res.arrived, true, 'arrived at wp0');
  assert.equal(res.index, 1, 'retargeted wp1');
  // Walk toward wp1 for a while; it should move east (toward wp1).
  e = { id: 'r1', x: res.x, y: res.y };
  let idx = res.index;
  for (let i = 0; i < 50; i++) {
    res = patrolStep(e, route, idx, DT, 120, c, 40, 40, TILE, RADIUS);
    e.x = res.x; e.y = res.y; idx = res.index;
  }
  assert.ok(e.x > route[0].x, 'progressed east toward wp1');
});

test('patrolStep: empty route is a no-op', () => {
  const c = openGrid(10, 10);
  const e = { id: 'r', x: 100, y: 100 };
  const res = patrolStep(e, [], 3, DT, 120, c, 10, 10, TILE, RADIUS);
  assert.equal(res.x, 100); assert.equal(res.y, 100);
  assert.equal(res.arrived, false);
});

test('patrolStep: deterministic', () => {
  const c = openGrid(40, 40);
  const route = [{ x: 5 * TILE, y: 5 * TILE }, { x: 30 * TILE, y: 20 * TILE }];
  const a = patrolStep({ id: 'r', x: 200, y: 200 }, route, 0, DT, 120, c, 40, 40, TILE, RADIUS);
  const b = patrolStep({ id: 'r', x: 200, y: 200 }, route, 0, DT, 120, c, 40, 40, TILE, RADIUS);
  assert.deepEqual(a, b);
});

// --- chainFollowStep ---------------------------------------------------------

test('chainFollowStep: heads toward the leader when beyond the gap', () => {
  const out = chainFollowStep({ x: 0, y: 0 }, { x: 100, y: 0 }, 40);
  assert.equal(out.moving, true);
  assert.ok(Math.abs(out.dirX - 1) < 1e-9 && Math.abs(out.dirY) < 1e-9, 'unit east toward leader');
});

test('chainFollowStep: holds (trails) when within the gap', () => {
  const out = chainFollowStep({ x: 0, y: 0 }, { x: 20, y: 0 }, 40);
  assert.equal(out.moving, false);
  assert.deepEqual({ dirX: out.dirX, dirY: out.dirY }, { dirX: 0, dirY: 0 });
});

// --- speedBoost --------------------------------------------------------------

test('speedBoost: deterministic and bounded to {1, MULT}', () => {
  for (let t = 0; t < 500; t++) {
    const v = speedBoost('robot-1', t);
    assert.ok(v === 1 || v === BOOST.MULT, `boost is 1 or MULT (got ${v})`);
    assert.equal(v, speedBoost('robot-1', t), 'same (id,tick) → same value');
  }
});

test('speedBoost: actually fires sometimes (not always 1) and differs per id', () => {
  let fired1 = 0, fired2 = 0;
  for (let t = 0; t < 2000; t++) {
    if (speedBoost('robot-1', t) === BOOST.MULT) fired1++;
    if (speedBoost('robot-2', t) === BOOST.MULT) fired2++;
  }
  assert.ok(fired1 > 0, 'robot-1 boosts at least once');
  assert.ok(fired2 > 0, 'robot-2 boosts at least once');
});

// --- locomotion registry -----------------------------------------------------

test('locomotionFor: unlisted species + robot → DEFAULT walk', () => {
  assert.deepEqual(locomotionFor('elephant'), DEFAULT_LOCOMOTION);
  assert.deepEqual(locomotionFor(undefined), DEFAULT_LOCOMOTION);
  assert.deepEqual(locomotionFor('robot'), DEFAULT_LOCOMOTION);
});

test('gaitSpeed: tortoise is always half speed', () => {
  for (let t = 0; t < 50; t++) {
    assert.equal(gaitSpeed('tortoise', 'pen-tortoise', t, 100), 50);
  }
});

test('gaitSpeed: kangaroo lurches — zero during pause, fast during burst, mean ≈ base', () => {
  const base = 100;
  const id = 'pen-kangaroo';
  let sawZero = false, sawFast = false, total = 0;
  const period = 16; // hopTicks 6 + pauseTicks 10
  for (let t = 0; t < period; t++) {
    const s = gaitSpeed('kangaroo', id, t, base);
    if (s === 0) sawZero = true;
    if (s > base) sawFast = true;
    total += s;
  }
  assert.ok(sawZero, 'paused (0) at some point in the cycle');
  assert.ok(sawFast, 'lurched faster than base at some point');
  // Average distance over a full cycle ≈ base (burst speed conserves mean distance).
  assert.ok(Math.abs(total / period - base) < 1e-6, `mean speed ≈ base (got ${total / period})`);
});

test('gaitSpeed: kangaroo phase is per-entity (two ids hop out of sync at some tick)', () => {
  let differ = false;
  for (let t = 0; t < 32; t++) {
    if (gaitSpeed('kangaroo', 'k-a', t, 100) !== gaitSpeed('kangaroo', 'k-b', t, 100)) {
      differ = true; break;
    }
  }
  assert.ok(differ, 'distinct kangaroos are phase-offset');
});

test('gaitSpeed: bird glides slightly faster than base, deterministic', () => {
  // 100 * 1.15 is 114.999… in IEEE float — assert closeness, not exact equality.
  assert.ok(Math.abs(gaitSpeed('bird', 'pen-bird', 0, 100) - 115) < 1e-9, 'bird ~1.15x base');
  assert.equal(
    gaitSpeed('bird', 'pen-bird', 0, 100),
    gaitSpeed('bird', 'pen-bird', 99, 100),
    'deterministic across ticks',
  );
});

test('locomotionStep: routes through collision and applies gait (tortoise moves half as far)', () => {
  const c = openGrid(20, 20);
  const walk = { id: 'pen-fox', x: 5 * TILE, y: 5 * TILE, species: 'fox' };
  const crawl = { id: 'pen-tortoise', x: 5 * TILE, y: 5 * TILE, species: 'tortoise' };
  for (let t = 0; t < 20; t++) {
    locomotionStep(walk, 1, 0, t, DT, 100, c, 20, 20, TILE, RADIUS);
    locomotionStep(crawl, 1, 0, t, DT, 100, c, 20, 20, TILE, RADIUS);
  }
  const walkDist = walk.x - 5 * TILE;
  const crawlDist = crawl.x - 5 * TILE;
  assert.ok(crawlDist > 0 && walkDist > 0, 'both moved');
  assert.ok(Math.abs(crawlDist - walkDist / 2) < 1e-6, `tortoise covered half the distance (${crawlDist} vs ${walkDist})`);
});

test('locomotionStep: kangaroo holds during its pause phase (some tick has no movement)', () => {
  const c = openGrid(20, 20);
  const k = { id: 'pen-kangaroo', x: 5 * TILE, y: 5 * TILE, species: 'kangaroo' };
  let stalledTick = -1;
  for (let t = 0; t < 16; t++) {
    const before = k.x;
    locomotionStep(k, 1, 0, t, DT, 100, c, 20, 20, TILE, RADIUS);
    if (k.x === before) { stalledTick = t; break; }
  }
  assert.ok(stalledTick >= 0, 'kangaroo had a hold tick (hop pause)');
});

// --- homeBiasedWanderStep ----------------------------------------------------

test('homeBiasedWanderStep: net-drifts toward home over time', () => {
  const bounds = { minX: 0, minY: 0, maxX: 4096, maxY: 4096 };
  const home = { x: 500, y: 500 };
  const e = { id: 'pen-fox-2', x: 2000, y: 2000 };
  const startDist = Math.hypot(e.x - home.x, e.y - home.y);
  for (let t = 0; t < 400; t++) {
    const next = homeBiasedWanderStep(e, t, DT, 60, bounds, home);
    e.x = next.x; e.y = next.y;
  }
  const endDist = Math.hypot(e.x - home.x, e.y - home.y);
  assert.ok(endDist < startDist, `drifted closer to home (${startDist.toFixed(0)} → ${endDist.toFixed(0)})`);
});

test('homeBiasedWanderStep: deterministic and respects the HOME_BIAS default', () => {
  const bounds = { minX: 0, minY: 0, maxX: 4096, maxY: 4096 };
  const home = { x: 100, y: 100 };
  const a = homeBiasedWanderStep({ id: 'h', x: 1000, y: 1000 }, 5, DT, 60, bounds, home);
  const b = homeBiasedWanderStep({ id: 'h', x: 1000, y: 1000 }, 5, DT, 60, bounds, home, WANDER.HOME_BIAS);
  assert.deepEqual(a, b, 'explicit default weight matches implicit');
});

// --- facingFromVecDeadband (anti pen-corner vibration) -----------------------

test('facingFromVecDeadband: a sub-deadband move HOLDS prev facing', () => {
  // A displacement whose magnitude is below FACING_DEADBAND must not turn the
  // animal, no matter which way the sub-pixel slide points (the vibration fix).
  const tiny = WANDER.FACING_DEADBAND * 0.5; // well under the deadband
  // Point this tiny move EAST — naive facingFromVec would snap to 'e'…
  const naive = facingFromVec(tiny, 0, 'n');
  assert.equal(naive, 'e', 'sanity: without the deadband a tiny east move would flip to e');
  // …but the deadband holds the previous 'n'.
  const held = facingFromVecDeadband(tiny, 0, 'n', WANDER.FACING_DEADBAND);
  assert.equal(held, 'n', 'sub-deadband move holds prev facing');
});

test('facingFromVecDeadband: an above-deadband move matches facingFromVec', () => {
  // A real step (>= deadband) must behave EXACTLY like the no-deadband path so
  // genuine movement still turns the animal.
  const big = WANDER.FACING_DEADBAND * 4; // a clear, meaningful step
  for (const [dx, dy] of [[big, 0], [0, big], [-big, big], [big, -big]]) {
    assert.equal(
      facingFromVecDeadband(dx, dy, 'n', WANDER.FACING_DEADBAND),
      facingFromVec(dx, dy, 'n'),
      `above-deadband (${dx},${dy}) defers to facingFromVec`,
    );
  }
});

test('facingFromVecDeadband: deterministic — same inputs, same output twice', () => {
  const a = facingFromVecDeadband(0.3, -0.2, 'sw', WANDER.FACING_DEADBAND);
  const b = facingFromVecDeadband(0.3, -0.2, 'sw', WANDER.FACING_DEADBAND);
  assert.equal(a, b, 'pure: identical args → identical Dir8');
  // And a real step is likewise stable across two calls.
  const c = facingFromVecDeadband(3, 4, 'n', WANDER.FACING_DEADBAND);
  const d = facingFromVecDeadband(3, 4, 'n', WANDER.FACING_DEADBAND);
  assert.equal(c, d, 'pure on the real-step path too');
});

test('facingFromVecDeadband: a corner grind never flips facing, then a real step turns it', () => {
  // Simulate the bug: a boxed-in animal gets a DIFFERENT tiny slide every tick
  // (steerAround's probe fan picking a fresh clear micro-direction as the body
  // shifts a fraction of a unit). Each is below the deadband, so facing must NOT
  // change across the whole grind — the vibration is gone.
  const tiny = WANDER.FACING_DEADBAND * 0.4;
  const grind = [
    [tiny, 0], [-tiny, 0], [0, tiny], [0, -tiny],
    [tiny, tiny], [-tiny, tiny], [tiny, -tiny], [-tiny, -tiny],
    [tiny * 0.5, tiny * 0.3], [-tiny * 0.2, -tiny * 0.7],
  ];
  let facing = 's'; // the animal's settled facing before it got boxed in
  for (const [dx, dy] of grind) {
    facing = facingFromVecDeadband(dx, dy, facing, WANDER.FACING_DEADBAND);
    assert.equal(facing, 's', `grind slide (${dx.toFixed(2)},${dy.toFixed(2)}) must hold facing`);
  }
  // Now it breaks free with a real westward step — facing finally turns.
  facing = facingFromVecDeadband(-(WANDER.FACING_DEADBAND * 3), 0, facing, WANDER.FACING_DEADBAND);
  assert.equal(facing, 'w', 'a real step past the deadband turns the animal');
});
