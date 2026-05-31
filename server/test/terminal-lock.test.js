'use strict';

/**
 * End-to-end behavior check for the keeper-terminal activation lock + 15s
 * auto-deactivate (game/caves-of-steel feature). Exercises the REAL quests.js +
 * world.js modules in engine load order, driving the ACTUAL world.pruneExpired
 * sweep over a real room world (terminals seeded via world.addWorldEntity, so
 * quests.nearestTerminal and pruneExpired read the same live entities).
 *
 * Invariants under test:
 *   1. Activating a terminal counts it for the activator AND stamps the shared
 *      world-entity lock (activatedBy/activatedTick).
 *   2. A DIFFERENT player cannot count a terminal locked by someone else within
 *      the 15s window (isTerminalLockedByOther true; onInteract is a no-op for them).
 *   3. The activator re-tapping their OWN still-locked terminal is a harmless no-op
 *      (idempotent; no double count).
 *   4. The real world.pruneExpired sweep releases the lock once
 *      TERMINAL.DEACTIVATE_SECS has elapsed — clearing ONLY the entity fields and
 *      NEVER touching the activator's questTerminals tally (quest progress unchanged).
 *   5. After release, the other player CAN count the freed terminal.
 *
 * Zero new deps: Node's built-in test runner over the CommonJS server modules.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const config = require('../config');
const { secsToTicks } = require('../game/room-utils');

test('terminal lock: activate stamps lock, blocks others, auto-deactivates without touching quest', async () => {
  const world = require('../game/world');
  await world.loadSharedWorld();
  // engine load order: stealth → quests → follow.
  const stealth = require('../game/stealth');
  const quests = require('../game/quests');
  require('../game/follow');
  if (stealth.loadShared) await stealth.loadShared();

  const ROOM = 'terminal-lock-test-room';
  world.removeRoom(ROOM); // start from a clean room world
  // Seed two terminals at the origin into the REAL room world, so both
  // quests.nearestTerminal (via getWorldEntities) and world.pruneExpired operate
  // on the same live objects the lock is stamped on.
  const t1 = { id: 'terminal-1', kind: 'terminal', x: 0, y: 0, name: 'terminal-1' };
  const t2 = { id: 'terminal-2', kind: 'terminal', x: 0, y: 0, name: 'terminal-2' };
  world.addWorldEntity(ROOM, t1);
  world.addWorldEntity(ROOM, t2);

  const lockTicks = secsToTicks(config.TERMINAL.DEACTIVATE_SECS);

  try {
    // elephant's step 0 is activate ×3.
    const a = { id: 'A', x: 0, y: 0, species: 'elephant', room: ROOM };
    const b = { id: 'B', x: 0, y: 0, species: 'elephant', room: ROOM };
    quests.initPlayer(a);
    quests.initPlayer(b);
    assert.equal(a.quest.type, 'activate', 'elephant step 0 is activate');

    // --- (1) A activates the nearest terminal at tick 100 -------------------
    const term = quests.nearestTerminal(a, ROOM);
    assert.ok(term, 'A finds a terminal in reach');
    const counted = quests.onInteract(a, ROOM, 100);
    assert.equal(counted, true, 'A counts a fresh terminal');
    assert.equal(a.questTerminals.size, 1, "A's tally is 1");
    assert.equal(term.activatedBy, 'A', 'lock stamped to A');
    assert.equal(term.activatedTick, 100, 'lock tick stamped');

    // --- (2) B cannot count the SAME terminal while A holds it -------------
    assert.equal(
      quests.isTerminalLockedByOther(term, b, 101),
      true,
      "B sees A's lock as held",
    );
    // Force B's nearest to be the locked one by moving t2 out of reach this beat.
    t2.x = 99999;
    const bCounted = quests.onInteract(b, ROOM, 101);
    assert.equal(bCounted, false, "B is blocked on A's locked terminal");
    assert.equal((b.questTerminals && b.questTerminals.size) || 0, 0, "B's tally stays 0");
    assert.equal(term.activatedBy, 'A', "lock still A's (B did not steal it)");
    t2.x = 0; // restore

    // --- (3) A re-tapping its own still-locked terminal is a no-op ---------
    const reCount = quests.onInteract(a, ROOM, 102);
    assert.equal(reCount, false, 'A re-tap is idempotent (no double count)');
    assert.equal(a.questTerminals.size, 1, "A's tally unchanged on re-tap");

    // --- (4) REAL pruneExpired BEFORE expiry holds the lock ----------------
    world.pruneExpired(ROOM, 100 + lockTicks - 1);
    assert.equal(term.activatedBy, 'A', 'lock held until the window elapses');

    // --- (4) REAL pruneExpired AT expiry releases it, quest untouched ------
    const tallyBefore = a.questTerminals.size;
    world.pruneExpired(ROOM, 100 + lockTicks);
    assert.equal(term.activatedBy, null, 'lock released by the 15s sweep');
    assert.equal(term.activatedTick, 0, 'lock tick cleared');
    assert.equal(a.questTerminals.size, tallyBefore, "A's quest tally UNCHANGED by deactivate");
    assert.equal(a.quest.done, 1, "A's quest progress UNCHANGED by deactivate");

    // --- (5) B can now claim the freed terminal ----------------------------
    t2.x = 99999; // again force B's nearest to be the now-free t1
    const bNow = quests.onInteract(b, ROOM, 100 + lockTicks + 1);
    assert.equal(bNow, true, 'B counts the freed terminal');
    assert.equal(b.questTerminals.size, 1, "B's tally is 1 after the release");
    assert.equal(term.activatedBy, 'B', 'lock now stamped to B');
    t2.x = 0;
  } finally {
    world.removeRoom(ROOM);
  }
});
