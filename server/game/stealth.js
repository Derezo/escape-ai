'use strict';

/**
 * Escape AI — Three-Laws stealth core (server authoritative).
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
const follow = require('./follow');
const behaviors = require('./behaviors');
const speciesRoster = require('../socket/species-roster');
const { bumpStat, bumpOwnEscape } = require('./stats-delta');
const { secsToTicks, findPlayerById } = require('./room-utils');

// The cached shared modules (resolved by loadShared() before the loop starts).
// `shared` is shared/dist/step.js (the Three-Laws math + collision integrator);
// `movement` is shared/dist/movement.js (steering/patrol/wander-avoid primitives);
// `locomotion` is shared/dist/locomotion.js (per-species gait registry + applicator);
// `pathfind` is shared/dist/pathfind.js (deterministic A* + inBounds containment).
let shared = null;
let movement = null;
let locomotion = null;
let pathfind = null;

// Collision half-extent for moving entities. Players, robots and idle decoys all
// share roughly one entity rect; 0.4×RECT_SIZE keeps them clear of walls without
// snagging on tile corners. Mirrors the radius engine.integratePlayers passes via
// movePlayerWithCollision (config.RECT_SIZE * 0.4).
const ROBOT_RADIUS = config.RECT_SIZE * 0.4;

// Fraction of a returning animal's OPEN-FIELD heading taken from the ambient wander
// (vs. the A* path waypoint), so the long walk home still reads as a leisurely
// saunter rather than a beeline. Low enough that the path still dominates and the
// animal makes steady progress; the blend is dropped entirely inside the gate band
// (PATHFIND.GATE_BAND_TILES) so the chokepoint threads at full fidelity.
const RETURN_WANDER_BLEND = 0.3;

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
  // Relative to this file (server/game/stealth.js) -> shared/dist/*.js.
  const mod = await import('../../shared/dist/step.js');
  const required = [
    'STEALTH', 'updateHumanLikeness', 'firstLawProtects',
    'freezeThreshold', 'robotDecision', 'dist2', 'facingFromVec',
    // Phase 4: collision-aware movement for players AND robots/idle animals.
    'moveWithCollision',
    // NPC movement refactor: home-return drift for released followers.
    'homeBiasedWanderStep',
    // Pathfinding plan: the return-home / robot path-follow uses these step.js
    // primitives directly in the hot loop — validate them at boot so a stale
    // shared/dist fails LOUD here, not mid-tick. (boxHitsSolid: near-wall test;
    // wanderVec: open-field saunter blend; hash32: per-entity repath phasing.)
    'boxHitsSolid', 'wanderVec', 'hash32',
    // Anti-vibration: the idle-wander facing commit uses the deadband helper +
    // its WANDER tuning, so validate both at boot (stale dist fails LOUD here).
    'facingFromVecDeadband', 'WANDER'
  ];
  const missing = required.filter((name) => mod[name] === undefined);
  if (missing.length) {
    throw new Error(
      `shared/dist/step.js is missing expected exports: ${missing.join(', ')}. ` +
      'Did you run `npm run build` in shared/? Refusing to re-implement the math.'
    );
  }
  shared = mod;

  // NPC movement refactor: the steering/patrol primitives (movement.js) and the
  // per-species gait registry (locomotion.js). Loaded + validated the same way so
  // a stale shared/dist fails LOUD at boot rather than mid-tick.
  const moveMod = await import('../../shared/dist/movement.js');
  const moveRequired = ['steerAround', 'patrolStep', 'chainFollowStep', 'speedBoost', 'wanderAvoid'];
  const moveMissing = moveRequired.filter((name) => moveMod[name] === undefined);
  if (moveMissing.length) {
    throw new Error(
      `shared/dist/movement.js is missing expected exports: ${moveMissing.join(', ')}. ` +
      'Did you run `npm run build` in shared/?'
    );
  }
  movement = moveMod;

  const locoMod = await import('../../shared/dist/locomotion.js');
  const locoRequired = ['locomotionFor', 'gaitSpeed', 'locomotionStep'];
  const locoMissing = locoRequired.filter((name) => locoMod[name] === undefined);
  if (locoMissing.length) {
    throw new Error(
      `shared/dist/locomotion.js is missing expected exports: ${locoMissing.join(', ')}. ` +
      'Did you run `npm run build` in shared/?'
    );
  }
  locomotion = locoMod;

  // The deterministic A* pathfinder (shared/dist/pathfind.js): the GLOBAL route
  // layer for return-home-through-the-gate and robot routing around walls, plus the
  // O(1) inBounds containment test the awareness filter uses. Loaded + validated the
  // same fail-loud way so a stale shared/dist trips at boot, not mid-tick.
  const pathMod = await import('../../shared/dist/pathfind.js');
  // The exports the server actually calls. (gateInsideTile is a shared/test helper —
  // world.js computes the gate-inside goal tile inline — so it's not validated here.)
  const pathRequired = ['findPath', 'makeScratch', 'toWorldWaypoints', 'nextWaypoint', 'inBounds'];
  const pathMissing = pathRequired.filter((name) => pathMod[name] === undefined);
  if (pathMissing.length) {
    throw new Error(
      `shared/dist/pathfind.js is missing expected exports: ${pathMissing.join(', ')}. ` +
      'Did you run `npm run build` in shared/?'
    );
  }
  pathfind = pathMod;

  // Hand the cached shared modules to the other orchestrators so there is exactly
  // ONE cached copy of each ESM module (they don't import() it themselves).
  follow.setShared(shared, movement, locomotion, pathfind);
  behaviors.setShared(shared, movement, pathfind);
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
 * shared wanderAvoid defaults to WORLD (1000²); the tilemap is MAP_W*TILE = 4096²,
 * so passing these lets a drifting decoy turn inward (soft edge bias) at the actual
 * edge. Falls back to undefined (→ shared's WORLD default) if dims are missing,
 * which is harmless since the collision grid is the hard backstop.
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
 * SITUATIONAL AWARENESS: an idle world-animal sitting "where it belongs" — inside
 * its own enclosure, or inside an aux building — is INVISIBLE to robots (it is not
 * a stealth target, so a robot must not freeze/investigate/pursue it and pointlessly
 * peel into a pen). Only animals OUTSIDE their home register: a follower being led
 * (leashed), an escaped/wandering animal, an animal still mid-return that hasn't
 * re-entered its pen yet (returningHome), and a fox decoy (no home rect). Players are
 * NEVER filtered (their branch has no pen rect). The filter is one point-in-rect per
 * idle animal — see isAtHomeAnimal. This is the single chokepoint feeding BOTH
 * robotDecision (perception/freeze/pursue) AND behaviors.pickInvestigateTarget.
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
  // Containment bounds for the awareness filter (cached once per room).
  const homeBounds = homeBoundsForRoom(roomName);
  const auxRects = auxInteriorRectsForRoom(roomName);

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
      // AWARENESS: an animal that is "where it belongs" is invisible to robots. A
      // LEASHED follower (being led around) or one mid-RETURN (returningHome, still
      // outside its pen) stays visible — only a genuinely at-home idler is hidden.
      if (!follow.isLeashed(e, currentTick) && !e.returningHome && isAtHomeAnimal(e, homeBounds, auxRects)) {
        continue;
      }
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
  if (!shared || !behaviors.isReady()) return { pursuingRobots: 0, catches: 0 };

  const worldEntities = world.getWorldEntities(roomName);
  const worldState = world.getWorldState(roomName);
  const lockdown = !!worldState.lockdown;

  // The room's collision grid, fetched ONCE per call (not per robot) for perf.
  // Robots respect walls just like players: a pursuit step that would tunnel
  // through a wall is blocked, and a patrol step into a wall is held.
  const rm = world.getRoomMap(roomName);
  // The room's robot patrol loop (path-network junctions in world units), also
  // fetched once. May be empty on a degenerate seed → behaviors falls back to
  // ambient wander-avoid. The hazard veto is shared with the pursue branch below.
  const route = world.getPatrolRoute(roomName);
  // Per-guard-robot containment bounds (aux-building interiors), fetched once and
  // cached per room. A guard robot wanders ONLY inside its building (behaviors.js
  // reads idleCtx.guardBounds); a plain patrol robot has no entry → undefined.
  const guardBoundsById = guardBoundsForRoom(roomName);
  // The room's reusable A* scratch + the path-follow helpers, handed to behaviors so
  // a robot routes AROUND walls / through a gate to an off-route goal (investigate a
  // noise behind a fence) instead of pressing into it with one-tile-ahead steering.
  const scratch = pathScratchForRoom(roomName, rm);
  const idleCtx = {
    rm,
    route,
    worldEntities,
    lockdown,
    currentTick,
    dt,
    entersHazard,
    guardBounds: undefined, // set per-robot below before stepRobotIdle
    scratch,
    followPathToGoal,
    clearPath,
  };

  // Disguise prop follows its carrier: each tick, if the prop has a carrierId,
  // snap it to that player's position so it visually rides along (the ape
  // courier). If the carrier has vanished (disconnect), free the prop in place.
  const prop = worldEntities.find((e) => e.kind === 'prop');
  if (prop && prop.carrierId) {
    const carrier = findPlayerById(connectedPlayers, rooms, roomName, prop.carrierId);
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
      // Remember where to resume patrol when the chase ends (capture on the edge,
      // before behavior flips to 'pursue'), then mark the FSM state. behaviors
      // owns the speed table (patrol < investigate < pursue + spontaneous boost).
      if (robot.behavior !== 'pursue') robot.lastPatrolIndex = robot.patrolIndex;
      robot.behavior = 'pursue';
      const speed = behaviors.speedFor(robot, lockdown, currentTick);

      // Wall + hazard avoidance, both honored before committing the chase step:
      //   - WALLS: route the chase heading through steerAround (so the robot
      //     rounds a fence corner toward the target instead of pressing into it),
      //     then the shared moveWithCollision integrator slides + refuses to
      //     tunnel (OOB is solid too). Run it on a COPY so we can also veto on the
      //     Third Law before committing.
      //   - Third Law (HAZARD): a robot won't chase INTO a skunk stink. If the
      //     resolved destination still lands in a hazard, it stalls this tick
      //     (still faces the target).
      const heading = movement.steerAround(
        robot, decision.dirX, decision.dirY, dt, speed,
        rm.collision, rm.w, rm.h, rm.tile, ROBOT_RADIUS
      );
      // steerAround returns {0,0} only when fully boxed in; fall back to the raw
      // pursue vector so a cornered robot still presses toward the target (slide).
      const hx = (heading.dirX === 0 && heading.dirY === 0) ? decision.dirX : heading.dirX;
      const hy = (heading.dirX === 0 && heading.dirY === 0) ? decision.dirY : heading.dirY;
      const trial = { x: robot.x, y: robot.y };
      shared.moveWithCollision(
        trial, hx, hy, dt, speed,
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
          (ref.shellUntilTick || 0) > currentTick ||
          // Post-spawn grace: a freshly (re)spawned player is catch-immune for a
          // short window, so a robot near the spawn point can't chain-catch it.
          (ref.spawnSafeUntilTick || 0) > currentTick
        );
        if (!uncatchable && shared.dist2(robot, target) <= touchR2) {
          // Respawn the player in THEIR OWN species pen (away from the gate-side
          // robot cluster), not the shared gate spawn — the other half of the
          // anti-loop fix, paired with the grace window stamped in catchPlayer.
          catchPlayer(target.ref, spawnForSpecies(roomName, target.ref.species, target.ref), currentTick);
          catches++;
        }
      }
    } else if (decision.mode === 'idle') {
      // Nothing close enough to chase → the PATROL ↔ INVESTIGATE ↔ RESUME FSM
      // (server/game/behaviors.js). A robot patrols the generated path loop, breaks
      // off to investigate a suspicious-but-distant animal at medium speed, then
      // resumes patrol at the nearest waypoint. robotDecision (perception) stays
      // untouched; this only decides what the body does when perception is idle.
      // Reports robot.mode = 'idle' on the wire (client renders it as before).
      // A guard robot is handed its aux-building containment bounds so it wanders
      // inside the building instead of patrolling; a patroller gets undefined.
      idleCtx.guardBounds = robot.guard ? guardBoundsById.get(robot.id) : undefined;
      behaviors.stepRobotIdle(robot, animals, idleCtx);
    }
    // 'frozen' robots hold position (frozen by the First Law — a convincing human
    // is nearby and must not be disturbed); 'ordered' returned earlier in the loop.
  }

  return { pursuingRobots, catches };
}

/**
 * Drift every idle world-animal in a room one step along its deterministic
 * wander heading (movement.wanderAvoid). These decoys have no input; making them
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
  if (!shared || !movement || !locomotion || !pathfind) return;
  const rm = world.getRoomMap(roomName);
  const mapB = mapBounds(rm);
  const homeBySpecies = homeBoundsForRoom(roomName);
  const gateBySpecies = homeGateForRoom(roomName);
  const scratch = pathScratchForRoom(roomName, rm);
  for (const e of world.getWorldEntities(roomName)) {
    if (e.kind !== 'animal') continue;
    // An animal still LEASHED to a player (active follower OR in its grace window)
    // is moved by follow.stepFollowers this tick (which runs right after this) —
    // skip it here so it isn't both drifted AND pulled along the chain (double-move).
    if (follow.isLeashed(e, currentTick)) continue;

    const species = penSpeciesOf(e.id);

    // RETURN HOME: a follower whose leash lapsed PATHS back into its enclosure,
    // routing around walls and THROUGH the gate (A*), rather than drifting toward the
    // center and jamming on the outside of the fence (the old proximity-hack bug).
    // The slow, ambient cadence is preserved: same WANDER_ANIMAL_SPEED + species
    // gait, and an open-field wander blend so it still reads as a saunter home — only
    // the chokepoint near the gate is followed at high fidelity so the gap threads.
    // "Home" is now a TRUE re-entry test (inside the inset interior bounds), not a
    // proximity guess. Keyed by e.species (how releaseToHome stamped it) with the
    // id-parsed species as a fallback so a pen animal still matches.
    if (e.returningHome) {
      const homeSpecies = (gateBySpecies.has(e.species) && e.species) || species;
      const homeBounds = homeBySpecies.get(e.species) || (species && homeBySpecies.get(species));
      const goalTile = homeSpecies && gateBySpecies.get(homeSpecies);

      // ARRIVED: genuinely inside the enclosure interior → done returning.
      if (homeBounds && pathfind.inBounds(e.x, e.y, homeBounds)) {
        e.returningHome = false;
        e.homeX = undefined;
        e.homeY = undefined;
        clearPath(e);
        // fall through to the normal contained wander below this tick.
      } else {
        const bx = e.x;
        const by = e.y;
        const waypoint = goalTile
          ? followPathToGoal(e, rm, scratch, goalTile.tx, goalTile.ty, currentTick)
          : null;

        if (waypoint) {
          // Head toward the next (dense, 1-tile) path waypoint. In genuinely OPEN
          // terrain blend a light ambient wander so the long walk still reads as a
          // leisurely saunter; whenever a WALL is near (within the gate band) follow
          // the path PURELY so the body never gets perturbed into a fence corner and
          // oscillates — this is the fix for the "stuck against the wall by the gate"
          // case. The wander is cosmetic; the slow cadence (speed + gait) is what
          // "looks good", and that is preserved either way.
          let dx = waypoint.x - e.x;
          let dy = waypoint.y - e.y;
          let len = Math.hypot(dx, dy) || 1;
          dx /= len; dy /= len;
          const bandPx = rm.tile * config.PATHFIND.GATE_BAND_TILES;
          const nearWall = shared.boxHitsSolid(e.x, e.y, ROBOT_RADIUS + bandPx, rm.collision, rm.w, rm.h, rm.tile);
          if (nearWall) {
            // NEAR A WALL (the gate chokepoint): the dense path already routes around
            // the wall — the next waypoint is one tile away and reachable — so feed the
            // heading STRAIGHT to the axis-separated integrator. We deliberately do NOT
            // run steerAround here: its probe fan would re-aim the clean path heading
            // and, combined with a diagonal toward a waypoint past a corner, oscillate
            // the body against the fence (the "stuck by the gate" bug). The slide in
            // moveWithCollision threads the gap one axis at a time.
            locomotion.locomotionStep(e, dx, dy, currentTick, dt, config.WANDER_ANIMAL_SPEED, rm.collision, rm.w, rm.h, rm.tile, ROBOT_RADIUS);
          } else {
            // OPEN terrain: blend a light ambient wander (the "looks good" saunter) and
            // route through steerAround for reactive avoidance of any stray obstacle.
            const wv = shared.wanderVec(e.id, currentTick);
            const w = RETURN_WANDER_BLEND;
            dx = (1 - w) * dx + w * wv.dirX;
            dy = (1 - w) * dy + w * wv.dirY;
            len = Math.hypot(dx, dy) || 1;
            dx /= len; dy /= len;
            const heading = movement.steerAround(e, dx, dy, dt, config.WANDER_ANIMAL_SPEED, rm.collision, rm.w, rm.h, rm.tile, ROBOT_RADIUS);
            const hx = (heading.dirX === 0 && heading.dirY === 0) ? dx : heading.dirX;
            const hy = (heading.dirX === 0 && heading.dirY === 0) ? dy : heading.dirY;
            locomotion.locomotionStep(e, hx, hy, currentTick, dt, config.WANDER_ANIMAL_SPEED, rm.collision, rm.w, rm.h, rm.tile, ROBOT_RADIUS);
          }
          // Commit faces the actual drift; UNCHANGED ambient speed + gait (cadence
          // preserved — a returning tortoise still crawls home at ½ speed).
          e.facing = shared.facingFromVec(e.x - bx, e.y - by, e.facing || 's');
          continue;
        }

        // FALLBACK (no route — degenerate seed / unreachable goal / no home tile):
        // the original home-biased wander drift, so an animal never strands forever.
        const home = { x: e.homeX || 0, y: e.homeY || 0 };
        const next = shared.homeBiasedWanderStep(e, currentTick, dt, config.WANDER_ANIMAL_SPEED, mapB, home);
        const ddx = next.x - e.x;
        const ddy = next.y - e.y;
        const dlen = Math.hypot(ddx, ddy) || 1;
        locomotion.locomotionStep(
          e, ddx / dlen, ddy / dlen, currentTick, dt, config.WANDER_ANIMAL_SPEED,
          rm.collision, rm.w, rm.h, rm.tile, ROBOT_RADIUS,
        );
        e.facing = shared.facingFromVec(e.x - bx, e.y - by, e.facing || 's');
        continue;
      }
    }

    // CONTAINMENT (Phase C): a pen animal (id `pen-${species}` / `pen-${species}-n`)
    // that is NOT following wanders ONLY within its enclosure interior rect. The soft
    // inward bias inside wanderAvoid turns it away from the fence before it reaches
    // the gate row; the collision grid is the hard backstop. Non-pen animals (the fox
    // lure `decoy-N`, any future free animal) have no entry → mapB → roam (unchanged).
    const bounds = (species && homeBySpecies.get(species)) || mapB;
    // wanderAvoid SLIDES off walls (deterministic probe-and-rotate) instead of pinning
    // flush to them until the heading re-rolls. The species gait is applied by feeding
    // it the gait-adjusted speed for this tick (gaitWanderSpeed) — so a wandering
    // tortoise crawls at ½ speed and a kangaroo's drift lurches in hop bursts (speed 0
    // on a pause tick → it holds, exactly like locomotionStep).
    const bx = e.x;
    const by = e.y;
    movement.wanderAvoid(
      e, currentTick, dt, gaitWanderSpeed(e, currentTick),
      rm.collision, rm.w, rm.h, rm.tile, ROBOT_RADIUS, bounds,
    );
    // Face the actual drift direction — but with a DEADBAND so a pen-corner grind
    // doesn't make the animal vibrate. wanderAvoid holds one desired heading for
    // ~40 ticks, yet when the body is pinned in a corner steerAround's probe fan
    // finds a DIFFERENT clear micro-slide every tick; deriving facing from each
    // sub-pixel displacement snapped it to wildly different dirs tick-to-tick
    // (the visible vibration). facingFromVecDeadband HOLDS the prior facing when
    // the actual move is below WANDER.FACING_DEADBAND, so facing only turns on a
    // real step. Deterministic + pure (no RNG/clock) like facingFromVec.
    e.facing = shared.facingFromVecDeadband(e.x - bx, e.y - by, e.facing || 's', shared.WANDER.FACING_DEADBAND);
  }
}

/** The gait-adjusted wander speed for an idle animal this tick (so wanderAvoid moves
 *  a tortoise at ½ speed, a kangaroo in hop bursts, etc. — the species gait applied
 *  to ambient drift, deterministically via the shared locomotion registry). */
function gaitWanderSpeed(entity, currentTick) {
  return locomotion.gaitSpeed(entity.species, entity.id, currentTick, config.WANDER_ANIMAL_SPEED);
}

/** The species owning a pen-anchor id (`pen-fox` / `pen-fox-2` → 'fox'), else null. */
function penSpeciesOf(id) {
  if (typeof id !== 'string' || !id.startsWith('pen-')) return null;
  // Strip the 'pen-' prefix and any '-<n>' index suffix.
  return id.slice(4).replace(/-\d+$/, '');
}

/** Per-room cache of species → enclosure containment bounds (built once per room). */
const homeBoundsByRoom = new Map();
function homeBoundsForRoom(roomName) {
  let b = homeBoundsByRoom.get(roomName);
  if (!b) {
    b = world.getHomeBoundsBySpecies(roomName);
    homeBoundsByRoom.set(roomName, b);
  }
  return b;
}

/** Per-room cache of guard-robot id → aux-building containment bounds (built once
 *  per room). A guard robot wanders only inside these bounds; see behaviors.js. */
const guardBoundsByRoom = new Map();
function guardBoundsForRoom(roomName) {
  let b = guardBoundsByRoom.get(roomName);
  if (!b) {
    b = world.getGuardBoundsByRobotId(roomName);
    guardBoundsByRoom.set(roomName, b);
  }
  return b;
}

/** Per-room cache of the aux-building INTERIOR rects (built once per room). Used by
 *  the awareness filter to treat any animal inside an aux interior as contained
 *  (invisible to robots), the same rule as a pen animal inside its enclosure. */
const auxInteriorRectsByRoom = new Map();
function auxInteriorRectsForRoom(roomName) {
  let r = auxInteriorRectsByRoom.get(roomName);
  if (!r) {
    r = world.getAuxInteriorRects(roomName);
    auxInteriorRectsByRoom.set(roomName, r);
  }
  return r;
}

/** Per-room cache of species → home gate-INSIDE goal tile (the return-home A*
 *  target — one tile inside the enclosure gate / building door). Built once per room. */
const homeGateByRoom = new Map();
function homeGateForRoom(roomName) {
  let g = homeGateByRoom.get(roomName);
  if (!g) {
    g = world.getHomeGateInsideBySpecies(roomName);
    homeGateByRoom.set(roomName, g);
  }
  return g;
}

/** Per-room reusable A* scratch buffer (sized to the room's grid). One per room,
 *  reused across every findPath call there so a search allocates nothing per call.
 *  Lazily built once the pathfinder + room map are available. */
const pathScratchByRoom = new Map();
function pathScratchForRoom(roomName, rm) {
  let s = pathScratchByRoom.get(roomName);
  if (!s) {
    s = pathfind.makeScratch(rm.w, rm.h);
    pathScratchByRoom.set(roomName, s);
  }
  return s;
}

/**
 * Ensure `entity` has a cached A* path toward goal TILE (goalTx,goalTy) and return
 * the current world-unit waypoint to head for — or null when no route exists (the
 * caller falls back to its reactive drift). The path is cached on the entity
 * (pathGoalTx/Ty + path + pathIndex + pathRepathTick) and recomputed only when the
 * goal tile changed, the path was exhausted/empty, or the slow repath cadence
 * elapsed (REPATH_TICKS, phased per-entity by hash32 so recomputes spread across
 * ticks and the look stays ambient). The waypoint list is simplified to turning
 * points with the gate-inside goal kept mandatory so the AABB threads the gap.
 *
 * Pure-ish: mutates only the entity's path-cache scratch (server-only, never
 * serialized) and reads the room collision grid; deterministic given (entity-state,
 * grid, goal, tick).
 *
 * @returns {{x:number,y:number}|null} the world-unit waypoint, or null if unreachable
 */
function followPathToGoal(entity, rm, scratch, goalTx, goalTy, currentTick, clearance) {
  const stale =
    !Array.isArray(entity.path) ||
    entity.path.length === 0 ||
    entity.pathGoalTx !== goalTx ||
    entity.pathGoalTy !== goalTy ||
    currentTick >= (entity.pathRepathTick || 0);

  if (stale) {
    const startTx = Math.floor(entity.x / rm.tile);
    const startTy = Math.floor(entity.y / rm.tile);
    // `clearance` (optional, {tile,radius}) is radius-aware routing that keeps a
    // body off wall corners — useful for a robot rounding an OPEN-ended barrier. But
    // a body that slid into a sub-radius nook mid-journey can have NO clearance-legal
    // neighbour and would repath to [] and jam, so when a clearance search comes up
    // empty we RETRY point-based (which the local steering can still follow out). The
    // gate-return path (animals) omits clearance entirely — the 2-tile gates thread
    // fine point-based, and point-based never has the nook problem. See callers.
    let tilePath = pathfind.findPath(rm.collision, rm.w, rm.h, startTx, startTy, goalTx, goalTy, scratch, undefined, clearance);
    if (tilePath.length === 0 && clearance) {
      tilePath = pathfind.findPath(rm.collision, rm.w, rm.h, startTx, startTy, goalTx, goalTy, scratch);
    }
    if (tilePath.length === 0) {
      entity.path = null; // unreachable / over-budget → caller falls back
      entity.pathGoalTx = goalTx;
      entity.pathGoalTy = goalTy;
      // Re-attempt after the cadence (a transient block may clear); phased by id.
      entity.pathRepathTick = currentTick + config.PATHFIND.REPATH_TICKS + (shared.hash32(entity.id) % config.PATHFIND.REPATH_TICKS);
      return null;
    }
    // Follow the DENSE tile path (no simplify): consecutive waypoints are one tile
    // apart and 4-neighbour-adjacent, so a straight step toward the next one is always
    // wall-clear. Simplifying to turning points let the body steer straight at a
    // distant waypoint THROUGH a wall corner and oscillate against it (the gate is on
    // the far face), which stranded animals approaching a pen from the wrong side.
    entity.path = pathfind.toWorldWaypoints(tilePath, rm.tile);
    entity.pathIndex = 0;
    entity.pathGoalTx = goalTx;
    entity.pathGoalTy = goalTy;
    entity.pathRepathTick = currentTick + config.PATHFIND.REPATH_TICKS + (shared.hash32(entity.id) % config.PATHFIND.REPATH_TICKS);
  }

  if (!entity.path || entity.path.length === 0) return null;
  const arriveR = rm.tile * config.PATHFIND.ARRIVE_TILES;
  const step = pathfind.nextWaypoint(entity.path, entity.pathIndex || 0, entity, arriveR);
  entity.pathIndex = step.index;
  return step.target;
}

/** Clear an entity's cached A* path scratch (on a goal/behavior change so a stale
 *  route can't bleed into the next one). Server-only fields, never serialized. */
function clearPath(entity) {
  entity.path = null;
  entity.pathIndex = 0;
  entity.pathGoalTx = undefined;
  entity.pathGoalTy = undefined;
  entity.pathRepathTick = 0;
}

/**
 * Whether an idle world-animal is "where it belongs" and so INVISIBLE to robots:
 * sitting inside its own species' enclosure, OR inside any aux-building interior.
 * A point-in-rect test (pathfind.inBounds) against the already-cached containment
 * bounds — O(1), deterministic, zero new wire state. Keyed by the id-parsed pen
 * species (penSpeciesOf) with e.species as a fallback. An animal with no home rect
 * (a transient fox decoy `decoy-N`, an unlisted species) is never contained → stays
 * visible (a decoy MUST draw pursuit). The caller has already excluded leashed +
 * returning-home animals, so this only fires for genuinely at-home idlers.
 * @param {object} e            the animal entity
 * @param {Map} homeBounds      species → enclosure bounds (homeBoundsForRoom)
 * @param {object[]} auxRects   aux interior rects (auxInteriorRectsForRoom)
 * @returns {boolean}
 */
function isAtHomeAnimal(e, homeBounds, auxRects) {
  if (!pathfind) return false; // not loaded yet (boot) → don't hide anything
  const species = penSpeciesOf(e.id) || e.species;
  const home = species && homeBounds.get(species);
  if (home && pathfind.inBounds(e.x, e.y, home)) return true;
  for (const rect of auxRects) {
    if (pathfind.inBounds(e.x, e.y, rect)) return true;
  }
  return false;
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
 * The spawn point for a player of `species` in a room: the CENTER of that species'
 * own pen/home (world units), with a small deterministic per-player jitter so two
 * same-species players don't stack exactly. Spawning in the home pen — not the
 * gate-side block — keeps the player clear of the robot patrol cluster around the
 * entrance, which was the source of the spawn-on-robot infinite catch loop (a
 * post-spawn grace window, stamped by the callers, is the second guard).
 *
 * Falls back to the room's first map spawn (gate-side `map.spawns[0]`) when the
 * species has no home (shouldn't happen for a playable species) — that fallback
 * lives inside `world.spawnForSpecies`. The jitter is bounded to the pen interior
 * bounds so the offset can never push the player into a wall; world-gen proves
 * every pen center is non-solid + reachable, and the interior is >= 6x6 tiles, so
 * a sub-tile jitter stays walkable.
 *
 * @param {string} roomName
 * @param {string} species
 * @param {object} [player]  used only for a stable per-player jitter seed (id)
 * @returns {{ x: number, y: number }}
 */
function spawnForSpecies(roomName, species, player) {
  // Delegates to world.spawnForSpecies (the ONE place that owns pen-center +
  // bounded jitter), keyed by the player id so the per-player offset is stable.
  return world.spawnForSpecies(roomName, species, player && player.id);
}

/**
 * Soft catch (Phase 2): the player loses its built-up disguise and is teleported
 * back to a spawn point. Phase 3 escalates this (lockdown / elimination).
 * @param {object} player
 * @param {{x:number,y:number}} spawn  the room's spawn point to reset to (caller
 *   resolves it from world.getRoomMap(roomName).spawns[0]).
 */
function catchPlayer(player, spawn, currentTick) {
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
  // Animal collection: a catch is the sting — you lose your collected food AND the
  // herd you were leading (the animals are freed back to idle drift). Cleared here
  // so the loss is part of the soft-respawn reset. player.room is set at join.
  follow.resetPlayer(player);
  if (player.room) follow.releaseFollowersOf(player.room, player.id);
  // Quest: a catch RESTARTS the quest for the SAME species (keep the animal,
  // re-zero stepIndex/done/complete + the distinct-terminal Set). Does NOT roll a
  // new species — that's the respawnPlayer (escape) path via initPlayer.
  quests.resetSteps(player);
  // Soft respawn in the player's own species pen (passed by the caller). A short
  // post-respawn GRACE window makes the player catch-immune (see the catch hook),
  // so a robot lingering near the respawn point can't chain-catch into an infinite
  // loop. The grace is stamped here (one place every catch funnels through).
  const at = spawn || { x: 50, y: 50 };
  player.x = at.x;
  player.y = at.y;
  player.spawnSafeUntilTick = (currentTick || 0) + secsToTicks(config.SPAWN_GRACE_SECS);
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
 * @param {string} roomName  the room to respawn into; the spawn point is resolved
 *   here via spawnForSpecies AFTER the species roll, so the pen matches the NEW
 *   species (not the old one).
 * @param {number} currentTick
 */
function respawnPlayer(player, roomName, currentTick) {
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
  // Animal collection: a fresh run starts with an empty food bag and no pending
  // gate toast. Release any follower still chasing this id (those scored at the
  // gate were already released; this frees a straggler fed DURING the celebration
  // window). scoreTotal is NOT reset — it's the running round score, persisted.
  follow.resetPlayer(player);
  if (player.room) follow.releaseFollowersOf(player.room, player.id);
  // Into the NEW species' pen (resolved here, after the species roll above), with
  // the same post-respawn grace window so the fresh run can't be instantly
  // re-caught at the spawn point. Mirrors catchPlayer.
  const at = spawnForSpecies(roomName, player.species, player);
  player.x = at.x;
  player.y = at.y;
  player.spawnSafeUntilTick = (currentTick || 0) + secsToTicks(config.SPAWN_GRACE_SECS);
  // Stamp the start of this fresh run (spawn→gate timing for escape-time-by-species),
  // so the NEXT escape measures from this respawn, not the original join.
  player.spawnedAtTick = currentTick || 0;
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
      respawnPlayer(player, roomName, currentTick);
    }
    return;
  }

  const gate = world.getWorldEntities(roomName).find((e) => e.kind === 'gate');
  if (!gate) return;
  // A generous reach so brushing the gate counts (it's the goal, not a trap).
  const reach = config.RECT_SIZE * 1.5;
  if (shared.dist2(player, gate) > reach * reach) return;

  // Phase 6: the ape's 'fetch' step completes the instant a CARRYING player
  // reaches the gate (the deposit). Evaluate it BEFORE the gate gating below so
  // the same tick both completes the quest and lets the courier escape.
  quests.stepFetchAtGate(player, gate, reach);
  // An 'escort' final step (cheetah/kangaroo/chameleon) completes at the gate when
  // the player arrives with >= need LIVE followers — evaluated here, before the
  // isComplete gate, so the herd-at-gate waypoint can complete + escape the same
  // tick. It only OBSERVES the herd; scoreEscape still banks it once below.
  quests.stepEscort(player, roomName, currentTick);

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
  // Escape-time-by-species: record THIS run's spawn→gate duration against the
  // species the player escaped AS (its own escape, not followers — those are
  // credited by scoreEscape below). spawnedAtTick is stamped at join (lobby.js)
  // and on every respawn (respawnPlayer); guard a missing/stale stamp.
  const spawnedAt = Number(player.spawnedAtTick);
  if (Number.isFinite(spawnedAt) && currentTick > spawnedAt) {
    const elapsedSecs = (currentTick - spawnedAt) / (config.TICK_RATE || 20);
    bumpOwnEscape(player, player.species, elapsedSecs);
  } else {
    bumpOwnEscape(player, player.species, 0); // still count the escape, no time
  }
  // Animal collection: bank the herd. Awards points for your own animal + each
  // following animal that escapes with you (stolen ones worth more), credits
  // escaped-by-species for the player and every follower, stamps player.lastScore
  // (the client toast) + scoreTotal, and releases the followers at the gate. Runs
  // on the same escape edge so the score is ready when the client sees `escaped`.
  follow.scoreEscape(player, roomName, currentTick);
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
      // FOOD FIRST: collecting from a kind:'food' source is a "use the world" verb
      // (same family as tapping a terminal) but a DISJOINT target class — food
      // sources live inside enclosures, terminals on roads. Early-return on a
      // successful collect so one press never both collects food AND orders a robot.
      if (follow.collectNearbyFood(player, roomName, currentTick)) break;
      // Interacting near a terminal acts like a Second-Law order to the nearest
      // robot (a terminal command stands a patrol down), and advances an 'activate'
      // quest (elephant/peacock/parrot) by counting each DISTINCT terminal tapped.
      if (nearTerminal(player, roomName)) {
        orderNearestRobot(player, roomName, currentTick);
        quests.onInteract(player, roomName);
      }
      break;
    case 'feed':
      // Give the nearest feedable animal its liked food → it follows you (or, if it
      // was following someone else, you steal it). A DEDICATED verb (not overloaded
      // on 'interact') so it never collides with the terminal / 'activate'-quest path.
      follow.feedNearbyAnimal(player, roomName, currentTick);
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
    // Quest: an 'ability' step OBSERVES this fired edge (never re-bumps the
    // abilitiesUsed stat above — only advances the quest's current step).
    quests.onAbility(player);
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
  // Quest: an 'order' step OBSERVES this landed-order edge (it fires for BOTH the
  // terminal-tap order path and a direct 'order' action). Never re-bumps the
  // ordersIssued stat above — only advances the quest's current step.
  quests.onOrder(player);

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
