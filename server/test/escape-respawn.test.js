'use strict';

/**
 * Phase 5C regression: escape DESPAWNs the herd a player led out the gate, and the
 * server's per-room respawn QUEUE re-materializes each follower inside its home pen
 * after FOLLOW.RESPAWN_SECS. Proves:
 *   - scoreEscape removes the follower entity from the room (no ghost herd at the gate);
 *   - the follower is NOT back before the 15s timer (stepRespawns is a no-op early);
 *   - once the timer elapses, stepRespawns re-creates the SAME id, kind:'animal',
 *     humanLikeness 0, with no follow state, INSIDE its home-pen bounds.
 *
 * Uses a real generated room so spawnForSpecies + getHomeCentersBySpecies resolve
 * against actual map geometry. Zero new deps: Node's built-in test runner.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const config = require('../config');
const { secsToTicks } = require('../game/room-utils');

test('escape despawns the herd and respawns it in-pen after RESPAWN_SECS', async () => {
  const world = require('../game/world');
  await world.loadSharedWorld();
  const stealth = require('../game/stealth');
  const follow = require('../game/follow');
  if (stealth.loadShared) await stealth.loadShared();

  const ROOM = 'escape-respawn-test-room';
  world.removeRoom(ROOM); // clean room world
  follow.clearRespawnQueue(ROOM);

  // Grab a real pen animal from the generated room as the follower-to-be.
  const animals = world.getWorldEntities(ROOM).filter((e) => e.kind === 'animal');
  assert.ok(animals.length > 0, 'the generated room has pen animals');
  const follower = animals[0];
  const species = follower.species;

  // Leash it to a player as an ACTIVE follower (the escape edge banks LIVE followers).
  const tick0 = 1000;
  const player = { id: 'escaper', species: 'ape', room: ROOM };
  follower.followerOf = player.id;
  follower.followUntilTick = tick0 + 10000; // live well past the escape tick
  follower.followSince = tick0;
  follower.stolen = false;

  // ESCAPE: scoreEscape banks the herd, despawns the follower, queues its respawn.
  follow.scoreEscape(player, ROOM, tick0);

  // The follower must be GONE from the world immediately (no ghost herd).
  const present = () => world.getWorldEntities(ROOM).some((e) => e.id === follower.id);
  assert.equal(present(), false, 'the escaped follower despawned from the room at the gate');
  assert.ok(player.lastScore && player.lastScore.herd === 1, 'score banked one herd member');

  // BEFORE the timer: stepRespawns is a no-op — still gone.
  const respawnTicks = secsToTicks(config.FOLLOW.RESPAWN_SECS);
  follow.stepRespawns(ROOM, tick0 + respawnTicks - 1);
  assert.equal(present(), false, 'follower stays despawned until RESPAWN_SECS elapses');

  // AT the timer: stepRespawns re-materializes it inside its home pen, fresh.
  follow.stepRespawns(ROOM, tick0 + respawnTicks);
  assert.equal(present(), true, 'follower respawned once RESPAWN_SECS elapsed');

  const reborn = world.getWorldEntities(ROOM).find((e) => e.id === follower.id);
  assert.equal(reborn.kind, 'animal', 'respawned entity is an animal');
  assert.equal(reborn.species, species, 'same species as before');
  assert.equal(reborn.humanLikeness, 0, 'respawns as a clean idle decoy (humanLikeness 0)');
  assert.equal(reborn.followerOf, undefined, 'respawns with no follow state');

  // It lands INSIDE its home pen bounds (guaranteed walkable + contained).
  const bounds = world.getHomeBoundsBySpecies(ROOM).get(species);
  assert.ok(bounds, 'species has a home pen');
  assert.ok(
    reborn.x >= bounds.minX && reborn.x <= bounds.maxX &&
    reborn.y >= bounds.minY && reborn.y <= bounds.maxY,
    'respawned animal is inside its home-pen bounds',
  );

  world.removeRoom(ROOM);
  follow.clearRespawnQueue(ROOM);
});
