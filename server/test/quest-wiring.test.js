'use strict';

/**
 * Regression guard for the follow.js ↔ quests.js CIRCULAR REQUIRE.
 *
 * follow.js and quests.js require each other (quests.stepEscort needs
 * follow.gatherFollowersOf; follow's collect/feed observe quests' step hooks). In
 * the server's REAL load order — engine.js requires stealth.js first, which
 * requires quests.js, which requires follow.js while quests.js is still mid-load —
 * a top-level `const quests = require('./quests')` in follow.js would capture
 * quests' PARTIAL (empty) exports, so quests.onCollect / onRecruit were
 * `undefined` and threw the instant a player collected food or fed an animal
 * (food collection appeared "broken"). follow.js now resolves quests LAZILY at
 * call time. This test reproduces the real load order and proves the hooks are
 * callable and food collection / feeding don't throw.
 *
 * Zero new deps: Node's built-in test runner over the CommonJS server modules.
 * Run with `npm test` (server) or `node --test test/`.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

test('circular require: cross-module quest hooks resolve in the real load order', async () => {
  const world = require('../game/world');
  await world.loadSharedWorld();

  // EXACT order engine.js uses: stealth first (it pulls quests → follow), then
  // follow + quests. This is the order that exposed the partial-export bug.
  const stealth = require('../game/stealth');
  const follow = require('../game/follow');
  const quests = require('../game/quests');
  if (stealth.loadShared) await stealth.loadShared();

  // follow.js's lazily-resolved `quests` must now see the COMPLETE exports.
  for (const fn of ['onCollect', 'onRecruit', 'onOrder', 'onAbility', 'onInteract']) {
    assert.equal(typeof quests[fn], 'function', `quests.${fn} resolved`);
  }
  // quests.js's top-level `follow` capture must be complete too (used by stepEscort).
  assert.equal(typeof follow.gatherFollowersOf, 'function', 'follow.gatherFollowersOf resolved');
});

test('food collection works and advances a collect step (no throw)', async () => {
  const world = require('../game/world');
  await world.loadSharedWorld();
  const stealth = require('../game/stealth');
  const follow = require('../game/follow');
  const quests = require('../game/quests');
  if (stealth.loadShared) await stealth.loadShared();

  const ROOM = 'wiring-test-room';
  // One food source in reach at the origin.
  const orig = world.getWorldEntities;
  world.getWorldEntities = () => [{ kind: 'food', x: 0, y: 0, foodKey: 'seed', species: 'bird' }];
  try {
    // bird's first quest step is collect ×2.
    const p = { id: 'p', x: 0, y: 0, species: 'bird', inventory: {}, room: ROOM };
    quests.initPlayer(p);
    assert.equal(p.quest.type, 'collect', 'bird step 0 is collect');

    const collected = follow.collectNearbyFood(p, ROOM, 1);
    assert.equal(collected, true, 'collectNearbyFood succeeds (did not throw on the quest hook)');
    assert.equal(p.inventory.seed, 1, 'one food unit banked');
    assert.equal(p.statsDelta.foodCollected, 1, 'foodCollected stat bumped');
    assert.equal(p.quest.done, 1, 'collect step advanced to 1/2');

    follow.collectNearbyFood(p, ROOM, 2);
    assert.equal(p.inventory.seed, 2, 'second food unit banked');
    assert.equal(p.quest.stepIndex, 1, 'collect ×2 filled → rolled to the next step');
  } finally {
    world.getWorldEntities = orig;
  }
});

test('feeding an animal works and advances a recruit step (no throw)', async () => {
  const world = require('../game/world');
  await world.loadSharedWorld();
  const stealth = require('../game/stealth');
  const follow = require('../game/follow');
  const quests = require('../game/quests');
  if (stealth.loadShared) await stealth.loadShared();

  const ROOM = 'wiring-test-room-2';
  // A feedable animal of a DIFFERENT species in reach (cheetah recruits others).
  const orig = world.getWorldEntities;
  const animal = { id: 'a1', kind: 'animal', species: 'bird', x: 0, y: 0 };
  world.getWorldEntities = () => [animal];
  try {
    // cheetah's first quest step is recruit ×2.
    const p = { id: 'feeder', x: 0, y: 0, species: 'cheetah', room: ROOM };
    quests.initPlayer(p);
    follow.initPlayer(p);
    // Carry the bird's liked food so the feed lands.
    const liked = world.foodForSpecies('bird').key;
    p.inventory = { [liked]: 1 };
    assert.equal(p.quest.type, 'recruit', 'cheetah step 0 is recruit');

    const result = follow.feedNearbyAnimal(p, ROOM, 1);
    assert.equal(result, 'fed', 'feedNearbyAnimal succeeds (did not throw on the quest hook)');
    assert.equal(p.quest.done, 1, 'recruit step advanced to 1/2');
  } finally {
    world.getWorldEntities = orig;
  }
});
