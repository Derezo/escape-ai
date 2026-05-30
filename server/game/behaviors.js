'use strict';

/**
 * Robot behavior FSM (server authoritative). The Three-Laws PERCEPTION lives in
 * shared/src/step.ts (robotDecision) and is UNCHANGED — this module owns only
 * what a robot DOES with its body: patrol the generated path loop, break off to
 * investigate a suspicious-but-distant target, and resume. stealth.stepRobots
 * still runs the per-robot loop (suspicion decay, Second-Law standdown, the
 * pursue branch + catch hook + panic tally); it delegates the non-pursue
 * movement here and pulls its chase speed from speedFor() so all robot speeds
 * (patrol < investigate < pursue, plus the spontaneous boost) live in one place.
 *
 * Mirrors the follow.js orchestrator pattern: the cached shared ESM modules are
 * handed over once via setShared() (the server is CommonJS; it never import()s
 * them itself). All movement math is the shared deterministic primitives — this
 * module never re-implements it. Behavior state (behavior, patrolIndex,
 * lastPatrolIndex, investigate*) lives on the robot entity, single-writer here.
 */

const config = require('../config');
const world = require('./world');
const { secsToTicks } = require('./room-utils');

// Cached shared modules (handed over by stealth.loadShared via setShared).
let shared = null;   // shared/dist/step.js — dist2, facingFromVec, freezeThreshold, …
let movement = null; // shared/dist/movement.js — steerAround, patrolStep, speedBoost
let pathfind = null; // shared/dist/pathfind.js — findPath (route around walls to a goal)

/** Hand over the cached shared step + movement (+ pathfind) modules. Called from
 *  stealth.loadShared(). `pathMod` is used by the investigate routing (Phase 4);
 *  optional so callers/tests that pass only step+movement keep working. */
function setShared(stepMod, moveMod, pathMod) {
  shared = stepMod;
  movement = moveMod;
  if (pathMod) pathfind = pathMod;
}

/** True once setShared has run (stealth gates the robot step on this). */
function isReady() {
  return shared !== null && movement !== null;
}

// Collision half-extent for a robot (mirrors stealth.ROBOT_RADIUS = RECT_SIZE*0.4).
const ROBOT_RADIUS = config.RECT_SIZE * 0.4;

/**
 * The robot's base move speed for its current behavior this tick, with the
 * lockdown multiplier and the deterministic spontaneous boost folded in. One
 * source of truth for every robot speed so patrol/investigate/pursue stay in a
 * consistent ratio and a boost reads the same everywhere.
 *
 *   patrol      → PATROL_SPEED        (slow rounds)
 *   investigate → INVESTIGATE.SPEED   (medium — heading to a last-known spot)
 *   pursue      → ROBOT_SPEED         (fast chase)
 *
 * @param {object} robot
 * @param {boolean} lockdown
 * @param {number} currentTick
 * @returns {number}
 */
function speedFor(robot, lockdown, currentTick) {
  let base;
  switch (robot.behavior) {
    case 'pursue': base = config.ROBOT_SPEED; break;
    case 'investigate': base = config.INVESTIGATE.SPEED; break;
    default: base = config.PATROL_SPEED; break; // patrol (and any unset state)
  }
  const lockMult = lockdown ? config.ROBOT_LOCKDOWN_SPEED_MULT : 1;
  return base * lockMult * movement.speedBoost(robot.id, currentTick);
}

/**
 * The nearest animal that's suspicious enough to investigate but not (yet) being
 * pursued: within a WIDER investigate ring than perception's pursue range, and
 * NOT convincingly human (a human-looking animal is First-Law protected, never a
 * target). Keeps robotDecision untouched — this is a separate, wider "something's
 * off over there" sense layered on the server.
 *
 * @param {object} robot
 * @param {object[]} animals  the gatherAnimals() candidates ({id,x,y,humanLikeness})
 * @returns {object|null}
 */
function pickInvestigateTarget(robot, animals) {
  const ring = shared.STEALTH.PERCEPTION_RADIUS * config.INVESTIGATE.RADIUS_MULT;
  const ring2 = ring * ring;
  const threshold = shared.freezeThreshold(robot.suspicion || 0);
  let best = null;
  let bestD2 = ring2;
  for (const a of animals) {
    if ((a.humanLikeness || 0) >= threshold) continue; // looks human → ignore
    const d2 = shared.dist2(robot, a);
    if (d2 <= bestD2) {
      bestD2 = d2;
      best = a;
    }
  }
  return best;
}

/**
 * The index of the nearest waypoint on `route` to `robot` (so a robot dragged far
 * by a chase resumes patrol at the closest point, not its stale index). Returns 0
 * for an empty route.
 */
function nearestWaypointIndex(robot, route) {
  let idx = 0;
  let bestD2 = Infinity;
  for (let i = 0; i < route.length; i++) {
    const dx = route[i].x - robot.x;
    const dy = route[i].y - robot.y;
    const d2 = dx * dx + dy * dy;
    if (d2 < bestD2) { bestD2 = d2; idx = i; }
  }
  return idx;
}

/** Lazily initialize a robot's patrol/behavior state the first time it's stepped.
 *  A guard robot keeps its 'guard' behavior (it contains itself rather than
 *  patrolling); only a non-guard with no behavior defaults to 'patrol'. */
function ensureInit(robot, route) {
  if (robot.behavior === undefined) robot.behavior = robot.guard ? 'guard' : 'patrol';
  if (typeof robot.patrolIndex !== 'number') {
    // Phase each robot to a distinct starting waypoint so they spread around the
    // loop instead of clumping (deterministic — hash of the id, no RNG).
    robot.patrolIndex = route.length > 0 ? shared.hash32(robot.id) % route.length : 0;
  }
  if (typeof robot.lastPatrolIndex !== 'number') robot.lastPatrolIndex = robot.patrolIndex;
}

/**
 * Move toward a world point with GLOBAL A* routing (around walls / through a gate)
 * plus the local obstacle-aware slide, vetoing a step that would land in a hazard
 * (Third Law). Mutates robot.{x,y} and sets facing from the heading actually taken.
 * Used by the investigate branch so a robot rounds a fence to reach a noise behind
 * it instead of pressing into the wall with one-tile-ahead steering.
 *
 * Routes via ctx.followPathToGoal (the shared cached-path helper) to the target's
 * TILE; the returned waypoint is steered toward with the existing steerAround. If no
 * route exists (findPath returns []) it falls back to steering toward the raw point
 * — the original behavior, zero regression on a degenerate map / unreachable spot.
 */
function moveTowardPoint(robot, tx, ty, dt, speed, rm, worldEntities, entersHazard, ctx) {
  // Default heading: straight at the raw point (the fallback when there's no route).
  let aimX = tx;
  let aimY = ty;
  let onPath = false;
  // GLOBAL route: ask for the next waypoint toward the target tile (cached + cadence-
  // gated inside the helper). Only when the pathfinder + helpers are wired (Phase 4).
  if (ctx && pathfind && ctx.followPathToGoal && ctx.scratch) {
    const goalTx = Math.floor(tx / rm.tile);
    const goalTy = Math.floor(ty / rm.tile);
    // Radius-aware so a robot rounds an open-ended barrier without hugging its corner;
    // followPathToGoal retries point-based if a clearance search comes up empty, so a
    // wedged robot is never stranded.
    const clearance = { tile: rm.tile, radius: ROBOT_RADIUS };
    const wp = ctx.followPathToGoal(robot, rm, ctx.scratch, goalTx, goalTy, ctx.currentTick, clearance);
    if (wp) { aimX = wp.x; aimY = wp.y; onPath = true; }
    // wp === null → unreachable: keep the straight-at-point fallback.
  }

  const dx = aimX - robot.x;
  const dy = aimY - robot.y;
  const len = Math.hypot(dx, dy) || 1;
  const ux = dx / len;
  const uy = dy / len;

  // NEAR A WALL while following a path: feed the heading STRAIGHT to the axis-separated
  // integrator. The dense path already routes around the wall (the next waypoint is one
  // tile away and reachable), so steerAround's probe fan would only re-aim it and
  // oscillate the body against a fence corner — the same "stuck by the gate" failure
  // the animal return-home path hit. In the OPEN, or with no path, keep steerAround for
  // reactive avoidance. The hazard veto (Third Law) applies in both branches.
  const bandPx = rm.tile * config.PATHFIND.GATE_BAND_TILES;
  const nearWall = shared.boxHitsSolid(robot.x, robot.y, ROBOT_RADIUS + bandPx, rm.collision, rm.w, rm.h, rm.tile);

  let hx;
  let hy;
  if (onPath && nearWall) {
    hx = ux;
    hy = uy;
  } else {
    const heading = movement.steerAround(robot, ux, uy, dt, speed, rm.collision, rm.w, rm.h, rm.tile, ROBOT_RADIUS);
    if (heading.dirX === 0 && heading.dirY === 0) return; // boxed in — hold this tick
    hx = heading.dirX;
    hy = heading.dirY;
  }

  const trial = { x: robot.x, y: robot.y };
  shared.moveWithCollision(trial, hx, hy, dt, speed, rm.collision, rm.w, rm.h, rm.tile, ROBOT_RADIUS);
  if (!entersHazard(trial.x, trial.y, worldEntities)) {
    robot.x = trial.x;
    robot.y = trial.y;
  }
  robot.facing = shared.facingFromVec(hx, hy, robot.facing || 's');
}

/**
 * The robot's non-pursue movement for this tick — the PATROL ↔ INVESTIGATE ↔
 * RESUME state machine. Called from stealth.stepRobots when robotDecision did NOT
 * return 'pursue' (i.e. decision.mode === 'idle': nothing close enough to chase).
 * Keeps robot.mode = 'idle' on the wire (the client renders patrol/investigate
 * the same as idle — no RobotMode change needed).
 *
 * A GUARD robot (robot.guard) is a special idle state: instead of walking the
 * shared patrol route it stays CONTAINED inside its aux building via wanderAvoid
 * over ctx.guardBounds (mirrors how idle pen animals stay in their enclosure). It
 * still breaks off to investigate intruders normally (the investigate branch is
 * shared) — only its baseline / resume movement differs from a patroller's.
 *
 * @param {object} robot               mutated in place
 * @param {object[]} animals           gatherAnimals() candidates (for investigate)
 * @param {object} ctx                 { rm, route, worldEntities, lockdown, currentTick, dt, entersHazard, guardBounds?, scratch?, followPathToGoal?, clearPath? }
 */
function stepRobotIdle(robot, animals, ctx) {
  const { rm, route, worldEntities, lockdown, currentTick, dt, entersHazard, guardBounds } = ctx;
  ensureInit(robot, route);

  // Reset any cached A* path on an FSM transition so a stale investigate route can't
  // bleed into a resume / a later investigate of a different spot (the helper also
  // recomputes on a goal-tile change, but an explicit clear on the edge is robust).
  const resetPathOnTransition = (next) => {
    if (robot.behavior !== next && ctx.clearPath) ctx.clearPath(robot);
  };

  const target = pickInvestigateTarget(robot, animals);

  if (target) {
    // Break patrol/guard to investigate. Capture where to resume on the edge (a
    // guard has no patrolIndex to keep, but the assignment is harmless).
    if (robot.behavior !== 'investigate') robot.lastPatrolIndex = robot.patrolIndex;
    resetPathOnTransition('investigate');
    robot.behavior = 'investigate';
    robot.investigateX = target.x;
    robot.investigateY = target.y;
    robot.investigateUntilTick = currentTick + secsToTicks(config.INVESTIGATE.LINGER_SECS);
    const speed = speedFor(robot, lockdown, currentTick);
    moveTowardPoint(robot, target.x, target.y, dt, speed, rm, worldEntities, entersHazard, ctx);
    return;
  }

  if (robot.behavior === 'investigate' && currentTick < (robot.investigateUntilTick || 0)) {
    // No fresh target, but still lingering: walk to / wait at the last-known spot.
    const speed = speedFor(robot, lockdown, currentTick);
    moveTowardPoint(robot, robot.investigateX, robot.investigateY, dt, speed, rm, worldEntities, entersHazard, ctx);
    return;
  }

  // GUARD: no fresh target and not lingering → resume the contained wander inside
  // the aux building (NOT the patrol route). The soft inward bias in wanderAvoid
  // keeps the guard off its walls, same as a contained pen animal. Falls back to
  // ambient wander if guardBounds is missing (a degenerate map) — never patrols.
  if (robot.guard) {
    resetPathOnTransition('guard');
    robot.behavior = 'guard';
    const bx = robot.x;
    const by = robot.y;
    movement.wanderAvoid(
      robot, currentTick, dt, speedFor(robot, lockdown, currentTick),
      rm.collision, rm.w, rm.h, rm.tile, ROBOT_RADIUS, guardBounds,
    );
    // Face the actual drift (zero delta on a boxed-in tick holds facing), mirroring
    // how stepIdleAnimals faces a contained pen animal after wanderAvoid.
    robot.facing = shared.facingFromVec(robot.x - bx, robot.y - by, robot.facing || 's');
    return;
  }

  // RESUME PATROL. On the transition out of investigate, rejoin the loop at the
  // NEAREST waypoint (a chase may have dragged the robot far from lastPatrolIndex).
  // The patrol LOOP itself stays on the carved spine (patrolStep over patrolRoute) —
  // the spine is already path-connected, so A* only ever engages for the off-route
  // investigate goal, not the loop. Clear any stale investigate path on the edge.
  if (robot.behavior !== 'patrol') {
    robot.patrolIndex = route.length > 0 ? nearestWaypointIndex(robot, route) : robot.lastPatrolIndex;
    resetPathOnTransition('patrol');
  }
  robot.behavior = 'patrol';

  if (route.length === 0) {
    // Degenerate seed: no patrol loop → fall back to ambient wander-avoid.
    movement.wanderAvoid(
      robot, currentTick, dt, speedFor(robot, lockdown, currentTick),
      rm.collision, rm.w, rm.h, rm.tile, ROBOT_RADIUS,
    );
    return;
  }

  const speed = speedFor(robot, lockdown, currentTick);
  const res = movement.patrolStep(
    robot, route, robot.patrolIndex, dt, speed,
    rm.collision, rm.w, rm.h, rm.tile, ROBOT_RADIUS,
  );
  // Hazard veto (Third Law) on the resolved destination, same as the pursue path.
  if (!entersHazard(res.x, res.y, worldEntities)) {
    robot.x = res.x;
    robot.y = res.y;
    robot.patrolIndex = res.index;
  }
  robot.facing = shared.facingFromVec(res.dirX, res.dirY, robot.facing || 's');
}

module.exports = {
  setShared,
  isReady,
  speedFor,
  stepRobotIdle,
  pickInvestigateTarget,
};
