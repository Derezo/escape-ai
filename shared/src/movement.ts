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
  turnTowardLimited,
  WANDER,
  TURN,
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
 * Order the NON-straight probe offsets so the one whose RESULTING heading lands
 * closest to `biasAngle` is tried first — the anti-vibration tie-break. With a
 * stable reference (a held wander heading, a leader direction) a boxed-in NPC
 * keeps picking the SAME slide direction tick-to-tick instead of alternating
 * between +45° and −45° as its desired heading wobbles across a probe boundary
 * (the micro-slide that reads as vibration). When `biasAngle` is undefined the
 * fixed {@link PROBE_FAN} order is kept verbatim (the legacy behavior).
 *
 * Tie-break (DOCUMENTED, deterministic): probes are sorted by absolute angular
 * distance from `biasAngle` (wrapped to [0, π]); at EQUAL angular distance the
 * higher PROBE_FAN index loses to the lower one, which — given PROBE_FAN lists
 * +offset immediately before its −offset at each magnitude — preserves the
 * historical "+ before − at equal distance" rule. `Array.prototype.sort` in V8 is
 * stable, and the comparator never returns 0 for distinct offsets unless their
 * angular distances tie, so the order is fully determined by (offsets, biasAngle).
 */
function probeOrder(base: number, biasAngle: number | undefined): readonly number[] {
  // Straight-ahead is always tried first (offset 0 is PROBE_FAN[0]); only the
  // remaining fan is reordered, so an UNBLOCKED straight probe returns instantly
  // with no behavior change vs. the legacy path.
  if (biasAngle === undefined) return PROBE_FAN;
  const rest = PROBE_FAN.slice(1);
  // Decorate-sort-undecorate keeps the index for the stable, documented tie-break.
  return [
    PROBE_FAN[0],
    ...rest
      .map((off, i) => ({ off, i, d: angDist(base + off, biasAngle) }))
      .sort((a, b) => a.d - b.d || a.i - b.i)
      .map((p) => p.off),
  ];
}

/** Smallest absolute angular distance between two angles, wrapped to [0, π]. */
function angDist(a: number, b: number): number {
  let d = Math.abs(a - b) % (Math.PI * 2);
  if (d > Math.PI) d = Math.PI * 2 - d;
  return d;
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
 * Optional `biasAngle` (radians) is an anti-vibration REFERENCE heading: when the
 * straight probe is blocked, the remaining probes are ordered by closeness to it
 * (see {@link probeOrder}) so a boxed-in NPC keeps choosing the same slide
 * direction instead of flip-flopping. Callers with a stable held heading pass it
 * (wanderAvoid passes its wander heading); callers without it omit the param and
 * get the legacy fixed-fan order. CRITICAL: when the straight probe is CLEAR the
 * function returns the desired heading regardless of biasAngle — identical to the
 * legacy path — so the parity/determinism gates stay green for the common case.
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
  biasAngle?: number,
): Heading {
  if (desX === 0 && desY === 0) return { dirX: 0, dirY: 0 };
  // Look far enough to react to a wall before touching it; at least one step.
  const look = Math.max(radius + tile * STEER.LOOK_TILES, speed * dt);
  const base = Math.atan2(desY, desX);
  for (const off of probeOrder(base, biasAngle)) {
    const a = base + off;
    const hx = Math.cos(a);
    const hy = Math.sin(a);
    if (!boxHitsSolid(entity.x + hx * look, entity.y + hy * look, radius, collision, mapW, mapH, tile)) {
      return { dirX: hx, dirY: hy };
    }
  }
  return { dirX: 0, dirY: 0 }; // boxed in on every probe — caller holds/jitters
}

/** A smoothed heading plus the angle to carry over to the next tick. */
export interface SmoothHeading {
  /** Unit heading actually taken this tick (turn-rate-limited toward the desired one). */
  dirX: number;
  dirY: number;
  /** The committed heading ANGLE (radians) — the caller writes this back onto the entity. */
  angle: number;
}

/**
 * Turn-rate-limit a DESIRED unit heading against the entity's last committed heading
 * angle, so the heading can't reverse from one tick to the next (the anti-bounce
 * smoother — see {@link turnTowardLimited} / {@link TURN}). Returns the smoothed unit
 * heading to integrate this tick AND the new committed angle to store back on the
 * entity for next tick.
 *
 * `prevAngle` is the entity's stored heading angle (radians) or `undefined` on the
 * first move — when undefined (or a zero desired heading) the desired heading is taken
 * verbatim and simply seeded as the committed angle (no lag on spawn). The cap is
 * {@link TURN.MAX_PER_TICK} by default; pass a wider/narrower cap for a faster/slower
 * turner. Pure + deterministic: a single atan2 + the angle clamp, no RNG/clock; the
 * angle the caller stores is server-only state (never serialized), exactly like a
 * patrolIndex, so it adds nothing to the wire and cannot desync the client.
 *
 * NOTE this only SHAPES the heading; the caller still commits the move through
 * moveWithCollision / locomotionStep, so collision/sliding is unchanged and a smoothed
 * heading can never tunnel a wall.
 */
export function smoothHeading(
  desX: number,
  desY: number,
  prevAngle: number | undefined,
  maxTurn: number = TURN.MAX_PER_TICK,
): SmoothHeading {
  if (desX === 0 && desY === 0) {
    // No desired motion: hold the previous angle (or 0) and emit a zero heading.
    const a = prevAngle ?? 0;
    return { dirX: 0, dirY: 0, angle: a };
  }
  const des = Math.atan2(desY, desX);
  // First move (no stored angle): take the desired heading exactly, seed the angle.
  const angle = prevAngle === undefined ? des : turnTowardLimited(prevAngle, des, maxTurn);
  return { dirX: Math.cos(angle), dirY: Math.sin(angle), angle };
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
  /**
   * The committed heading ANGLE (radians) when turn-rate limiting is active (a
   * `prevAngle` was passed), for the caller to store back on the entity. `undefined`
   * when no smoothing was requested (the legacy unsmoothed path).
   */
  angle?: number;
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
  smooth?: { angle: number | undefined },
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
  let heading = steerAround(entity, desX, desY, dt, speed, collision, mapW, mapH, tile, radius);

  // ANTI-BOUNCE (opt-in via `smooth`): turn-rate-limit the committed heading so a
  // patroller rounding a fence corner — where steerAround can flip its tangent tick to
  // tick as the body drifts across a probe boundary — can't reverse in one tick. The
  // caller passes a `{ angle }` box holding its last committed heading angle (or
  // `undefined` on the first move); smoothHeading seeds it on the first move and
  // limits the turn thereafter. When `smooth` is omitted the legacy unsmoothed heading
  // is used verbatim (byte-identical), so existing tests/callers are unaffected. A
  // boxed-in {0,0} heading stays {0,0} (no smoothing of "don't move") and holds the angle.
  let angle: number | undefined;
  if (smooth) {
    if (heading.dirX !== 0 || heading.dirY !== 0) {
      const sm = smoothHeading(heading.dirX, heading.dirY, smooth.angle);
      heading = { dirX: sm.dirX, dirY: sm.dirY };
      angle = sm.angle;
    } else {
      angle = smooth.angle; // boxed in this tick — hold the committed angle
    }
  }

  const pos = { x: entity.x, y: entity.y };
  if (heading.dirX !== 0 || heading.dirY !== 0) {
    moveWithCollision(pos, heading.dirX, heading.dirY, dt, speed, collision, mapW, mapH, tile, radius);
  }
  return { x: pos.x, y: pos.y, index: idx, dirX: heading.dirX, dirY: heading.dirY, arrived, angle };
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
// The prior approach computed an ambient drift target then dropped the whole move
// if the destination tile was solid — which pinned the NPC to the wall until its
// heading re-rolled (up to 40 ticks). wanderAvoid keeps the same deterministic
// heading (wanderVec) + inward edge bias, but routes it through steerAround so it
// rounds the wall, then commits via moveWithCollision (which also slides). This is
// now the ONE ambient-drift helper — it replaced the old return-a-target wanderStep.
// ---------------------------------------------------------------------------

/**
 * One ambient wander step that avoids walls. Derives the deterministic heading
 * from wanderVec(id, tick), applies an inward edge bias (turn away from a soft
 * bound within EDGE_MARGIN), then steers around any solid ahead and integrates
 * with moveWithCollision. Mutates `entity.x/y` in place (like moveWithCollision).
 * Pure given `(entity, tick, dt, grid)`.
 *
 * ANTI-VIBRATION (two coupled guards, both deterministic):
 *   1) The held wander heading is passed to steerAround as the bias reference, so
 *      a boxed-in wanderer keeps picking the SAME slide direction tick-to-tick
 *      instead of alternating +45°/−45° as the desired heading wobbles across a
 *      probe boundary (the flip-flop that micro-slid the body sideways).
 *   2) HOLD-POSITION: snapshot the position, integrate on the entity, then if the
 *      net displacement is below {@link WANDER.MIN_STEP} (a sub-pixel grind in a
 *      corner) roll x/y back to the snapshot — no move this tick. This removes the
 *      residual sub-MIN_STEP slide the facing deadband alone left in the body.
 * Together with facingFromVecDeadband on the caller's facing commit, a wanderer
 * pinned in a pen corner neither slides nor flips — the vibration is gone — while
 * a real drift step (≫ MIN_STEP) is unaffected.
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
  smooth?: { angle: number | undefined },
): void {
  let { dirX, dirY } = wanderVec(entity.id, tick);
  // Bias inward near a soft bound (sign forced by position only → stays pure) so
  // a contained animal turns away from its fence before reaching the gate row.
  if (entity.x < bounds.minX + WANDER.EDGE_MARGIN) dirX = Math.abs(dirX);
  else if (entity.x > bounds.maxX - WANDER.EDGE_MARGIN) dirX = -Math.abs(dirX);
  if (entity.y < bounds.minY + WANDER.EDGE_MARGIN) dirY = Math.abs(dirY);
  else if (entity.y > bounds.maxY - WANDER.EDGE_MARGIN) dirY = -Math.abs(dirY);

  // Bias the probe fan toward the (post-edge-bias) wander heading itself so a
  // boxed-in wanderer commits to one slide direction rather than flip-flopping.
  const biasAngle = Math.atan2(dirY, dirX);
  let heading = steerAround(entity, dirX, dirY, dt, speed, collision, mapW, mapH, tile, radius, biasAngle);
  if (heading.dirX === 0 && heading.dirY === 0) return; // boxed in this tick

  // ANTI-BOUNCE (opt-in via `smooth`): turn-rate-limit the committed heading so a
  // wanderer rounding a corner can't reverse it tick to tick. The caller passes a
  // `{ angle }` box (its last committed heading angle, or undefined on the first move);
  // smoothHeading seeds then limits it. Omitted → legacy unsmoothed heading (byte-
  // identical), preserving the existing wanderAvoid callers/tests.
  if (smooth) {
    const sm = smoothHeading(heading.dirX, heading.dirY, smooth.angle);
    heading = { dirX: sm.dirX, dirY: sm.dirY };
    smooth.angle = sm.angle;
  }

  // Integrate, then HOLD if it was only a sub-MIN_STEP micro-slide (corner grind).
  const bx = entity.x;
  const by = entity.y;
  moveWithCollision(entity, heading.dirX, heading.dirY, dt, speed, collision, mapW, mapH, tile, radius);
  const mdx = entity.x - bx;
  const mdy = entity.y - by;
  if (mdx * mdx + mdy * mdy < WANDER.MIN_STEP * WANDER.MIN_STEP) {
    entity.x = bx;
    entity.y = by;
  }
}
