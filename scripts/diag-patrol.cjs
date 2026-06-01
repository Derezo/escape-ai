'use strict';
/*
 * Robot-patrol regression diagnostic. Two parts:
 *
 *   STATIC  — generate a room world and dump the patrol waypoints + robot spawns,
 *             plus the straight-line connectivity of the global loop. (The straight
 *             "BLOCKED" count is now EXPECTED to be non-zero — the loop is walked with
 *             A*, not straight-line steering — so it is reported, not asserted.)
 *
 *   DYNAMIC — drive the REAL behaviors.stepRobotIdle patrol path for N ticks against
 *             the real shared movement/pathfind, and ASSERT each patrol robot advances
 *             through its designated local loop and makes net forward progress (no
 *             robot stays pinned in one spot — the bug this fix closes). Exits non-zero
 *             if any robot is stuck, so it can gate CI / a pre-commit check.
 *
 * Usage:  node scripts/diag-patrol.cjs [room]      (default room "default")
 *         node scripts/diag-patrol.cjs --all       (run the dynamic check on a seed sweep)
 */

const path = require('path');
const sharedDir = path.join(__dirname, '..', 'shared', 'dist');
const world = require(path.join(sharedDir, 'world.js'));
const rng = require(path.join(sharedDir, 'rng.js'));
const movement = require(path.join(sharedDir, 'movement.js'));
const stepMod = require(path.join(sharedDir, 'step.js'));
const pathfind = require(path.join(sharedDir, 'pathfind.js'));
const behaviors = require(path.join(__dirname, '..', 'server', 'game', 'behaviors.js'));

const ROBOT_RADIUS = 32 * 0.4; // mirror behaviors.ROBOT_RADIUS (config.RECT_SIZE * 0.4)
const TICK_HZ = 20;
const DT = 1 / TICK_HZ;

behaviors.setShared(stepMod, movement, pathfind);

function buildRoom(room) {
  const seed = rng.seedFromString(room);
  const map = world.generateWorld(seed);
  const rm = { tile: map.tile, collision: map.collision, w: map.w, h: map.h };
  return { seed, map, rm };
}

// A faithful slim copy of stealth.js's followPathToGoal/clearPath (the cached A*
// path-follow the robots use). Server-only scratch lives on the entity, same as prod.
function makePathHelpers(rm) {
  const scratch = pathfind.makeScratch(rm.w, rm.h);
  const REPATH = 30; // ~config.PATHFIND.REPATH_TICKS; only affects cadence, not correctness
  const ARRIVE_TILES = 1.0;
  function followPathToGoal(entity, _rm, _scratch, goalTx, goalTy, currentTick, clearance) {
    const stale =
      !Array.isArray(entity.path) || entity.path.length === 0 ||
      entity.pathGoalTx !== goalTx || entity.pathGoalTy !== goalTy ||
      currentTick >= (entity.pathRepathTick || 0);
    if (stale) {
      const startTx = Math.floor(entity.x / rm.tile);
      const startTy = Math.floor(entity.y / rm.tile);
      let tp = pathfind.findPath(rm.collision, rm.w, rm.h, startTx, startTy, goalTx, goalTy, scratch, undefined, clearance);
      if (tp.length === 0 && clearance) tp = pathfind.findPath(rm.collision, rm.w, rm.h, startTx, startTy, goalTx, goalTy, scratch);
      if (tp.length === 0) {
        entity.path = null; entity.pathGoalTx = goalTx; entity.pathGoalTy = goalTy;
        entity.pathRepathTick = currentTick + REPATH + (stepMod.hash32(entity.id) % REPATH);
        return null;
      }
      entity.path = pathfind.toWorldWaypoints(tp, rm.tile);
      entity.pathIndex = 0; entity.pathGoalTx = goalTx; entity.pathGoalTy = goalTy;
      entity.pathRepathTick = currentTick + REPATH + (stepMod.hash32(entity.id) % REPATH);
    }
    if (!entity.path || entity.path.length === 0) return null;
    const arriveR = rm.tile * ARRIVE_TILES;
    const step = pathfind.nextWaypoint(entity.path, entity.pathIndex || 0, entity, arriveR);
    entity.pathIndex = step.index;
    return step.target;
  }
  function clearPath(entity) {
    entity.path = null; entity.pathIndex = 0;
    entity.pathGoalTx = undefined; entity.pathGoalTy = undefined; entity.pathRepathTick = 0;
  }
  return { scratch, followPathToGoal, clearPath };
}

function patrolRobots(map) {
  return map.entitySpecs
    .filter((s) => s.kind === 'robotSpawn' && !(s.meta && s.meta.guard))
    .map((s) => ({ id: s.id, x: s.x, y: s.y, name: s.id, kind: 'robot', suspicion: 0, facing: 's', behavior: 'patrol' }));
}

function tileOf(px, py, tile) { return { tx: Math.floor(px / tile), ty: Math.floor(py / tile) }; }

function staticReport(room) {
  const { seed, map, rm } = buildRoom(room);
  const route = map.patrolRoute || [];
  console.log(`\n=== STATIC  room "${room}" seed=${seed} map=${rm.w}x${rm.h} tile=${rm.tile} ===`);
  console.log(`patrolRoute length: ${route.length}`);
  route.forEach((wp, i) => {
    const t = tileOf(wp.x, wp.y, rm.tile);
    const solid = rm.collision[t.ty * rm.w + t.tx] === 1;
    console.log(`  [${i}] tile(${t.tx},${t.ty}) ${solid ? '*** SOLID ***' : 'walkable'}`);
  });
  // Straight-line connectivity (informational — A* now traverses, so crossings are expected).
  let blocked = 0;
  for (let i = 0; i < route.length; i++) {
    const a = route[i], b = route[(i + 1) % route.length];
    const steps = Math.max(1, Math.ceil(Math.hypot(b.x - a.x, b.y - a.y) / (rm.tile / 2)));
    let hit = false;
    for (let s = 0; s <= steps && !hit; s++) {
      const t = tileOf(a.x + (b.x - a.x) * s / steps, a.y + (b.y - a.y) * s / steps, rm.tile);
      if (t.tx < 0 || t.ty < 0 || t.tx >= rm.w || t.ty >= rm.h || rm.collision[t.ty * rm.w + t.tx] === 1) hit = true;
    }
    if (hit) blocked++;
  }
  console.log(`straight-line global-loop segments crossing solids: ${blocked}/${route.length} (informational — loop is A*-walked)`);
}

// Drive the real patrol FSM and assert forward progress. A single local-loop leg can
// be a long A* detour around the river (~50s wall-clock), so the window must cover at
// least one full 3-leg loop — 3000 ticks (150s @ 20Hz) is ~2 full loops, comfortable.
function dynamicCheck(room, ticks = 3000, verbose = true) {
  const { seed, map, rm } = buildRoom(room);
  const route = map.patrolRoute || [];
  const robots = patrolRobots(map);
  const { scratch, followPathToGoal, clearPath } = makePathHelpers(rm);
  const ctx = {
    rm, route, worldEntities: [], lockdown: false, currentTick: 0, dt: DT,
    entersHazard: () => false, // no hazards in the diagnostic
    guardBounds: undefined, scratch, followPathToGoal, clearPath,
    pickGuardTarget: () => null,
  };

  // Per-robot telemetry: set of local-loop POSITIONS visited (arrived at), and total
  // distance moved (to detect a robot pinned in place).
  const tel = robots.map(() => ({ visited: new Set(), moved: 0, lastArrivedPos: -1 }));

  for (let t = 0; t < ticks; t++) {
    ctx.currentTick = t;
    robots.forEach((r, i) => {
      const px = r.x, py = r.y;
      behaviors.stepRobotIdle(r, [], ctx); // no animals → pure patrol path
      tel[i].moved += Math.hypot(r.x - px, r.y - py);
      // Record arrival at a local-loop position (within the 48px arrive gate).
      if (Array.isArray(r.localLoop) && r.localLoop.length) {
        const wp = route[r.localLoop[r.localLoopPos]];
        if (Math.hypot(wp.x - r.x, wp.y - r.y) <= rm.tile * movement.PATROL.ARRIVE_TILES) {
          tel[i].visited.add(r.localLoopPos);
        }
      }
    });
  }

  console.log(`\n=== DYNAMIC room "${room}" seed=${seed}  ${ticks} ticks (${(ticks / TICK_HZ).toFixed(0)}s @ ${TICK_HZ}Hz) ===`);
  let allPass = true;
  robots.forEach((r, i) => {
    const loopLen = Array.isArray(r.localLoop) ? r.localLoop.length : 0;
    const visited = tel[i].visited.size;
    const movedTiles = tel[i].moved / rm.tile;
    // PASS criteria: the robot cycled its WHOLE local loop (visited every position) AND
    // moved a meaningful distance (not pinned). loopLen is 1..3; require all positions.
    const cycledAll = loopLen > 0 && visited >= loopLen;
    const movedEnough = movedTiles >= loopLen * 4; // at least a few tiles per leg
    const pass = cycledAll && movedEnough;
    if (!pass) allPass = false;
    if (verbose) {
      console.log(`  ${r.id}  localLoop=[${(r.localLoop || []).join(',')}]  visited ${visited}/${loopLen} positions  moved ${movedTiles.toFixed(0)} tiles  ${pass ? 'PASS' : '*** STUCK/INCOMPLETE ***'}`);
    }
  });
  console.log(`  => ${allPass ? 'PASS: every patrol robot cycles its designated area' : 'FAIL: a robot is stuck or did not complete its loop'}`);
  return allPass;
}

// ---- main ----
const arg = process.argv[2];
if (arg === '--all') {
  const seeds = ['default', 'alpha', 'zoo', 'room-7', 'xyzzy', 'lobby', 'test123'];
  let ok = true;
  for (const s of seeds) { staticReport(s); ok = dynamicCheck(s) && ok; }
  console.log(`\n${ok ? 'ALL SEEDS PASS' : 'SOME SEEDS FAILED'}`);
  process.exit(ok ? 0 : 1);
} else {
  const room = arg || 'default';
  staticReport(room);
  const ok = dynamicCheck(room);
  process.exit(ok ? 0 : 1);
}
