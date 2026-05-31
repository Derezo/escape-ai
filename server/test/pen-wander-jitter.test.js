'use strict';

/**
 * Anti-bounce regression gate: a penned animal driven by the REAL stepIdleAnimals
 * code path must NOT vibrate (the reported "tortoise flips E/W in its pond pen").
 *
 * Root cause (see CHANGELOG 0.2.153+): the old reactive wanderAvoid generated a
 * wander heading that pointed into an interior obstacle (a pond's solid deep-water
 * core) for ~40 ticks, and steerAround deflected to a tangent that flip-flopped tick
 * to tick — the body bounced E/W in place and facing snapped e↔w. The fix routes a
 * pen animal to a deterministic reachable interior tile via A* and turn-rate-limits
 * the committed heading, so the heading can never reverse in one tick.
 *
 * The metric that matters is NEAR-OPPOSITE REVERSALS — a facing change to a direction
 * ≥135° away from the facing K ticks earlier. Circling an obstacle legitimately turns
 * a lot; only a per-tick reversal is the visible vibration. We assert reversals == 0
 * for a tortoise (the worst case — its pond pen has a solid deep-water core), and that
 * it actually TRAVELS (net displacement well above the bouncing-in-place baseline).
 *
 * Uses a real generated room so the pond geometry + containment bounds are the real
 * ones. Zero new deps: Node's built-in test runner over the real server modules.
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
/** Count facing changes whose direction is ≥135° from the facing K ticks ago. */
function countReversals(facings, K = 4) {
  let reversals = 0;
  for (let i = K; i < facings.length; i++) {
    if (facings[i] !== facings[i - 1] && angSep(facings[i], facings[i - K]) >= (3 * Math.PI / 4)) {
      reversals++;
    }
  }
  return reversals;
}

test('the tortoise (pond pen, solid deep-water core) does not vibrate and travels', async () => {
  const world = require('../game/world');
  await world.loadSharedWorld();
  const stealth = require('../game/stealth');
  if (stealth.loadShared) await stealth.loadShared();

  const ROOM = 'pen-wander-jitter-test-room';
  world.removeRoom(ROOM);

  // The tortoise lives in a 'pond' pen — a passable shallow ring around a SOLID
  // deep-water core — the exact geometry that produced the reported E/W bounce.
  const animals = world.getWorldEntities(ROOM).filter((e) => e.kind === 'animal' && typeof e.id === 'string' && e.id.startsWith('pen-'));
  assert.ok(animals.length > 0, 'the generated room has penned animals');
  const tortoise = animals.find((e) => e.species === 'tortoise') || animals[0];

  const DT = 1 / 20;
  const TICKS = 600;
  const startX = tortoise.x;
  const startY = tortoise.y;
  const facings = [];
  let maxDispFromStart = 0;
  for (let t = 0; t < TICKS; t++) {
    stealth.stepIdleAnimals(DT, ROOM, 1000 + t);
    facings.push(tortoise.facing || 's');
    maxDispFromStart = Math.max(maxDispFromStart, Math.hypot(tortoise.x - startX, tortoise.y - startY));
  }

  const reversals = countReversals(facings);
  assert.equal(
    reversals, 0,
    `a penned ${tortoise.species} made ${reversals} near-opposite facing reversals in ${TICKS} ticks — that is the E/W bounce, it must be 0`,
  );

  // It must genuinely roam its pen, not bounce in place. The bouncing baseline reached
  // only ~10 units of net travel; a real saunter covers far more than one tile.
  assert.ok(
    maxDispFromStart > 32 * 2,
    `a penned ${tortoise.species} only moved ${maxDispFromStart.toFixed(1)} units from start — it is stuck/bouncing, not wandering`,
  );

  world.removeRoom(ROOM);
});

test('NO penned animal of any species vibrates (whole-zoo anti-bounce gate)', async () => {
  const world = require('../game/world');
  await world.loadSharedWorld();
  const stealth = require('../game/stealth');
  if (stealth.loadShared) await stealth.loadShared();

  const ROOM = 'pen-wander-jitter-zoo-room';
  world.removeRoom(ROOM);

  const animals = world.getWorldEntities(ROOM).filter((e) => e.kind === 'animal' && typeof e.id === 'string' && e.id.startsWith('pen-'));
  assert.ok(animals.length > 10, 'the generated room has a full zoo of penned animals');

  const DT = 1 / 20;
  const TICKS = 600;
  const seqs = new Map(animals.map((a) => [a.id, []]));
  for (let t = 0; t < TICKS; t++) {
    stealth.stepIdleAnimals(DT, ROOM, 1000 + t);
    for (const a of animals) seqs.get(a.id).push(a.facing || 's');
  }

  // The visible vibration is a SUSTAINED per-tick reversal. A lone isolated reversal (a
  // single repath blip) is not vibration, so allow ≤1 per animal but assert the TOTAL
  // across the whole zoo stays tiny — vs the bouncing baseline (tens per animal).
  let worst = { id: null, rev: 0 };
  let total = 0;
  for (const a of animals) {
    const rev = countReversals(seqs.get(a.id));
    total += rev;
    if (rev > worst.rev) worst = { id: a.id, rev };
  }
  assert.ok(
    worst.rev <= 1,
    `${worst.id} made ${worst.rev} near-opposite reversals — a single animal is vibrating`,
  );
  assert.ok(
    total <= animals.length * 0.1,
    `${total} total reversals across ${animals.length} penned animals — too many; the bounce is back`,
  );

  world.removeRoom(ROOM);
});

test('the pen-wander is deterministic — two identical runs match bit-for-bit', async () => {
  const world = require('../game/world');
  await world.loadSharedWorld();
  const stealth = require('../game/stealth');
  if (stealth.loadShared) await stealth.loadShared();

  const run = () => {
    const ROOM = 'pen-wander-determinism-room';
    world.removeRoom(ROOM);
    const animals = world.getWorldEntities(ROOM).filter((e) => e.kind === 'animal' && typeof e.id === 'string' && e.id.startsWith('pen-'));
    const tortoise = animals.find((e) => e.species === 'tortoise') || animals[0];
    const trace = [];
    for (let t = 0; t < 200; t++) {
      stealth.stepIdleAnimals(1 / 20, ROOM, 5000 + t);
      trace.push([+tortoise.x.toFixed(6), +tortoise.y.toFixed(6), tortoise.facing]);
    }
    world.removeRoom(ROOM);
    return trace;
  };

  assert.deepEqual(run(), run(), 'same room + same ticks → bit-identical pen-wander path');
});

test('the pen-wander target tile is never a solid cell (deep-water core excluded)', async () => {
  const world = require('../game/world');
  await world.loadSharedWorld();
  const stealth = require('../game/stealth');
  if (stealth.loadShared) await stealth.loadShared();

  const ROOM = 'pen-wander-target-solid-room';
  world.removeRoom(ROOM);
  const rm = world.getRoomMap(ROOM);
  const animals = world.getWorldEntities(ROOM).filter((e) => e.kind === 'animal' && typeof e.id === 'string' && e.id.startsWith('pen-'));

  // Drive the zoo; every tick, the followed A* waypoint (and thus the standing cell)
  // must be non-solid — a tortoise can never be routed onto its pond's deep-water core.
  for (let t = 0; t < 300; t++) {
    stealth.stepIdleAnimals(1 / 20, ROOM, 2000 + t);
    for (const a of animals) {
      const tx = Math.floor(a.x / rm.tile);
      const ty = Math.floor(a.y / rm.tile);
      assert.ok(
        tx >= 0 && ty >= 0 && tx < rm.w && ty < rm.h && rm.collision[ty * rm.w + tx] === 0,
        `${a.id} stood on a solid cell (${tx},${ty}) at tick ${t} — pen-wander routed it into a wall/water`,
      );
    }
  }
  world.removeRoom(ROOM);
});
