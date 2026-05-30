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
const quests = require('./quests');
const speciesRoster = require('../socket/species-roster');

// The cached shared module (resolved by loadShared() before the loop starts).
let shared = null;

// Collision half-extent for moving entities. Players, robots and idle decoys all
// share roughly one entity rect; 0.4×RECT_SIZE keeps them clear of walls without
// snagging on tile corners. Mirrors the radius engine.integratePlayers passes via
// movePlayerWithCollision (config.RECT_SIZE * 0.4).
const ROBOT_RADIUS = config.RECT_SIZE * 0.4;

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
 * Bump a per-player persistent-stat counter. The game math stays decoupled from
 * the DB: we only accumulate onto `player.statsDelta` (created lazily) and the
 * engine flushes a non-empty delta to SQLite on the next tick (and connection.js
 * on disconnect). No-op on a falsy player.
 * @param {object} player
 * @param {'escapes'|'caught'|'ordersIssued'|'abilitiesUsed'} key
 * @param {number} [by=1]
 */
function bumpStat(player, key, by = 1) {
  if (!player) return;
  player.statsDelta ||= { escapes: 0, caught: 0, ordersIssued: 0, abilitiesUsed: 0 };
  player.statsDelta[key] = (player.statsDelta[key] || 0) + by;
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
    'freezeThreshold', 'robotDecision', 'dist2', 'wanderStep', 'facingFromVec',
    // Phase 4: collision-aware movement for players AND robots/idle animals.
    'moveWithCollision'
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
function stepPlayerHumanLikeness(player, dt, currentTick) {
  if (!shared) return;

  // CHAMELEON "cloak": a perfect disguise — humanLikeness floored to 1.0 while
  // active, regardless of motion. Overrides the normal curve.
  if ((player.cloakUntilTick || 0) > currentTick) {
    player.humanLikeness = 1;
    return;
  }
  // TORTOISE "shell": the player waits out a chase — humanLikeness is HELD at its
  // current value (neither rising nor decaying) while shelled.
  if ((player.shellUntilTick || 0) > currentTick) {
    return;
  }

  const input = player.input || {};
  const dx = input.dx || 0;
  const dy = input.dy || 0;
  // Speed must match the SAME walk/sprint speed integratePlayers moves at, or the
  // disguise math would disagree with the motion the player sees. A cheetah dash
  // multiplies that speed (so a dashing cheetah reads as fast-fleeing prey).
  const dashing = (player.dashUntilTick || 0) > currentTick;
  const speedMult = dashing ? config.ABILITY.CHEETAH_SPEED_MULT : 1;
  const speed = Math.hypot(dx, dy) * shared.moveSpeed(input.sprint === true) * speedMult;
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
 * Collision-aware player movement (called by engine.integratePlayers). The
 * engine doesn't hold the shared module — stealth does — so it routes the move
 * through here: we look up the room's collision grid and run the shared
 * axis-separated sliding integrator (OOB is solid, so the perimeter wall keeps
 * players in; the gate gap is the only non-solid way out). Mutates player.x/y in
 * place. No-op (holds position) until the shared module has loaded.
 * @param {object} player  mutated in place
 * @param {number} dx
 * @param {number} dy
 * @param {number} dt
 * @param {number} speed   world units/sec at full axis deflection
 * @param {string} roomName
 */
function movePlayerWithCollision(player, dx, dy, dt, speed, roomName) {
  if (!shared) return;
  const rm = world.getRoomMap(roomName);
  shared.moveWithCollision(
    player, dx, dy, dt, speed,
    rm.collision, rm.w, rm.h, rm.tile, config.RECT_SIZE * 0.4
  );
}

/** Map a movement vector to a Dir8 facing, from shared (held facing if zero). */
function facingFromVec(dx, dy, prev) {
  return shared ? shared.facingFromVec(dx, dy, prev || 's') : (prev || 's');
}

/**
 * The real world-unit bounds for a room's map, for the ambient wander clamp. The
 * shared wanderStep defaults to WORLD (1000²); the tilemap is MAP_W*TILE = 4096²,
 * so passing these lets a patrolling robot / drifting decoy turn inward at the
 * actual edge. Falls back to undefined (→ shared's WORLD default) if dims are
 * missing, which is harmless since the collision grid is the hard backstop.
 * @param {{ w?:number, h?:number, tile?:number }} rm  a getRoomMap() result
 */
function mapBounds(rm) {
  if (!rm || !rm.w || !rm.h || !rm.tile) return undefined;
  return { minX: 0, minY: 0, maxX: rm.w * rm.tile, maxY: rm.h * rm.tile };
}

/**
 * Stamp the render-echo of an ability effect onto an entity (player OR world
 * entity). `startTick` is the rising edge the client triggers a one-shot FX
 * burst on; `untilTick` drives any sustained FX. toEntity forwards a player's fx
 * while live; world entities (robots) carry it raw on the delta. One source of
 * truth so every ability reports FX the same way.
 * @param {object} entity
 * @param {string} kind
 * @param {number} currentTick
 * @param {number} durationTicks
 */
function setFx(entity, kind, currentTick, durationTicks) {
  entity.fx = { kind, startTick: currentTick, untilTick: currentTick + Math.max(1, durationTicks) };
}

/** Seconds -> whole ticks (deterministic; no wall clock). */
function secsToTicks(secs) {
  return Math.round(secs * config.TICK_RATE);
}

/**
 * Third-Law hazard avoidance: would a step to (nx,ny) land a robot inside any
 * active hazard zone (a skunk stink-cloud)? Robots refuse to enter, so the
 * orchestrator zeroes the move (the robot stalls at the edge). Pure radius test;
 * keeps robotDecision (perception) untouched.
 * @returns {boolean}
 */
function entersHazard(nx, ny, worldEntities) {
  for (const e of worldEntities) {
    if (e.kind !== 'hazard') continue;
    const r = (e.radius || config.ABILITY.SKUNK_RADIUS);
    const ddx = nx - e.x;
    const ddy = ny - e.y;
    if (ddx * ddx + ddy * ddy <= r * r) return true;
  }
  return false;
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

  // The room's collision grid, fetched ONCE per call (not per robot) for perf.
  // Robots respect walls just like players: a pursuit step that would tunnel
  // through a wall is blocked, and a patrol step into a wall is held.
  const rm = world.getRoomMap(roomName);

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

    // Clear an expired ability-effect echo so a robot doesn't keep re-sending a
    // stale fx on full refreshes (the client ignores an unchanged startTick, so
    // this is just keeping the wire tidy).
    if (robot.fx && robot.fx.untilTick < currentTick) robot.fx = null;

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
      // Wall + hazard avoidance, both honored before committing the chase step:
      //   - WALLS: the shared moveWithCollision integrator slides the robot along
      //     walls and refuses to tunnel through one (OOB is solid too). Run it on
      //     a COPY first so we can also veto on the Third Law before committing.
      //   - Third Law (HAZARD): a robot won't chase INTO a skunk stink. If the
      //     wall-resolved destination still lands in a hazard, it stalls this tick
      //     (still faces the target).
      const trial = { x: robot.x, y: robot.y };
      shared.moveWithCollision(
        trial, decision.dirX, decision.dirY, dt, speed,
        rm.collision, rm.w, rm.h, rm.tile, ROBOT_RADIUS
      );
      if (!entersHazard(trial.x, trial.y, worldEntities)) {
        robot.x = trial.x;
        robot.y = trial.y;
      }
      // Face the chase direction (for the directional sprite).
      robot.facing = shared.facingFromVec(decision.dirX, decision.dirY, robot.facing || 's');

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
        // UNCATCHABLE windows: a touching robot can't grab the player this tick.
        //   - BIRD flit / KANGAROO leap (flew/hopped out of reach) → flitUntilTick
        //   - TORTOISE shell (bunkered, can't be grabbed) → shellUntilTick
        const ref = target.ref;
        const uncatchable = ref && (
          (ref.flitUntilTick || 0) > currentTick ||
          (ref.shellUntilTick || 0) > currentTick
        );
        if (!uncatchable && shared.dist2(robot, target) <= touchR2) {
          catchPlayer(target.ref, firstSpawn(rm));
          catches++;
        }
      }
    } else if (decision.mode === 'idle') {
      // PATROL: a robot with nothing to react to walks its rounds (deterministic
      // wander) instead of standing dead-still, so it's a moving threat to route
      // around. A decoy/player that drifts into perception flips it to 'pursue'
      // next tick. Patrol is intentionally slower than a chase (config.PATROL_SPEED).
      // Pass the REAL map bounds so a patrolling robot biases inward at the true
      // world edge (4096²), not the shared default WORLD clamp (1000²). The
      // collision grid is the hard backstop, but matching the bounds keeps the
      // wander's edge-turn honest.
      const next = shared.wanderStep(robot, currentTick, dt, config.PATROL_SPEED, mapBounds(rm));
      // Face the patrol heading (derive from the actual position delta).
      robot.facing = shared.facingFromVec(next.x - robot.x, next.y - robot.y, robot.facing || 's');
      // Don't patrol into a WALL (collision) or a HAZARD (Third Law); hold
      // position if either would — robots shouldn't wander into their own walls.
      if (!world.isSolidAtRoom(roomName, next.x, next.y) && !entersHazard(next.x, next.y, worldEntities)) {
        robot.x = next.x;
        robot.y = next.y;
      }
    }
    // 'frozen' robots hold position (frozen by the First Law — a convincing human
    // is nearby and must not be disturbed); 'ordered' returned earlier in the loop.
  }

  return { pursuingRobots, catches };
}

/**
 * Drift every idle world-animal in a room one step along its deterministic
 * wander heading (shared.wanderStep). These decoys have no input; making them
 * MOVE turns them into live cover + distractions — one that drifts within a
 * robot's perception while looking like prey (humanLikeness 0) will be chased,
 * peeling the robot off the players. Mutated in place in the world entity map,
 * so they ride the engine's existing delta diff automatically.
 *
 * Called from engine.stepNpcs BEFORE stepRobots so robots perceive decoys at
 * this tick's positions (no one-tick perception lag). Catching a decoy is
 * impossible (the catch hook is player-only) and decoy-pursuit doesn't feed
 * panic (the pursuingRobots tally is gated on isPlayer) — both intentional.
 *
 * @param {number} dt
 * @param {string} roomName
 * @param {number} currentTick
 */
function stepIdleAnimals(dt, roomName, currentTick) {
  if (!shared) return;
  const bounds = mapBounds(world.getRoomMap(roomName));
  for (const e of world.getWorldEntities(roomName)) {
    if (e.kind !== 'animal') continue;
    const next = shared.wanderStep(e, currentTick, dt, config.WANDER_ANIMAL_SPEED, bounds);
    // Face the drift direction so the decoy's walk animation reads correctly.
    e.facing = shared.facingFromVec(next.x - e.x, next.y - e.y, e.facing || 's');
    // Hold position if the drift would carry the decoy onto a solid tile, so it
    // doesn't walk through its own enclosure fence.
    if (world.isSolidAtRoom(roomName, next.x, next.y)) continue;
    e.x = next.x;
    e.y = next.y;
  }
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
 * The first spawn point of a room map, or a safe fallback. The map always
 * produces spawn points just inside the gate; the fallback only fires in the
 * impossible case of an empty spawns list (map center, then (50,50)).
 * @param {{ spawns?: {x:number,y:number}[], w?:number, h?:number, tile?:number }} rm  a getRoomMap() result
 * @returns {{ x: number, y: number }}
 */
function firstSpawn(rm) {
  if (rm && Array.isArray(rm.spawns) && rm.spawns.length > 0) return rm.spawns[0];
  if (rm && rm.w && rm.h && rm.tile) {
    return { x: (rm.w * rm.tile) / 2, y: (rm.h * rm.tile) / 2 };
  }
  return { x: 50, y: 50 };
}

/**
 * Soft catch (Phase 2): the player loses its built-up disguise and is teleported
 * back to a spawn point. Phase 3 escalates this (lockdown / elimination).
 * @param {object} player
 * @param {{x:number,y:number}} spawn  the room's spawn point to reset to (caller
 *   resolves it from world.getRoomMap(roomName).spawns[0]).
 */
function catchPlayer(player, spawn) {
  if (!player) return;
  // Persistent stat: count this capture. The single capture chokepoint — an
  // escaped player is never a catch target (gatherAnimals skips player.escaped),
  // so this only credits real catches. Decoupled from the DB (see bumpStat).
  if (!player.escaped) bumpStat(player, 'caught');
  player.humanLikeness = 0;
  player.carrying = false;
  // A respawn cancels every in-flight self-effect — the courier prop is freed by
  // the prop-follow step once carrying drops.
  player.flitUntilTick = 0;
  player.skitterUntilTick = 0;
  player.cloakUntilTick = 0;
  player.dashUntilTick = 0;
  player.shellUntilTick = 0;
  player.fx = null;
  // Soft respawn at the room's first map spawn point (just inside the gate).
  const at = spawn || { x: 50, y: 50 };
  player.x = at.x;
  player.y = at.y;
}

/**
 * Respawn an escaped player into a fresh run: a NEW species, back at the spawn
 * origin, disguise + ability timers wiped, `escaped` cleared. This is what makes
 * the game a round-based loop — escape, brief celebration, play again as someone
 * new — rather than a terminal win that strands the avatar at the gate forever.
 *
 * The new species is rolled from the ONE shared roster (species-roster.js); we
 * avoid handing back the same species so a respawn visibly changes the animal.
 * @param {object} player
 * @param {{x:number,y:number}} spawn  the room's spawn point to reset to (caller
 *   resolves it from world.getRoomMap(roomName).spawns[0]).
 */
function respawnPlayer(player, spawn) {
  const roster = speciesRoster.getKeys();
  if (roster.length > 0) {
    // Pick a species other than the current one when we can, so the respawn
    // reads as a genuinely new animal. Deterministic (no Math.random): step to
    // the next species in roster order, which also keeps the zoo varied.
    const cur = roster.indexOf(player.species);
    const next = cur >= 0 ? (cur + 1) % roster.length : 0;
    player.species = roster[next];
  }
  player.escaped = false;
  player.escapeUntilTick = 0;
  player.humanLikeness = 0;
  player.carrying = false;
  player.flitUntilTick = 0;
  player.skitterUntilTick = 0;
  player.cloakUntilTick = 0;
  player.dashUntilTick = 0;
  player.shellUntilTick = 0;
  player.abilityCdUntilTick = 0;
  player.fx = null;
  // Phase 6: the respawn handed the player a NEW species above, so re-derive its
  // quest and reset all progress (done:0/complete:false). Must run AFTER the
  // species reassignment so the new run gets the new animal's quest.
  quests.initPlayer(player);
  // Back to the room's first map spawn point (mirrors catchPlayer).
  const at = spawn || { x: 50, y: 50 };
  player.x = at.x;
  player.y = at.y;
}

/**
 * Win + respawn lifecycle. A player who reaches the perimeter gate ESCAPES: the
 * `escaped` flag flips (the client shows the victory banner) and an
 * `escapeUntilTick` deadline is stamped. While escaped the player has left the
 * play field — robots ignore it, it can't be caught, it doesn't feed panic. Once
 * the celebration window elapses the player RESPAWNS as a fresh animal, which
 * also clears `escaped` so the client banner goes away and the round restarts.
 * @param {object} player
 * @param {string} roomName
 * @param {number} currentTick
 */
function checkEscape(player, roomName, currentTick) {
  if (!shared) return;

  // Already escaped: hold the win state until the celebration window elapses,
  // then respawn into a fresh run at the room's first map spawn point.
  if (player.escaped) {
    if (currentTick >= (player.escapeUntilTick || 0)) {
      respawnPlayer(player, firstSpawn(world.getRoomMap(roomName)));
    }
    return;
  }

  const gate = world.getWorldEntities(roomName).find((e) => e.kind === 'gate');
  if (!gate) return;
  // A generous reach so brushing the gate counts (it's the goal, not a trap).
  const reach = config.RECT_SIZE * 1.5;
  if (shared.dist2(player, gate) > reach * reach) return;

  // Phase 6: the ape's 'fetch' quest completes the instant a CARRYING player
  // reaches the gate (the deposit). Evaluate it BEFORE the gate gating below so
  // the same tick both completes the quest and lets the courier escape.
  quests.stepFetchAtGate(player, gate, reach);

  // GATE GATING: a player may only escape once its per-species quest is complete.
  // If it reaches the gate without a complete quest, stamp questBlocked (a tick
  // the client can show a "finish your quest" hint from) and refuse the escape.
  if (!quests.isComplete(player)) {
    player.questBlocked = currentTick;
    return;
  }

  player.escaped = true;
  player.escapeUntilTick = currentTick + secsToTicks(config.ESCAPE_CELEBRATION_SECS);
  // Persistent stat: this flips exactly once per run (guarded by `player.escaped`
  // above), so each escape is counted once. Decoupled from the DB; the engine
  // flushes the delta promptly on the escape edge tick.
  bumpStat(player, 'escapes');
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
        // Phase 6: an 'activate' quest (elephant/peacock/parrot) counts each
        // DISTINCT terminal tapped toward its target. No-op for other quests.
        quests.onInteract(player, roomName);
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
 * Dispatch a player's species ability (one per species). Gated by a generic
 * cooldown so powers can't be spammed; each handler returns true if it actually
 * FIRED (e.g. the elephant shove only fires with a robot in reach), so a no-op
 * doesn't burn the cooldown. Unknown/absent species is a no-op.
 *
 * Niches: disguise (ape/chameleon/tortoise), evasion (bird/rat/mole/kangaroo/
 * cheetah), robot-control (elephant/peacock/parrot/skunk), panic-meta (owl/fox).
 *
 * @param {object} player
 * @param {string} roomName
 * @param {number} currentTick
 */
function applyAbility(player, roomName, currentTick) {
  // Cooldown gate: refuse if a previous use is still cooling down.
  if ((player.abilityCdUntilTick || 0) > currentTick) return;

  let fired = false;
  switch (player.species) {
    case 'ape': fired = apeCarry(player, roomName, currentTick); break;
    case 'bird': fired = birdFlit(player, currentTick); break;
    case 'rat': fired = ratSkitter(player, currentTick); break;
    case 'elephant': fired = elephantShove(player, roomName, currentTick); break;
    case 'chameleon': fired = chameleonCloak(player, roomName, currentTick); break;
    case 'peacock': fired = peacockDazzle(player, roomName, currentTick); break;
    case 'skunk': fired = skunkStink(player, roomName, currentTick); break;
    case 'mole': fired = moleBurrow(player, roomName, currentTick); break;
    case 'cheetah': fired = cheetahDash(player, currentTick); break;
    case 'parrot': fired = parrotMimic(player, roomName, currentTick); break;
    case 'tortoise': fired = tortoiseShell(player, currentTick); break;
    case 'kangaroo': fired = kangarooLeap(player, roomName, currentTick); break;
    case 'owl': fired = owlHush(player, roomName, currentTick); break;
    case 'fox': fired = foxDecoy(player, roomName, currentTick); break;
    default: break;
  }

  if (fired) {
    player.abilityCdUntilTick = currentTick + secsToTicks(config.ABILITY.COOLDOWN_SECS);
    // Persistent stat: only an ability that actually FIRED (not a no-op like an
    // elephant shove with no robot in reach) counts. Decoupled from the DB.
    bumpStat(player, 'abilitiesUsed');
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
function apeCarry(player, roomName, currentTick) {
  const r2 = config.RECT_SIZE * config.RECT_SIZE;
  const entities = world.getWorldEntities(roomName);
  const prop = entities.find((e) => e.kind === 'prop');
  if (!prop) return false;

  if (!player.carrying) {
    // Pick up — only if the prop is free and in reach.
    if (prop.carrierId) return false;
    if (shared.dist2(player, prop) > r2) return false;
    player.carrying = true;
    prop.carrierId = player.id;
    // Sustained "carrying" glow: echo it for the carry's duration estimate (the
    // client also reads `carrying` directly; this drives the pickup burst edge).
    setFx(player, 'carry', currentTick, secsToTicks(1));
    return true;
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
    setFx(recipient, 'carry', currentTick, secsToTicks(1));
  } else {
    // DROP: leave the prop where the player is standing.
    player.carrying = false;
    prop.carrierId = null;
    prop.x = player.x;
    prop.y = player.y;
  }
  return true;
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
  const d = secsToTicks(config.ABILITY.BIRD_FLIT_SECS);
  player.flitUntilTick = currentTick + d;
  setFx(player, 'flit', currentTick, d);
  return true;
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
  const d = secsToTicks(config.ABILITY.RAT_SKITTER_SECS);
  player.skitterUntilTick = currentTick + d;
  setFx(player, 'skitter', currentTick, d);
  return true;
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

  const nearest = nearestRobot(player, roomName, reachR2);
  if (!nearest) return false;

  // Stun: stand the robot down for the shove window (same field stepRobots reads
  // for ordered standdown).
  nearest.orderedUntilTick = currentTick + secsToTicks(config.ABILITY.ELEPHANT_STUN_SECS);

  // Push: knock the robot directly away from the elephant a few units.
  const dx = nearest.x - player.x;
  const dy = nearest.y - player.y;
  const len = Math.hypot(dx, dy) || 1;
  nearest.x += (dx / len) * config.ABILITY.ELEPHANT_PUSH_UNITS;
  nearest.y += (dy / len) * config.ABILITY.ELEPHANT_PUSH_UNITS;

  // FX on both: the shockwave at the elephant, the impact on the shoved robot.
  setFx(player, 'shove', currentTick, secsToTicks(0.4));
  setFx(nearest, 'shove', currentTick, secsToTicks(config.ABILITY.ELEPHANT_STUN_SECS));

  // Loud: a shove feeds the panic meter just like an order. Latched here,
  // consumed in stepPanic — the double-edged cost of brute force.
  const worldState = world.getWorldState(roomName);
  worldState.pendingOrders = (worldState.pendingOrders || 0) + 1;
  return true;
}

/** Find the nearest robot to `player` within `reachR2` (squared), or null. */
function nearestRobot(player, roomName, reachR2) {
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
  return nearest;
}

// ---------------------------------------------------------------------------
// The zoo expansion — 10 new species abilities (Phase C). Each returns true if
// it FIRED (so applyAbility only burns the cooldown on a real activation), sets
// its fx echo for the client FX layer, and ties into the Three-Laws/panic loop.
// ---------------------------------------------------------------------------

/**
 * CHAMELEON "cloak": a perfect disguise — humanLikeness is floored to 1.0 for
 * CLOAK_SECS (even while moving), via stepPlayerHumanLikeness. Double-edged: if a
 * robot is already perceiving the chameleon, cloaking is a visible contradiction
 * that bumps that robot's suspicion (harder to bluff later).
 */
function chameleonCloak(player, roomName, currentTick) {
  const d = secsToTicks(config.ABILITY.CHAMELEON_CLOAK_SECS);
  player.cloakUntilTick = currentTick + d;
  // Suspicion cost if a robot is within perception when you cloak.
  const percR2 = shared.STEALTH.PERCEPTION_RADIUS * shared.STEALTH.PERCEPTION_RADIUS;
  const near = nearestRobot(player, roomName, percR2);
  if (near) near.suspicion = Math.min(1, (near.suspicion || 0) + shared.STEALTH.SUSPICION_PER_ORDER * 0.5);
  setFx(player, 'cloak', currentTick, d);
  return true;
}

/**
 * PEACOCK "dazzle": AoE stand-down. Every robot within PEACOCK_RADIUS is ordered
 * (reuses orderedUntilTick) and turned toward the peacock. LOUD — each dazzled
 * robot latches one panic order, so a big crowd is a big panic spike.
 */
function peacockDazzle(player, roomName, currentTick) {
  const r2 = config.ABILITY.PEACOCK_RADIUS * config.ABILITY.PEACOCK_RADIUS;
  const d = secsToTicks(config.ABILITY.PEACOCK_DAZZLE_SECS);
  const worldState = world.getWorldState(roomName);
  let hit = 0;
  for (const e of world.getWorldEntities(roomName)) {
    if (e.kind !== 'robot') continue;
    if (shared.dist2(player, e) > r2) continue;
    e.orderedUntilTick = currentTick + d;
    e.facing = shared.facingFromVec(player.x - e.x, player.y - e.y, e.facing || 's');
    setFx(e, 'dazzle', currentTick, d);
    worldState.pendingOrders = (worldState.pendingOrders || 0) + 1;
    hit++;
  }
  setFx(player, 'dazzle', currentTick, secsToTicks(0.5));
  return hit > 0;
}

/**
 * SKUNK "stink": drop a lingering hazard zone at the player's feet. Robots refuse
 * to step into it (Third-Law self-preservation; see entersHazard). A temporary
 * world entity with an expireTick — swept by world.pruneExpired.
 */
function skunkStink(player, roomName, currentTick) {
  const d = secsToTicks(config.ABILITY.SKUNK_STINK_SECS);
  const id = world.nextTempId(roomName, 'hazard');
  world.addWorldEntity(roomName, {
    id,
    x: player.x,
    y: player.y,
    kind: 'hazard',
    radius: config.ABILITY.SKUNK_RADIUS,
    expireTick: currentTick + d,
    fx: { kind: 'stink', startTick: currentTick, untilTick: currentTick + d }
  });
  setFx(player, 'stink', currentTick, secsToTicks(0.5));
  return true;
}

/**
 * MOLE "burrow": dig a short distance along the facing direction (a teleport,
 * clamped to the world) and resurface briefly unseen (reuses skitterUntilTick).
 * The teleport is collision-checked at the destination: if it would land in a
 * wall the mole stays put (only the unseen window applies) so a burrow can't dump
 * the player inside solid tiles. The unseen effect still fires either way.
 */
function moleBurrow(player, roomName, currentTick) {
  const dir = unitFromFacing(player.facing);
  const nx = clampWorld(player.x + dir.x * config.ABILITY.MOLE_BURROW_DIST);
  const ny = clampWorld(player.y + dir.y * config.ABILITY.MOLE_BURROW_DIST);
  if (!world.isSolidAtRoom(roomName, nx, ny)) {
    player.x = nx;
    player.y = ny;
  }
  player.skitterUntilTick = currentTick + secsToTicks(config.ABILITY.MOLE_UNSEEN_SECS);
  setFx(player, 'burrow', currentTick, secsToTicks(0.5));
  return true;
}

/**
 * CHEETAH "dash": a brief speed burst (engine.integratePlayers reads dashUntilTick
 * for the multiplier). Double-edged: fast reads as fleeing prey, so humanLikeness
 * crashes via the shared curve.
 */
function cheetahDash(player, currentTick) {
  const d = secsToTicks(config.ABILITY.CHEETAH_DASH_SECS);
  player.dashUntilTick = currentTick + d;
  setFx(player, 'dash', currentTick, d);
  return true;
}

/**
 * PARROT "mimic": a perfect human-voice mimic — orders the nearest robot to stand
 * down like a Second-Law order but with NO suspicion cost. Still latches panic
 * (it's a noise the zoo registers).
 */
function parrotMimic(player, roomName, currentTick) {
  const percR2 = shared.STEALTH.PERCEPTION_RADIUS * shared.STEALTH.PERCEPTION_RADIUS;
  const near = nearestRobot(player, roomName, percR2);
  if (!near) return false;
  const d = secsToTicks(config.ABILITY.PARROT_ORDER_SECS);
  near.orderedUntilTick = currentTick + d;
  // NO suspicion bump (the mimic point). But it is audible → feeds panic.
  const worldState = world.getWorldState(roomName);
  worldState.pendingOrders = (worldState.pendingOrders || 0) + 1;
  setFx(player, 'mimic', currentTick, secsToTicks(0.6));
  setFx(near, 'mimic', currentTick, d);
  return true;
}

/**
 * TORTOISE "shell": bunker down — immovable + uncatchable for SHELL_SECS, with
 * humanLikeness HELD. integratePlayers zeroes movement, the catch hook skips it,
 * and stepPlayerHumanLikeness freezes the value while shellUntilTick is live.
 */
function tortoiseShell(player, currentTick) {
  const d = secsToTicks(config.ABILITY.TORTOISE_SHELL_SECS);
  player.shellUntilTick = currentTick + d;
  setFx(player, 'shell', currentTick, d);
  return true;
}

/**
 * KANGAROO "leap": a long directional hop along facing (clamped to the world),
 * briefly uncatchable mid-air (reuses flitUntilTick). Collision-checked at the
 * landing tile: a hop that would land in a wall is cancelled (the player holds
 * position) so a leap can't deposit the player inside solid tiles. The mid-air
 * uncatchable window still applies.
 */
function kangarooLeap(player, roomName, currentTick) {
  const dir = unitFromFacing(player.facing);
  const nx = clampWorld(player.x + dir.x * config.ABILITY.KANGAROO_LEAP_DIST);
  const ny = clampWorld(player.y + dir.y * config.ABILITY.KANGAROO_LEAP_DIST);
  if (!world.isSolidAtRoom(roomName, nx, ny)) {
    player.x = nx;
    player.y = ny;
  }
  player.flitUntilTick = currentTick + secsToTicks(config.ABILITY.KANGAROO_AIR_SECS);
  setFx(player, 'leap', currentTick, secsToTicks(0.6));
  return true;
}

/**
 * OWL "hush": drain a flat chunk off the room's panic meter — the team counter to
 * the overflow container. Best used right before lockdown; the cooldown keeps it
 * from being a permanent panic sink.
 */
function owlHush(player, roomName, currentTick) {
  const worldState = world.getWorldState(roomName);
  worldState.panic = Math.max(0, (worldState.panic || 0) - config.ABILITY.OWL_HUSH_AMOUNT);
  setFx(player, 'hush', currentTick, secsToTicks(0.8));
  return true;
}

/**
 * FOX "decoy": spawn a temporary human-looking decoy animal that robots prefer to
 * chase (high humanLikeness can also freeze them — First Law), peeling pursuit off
 * the team. A temporary world entity (kind 'animal') that stepIdleAnimals drifts
 * and pruneExpired removes.
 */
function foxDecoy(player, roomName, currentTick) {
  const d = secsToTicks(config.ABILITY.FOX_DECOY_SECS);
  const id = world.nextTempId(roomName, 'decoy');
  world.addWorldEntity(roomName, {
    id,
    x: player.x,
    y: player.y,
    name: 'decoy',
    kind: 'animal',
    species: 'fox',
    humanLikeness: config.ABILITY.FOX_DECOY_HL,
    facing: 's',
    expireTick: currentTick + d,
    fx: { kind: 'decoy', startTick: currentTick, untilTick: currentTick + d }
  });
  setFx(player, 'decoy', currentTick, secsToTicks(0.5));
  return true;
}

/** A unit vector from a Dir8 facing string (for burrow/leap displacement). */
function unitFromFacing(facing) {
  const SQ = Math.SQRT1_2;
  switch (facing) {
    case 'e': return { x: 1, y: 0 };
    case 'w': return { x: -1, y: 0 };
    case 's': return { x: 0, y: 1 };
    case 'n': return { x: 0, y: -1 };
    case 'se': return { x: SQ, y: SQ };
    case 'sw': return { x: -SQ, y: SQ };
    case 'ne': return { x: SQ, y: -SQ };
    case 'nw': return { x: -SQ, y: -SQ };
    default: return { x: 0, y: 1 };
  }
}

/**
 * Clamp a coordinate into the world bounds. Used only as a backstop for the
 * mole/kangaroo teleports (WORLD_MAX is now 4096 = MAP_W*TILE). The authoritative
 * movement bound is the collision grid (OOB is solid); these teleports also
 * collision-check their destination tile, so this just keeps the raw coordinate
 * sane before that check.
 */
function clampWorld(v) {
  return Math.max(0, Math.min(config.WORLD_MAX, v));
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

  // Persistent stat: an order actually landed (a robot was in range and stood
  // down). Counted only here, past the no-target early-return. Decoupled from DB.
  bumpStat(player, 'ordersIssued');

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
  movePlayerWithCollision,
  facingFromVec,
  stepRobots,
  stepIdleAnimals,
  stepPanic,
  checkEscape,
  applyAction,
  // Exported for testing / future reuse.
  catchPlayer,
  gatherAnimals
};
