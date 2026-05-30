'use strict';

/**
 * The "shepherd an animal out" loop — collect / feed / follow / steal / score,
 * server authoritative. Mirrors game/quests.js: this module owns ONLY these rules;
 * engine.js and stealth.js call into it. The deterministic movement math lives once
 * in shared/dist/step.js (moveWithCollision); this is the orchestrator, exactly
 * like stealth.js — it never re-implements the math.
 *
 * Identity model: a "follower" is one of the existing idle penAnchor decoy animals
 * (a world entity, kind:'animal') that a player has fed its liked food. The player
 * is NOT that entity — feeding CLAIMS the decoy by stamping `followerOf` (+ timers)
 * on it. The whole decoy→follower→released lifecycle is field transitions on ONE
 * stable entity id, so ownership is always a single-writer mutation on the entity.
 *
 * Timing is in TICKS (secsToTicks), never wall-clock — so the decaying ring the
 * client floats over a follower is derived purely from
 * (followUntilTick - latestTick) / (followUntilTick - followSince), both stamped
 * here. These fields ride the animal's snapshot delta automatically (the Entity
 * index signature, no net.ts change; the follower also moves every tick so it is
 * already in the per-tick delta).
 *
 * shared is ESM and the server is CommonJS, so the shared math is loaded ONCE by
 * stealth.loadShared() and HANDED here via setShared() (one cached copy of the
 * module). The live player + room maps come via setRefs() from engine.init().
 */

const config = require('../config');
const world = require('./world');
const { bumpStat, bumpEscapedSpecies } = require('./stats-delta');

// The cached shared module (handed over by stealth.loadShared via setShared).
let shared = null;
// The engine's live player + room maps (handed over by engine.init via setRefs),
// so we can resolve a follower's owner back to the live player object each tick.
let connectedPlayers = null; // Map<socketId, player>
let rooms = null;            // Map<roomName, Set<socketId>>

/** Hand over the cached shared step module. Called from stealth.loadShared(). */
function setShared(mod) {
  shared = mod;
}

/** Hand over the engine's live player + room maps. Called from engine.init(). */
function setRefs(players, roomsMap) {
  connectedPlayers = players;
  rooms = roomsMap;
}

/** Seconds → whole ticks (deterministic; mirrors stealth.secsToTicks). */
function secsToTicks(secs) {
  return Math.round(secs * config.TICK_RATE);
}

// --- player state -----------------------------------------------------------

/** Initialize a player's food bag. Called on join (lobby.js) and respawn. */
function initPlayer(player) {
  if (!player) return;
  player.inventory = {};
}

/**
 * Reset a player's collection state: empty the food bag and clear any pending
 * gate-score toast. Followers are released separately (releaseFollowersOf) since
 * that needs the room. Called from catchPlayer + respawnPlayer.
 */
function resetPlayer(player) {
  if (!player) return;
  player.inventory = {};
  player.lastScore = null;
}

// --- collect ----------------------------------------------------------------

/**
 * Collect one unit from the nearest kind:'food' source in reach. Food sources are
 * RENEWABLE (collecting never removes the entity — keeps the 14 sources static and
 * the world deterministic; it's a feeding station, not a one-shot pickup). Returns
 * true if something was collected, so applyAction's 'interact' branch early-returns
 * and a single press never both collects food AND orders a robot near a terminal.
 * @param {object} player
 * @param {string} roomName
 * @param {number} currentTick
 * @returns {boolean}
 */
function collectNearbyFood(player, roomName, currentTick) {
  if (!shared) return false;
  const r2 = config.RECT_SIZE * config.RECT_SIZE;
  let nearest = null;
  let nearestD2 = Infinity;
  for (const e of world.getWorldEntities(roomName)) {
    if (e.kind !== 'food') continue;
    const d2 = shared.dist2(player, e);
    if (d2 <= r2 && d2 < nearestD2) {
      nearestD2 = d2;
      nearest = e;
    }
  }
  if (!nearest) return false;
  const key = nearest.foodKey || world.foodForSpecies(nearest.species).key;
  if (!player.inventory) player.inventory = {};
  player.inventory[key] = (player.inventory[key] || 0) + 1;
  bumpStat(player, 'foodCollected');
  // FX echo so the client can fire a pickup burst/SFX on this player's entity.
  setFx(player, 'collect', currentTick);
  return true;
}

// --- feed / steal -----------------------------------------------------------

/**
 * Feed the nearest feedable animal in reach its liked food (if the player carries
 * it). A NEW capture or a top-up of your own follower ACCUMULATES the follow time
 * (capped); feeding an animal already following ANOTHER player STEALS it (fresh
 * timer, ownership transfer, theft credited). Returns 'fed' | 'stolen' | null.
 * @param {object} player
 * @param {string} roomName
 * @param {number} currentTick
 * @returns {'fed'|'stolen'|null}
 */
function feedNearbyAnimal(player, roomName, currentTick) {
  if (!shared) return null;
  const r2 = config.RECT_SIZE * config.RECT_SIZE;

  // Nearest feedable idle/following animal whose liked food we actually carry.
  let target = null;
  let bestD2 = Infinity;
  for (const e of world.getWorldEntities(roomName)) {
    if (e.kind !== 'animal') continue;
    if (e.expireTick) continue; // skip transient fox-decoy animals
    const liked = world.foodForSpecies(e.species).key;
    if (!(player.inventory && player.inventory[liked] > 0)) continue;
    const d2 = shared.dist2(player, e);
    if (d2 <= r2 && d2 < bestD2) {
      bestD2 = d2;
      target = e;
    }
  }
  if (!target) return null;

  const liked = world.foodForSpecies(target.species).key;
  player.inventory[liked] -= 1; // consume one unit

  const grant = secsToTicks(config.FOLLOW.GRANT_SECS);
  const cap = secsToTicks(config.FOLLOW.CAP_SECS);
  const prevOwner = target.followerOf || null;
  const isSteal = prevOwner && prevOwner !== player.id;

  if (isSteal) {
    // STEAL: reset to a FRESH single grant (not accumulative) and reassign owner.
    target.followerOf = player.id;
    target.followUntilTick = currentTick + grant;
    target.followSince = currentTick; // ring restarts full
    target.stolen = true;             // worth more at the gate
    bumpStat(player, 'animalsStolen');
    setFx(target, 'steal', currentTick);
    return 'stolen';
  }

  // FEED (new capture, or top-up of your own follower): ACCUMULATIVE, CAPPED.
  const remaining = Math.max(0, (target.followUntilTick || 0) - currentTick);
  const newRemaining = Math.min(cap, remaining + grant);
  target.followUntilTick = currentTick + newRemaining;
  target.followSince = currentTick; // ring refills to full on every feed
  if (prevOwner !== player.id) {
    target.followerOf = player.id; // first feed by this player (a wild capture)
    target.stolen = false;
  }
  setFx(target, 'feed', currentTick);
  return 'fed';
}

// --- per-tick follower movement --------------------------------------------

/** True if an animal entity is an ACTIVE follower at `tick` (used by
 *  stepIdleAnimals to skip it so it isn't both drifted and pulled). */
function isFollower(entity, tick) {
  return !!entity.followerOf && (entity.followUntilTick || 0) > tick;
}

/**
 * Move every active follower one step toward its owner (collision-aware, shared
 * integrator) and release any whose timer lapsed or whose owner vanished. Runs in
 * engine.stepNpcs AFTER stepIdleAnimals (which skips followers) and BEFORE
 * stepRobots (so robots perceive followers at this tick's positions). Deterministic:
 * integer-tick comparisons, Map insertion order, shared math, dt passed in.
 * @param {number} dt
 * @param {string} roomName
 * @param {number} currentTick
 */
function stepFollowers(dt, roomName, currentTick) {
  if (!shared) return;
  const rm = world.getRoomMap(roomName);
  const speed = config.FOLLOW.SPEED;
  const stop2 = config.FOLLOW.STOP_DIST * config.FOLLOW.STOP_DIST;
  const radius = config.RECT_SIZE * 0.4;

  for (const e of world.getWorldEntities(roomName)) {
    if (e.kind !== 'animal' || !e.followerOf) continue;

    // EXPIRE: the follow lapsed → release to idle drift (stepIdleAnimals owns it
    // again next tick).
    if ((e.followUntilTick || 0) <= currentTick) {
      releaseFollower(e);
      continue;
    }

    // OWNER GONE: disconnected / no longer in this room → release. (Disconnect /
    // catch / escape free followers at their own chokepoints; this is the per-tick
    // backstop so a follower never chases a ghost.)
    const owner = findPlayerById(roomName, e.followerOf);
    if (!owner || owner.escaped) {
      releaseFollower(e);
      continue;
    }

    // Move toward the owner with the shared sliding integrator (same call shape as
    // stealth.movePlayerWithCollision / the robot trial). Stop within STOP_DIST so
    // it trails rather than jittering on top of the owner.
    if (shared.dist2(e, owner) > stop2) {
      const dx = owner.x - e.x;
      const dy = owner.y - e.y;
      const len = Math.hypot(dx, dy) || 1;
      shared.moveWithCollision(
        e, dx / len, dy / len, dt, speed,
        rm.collision, rm.w, rm.h, rm.tile, radius,
      );
      e.facing = shared.facingFromVec(dx / len, dy / len, e.facing || 's');
    }
  }
}

// --- scoring + release ------------------------------------------------------

/** Every ACTIVE follower of a player in a room (followerOf===playerId, live). */
function gatherFollowersOf(roomName, playerId, currentTick) {
  const out = [];
  for (const e of world.getWorldEntities(roomName)) {
    if (e.kind === 'animal' && e.followerOf === playerId && (e.followUntilTick || 0) > currentTick) {
      out.push(e);
    }
  }
  return out;
}

/**
 * Score a player's escape and bank the herd. Called from stealth.checkEscape on the
 * escape edge. Awards SCORE_OWN for the player's own animal + per-follower (more for
 * a stolen one), credits escaped-by-species for the player AND each follower, then
 * RELEASES every follower (back to idle drift). Stamps player.lastScore (the client
 * toast) and bumps player.scoreTotal (the running round score, persists respawn).
 * @param {object} player
 * @param {string} roomName
 * @param {number} currentTick
 */
function scoreEscape(player, roomName, currentTick) {
  const followers = gatherFollowersOf(roomName, player.id, currentTick);
  let points = config.FOLLOW.SCORE_OWN;
  let stolenCount = 0;
  bumpEscapedSpecies(player, player.species); // your own animal out, by species
  for (const f of followers) {
    if (f.stolen) {
      points += config.FOLLOW.SCORE_STOLEN;
      stolenCount += 1;
    } else {
      points += config.FOLLOW.SCORE_FOLLOWER;
    }
    bumpEscapedSpecies(player, f.species); // each follower out, by its species
    releaseFollower(f);                    // released at the gate → back to idle
  }
  player.lastScore = { points, herd: followers.length, stolen: stolenCount, tick: currentTick };
  player.scoreTotal = (player.scoreTotal || 0) + points;
}

/** Clear all follow state on an animal → it reverts to an idle decoy. */
function releaseFollower(entity) {
  if (!entity) return;
  entity.followerOf = null;
  entity.followUntilTick = 0;
  entity.followSince = 0;
  entity.stolen = false;
}

/** Release every follower owned by `playerId` in a room (disconnect/catch/respawn). */
function releaseFollowersOf(roomName, playerId) {
  for (const e of world.getWorldEntities(roomName)) {
    if (e.kind === 'animal' && e.followerOf === playerId) releaseFollower(e);
  }
}

// --- helpers ----------------------------------------------------------------

/** Resolve a player by its game id within a room (mirrors stealth.findPlayerById,
 *  using the refs handed over at init so follow.js doesn't reach into stealth). */
function findPlayerById(roomName, playerId) {
  if (!connectedPlayers || !rooms) return null;
  const members = rooms.get(roomName);
  if (!members) return null;
  for (const socketId of members) {
    const p = connectedPlayers.get(socketId);
    if (p && p.id === playerId) return p;
  }
  return null;
}

/** Stamp the render-echo of a collect/feed/steal event onto an entity. Mirrors
 *  stealth.setFx: startTick is the client's one-shot edge; a short untilTick drives
 *  any brief sustained glow. */
function setFx(entity, kind, currentTick) {
  const t = currentTick || 0;
  entity.fx = { kind, startTick: t, untilTick: t + Math.max(1, secsToTicks(0.5)) };
}

module.exports = {
  setShared,
  setRefs,
  initPlayer,
  resetPlayer,
  collectNearbyFood,
  feedNearbyAnimal,
  isFollower,
  stepFollowers,
  gatherFollowersOf,
  scoreEscape,
  releaseFollower,
  releaseFollowersOf,
};
