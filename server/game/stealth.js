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

// Cached references to the engine's live player + room maps. Most per-tick
// functions receive these as args, but the ape "carry" hand-off needs to scan a
// room's players from inside applyAction (which only gets the acting player), so
// the engine hands them over once at init via setRefs().
let connectedPlayers = null; // Map<socketId, player>
let rooms = null;            // Map<roomName, Set<socketId>>

/**
 * Cache the engine's live player + room maps so applyAction's ability hooks can
 * scan a room. Called once from engine.init(), before the loop starts.
 * @param {Map<string, object>} players
 * @param {Map<string, Set<string>>} roomsMap
 */
function setRefs(players, roomsMap) {
  connectedPlayers = players;
  rooms = roomsMap;
}

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
  // Speed must match the SAME walk/sprint speed integratePlayers moves at, or the
  // disguise math would disagree with the motion the player sees.
  const speed = Math.hypot(dx, dy) * shared.moveSpeed(input.sprint === true);
  player.humanLikeness = shared.updateHumanLikeness(
    player.humanLikeness || 0,
    speed,
    !!player.carrying,
    dt
  );
}

/** The per-frame movement speed for an input (walk vs sprint), from shared. */
function moveSpeed(sprint) {
  return shared ? shared.moveSpeed(sprint === true) : config.PLAYER_SPEED;
}

/**
 * Collect the animal entities a robot in `roomName` can perceive: every
 * player-animal currently in the room PLUS the idle world animals. Player
 * entities are shaped to the {id,x,y,humanLikeness} the shared math reads, and
 * tagged isPlayer so the catch hook can tell players from idle props.
 *
 * A RAT mid-"skitter" (skitterUntilTick still in the future) is omitted entirely:
 * it's invisible to robot perception this tick, so robotDecision can neither
 * freeze on it nor pursue it — the squeeze-through-a-gap escape.
 *
 * @param {string} roomName
 * @param {Map<string, object>} connectedPlayers
 * @param {Map<string, Set<string>>} rooms
 * @param {object[]} worldEntities  the room's world props (already fetched)
 * @param {number} currentTick  for evaluating timed effects (rat skitter)
 * @returns {object[]} candidate animals for robotDecision
 */
function gatherAnimals(roomName, connectedPlayers, rooms, worldEntities, currentTick) {
  const animals = [];

  // Player-animals: the real quarry. Reference the live player so the catch
  // hook can mutate it (respawn / reset likeness) when touched.
  const members = rooms.get(roomName);
  if (members) {
    for (const socketId of members) {
      const p = connectedPlayers.get(socketId);
      if (!p) continue;
      // An escaped player has left the field — robots ignore it entirely.
      if (p.escaped) continue;
      // RAT skitter: a skittering player is invisible to robots this tick.
      if ((p.skitterUntilTick || 0) > currentTick) continue;
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
 * Find a connected player by its game id within a room. Used by the prop-follow
 * step to resolve a prop's carrierId back to the live player object.
 * @param {string} roomName
 * @param {string} playerId
 * @returns {object|null}
 */
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
  if (!shared) return { pursuingRobots: 0, catches: 0 };

  const worldEntities = world.getWorldEntities(roomName);
  const worldState = world.getWorldState(roomName);
  const lockdown = !!worldState.lockdown;

  // Disguise prop follows its carrier: each tick, if the prop has a carrierId,
  // snap it to that player's position so it visually rides along (the ape
  // courier). If the carrier has vanished (disconnect), free the prop in place.
  const prop = worldEntities.find((e) => e.kind === 'prop');
  if (prop && prop.carrierId) {
    const carrier = findPlayerById(roomName, prop.carrierId);
    if (carrier && carrier.carrying) {
      // Still held: ride along with the carrier.
      prop.x = carrier.x;
      prop.y = carrier.y;
    } else {
      // Carrier disconnected, or was caught (catchPlayer cleared its carrying):
      // free the prop. It stays wherever it was last placed.
      prop.carrierId = null;
    }
  }

  const animals = gatherAnimals(roomName, connectedPlayers, rooms, worldEntities, currentTick);
  const touchR2 = config.RECT_SIZE * config.RECT_SIZE;
  const speed = config.ROBOT_SPEED * (lockdown ? config.ROBOT_LOCKDOWN_SPEED_MULT : 1);

  // Tally what fed the panic meter this tick (consumed by stepPanic).
  let pursuingRobots = 0;
  let catches = 0;

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

      const target = animals.find((a) => a.id === decision.targetId);
      // Panic is the alarm over the ESCAPE, so only a robot chasing a real
      // PLAYER stokes it — chasing idle scenery-animals must not, or the meter
      // would climb to overflow with no player provocation (the room's idle
      // animals always read as prey and never escape). Idle-animal pursuit is
      // pure ambient behavior with no bearing on the container.
      if (target && target.isPlayer) {
        pursuingRobots++;

        // CATCH HOOK: a pursuing robot that touches a player catches it — a soft
        // respawn (reset disguise + teleport to spawn). A catch is the biggest
        // single jolt to the panic meter (see stepPanic), so a botched bluff that
        // gets someone caught visibly pushes the whole room toward lockdown.
        //
        // BIRD flit: a flitting player is briefly UNCATCHABLE (it flew over a
        // wall, out of reach), so a touching robot can't grab it this tick.
        const flitting = target.ref && (target.ref.flitUntilTick || 0) > currentTick;
        if (!flitting && shared.dist2(robot, target) <= touchR2) {
          catchPlayer(target.ref);
          catches++;
        }
      }
    }
    // 'idle' and 'frozen' robots hold position — frozen by the First Law (a
    // convincing human nearby), idle when nothing is in range.
  }

  return { pursuingRobots, catches };
}

/**
 * Advance one room's panic meter + lockdown for this tick. Pulls the order
 * count latched on the world by applyAction since the last call, combines it
 * with the robot-pursuit/catch tallies from stepRobots, and runs the shared
 * overflow math. Returns whether lockdown just toggled this tick (for the
 * server log / future hooks).
 *
 * @param {number} dt
 * @param {string} roomName
 * @param {{pursuingRobots:number, catches:number}} robotEvents
 * @returns {{ enteredLockdown: boolean, liftedLockdown: boolean }}
 */
function stepPanic(dt, roomName, robotEvents) {
  if (!shared) return { enteredLockdown: false, liftedLockdown: false };

  const worldState = world.getWorldState(roomName);
  const wasLockdown = !!worldState.lockdown;

  // Consume the orders issued since the previous tick (latched in applyAction).
  const orders = worldState.pendingOrders || 0;
  worldState.pendingOrders = 0;

  shared.stepPanic(
    worldState,
    {
      pursuingRobots: robotEvents.pursuingRobots || 0,
      catches: robotEvents.catches || 0,
      orders
    },
    dt
  );

  return {
    enteredLockdown: !wasLockdown && worldState.lockdown,
    liftedLockdown: wasLockdown && !worldState.lockdown
  };
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
  // A respawn cancels any in-flight species effect (flit / skitter) — the
  // courier prop is freed by the prop-follow step once carrying drops.
  player.flitUntilTick = 0;
  player.skitterUntilTick = 0;
  // Soft respawn at the world's spawn origin (mirrors lobby's SPAWN_ORIGIN).
  player.x = 50;
  player.y = 50;
}

/**
 * Win check: a player who reaches the perimeter gate has escaped. Sets a sticky
 * `escaped` flag (idempotent — checked every tick but only flips once) so the
 * client can show the victory state. An escaped player no longer feeds panic /
 * gets caught because it has effectively left the play field.
 * @param {object} player
 * @param {string} roomName
 */
function checkEscape(player, roomName) {
  if (!shared || player.escaped) return;
  const gate = world.getWorldEntities(roomName).find((e) => e.kind === 'gate');
  if (!gate) return;
  // A generous reach so brushing the gate counts (it's the goal, not a trap).
  const reach = config.RECT_SIZE * 1.5;
  if (shared.dist2(player, gate) <= reach * reach) {
    player.escaped = true;
  }
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
      // Phase 4: species-specific powers. Edge-triggered (the engine clears
      // pendingAction after this call), so each fires once per press. The
      // orchestration — timers, target picking, mutating entities — lives here;
      // the deterministic math (likeness, perception, Laws) stays in shared.
      applyAbility(player, roomName, currentTick);
      break;
    default:
      break;
  }
}

/**
 * Dispatch a player's species ability. Branches on player.species:
 *   - ape      "carry"    pick up / hand off / drop the disguise prop
 *   - bird     "flit"     a short uncatchable burst (flies over a wall)
 *   - rat      "skitter"  a short burst invisible to robot perception
 *   - elephant "shove"    stun + push the nearest robot (loud → feeds panic)
 * Unknown/absent species is a no-op (the bare starter point has no species).
 *
 * @param {object} player
 * @param {string} roomName
 * @param {number} currentTick
 */
function applyAbility(player, roomName, currentTick) {
  switch (player.species) {
    case 'ape':
      apeCarry(player, roomName);
      break;
    case 'bird':
      birdFlit(player, currentTick);
      break;
    case 'rat':
      ratSkitter(player, currentTick);
      break;
    case 'elephant':
      elephantShove(player, roomName, currentTick);
      break;
    default:
      break;
  }
}

/**
 * APE "carry": be the disguise courier. Three states, edge-triggered:
 *   - NOT carrying + within RECT_SIZE of the prop (and it has no carrier):
 *       pick it up — player.carrying=true, prop.carrierId=player.id.
 *   - carrying + another PLAYER animal within RECT_SIZE: HAND OFF to them
 *       (transfer carrying + carrierId).
 *   - carrying + nobody to hand to: DROP — player.carrying=false,
 *       prop.carrierId=null, and the prop is left at the player's position.
 * The prop floors human-likeness at STEALTH.PROP_BONUS (updateHumanLikeness
 * honors `carrying`), so whoever holds it reads as plausibly human while moving.
 * The prop's per-tick "follow the carrier" move lives in stepRobots().
 *
 * @param {object} player
 * @param {string} roomName
 */
function apeCarry(player, roomName) {
  const r2 = config.RECT_SIZE * config.RECT_SIZE;
  const entities = world.getWorldEntities(roomName);
  const prop = entities.find((e) => e.kind === 'prop');
  if (!prop) return;

  if (!player.carrying) {
    // Pick up — only if the prop is free and in reach.
    if (prop.carrierId) return;
    if (shared.dist2(player, prop) > r2) return;
    player.carrying = true;
    prop.carrierId = player.id;
    return;
  }

  // Already carrying: prefer a hand-off to a nearby teammate, else drop.
  let recipient = null;
  for (const socketId of (rooms.get(roomName) || [])) {
    const other = connectedPlayers.get(socketId);
    if (!other || other.id === player.id || other.carrying) continue;
    if (shared.dist2(player, other) <= r2) { recipient = other; break; }
  }

  if (recipient) {
    // HAND OFF: transfer the disguise to the teammate in reach.
    player.carrying = false;
    recipient.carrying = true;
    prop.carrierId = recipient.id;
  } else {
    // DROP: leave the prop where the player is standing.
    player.carrying = false;
    prop.carrierId = null;
    prop.x = player.x;
    prop.y = player.y;
  }
}

/**
 * BIRD "flit": a short burst during which the bird is UNCATCHABLE — it flits up
 * and over a wall, briefly out of a robot's reach. Implemented as a tick
 * deadline; the catch hook in stepRobots skips a player whose flit is active.
 *
 * @param {object} player
 * @param {number} currentTick
 */
function birdFlit(player, currentTick) {
  player.flitUntilTick = currentTick + Math.round(config.ABILITY.BIRD_FLIT_SECS * config.TICK_RATE);
}

/**
 * RAT "skitter": a short burst during which the rat is INVISIBLE to robot
 * perception — it squeezes through a gap / behind cover, so robots can't lock
 * onto or chase it. Implemented as a tick deadline; gatherAnimals excludes a
 * skittering player from the list handed to robotDecision while it's active.
 *
 * @param {object} player
 * @param {number} currentTick
 */
function ratSkitter(player, currentTick) {
  player.skitterUntilTick = currentTick + Math.round(config.ABILITY.RAT_SKITTER_SECS * config.TICK_RATE);
}

/**
 * ELEPHANT "shove": stun + knock back the nearest robot within
 * RECT_SIZE * ELEPHANT_REACH_MULT. The robot is stood down (we reuse
 * orderedUntilTick, which stepRobots already honors) for ELEPHANT_STUN_SECS and
 * pushed a few units directly away from the elephant.
 *
 * DOUBLE-EDGED, like a Second-Law order: a shove is LOUD. It bumps the zoo-wide
 * panic meter (latched on worldState.pendingOrders, consumed by stepPanic), so
 * it clears a robot now but feeds the overflow container that ends the run.
 *
 * @param {object} player
 * @param {string} roomName
 * @param {number} currentTick
 */
function elephantShove(player, roomName, currentTick) {
  const reach = config.RECT_SIZE * config.ABILITY.ELEPHANT_REACH_MULT;
  const reachR2 = reach * reach;

  let nearest = null;
  let nearestD2 = Infinity;
  for (const e of world.getWorldEntities(roomName)) {
    if (e.kind !== 'robot') continue;
    const d2 = shared.dist2(player, e);
    if (d2 <= reachR2 && d2 < nearestD2) {
      nearestD2 = d2;
      nearest = e;
    }
  }
  if (!nearest) return;

  // Stun: stand the robot down for the shove window (same field stepRobots reads
  // for ordered standdown).
  nearest.orderedUntilTick = currentTick + Math.round(config.ABILITY.ELEPHANT_STUN_SECS * config.TICK_RATE);

  // Push: knock the robot directly away from the elephant a few units.
  const dx = nearest.x - player.x;
  const dy = nearest.y - player.y;
  const len = Math.hypot(dx, dy) || 1;
  nearest.x += (dx / len) * config.ABILITY.ELEPHANT_PUSH_UNITS;
  nearest.y += (dy / len) * config.ABILITY.ELEPHANT_PUSH_UNITS;

  // Loud: a shove feeds the panic meter just like an order. Latched here,
  // consumed in stepPanic — the double-edged cost of brute force.
  const worldState = world.getWorldState(roomName);
  worldState.pendingOrders = (worldState.pendingOrders || 0) + 1;
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
  // ...and it nudges the zoo-wide panic meter (the double-edged element ties
  // straight into the overflow container). Latched here, consumed in stepPanic.
  const worldState = world.getWorldState(roomName);
  worldState.pendingOrders = (worldState.pendingOrders || 0) + 1;
}

module.exports = {
  loadShared,
  setRefs,
  isReady,
  stepPlayerHumanLikeness,
  moveSpeed,
  stepRobots,
  stepPanic,
  checkEscape,
  applyAction,
  // Exported for testing / future reuse.
  catchPlayer,
  gatherAnimals
};
