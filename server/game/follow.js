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
const { secsToTicks, findPlayerById } = require('./room-utils');

// The cached shared modules (handed over by stealth.loadShared via setShared).
// `shared` = step.js (math/collision); `movement` = movement.js (chain/steer);
// `locomotion` = locomotion.js (per-species gait). The latter two are used by the
// chain-follow + return-home work; harmless to hold even before they're wired.
let shared = null;
let movement = null;
let locomotion = null;
// The engine's live player + room maps (handed over by engine.init via setRefs),
// so we can resolve a follower's owner back to the live player object each tick.
let connectedPlayers = null; // Map<socketId, player>
let rooms = null;            // Map<roomName, Set<socketId>>

/** Hand over the cached shared modules. Called from stealth.loadShared(). `moveMod`
 *  and `locoMod` are optional so older callers (and tests) that pass only the step
 *  module keep working; the chain/return-home paths require them. (A 4th `pathMod`
 *  arg is passed by stealth.loadShared and wired here in Phase 3 for return-home A*.) */
function setShared(mod, moveMod, locoMod) {
  shared = mod;
  if (moveMod) movement = moveMod;
  if (locoMod) locomotion = locoMod;
}

/** Hand over the engine's live player + room maps. Called from engine.init(). */
function setRefs(players, roomsMap) {
  connectedPlayers = players;
  rooms = roomsMap;
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
    // The food now lives inside an aux building whose door starts LOCKED. Skip a
    // source whose building is still locked so it's invisible to collection until
    // the player taps its door-terminal — but DON'T let a locked source shadow a
    // reachable unlocked one in the same range (two buildings' walls can sit within
    // a single RECT_SIZE). A source with no buildingId (defensive fallback) is never
    // gated. The skip is the entire lock enforcement; the door tile stays non-solid.
    if (e.buildingId && world.isDoorLocked(roomName, e.buildingId)) continue;
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

  // A re-feed (within grace, or of an animal that had detached to drift home)
  // re-leashes it: clear the grace + return-home state so it snaps back into the
  // chain instead of lagging out or wandering off.
  target.graceUntilTick = 0;
  target.returningHome = false;
  target.homeX = undefined;
  target.homeY = undefined;

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

/** True if an animal entity is an ACTIVE follower at `tick` (its follow timer is
 *  still live — not counting the grace window). */
function isFollower(entity, tick) {
  return !!entity.followerOf && (entity.followUntilTick || 0) > tick;
}

/** True if an animal is still LEASHED to its owner at `tick`: an active follower,
 *  OR a lapsed one still inside its grace window (it lags in the chain a beat,
 *  and a re-feed snaps it back). stepIdleAnimals skips a leashed animal so it
 *  isn't both drifted by wander AND pulled along the chain in the same tick. */
function isLeashed(entity, tick) {
  return !!entity.followerOf && (
    (entity.followUntilTick || 0) > tick || (entity.graceUntilTick || 0) > tick
  );
}

/**
 * Move every leashed follower one step along its owner's CHAIN this tick, and
 * transition any whose timer/grace lapsed (drift home) or whose owner vanished.
 * Followers form a line: the oldest-fed link trails the player, the next link
 * trails it, and so on (player → f1 → f2 → …). Runs in engine.stepNpcs AFTER
 * stepIdleAnimals (which skips leashed animals) and BEFORE stepRobots (so robots
 * perceive followers at this tick's positions). Deterministic: integer-tick
 * comparisons, a stable sort, shared math, dt passed in.
 * @param {number} dt
 * @param {string} roomName
 * @param {number} currentTick
 */
function stepFollowers(dt, roomName, currentTick) {
  if (!shared || !movement || !locomotion) return;
  const rm = world.getRoomMap(roomName);
  const radius = config.RECT_SIZE * 0.4;

  const entities = world.getWorldEntities(roomName);

  // 1) Lifecycle pass: expire (→ grace, then drift home) / owner-gone, BEFORE the
  //    chain is built so a detached link isn't part of this tick's line.
  for (const e of entities) {
    if (e.kind !== 'animal' || !e.followerOf) continue;

    // OWNER GONE: disconnected / no longer in this room / escaped → drift home.
    const owner = findPlayerById(connectedPlayers, rooms, roomName, e.followerOf);
    if (!owner || owner.escaped) {
      releaseToHome(e, roomName);
      continue;
    }

    // TIMER LAPSED → enter the grace window (once), keep lagging in the chain.
    if ((e.followUntilTick || 0) <= currentTick) {
      if (!e.graceUntilTick) e.graceUntilTick = currentTick + secsToTicks(config.FOLLOW.GRACE_SECS);
      // GRACE ELAPSED with no re-feed → detach and drift home.
      if ((e.graceUntilTick || 0) <= currentTick) {
        releaseToHome(e, roomName);
        continue;
      }
    }
  }

  // 2) Chain pass: group the still-leashed followers by owner, order each owner's
  //    chain (oldest fed first = closest to the player), and step front-to-back so
  //    each link chases its predecessor's ALREADY-UPDATED position this tick.
  const byOwner = new Map(); // ownerId -> follower entities
  for (const e of entities) {
    if (e.kind === 'animal' && isLeashed(e, currentTick)) {
      const list = byOwner.get(e.followerOf) || [];
      list.push(e);
      byOwner.set(e.followerOf, list);
    }
  }

  const gap = config.FOLLOW.GAP;
  const speed = config.FOLLOW.SPEED;
  for (const [ownerId, chain] of byOwner) {
    const owner = findPlayerById(connectedPlayers, rooms, roomName, ownerId);
    if (!owner) continue; // handled in the lifecycle pass; defensive
    // Stable chain order: oldest follow first (front), tie-broken by id hash so a
    // same-tick double-feed is deterministic regardless of Map iteration order.
    chain.sort((a, b) => (a.followSince - b.followSince) || (shared.hash32(a.id) - shared.hash32(b.id)));

    let prev = { x: owner.x, y: owner.y }; // link 0 trails the player
    for (let i = 0; i < chain.length; i++) {
      const e = chain[i];
      e.chainIndex = i; // client-cosmetic cache; recomputed every tick
      stepChainLink(e, prev, owner, gap, speed, dt, currentTick, rm, radius);
      prev = { x: e.x, y: e.y }; // next link trails THIS link's now-updated position
    }
  }
}

/**
 * Move one chain link one step toward `leader` (the player for link 0, else the
 * predecessor link), trailing by `gap`. Applies the species gait (locomotionStep)
 * and obstacle-aware steering. Deterministic anti-stuck ladder: if a step makes
 * ~no progress while still beyond the gap, retry steering toward the OWNER (the
 * proven-reachable anchor — the conga-line corner-snag fix); if still jammed, a
 * deterministic per-(id,tick) jitter; else hold this tick.
 */
function stepChainLink(e, leader, owner, gap, speed, dt, currentTick, rm, radius) {
  const link = movement.chainFollowStep(e, leader, gap);
  if (!link.moving) {
    // Within the gap: trail in place, but still face the leader so the line reads.
    e.facing = shared.facingFromVec(leader.x - e.x, leader.y - e.y, e.facing || 's');
    return;
  }

  const tryStep = (desX, desY) => {
    const heading = movement.steerAround(e, desX, desY, dt, speed, rm.collision, rm.w, rm.h, rm.tile, radius);
    if (heading.dirX === 0 && heading.dirY === 0) return false;
    const bx = e.x;
    const by = e.y;
    locomotion.locomotionStep(e, heading.dirX, heading.dirY, currentTick, dt, speed, rm.collision, rm.w, rm.h, rm.tile, radius);
    e.facing = shared.facingFromVec(heading.dirX, heading.dirY, e.facing || 's');
    // Progress = real displacement; a hop-pause tick legitimately makes none.
    return (e.x - bx) * (e.x - bx) + (e.y - by) * (e.y - by) > STUCK_EPS2;
  };

  // 1) Aim at the immediate leader (predecessor).
  if (tryStep(link.dirX, link.dirY)) return;
  // 2) Stuck: aim at the owner (reachable anchor) — cut the corner toward the head.
  const odx = owner.x - e.x;
  const ody = owner.y - e.y;
  const olen = Math.hypot(odx, ody) || 1;
  if (tryStep(odx / olen, ody / olen)) return;
  // 3) Still jammed: a deterministic jitter heading so it doesn't pin dead-still.
  const j = (shared.hash32(e.id) ^ Math.floor(currentTick / JITTER_BUCKET_TICKS)) % 8;
  const ja = (j / 8) * Math.PI * 2;
  tryStep(Math.cos(ja), Math.sin(ja));
  // (If even the jitter is blocked the link holds this tick; the leader keeps
  //  moving so the geometry changes next tick — no permanent deadlock.)
}

/** Squared min-progress threshold for the chain anti-stuck check (a fraction of a
 *  full step at FOLLOW.SPEED; below this the slide is considered jammed). */
const STUCK_EPS2 = 1; // ~1 world unit of progress
/** Re-roll window (ticks) for the deterministic anti-stuck jitter heading. */
const JITTER_BUCKET_TICKS = 10;

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

/** Clear all follow state on an animal → it reverts to an idle decoy. The HARD
 *  reset (gate score, disconnect, catch, respawn) — no drift-home; the animal
 *  just goes back to wandering its pen wherever it stands. */
function releaseFollower(entity) {
  if (!entity) return;
  entity.followerOf = null;
  entity.followUntilTick = 0;
  entity.followSince = 0;
  entity.stolen = false;
  entity.graceUntilTick = 0;
  entity.chainIndex = undefined;
}

/**
 * SOFT release on a natural lapse (timer + grace elapsed, or owner vanished): the
 * animal detaches and DRIFTS HOME — wanders biased toward its enclosure center
 * over time (stealth.stepIdleAnimals runs the home-biased drift; once back inside
 * its home bounds it clears the flag and resumes a contained wander). If the
 * species has no home center (a transient fox decoy, an unlisted species) we fall
 * back to the plain hard reset → it just wanders where it stands.
 * @param {object} entity
 * @param {string} roomName
 */
function releaseToHome(entity, roomName) {
  if (!entity) return;
  const home = world.getHomeCentersBySpecies(roomName).get(entity.species);
  releaseFollower(entity); // clear the follow state first (also clears grace/chainIndex)
  if (home) {
    entity.returningHome = true;
    entity.homeX = home.x;
    entity.homeY = home.y;
  }
}

/** Release every follower owned by `playerId` in a room (disconnect/catch/respawn). */
function releaseFollowersOf(roomName, playerId) {
  for (const e of world.getWorldEntities(roomName)) {
    if (e.kind === 'animal' && e.followerOf === playerId) releaseFollower(e);
  }
}

// --- helpers ----------------------------------------------------------------

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
  isLeashed,
  stepFollowers,
  gatherFollowersOf,
  scoreEscape,
  releaseFollower,
  releaseToHome,
  releaseFollowersOf,
};
