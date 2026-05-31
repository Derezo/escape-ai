'use strict';

/**
 * Anti-bounce regression gate for ROBOTS (companion to pen-wander-jitter.test.js).
 *
 * The user reported robots "bouncing at walls and getting stuck" too. Three robot
 * movement paths could flip facing tick-to-tick the same way the pen animals did:
 *   - patrol (patrolStep rounding a fence corner),
 *   - guard (a guard pacing e↔w inside a tiny aux building),
 *   - investigate / return / exit (moveTowardPoint's reactive steerAround at a wall).
 * The fix turn-rate-limits the committed heading on all three (and routes guards via
 * A*-to-an-interior-target like the pen animals). This drives the metric that matters —
 * NEAR-OPPOSITE facing reversals (a change ≥135° from the facing K ticks earlier) — to
 * essentially zero across the whole robot roster on the real code path.
 *
 * Uses a real generated room + the real stepRobots pipeline. Zero new deps.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const DIR8 = ['e', 'se', 's', 'sw', 'w', 'nw', 'n', 'ne'];
const dirAngle = (f) => DIR8.indexOf(f) * Math.PI / 4;
function angSep(a, b) {
  let d = Math.abs(dirAngle(a) - dirAngle(b)) % (Math.PI * 2);
  if (d > Math.PI) d = Math.PI * 2 - d;
  return d;
}
function countReversals(facings, K = 4) {
  let reversals = 0;
  for (let i = K; i < facings.length; i++) {
    if (facings[i] !== facings[i - 1] && angSep(facings[i], facings[i - K]) >= (3 * Math.PI / 4)) {
      reversals++;
    }
  }
  return reversals;
}

test('no robot vibrates — patrol + guard reversals are ~zero over a long run', async () => {
  const world = require('../game/world');
  await world.loadSharedWorld();
  const stealth = require('../game/stealth');
  if (stealth.loadShared) await stealth.loadShared();

  const ROOM = 'robot-bounce-test-room';
  world.removeRoom(ROOM);

  const robots = world.getWorldEntities(ROOM).filter((e) => e.kind === 'robot');
  assert.ok(robots.length > 0, 'the generated room has robots');
  assert.ok(robots.some((r) => r.guard), 'the room has at least one guard robot');

  // No connected players → robots patrol / guard (the steady-state movement we test).
  const players = new Map();
  const rooms = new Map([[ROOM, new Set()]]);

  const DT = 1 / 20;
  const TICKS = 800;
  const seqs = new Map(robots.map((r) => [r.id, []]));
  for (let t = 0; t < TICKS; t++) {
    stealth.stepIdleAnimals(DT, ROOM, 1000 + t);
    stealth.stepRobots(DT, ROOM, players, rooms, 1000 + t);
    for (const r of robots) seqs.get(r.id).push(r.facing || 's');
  }

  let worst = { id: null, rev: 0 };
  let total = 0;
  for (const r of robots) {
    const rev = countReversals(seqs.get(r.id));
    total += rev;
    if (rev > worst.rev) worst = { id: r.id, rev };
  }
  assert.ok(
    worst.rev <= 1,
    `${worst.id} made ${worst.rev} near-opposite facing reversals in ${TICKS} ticks — a robot is bouncing/stuck at a wall`,
  );
  assert.ok(
    total <= 2,
    `${total} total robot reversals — too many; the wall bounce is back`,
  );

  world.removeRoom(ROOM);
});

test('robots stay finite + in-world over a long pipeline run (no stuck/NaN)', async () => {
  const world = require('../game/world');
  await world.loadSharedWorld();
  const stealth = require('../game/stealth');
  if (stealth.loadShared) await stealth.loadShared();

  const ROOM = 'robot-stability-test-room';
  world.removeRoom(ROOM);
  const robots = world.getWorldEntities(ROOM).filter((e) => e.kind === 'robot');
  const rm = world.getRoomMap(ROOM);
  const players = new Map();
  const rooms = new Map([[ROOM, new Set()]]);

  for (let t = 0; t < 1500; t++) {
    stealth.stepIdleAnimals(1 / 20, ROOM, t);
    stealth.stepRobots(1 / 20, ROOM, players, rooms, t);
  }
  const worldPx = rm.w * rm.tile;
  for (const r of robots) {
    assert.ok(Number.isFinite(r.x) && Number.isFinite(r.y), `${r.id} has a non-finite position`);
    assert.ok(r.x >= 0 && r.y >= 0 && r.x <= worldPx && r.y <= worldPx, `${r.id} left the world`);
  }
  world.removeRoom(ROOM);
});

test('robot patrol/guard movement is deterministic across two identical runs', async () => {
  const world = require('../game/world');
  await world.loadSharedWorld();
  const stealth = require('../game/stealth');
  if (stealth.loadShared) await stealth.loadShared();

  const run = () => {
    const ROOM = 'robot-determinism-test-room';
    world.removeRoom(ROOM);
    const robots = world.getWorldEntities(ROOM).filter((e) => e.kind === 'robot').sort((a, b) => (a.id < b.id ? -1 : 1));
    const players = new Map();
    const rooms = new Map([[ROOM, new Set()]]);
    const trace = [];
    for (let t = 0; t < 300; t++) {
      stealth.stepIdleAnimals(1 / 20, ROOM, 7000 + t);
      stealth.stepRobots(1 / 20, ROOM, players, rooms, 7000 + t);
      trace.push(robots.map((r) => `${r.id}:${r.x.toFixed(5)},${r.y.toFixed(5)},${r.facing}`).join('|'));
    }
    world.removeRoom(ROOM);
    return trace;
  };

  assert.deepEqual(run(), run(), 'same room + same ticks → bit-identical robot movement');
});
