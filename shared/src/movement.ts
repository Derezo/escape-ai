/**
 * Deterministic NPC steering + behavior primitives.
 *
 * The lowest-level movement math lives in {@link ./step.ts} (moveWithCollision,
 * wanderVec, hash32, boxHitsSolid). This module layers *intent* on top of it —
 * obstacle-aware steering, waypoint patrol, chain-follow targeting, and an
 * occasional speed boost — while staying just as PURE and DETERMINISTIC: no
 * Math.random, no Date.now/performance.now, `dt`/`tick` always passed in. The
 * server (authoritative) and any client prediction call these and get
 * bit-identical results for the same inputs.
 *
 * Mutable per-NPC behavior state (a robot's patrolIndex, an animal's
 * returningHome flag) lives on the ENTITY, written by the single server
 * orchestrator that owns it — these functions read it in and return the intent;
 * the orchestrator commits. That keeps the math pure and the state single-writer.
 */

import {
  hash32,
  boxHitsSolid,
  moveWithCollision,
  wanderVec,
  WANDER,
  WORLD,
  type Bounds,
} from './step.js';

// ---------------------------------------------------------------------------
// Tunables — centralized so balancing happens in one spot (mirrors WANDER /
// STEALTH / PANIC in step.ts). All distances in world units, times in ticks.
// ---------------------------------------------------------------------------

/** Tunables for the obstacle-avoidance steering probe. */
export const STEER = {
  /**
   * Extra look-ahead (in tiles) added to the entity radius when probing for a
   * wall, so a slow patroller "sees" the wall before its skin touches it. The
   * effective probe distance is max(radius + LOOK_TILES*tile, speed*dt).
   */
  LOOK_TILES: 0.5,
} as const;

/** Tunables for waypoint patrol following. */
export const PATROL = {
  /** Arrive radius (in tiles): within this of the target waypoint, advance the index. */
  ARRIVE_TILES: 1.5,
} as const;

/** Tunables for the deterministic spontaneous speed boost. */
export const BOOST = {
  /** Length of a boost "bucket" in ticks (~2s at 20Hz). A bucket is on or off as a whole. */
  BUCKET_TICKS: 40,
  /** 1-in-PERIOD buckets is a boost bucket (so a boost fires ~every PERIOD buckets). */
  PERIOD: 6,
  /** Speed multiplier applied during a boost bucket. */
  MULT: 1.4,
} as const;

/**
 * The deterministic probe fan, in radians, tried in order around the desired
 * heading: straight, then ±45°, ±90°, ±135°. The +offset is tried before the
 * −offset at each magnitude (a fixed, documented tie-break) so two NPCs in the
 * same spot resolve identically — bit-stable. 180° is intentionally excluded:
 * reversing into where you came from reads worse than holding for a tick.
 */
const PROBE_FAN: readonly number[] = [
  0,
  Math.PI / 4,
  -Math.PI / 4,
  Math.PI / 2,
  -Math.PI / 2,
  (3 * Math.PI) / 4,
  -(3 * Math.PI) / 4,
];

/** A unit (or zero) heading. */
export interface Heading {
  dirX: number;
  dirY: number;
}

/**
 * Given a DESIRED unit heading, return an adjusted unit heading that makes
 * forward progress against the collision grid. Probes the desired heading
 * first; if a short look-ahead box would be solid, rotates through {@link
 * PROBE_FAN} (a fixed deterministic sequence) and returns the first heading
 * whose look-ahead is clear. Returns {0,0} if every probe is blocked (the caller
 * holds or jitters).
 *
 * This is the anti-stall fix: the current pattern ("destination tile is solid →
 * don't move") pins an NPC flush to a wall until its wander heading re-rolls.
 * Here the NPC instead turns toward the first open direction within ±135° of
 * where it wanted to go and slides around the corner via moveWithCollision.
 *
 * Pure + deterministic: no RNG, no clock; the probe order and tie-break are
 * fixed. atan2/cos/sin are already part of the deterministic core (facingFromVec,
 * wanderVec), so they're an accepted baseline. The probe uses the SAME
 * boxHitsSolid the integrator uses, so "clear here" never disagrees with the
 * commit.
 */
export function steerAround(
  entity: { x: number; y: number },
  desX: number,
  desY: number,
  dt: number,
  speed: number,
  collision: Uint8Array,
  mapW: number,
  mapH: number,
  tile: number,
  radius: number,
): Heading {
  if (desX === 0 && desY === 0) return { dirX: 0, dirY: 0 };
  // Look far enough to react to a wall before touching it; at least one step.
  const look = Math.max(radius + tile * STEER.LOOK_TILES, speed * dt);
  const base = Math.atan2(desY, desX);
  for (const off of PROBE_FAN) {
    const a = base + off;
    const hx = Math.cos(a);
    const hy = Math.sin(a);
    if (!boxHitsSolid(entity.x + hx * look, entity.y + hy * look, radius, collision, mapW, mapH, tile)) {
      return { dirX: hx, dirY: hy };
    }
  }
  return { dirX: 0, dirY: 0 }; // boxed in on every probe — caller holds/jitters
}

/** A single point on a patrol route (world units). */
export interface Waypoint {
  x: number;
  y: number;
}

/** The outcome of one {@link patrolStep}. */
export interface PatrolResult {
  /** The post-step position (caller writes back onto the entity). */
  x: number;
  y: number;
  /** The (possibly advanced) waypoint index (caller writes back onto the entity). */
  index: number;
  /** The unit heading actually taken this step (for facing). */
  dirX: number;
  dirY: number;
  /** True on the tick the current waypoint was reached (index advanced this step). */
  arrived: boolean;
}

/**
 * Advance an entity one step along an ordered, looping waypoint route. When
 * within the arrive radius of route[index], advance the index (mod length) and
 * retarget the next waypoint so there's no dead tick standing on a waypoint. The
 * heading toward the target is run through {@link steerAround} (so the robot
 * rounds a fence corner between two junctions) and committed with
 * moveWithCollision on a COPY — the entity is NOT mutated; the caller writes back
 * the returned position + index (so the index stays single-writer on the server).
 *
 * Pure + deterministic: route, index, dt, speed and the collision grid fully
 * determine the output. A zero-length route is a no-op (arrived:false) so the
 * caller can fall back to ambient wander.
 */
export function patrolStep(
  entity: { id: string; x: number; y: number },
  route: readonly Waypoint[],
  index: number,
  dt: number,
  speed: number,
  collision: Uint8Array,
  mapW: number,
  mapH: number,
  tile: number,
  radius: number,
): PatrolResult {
  if (route.length === 0) {
    return { x: entity.x, y: entity.y, index: 0, dirX: 0, dirY: 0, arrived: false };
  }
  const arriveR = tile * PATROL.ARRIVE_TILES;
  // Fold the incoming index into range (defensive: it lives on the entity).
  let idx = ((index % route.length) + route.length) % route.length;

  let target = route[idx];
  let dx = target.x - entity.x;
  let dy = target.y - entity.y;
  let arrived = false;

  // Detect arrival against the CURRENT position (before moving), then retarget so
  // the step heads to the next waypoint immediately.
  if (Math.hypot(dx, dy) <= arriveR) {
    arrived = true;
    idx = (idx + 1) % route.length;
    target = route[idx];
    dx = target.x - entity.x;
    dy = target.y - entity.y;
  }

  const len = Math.hypot(dx, dy) || 1;
  const desX = dx / len;
  const desY = dy / len;
  const heading = steerAround(entity, desX, desY, dt, speed, collision, mapW, mapH, tile, radius);

  const pos = { x: entity.x, y: entity.y };
  if (heading.dirX !== 0 || heading.dirY !== 0) {
    moveWithCollision(pos, heading.dirX, heading.dirY, dt, speed, collision, mapW, mapH, tile, radius);
  }
  return { x: pos.x, y: pos.y, index: idx, dirX: heading.dirX, dirY: heading.dirY, arrived };
}

/** The outcome of one {@link chainFollowStep}. */
export interface ChainStep {
  /** Unit heading toward the leader, or {0,0} when already within `gap` (trail, don't pile). */
  dirX: number;
  dirY: number;
  /** False when within `gap` (no move this tick). */
  moving: boolean;
}

/**
 * Resolve where a chain link should head: toward `leader`, but stop once within
 * `gap` so links trail in a line instead of piling onto each other. Returns a
 * unit heading; the caller applies its speed + species gait and commits (so a
 * tortoise link still trails at half speed). Pure: derived only from the two
 * positions + the gap, no stored velocity — fully deterministic.
 */
export function chainFollowStep(
  self: { x: number; y: number },
  leader: { x: number; y: number },
  gap: number,
): ChainStep {
  const dx = leader.x - self.x;
  const dy = leader.y - self.y;
  const d2 = dx * dx + dy * dy;
  if (d2 <= gap * gap) return { dirX: 0, dirY: 0, moving: false };
  const len = Math.hypot(dx, dy) || 1;
  return { dirX: dx / len, dirY: dy / len, moving: true };
}

/**
 * A deterministic, occasional speed multiplier for an NPC — the "spontaneous
 * boost" so a robot sometimes strides faster. Returns {@link BOOST.MULT} during
 * hash-scheduled boost buckets and 1.0 otherwise. Reuses the hash32/bucket idea
 * from wanderVec, phased per-entity by hash32(id) so robots boost out of sync.
 * Pure: same (id, tick) → same value across machines and across a reconnect at
 * the same tick. It only SCALES the step magnitude fed to moveWithCollision, so
 * collision still rejects any sub-step into a wall — a boost can never tunnel.
 */
export function speedBoost(id: string, tick: number): number {
  const bucket = Math.floor(tick / BOOST.BUCKET_TICKS);
  const mixed = (Math.imul(hash32(id) ^ bucket, 0x9e3779b1) >>> 0) % BOOST.PERIOD;
  return mixed === 0 ? BOOST.MULT : 1;
}

// ---------------------------------------------------------------------------
// wanderAvoid — ambient wander that SLIDES off walls instead of stalling.
//
// The current callers compute a wanderStep target then drop the whole move if
// the destination tile is solid (it pins the NPC to the wall until the 40-tick
// heading re-roll). wanderAvoid keeps the same deterministic heading + inward
// edge bias as wanderStep, but routes it through steerAround so it rounds the
// wall, then commits via moveWithCollision (which also slides). wanderStep is
// kept in step.ts for soft-bounds-only callers; server NPCs move to this.
// ---------------------------------------------------------------------------

/**
 * One ambient wander step that avoids walls. Derives the deterministic heading
 * from wanderVec(id, tick), applies the same inward edge bias as wanderStep
 * (turn away from a soft bound within EDGE_MARGIN), then steers around any solid
 * ahead and integrates with moveWithCollision. Mutates `entity.x/y` in place
 * (like moveWithCollision). Pure given `(entity, tick, dt, grid)`.
 */
export function wanderAvoid(
  entity: { id: string; x: number; y: number },
  tick: number,
  dt: number,
  speed: number,
  collision: Uint8Array,
  mapW: number,
  mapH: number,
  tile: number,
  radius: number,
  bounds: Bounds = WORLD,
): void {
  let { dirX, dirY } = wanderVec(entity.id, tick);
  // Bias inward near a soft bound (sign forced by position only → stays pure),
  // identical to wanderStep so contained animals turn away from their fence.
  if (entity.x < bounds.minX + WANDER.EDGE_MARGIN) dirX = Math.abs(dirX);
  else if (entity.x > bounds.maxX - WANDER.EDGE_MARGIN) dirX = -Math.abs(dirX);
  if (entity.y < bounds.minY + WANDER.EDGE_MARGIN) dirY = Math.abs(dirY);
  else if (entity.y > bounds.maxY - WANDER.EDGE_MARGIN) dirY = -Math.abs(dirY);

  const heading = steerAround(entity, dirX, dirY, dt, speed, collision, mapW, mapH, tile, radius);
  if (heading.dirX === 0 && heading.dirY === 0) return; // boxed in this tick
  moveWithCollision(entity, heading.dirX, heading.dirY, dt, speed, collision, mapW, mapH, tile, radius);
}
