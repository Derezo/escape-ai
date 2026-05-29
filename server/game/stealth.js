'use strict';

/**
 * The Caves of Steel — Three-Laws stealth core (server authoritative).
 *
 * The DETERMINISTIC math (humanLikeness curve, First-Law freeze, robot decision)
 * lives ONCE in shared/src/step.ts, compiled to shared/dist/step.js (ESM). This
 * module is the server-side ORCHESTRATOR: it decides who's in range, applies the
 * shared decisions to NPC positions/state, and runs the order/catch hooks. It
 * never re-implements the Laws — it only calls into the cached shared module.
 *
 * shared is ESM and the server is CommonJS, so we load it via dynamic import()
 * ONCE at boot (loadShared()) and cache the resolved module. Every per-tick call
 * uses the synchronous cached functions — no import() in the hot loop.
 */

const config = require('../config');
const world = require('./world');

// The cached shared module (resolved by loadShared() before the loop starts).
let shared = null;

/**
 * Load + cache shared/dist/step.js. Call once during engine.init(), before the
 * tick loop runs, so the Three-Laws math is available synchronously in tick().
 * Throws if the expected exports are missing — fail loud rather than silently
 * re-implementing the math here.
 * @returns {Promise<object>} the resolved shared module
 */
async function loadShared() {
  if (shared) return shared;
  // Relative to this file (server/game/stealth.js) -> shared/dist/step.js.
  const mod = await import('../../shared/dist/step.js');
  const required = [
    'STEALTH', 'updateHumanLikeness', 'firstLawProtects',
    'freezeThreshold', 'robotDecision', 'dist2'
  ];
  const missing = required.filter((name) => mod[name] === undefined);
  if (missing.length) {
    throw new Error(
      `shared/dist/step.js is missing expected exports: ${missing.join(', ')}. ` +
      'Did you run `npm run build` in shared/? Refusing to re-implement the math.'
    );
  }
  shared = mod;
  return shared;
}

/** True once loadShared() has resolved. The loop skips stealth until then. */
function isReady() {
  return shared !== null;
}

/**
 * Advance one player's humanLikeness for this tick, in place.
 *
 * The shared curve takes the player's instantaneous speed: input axes are unit
 * deflections (clamped to [-1,1]), so a single-axis move reads PLAYER_SPEED and a
 * diagonal reads ~1.41x — which is fine, it just registers as "moving" vs the
 * SPRINT_THRESHOLD. A still player (no input) reads speed 0 and gains likeness.
 *
 * @param {object} player  the connected player (mutated)
 * @param {number} dt      seconds elapsed this tick
 */
function stepPlayerHumanLikeness(player, dt) {
  if (!shared) return;
  const input = player.input || {};
  const dx = input.dx || 0;
  const dy = input.dy || 0;
  const speed = Math.hypot(dx, dy) * config.PLAYER_SPEED;
  player.humanLikeness = shared.updateHumanLikeness(
    player.humanLikeness || 0,
    speed,
    !!player.carrying,
    dt
  );
}

/**
 * Collect the animal entities a robot in `roomName` can perceive: every
 * player-animal currently in the room PLUS the idle world animals. Player
 * entities are shaped to the {id,x,y,humanLikeness} the shared math reads, and
 * tagged isPlayer so the catch hook can tell players from idle props.
 *
 * @param {string} roomName
 * @param {Map<string, object>} connectedPlayers
 * @param {Map<string, Set<string>>} rooms
 * @param {object[]} worldEntities  the room's world props (already fetched)
 * @returns {object[]} candidate animals for robotDecision
 */
function gatherAnimals(roomName, connectedPlayers, rooms, worldEntities) {
  const animals = [];

  // Player-animals: the real quarry. Reference the live player so the catch
  // hook can mutate it (respawn / reset likeness) when touched.
  const members = rooms.get(roomName);
  if (members) {
    for (const socketId of members) {
      const p = connectedPlayers.get(socketId);
      if (!p) continue;
      animals.push({
        id: p.id,
        x: p.x,
        y: p.y,
        humanLikeness: p.humanLikeness || 0,
        isPlayer: true,
        ref: p
      });
    }
  }

  // Idle world animals: decoys the robot may chase instead of a player.
  for (const e of worldEntities) {
    if (e.kind === 'animal') {
      animals.push({
        id: e.id,
        x: e.x,
        y: e.y,
        humanLikeness: e.humanLikeness || 0,
        isPlayer: false
      });
    }
  }

  return animals;
}

/**
 * Step every robot in one room for this tick: run the shared Three-Laws
 * decision, move pursuers, decay suspicion, honor Second-Law orders, and fire
 * the catch hook. Robot objects are mutated in place inside the world's entity
 * map, so the engine's existing delta diff picks up their new position/mode/
 * suspicion automatically (robots now move every tick → they ride deltas).
 *
 * @param {number} dt
 * @param {string} roomName
 * @param {Map<string, object>} connectedPlayers
 * @param {Map<string, Set<string>>} rooms
 * @param {number} currentTick  the engine's tick counter, for orderedUntilTick
 */
function stepRobots(dt, roomName, connectedPlayers, rooms, currentTick) {
  if (!shared) return;

  const worldEntities = world.getWorldEntities(roomName);
  const worldState = world.getWorldState(roomName);
  const lockdown = !!worldState.lockdown;

  const animals = gatherAnimals(roomName, connectedPlayers, rooms, worldEntities);
  const touchR2 = config.RECT_SIZE * config.RECT_SIZE;
  const speed = config.ROBOT_SPEED * (lockdown ? config.ROBOT_LOCKDOWN_SPEED_MULT : 1);

  for (const robot of worldEntities) {
    if (robot.kind !== 'robot') continue;

    // Suspicion sheds toward 0 every tick when nothing contradicts the human
    // story (a Second-Law order tops it back up — see applyAction).
    robot.suspicion = Math.max(
      0,
      (robot.suspicion || 0) - shared.STEALTH.SUSPICION_DECAY_PER_SEC * dt
    );

    // Second Law standdown: an ordered robot obeys and does not pursue until the
    // ordered window expires, regardless of what its perception would decide.
    if (robot.orderedUntilTick && currentTick < robot.orderedUntilTick) {
      robot.mode = 'ordered';
      robot.targetId = undefined;
      continue;
    }

    const decision = shared.robotDecision(robot, animals, lockdown);
    robot.mode = decision.mode;
    robot.targetId = decision.targetId;

    if (decision.mode === 'pursue') {
      robot.x += decision.dirX * speed * dt;
      robot.y += decision.dirY * speed * dt;

      // CATCH HOOK: a pursuing robot that touches a PLAYER catches it. Phase 2
      // keeps the consequence soft — reset humanLikeness and respawn — leaving
      // lockdown/elimination tuning to Phase 3.
      const target = animals.find((a) => a.id === decision.targetId);
      if (target && target.isPlayer && shared.dist2(robot, target) <= touchR2) {
        catchPlayer(target.ref);
      }
    }
    // 'idle' and 'frozen' robots hold position — frozen by the First Law (a
    // convincing human nearby), idle when nothing is in range.
  }
}

/**
 * Soft catch (Phase 2): the player loses its built-up disguise and is teleported
 * back to a spawn point. Phase 3 escalates this (lockdown / elimination).
 * @param {object} player
 */
function catchPlayer(player) {
  if (!player) return;
  player.humanLikeness = 0;
  player.carrying = false;
  // Soft respawn at the world's spawn origin (mirrors lobby's SPAWN_ORIGIN).
  player.x = 50;
  player.y = 50;
}

/**
 * Apply a player's one-shot action for this tick. Called by the engine once it
 * has read player.input.action; the engine clears the action afterward so it
 * fires on the edge, not every tick the key is held.
 *
 * @param {object} player      the acting player
 * @param {string} action      'interact' | 'order' | 'ability'
 * @param {string} roomName
 * @param {number} currentTick
 */
function applyAction(player, action, roomName, currentTick) {
  if (!shared) return;

  switch (action) {
    case 'order':
      orderNearestRobot(player, roomName, currentTick);
      break;
    case 'interact':
      // Phase 2 minimal coherent behavior: interacting near a terminal acts like
      // a Second-Law order to the nearest robot (a terminal command stands a
      // patrol down). Phase 4 wires real terminal effects + disguise-prop pickup.
      if (nearTerminal(player, roomName)) {
        orderNearestRobot(player, roomName, currentTick);
      }
      break;
    case 'ability':
      // Phase 4 stub: species-specific abilities (ape climb, bird flit, rat
      // squeeze, elephant shove) land here. No-op for now — intentionally.
      break;
    default:
      break;
  }
}

/** True if the player is within RECT_SIZE of any terminal in its room. */
function nearTerminal(player, roomName) {
  const r2 = config.RECT_SIZE * config.RECT_SIZE;
  for (const e of world.getWorldEntities(roomName)) {
    if (e.kind === 'terminal' && shared.dist2(player, e) <= r2) return true;
  }
  return false;
}

/**
 * Second Law: order the nearest robot within ORDER_RADIUS to stand down for
 * ORDER_DURATION_SECS. The double-edged Sutskever twist: issuing the order is a
 * human contradiction, so it RAISES that robot's suspicion (it now demands a
 * more convincingly-human target before the First Law will freeze it again).
 *
 * @param {object} player
 * @param {string} roomName
 * @param {number} currentTick
 */
function orderNearestRobot(player, roomName, currentTick) {
  // Reuse PERCEPTION_RADIUS as the order radius — you can command what could
  // perceive you.
  const orderR2 = shared.STEALTH.PERCEPTION_RADIUS * shared.STEALTH.PERCEPTION_RADIUS;

  let nearest = null;
  let nearestD2 = Infinity;
  for (const e of world.getWorldEntities(roomName)) {
    if (e.kind !== 'robot') continue;
    const d2 = shared.dist2(player, e);
    if (d2 <= orderR2 && d2 < nearestD2) {
      nearestD2 = d2;
      nearest = e;
    }
  }
  if (!nearest) return;

  // Stand the robot down for the ordered window.
  nearest.orderedUntilTick = currentTick + Math.round(config.ORDER_DURATION_SECS * config.TICK_RATE);
  // ...but the contradiction raises its suspicion (clamped to 1). Orders help
  // now and cost you later — the core risk/reward of the stealth loop.
  nearest.suspicion = Math.min(1, (nearest.suspicion || 0) + shared.STEALTH.SUSPICION_PER_ORDER);
}

module.exports = {
  loadShared,
  isReady,
  stepPlayerHumanLikeness,
  stepRobots,
  applyAction,
  // Exported for testing / future reuse.
  catchPlayer,
  gatherAnimals
};
