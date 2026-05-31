/**
 * Deterministic simulation step + math utils.
 *
 * CRITICAL: everything here MUST be pure and deterministic so the server
 * (authoritative) and the client (prediction) produce bit-identical results for
 * the same inputs. That means:
 *   - no Math.random()
 *   - no Date.now() / performance.now()
 *   - no DOM, no Node APIs, no I/O
 * `dt` is always passed in by the caller (the fixed-tick loop on the server, the
 * frame/accumulator loop on the client).
 */

import type { Dir8, Entity, WorldState } from './types.js';

// ---------------------------------------------------------------------------
// Escape AI — Three-Laws stealth math (deterministic, both sides)
//
// These pure helpers encode the gameplay the server runs each tick and the
// client can mirror for prediction/feedback. NONE of them read wall-clock time
// or RNG; every time-dependent quantity comes in as `dt`. The server is still
// authoritative for robot/animal NPC state — these just keep the math in one
// place so client feedback (e.g. the human-likeness bar) never disagrees.
// ---------------------------------------------------------------------------

/** Tunables for the stealth loop. Centralized so Phase 5 can balance in one spot. */
export const STEALTH = {
  /** humanLikeness/sec gained while "behaving human" (still / upright / slow). */
  RISE_PER_SEC: 0.5,
  /** humanLikeness/sec lost while behaving like prey (sprinting / fleeing). */
  DECAY_PER_SEC: 0.8,
  /** Flat humanLikeness bonus while carrying the disguise prop (clipboard). */
  PROP_BONUS: 0.35,
  /**
   * Speed (units/sec) above which an animal reads as "fleeing prey", not human.
   * Sits between WALK_SPEED and PLAYER_SPEED (see server/config.js, client
   * config.ts): a walk stays human-ish, a sprint (Shift) reads as prey.
   */
  SPRINT_THRESHOLD: 150,
  /** Base humanLikeness a robot needs to see before the First Law freezes it. */
  FREEZE_THRESHOLD: 0.6,
  /** Radius (world units) within which a robot perceives/engages an animal. */
  PERCEPTION_RADIUS: 200,
  /** suspicion/sec a robot sheds when nothing contradicts the human story. */
  SUSPICION_DECAY_PER_SEC: 0.15,
  /** suspicion added when an "animal" issues a Second-Law order (a contradiction). */
  SUSPICION_PER_ORDER: 0.4,
  /**
   * How much each point of suspicion raises the effective freeze threshold: a
   * suspicious robot demands a *more* convincingly-human target before it
   * freezes, so the detective layer makes bluffing progressively harder.
   */
  SUSPICION_THRESHOLD_GAIN: 0.4,
} as const;

/**
 * Movement speeds (units/sec). Walking keeps you below SPRINT_THRESHOLD (so the
 * human disguise holds while moving); sprinting (Shift) is faster but reads as
 * fleeing prey. These are the single source of truth — server integration and
 * client prediction both call {@link moveSpeed} so they never disagree.
 */
export const WALK_SPEED = 120;
export const SPRINT_SPEED = 200;

/** The movement speed for this frame given the sprint intent. */
export function moveSpeed(sprint: boolean): number {
  return sprint ? SPRINT_SPEED : WALK_SPEED;
}

/** Squared distance between two entities (cheaper than sqrt for radius checks). */
export function dist2(a: { x: number; y: number }, b: { x: number; y: number }): number {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  return dx * dx + dy * dy;
}

/**
 * The 8 facings in index order by angle (east, then clockwise — screen y is down
 * so increasing atan2 angle rotates clockwise). Index i = the direction at angle
 * i * 45°. {@link facingFromVec} uses this to map a movement vector to a Dir8.
 * Both the server (deriving authoritative facing) and the client (prediction +
 * fallback) call facingFromVec so they always agree.
 */
export const DIR8: readonly Dir8[] = ['e', 'se', 's', 'sw', 'w', 'nw', 'n', 'ne'] as const;

/**
 * Map a movement vector to one of 8 facings. Pure + deterministic (no RNG/clock):
 * the same args always yield the same dir, so client prediction and server
 * authority can't disagree. A zero vector keeps the previous facing (`prev`), so a
 * stationary entity holds the direction it last moved instead of snapping to a
 * default. Default `prev` is 's' (facing the camera) for a never-moved entity.
 */
export function facingFromVec(dx: number, dy: number, prev: Dir8 = 's'): Dir8 {
  if (dx === 0 && dy === 0) return prev;
  let idx = Math.round(Math.atan2(dy, dx) / (Math.PI / 4)); // -4..4
  idx = ((idx % 8) + 8) % 8; // fold to 0..7
  return DIR8[idx];
}

/**
 * Like {@link facingFromVec}, but with a minimum-displacement DEADBAND that holds
 * the previous facing on a sub-threshold move. This kills the "pen-corner
 * vibration" bug: an idle animal pinned in a corner of its enclosure barely moves
 * each tick (steerAround's probe fan finds a DIFFERENT clear micro-slide every
 * tick as the body shifts a fraction of a pixel), so naively deriving facing from
 * each tiny displacement snapped facing to wildly different directions tick after
 * tick — the animal looked like it was flipping/vibrating even though net motion
 * was ~0. The fix: only commit a NEW facing when the body actually traveled a
 * meaningful distance (>= minDelta); below that, HOLD prev and don't turn.
 *
 * Pure + deterministic (no RNG/clock): same (dx, dy, prev, minDelta) → same Dir8,
 * so server authority and any client prediction can't disagree. Consistent with
 * facingFromVec's contract — a too-small move (including the exact zero vector,
 * which has magnitude 0 < any positive minDelta) returns prev; a real move defers
 * to facingFromVec. Pass minDelta from the caller's tuning (e.g.
 * {@link WANDER.FACING_DEADBAND}) so the threshold stays a single tunable.
 */
export function facingFromVecDeadband(dx: number, dy: number, prev: Dir8, minDelta: number): Dir8 {
  // Magnitude below the deadband ⇒ corner-grinding / barely moving: HOLD facing.
  if (Math.hypot(dx, dy) < minDelta) return prev;
  // Real step ⇒ turn to face it, identical to the no-deadband path.
  return facingFromVec(dx, dy, prev);
}

// ---------------------------------------------------------------------------
// Ambient NPC drift — deterministic patrol (robots) + wander (idle animals)
//
// Input-less NPCs (a robot with nothing to chase, an idle decoy animal) need to
// MOVE so the zoo reads as alive and threatening — but the move must be pure and
// deterministic (server-authoritative, reusable, testable). So instead of RNG we
// derive a heading from a tiny integer hash of the entity id mixed with a slow
// tick "bucket": the heading holds for HEADING_HOLD_TICKS, then re-rolls. Same
// (id, tick) always yields the same vector — no Math.random, no wall clock.
// ---------------------------------------------------------------------------

/** Tunables for ambient NPC drift (robot patrol + idle-animal wander). */
export const WANDER = {
  /** Robot idle-patrol speed (units/sec). Slower than ROBOT_SPEED so a chase still reads. */
  PATROL_SPEED: 60,
  /** Idle decoy-animal drift speed (units/sec). Gentle ambient motion. */
  ANIMAL_SPEED: 40,
  /** Ticks a heading is held before it re-rolls (~2s at 20Hz). The "drift, then turn" rhythm. */
  HEADING_HOLD_TICKS: 40,
  /** Distance (units) from a bound at which a wanderer biases its heading back inward. */
  EDGE_MARGIN: 40,
  /**
   * Fraction of a returning animal's heading pulled toward its home enclosure during the
   * post-follow drift-home behavior (0..1). Low enough that it still reads as wandering,
   * high enough that the long-run average net-converges on home rather than a beeline.
   * Used by {@link homeBiasedWanderStep}.
   */
  HOME_BIAS: 0.45,
  /**
   * Minimum per-tick displacement (units) required to RE-DERIVE an idle animal's
   * facing from its drift. Below this, {@link facingFromVecDeadband} holds the
   * previous facing — the anti-vibration deadband for pen-corner grinding. Tuned
   * well under a normal step (full-speed drift ≈ 2 units/tick at ANIMAL_SPEED=40,
   * dt=0.05) so real movement still turns the animal, but above the sub-pixel
   * jitter a boxed-in wanderer produces when steerAround slides it a fraction of a
   * unit in a fresh direction each tick. Same value on every server (deterministic).
   */
  FACING_DEADBAND: 0.75,
  /**
   * Minimum per-tick BODY displacement (units) `wanderAvoid` will commit. When a
   * boxed-in wanderer's resolved step would move it LESS than this (a sub-pixel
   * micro-slide), wanderAvoid rolls the move back entirely and HOLDS position for
   * the tick. This is the body-side companion to {@link FACING_DEADBAND}: the
   * deadband stops the FACING from flipping, but a sub-unit slide still nudged the
   * body in alternating directions tick-to-tick (the visible vibration / drift in a
   * pen corner). Holding below MIN_STEP removes that residual jitter while leaving
   * real movement (a full drift step ≫ MIN_STEP) untouched. Set equal to
   * FACING_DEADBAND so the "too small to face" and "too small to move" thresholds
   * coincide — one boxed-in tick neither turns nor slides. Deterministic (a plain
   * distance compare), so every server holds on the exact same ticks.
   */
  MIN_STEP: 0.75,
} as const;

/**
 * Pure 32-bit FNV-1a hash of a string → unsigned int. Deterministic, no RNG.
 * Kept in uint32 via {@link Math.imul} + `>>> 0` so it is bit-stable across V8
 * (server) and any client that later mirrors this math.
 */
export function hash32(s: string): number {
  let h = 0x811c9dc5; // FNV offset basis
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0; // FNV prime, folded back into uint32
  }
  return h >>> 0;
}

/**
 * A deterministic unit heading for entity `id` at integer `tick`, held constant
 * for {@link WANDER.HEADING_HOLD_TICKS} ticks then re-rolled. Pure: the same
 * `(id, tick)` always yields the same vector. De-correlated per id (the id hash
 * differs) and time-varying (the bucket changes) without any RNG.
 */
export function wanderVec(id: string, tick: number): { dirX: number; dirY: number } {
  const bucket = Math.floor(tick / WANDER.HEADING_HOLD_TICKS);
  // Mix the id-hash with the bucket (another integer mix) → uint32 → [0, 2π).
  const mixed = Math.imul(hash32(id) ^ bucket, 0x9e3779b1) >>> 0;
  const angle = (mixed / 0x100000000) * Math.PI * 2;
  return { dirX: Math.cos(angle), dirY: Math.sin(angle) };
}

// (The old `wanderStep` — return-a-target ambient drift that the caller dropped if
// the destination was solid — was removed once the NPC movement refactor replaced
// every caller with `movement.wanderAvoid`, which steers around walls instead of
// stalling against them. Its deterministic heading + inward edge-bias live on in
// `wanderVec` (above) and `wanderAvoid` (movement.ts), which both callers now use.)

/**
 * One home-return drift step for an animal released from following: blend the
 * deterministic wander heading ({@link wanderVec}) with a unit vector toward `home`,
 * weighted by `biasWeight`, then integrate at `speed` clamped to `bounds`. The blend is
 * `normalize((1 - w)·wander + w·toHome)`, so the animal still jitters like a wanderer
 * per tick but its long-run average drifts home — "returning over time", not a beeline.
 * Degrades to a plain wander once it sits on home (the toward-home term goes to ~0).
 * Pure given `(entity, tick, dt)`: no RNG, no clock. Returns the new `{x, y}` for the
 * caller to write back (it does not mutate `entity`).
 */
export function homeBiasedWanderStep(
  entity: { id: string; x: number; y: number },
  tick: number,
  dt: number,
  speed: number,
  bounds: Bounds,
  home: { x: number; y: number },
  biasWeight: number = WANDER.HOME_BIAS,
): { x: number; y: number } {
  const { dirX: wx, dirY: wy } = wanderVec(entity.id, tick);
  let hx = home.x - entity.x;
  let hy = home.y - entity.y;
  const hlen = Math.hypot(hx, hy) || 1;
  hx /= hlen; // unit vector toward home
  hy /= hlen;
  // Linear blend then renormalize so the step speed is constant regardless of weight.
  let bx = (1 - biasWeight) * wx + biasWeight * hx;
  let by = (1 - biasWeight) * wy + biasWeight * hy;
  const blen = Math.hypot(bx, by) || 1;
  bx /= blen;
  by /= blen;
  return {
    x: clamp(entity.x + bx * speed * dt, bounds.minX, bounds.maxX),
    y: clamp(entity.y + by * speed * dt, bounds.minY, bounds.maxY),
  };
}

/**
 * The effective First-Law freeze threshold for a robot given its suspicion. A
 * calm robot (suspicion 0) freezes at FREEZE_THRESHOLD; a suspicious one needs a
 * higher humanLikeness to be fooled. Clamped to a sane ceiling so a maxed-out
 * robot is hard — but not strictly impossible — to bluff.
 */
export function freezeThreshold(suspicion: number): number {
  return clamp(
    STEALTH.FREEZE_THRESHOLD + suspicion * STEALTH.SUSPICION_THRESHOLD_GAIN,
    STEALTH.FREEZE_THRESHOLD,
    0.95,
  );
}

/**
 * Advance an animal's humanLikeness for one step based on how it's moving and
 * whether it carries the disguise prop. Behaving human (slow/still) raises it;
 * moving like fleeing prey (fast) drops it. Returns the new value in [0, 1].
 *
 * @param current  the animal's current humanLikeness (0..1)
 * @param speed    the animal's instantaneous speed this step (world units/sec)
 * @param carrying whether the animal holds the disguise prop
 * @param dt       seconds elapsed
 */
export function updateHumanLikeness(
  current: number,
  speed: number,
  carrying: boolean,
  dt: number,
): number {
  const fleeing = speed > STEALTH.SPRINT_THRESHOLD;
  const rate = fleeing ? -STEALTH.DECAY_PER_SEC : STEALTH.RISE_PER_SEC;
  let next = current + rate * dt;
  // The prop is a floor, not an addition: while carried it guarantees at least
  // PROP_BONUS so a courier reads as plausibly human even while moving.
  if (carrying) next = Math.max(next, STEALTH.PROP_BONUS);
  return clamp(next, 0, 1);
}

/**
 * Whether the First Law forbids `robot` from acting against `animal`: the animal
 * is within perception range AND looks human enough to clear the robot's
 * (suspicion-adjusted) freeze threshold. When true the robot must yield/freeze.
 */
export function firstLawProtects(robot: Entity, animal: Entity): boolean {
  const hl = typeof animal.humanLikeness === 'number' ? animal.humanLikeness : 0;
  const susp = typeof robot.suspicion === 'number' ? robot.suspicion : 0;
  if (hl < freezeThreshold(susp)) return false;
  return dist2(robot, animal) <= STEALTH.PERCEPTION_RADIUS * STEALTH.PERCEPTION_RADIUS;
}

/**
 * A robot's possible dispositions for one tick. `ordered` is a Second-Law
 * standdown the server applies outside robotDecision (it isn't returned by
 * robotDecision, but it IS a valid robot.mode the client renders), so it lives
 * in the shared type for both sides to agree on.
 */
export type RobotMode = 'idle' | 'frozen' | 'pursue' | 'ordered';

/** The outcome of a robot's Three-Laws reasoning for one tick. */
export interface RobotDecision {
  mode: RobotMode;
  /** The animal the robot is reacting to (frozen by, or pursuing), if any. */
  targetId?: string;
  /** When pursuing, the unit vector toward the target (else 0,0). */
  dirX: number;
  dirY: number;
}

/**
 * Run one robot's Three-Laws decision against the animals it can perceive.
 *
 * - **First Law** — if ANY perceived animal looks human enough, the robot must
 *   not act: it freezes (it cannot risk harming a "human"). This is the stealth.
 * - **Lockdown override** — once the world is in lockdown the First-Law caution
 *   is dropped: the robot pursues the nearest animal regardless of disguise.
 * - Otherwise the robot pursues the nearest non-human-looking animal in range.
 *
 * The Third Law (hazard self-preservation) is layered on by the server, which
 * knows where hazards are; this function stays purely about perception + Laws.
 */
export function robotDecision(
  robot: Entity,
  animals: Entity[],
  lockdown: boolean,
): RobotDecision {
  const r2 = STEALTH.PERCEPTION_RADIUS * STEALTH.PERCEPTION_RADIUS;

  let nearest: Entity | undefined;
  let nearestD2 = Infinity;
  for (const a of animals) {
    const d2 = dist2(robot, a);
    if (d2 > r2) continue;
    // First Law (only while not in lockdown): a convincingly-human animal in
    // range freezes the robot outright — it can't risk acting near a "human".
    if (!lockdown && firstLawProtects(robot, a)) {
      return { mode: 'frozen', targetId: a.id, dirX: 0, dirY: 0 };
    }
    if (d2 < nearestD2) {
      nearestD2 = d2;
      nearest = a;
    }
  }

  if (!nearest) return { mode: 'idle', dirX: 0, dirY: 0 };

  const dx = nearest.x - robot.x;
  const dy = nearest.y - robot.y;
  const len = Math.hypot(dx, dy) || 1;
  return { mode: 'pursue', targetId: nearest.id, dirX: dx / len, dirY: dy / len };
}

// ---------------------------------------------------------------------------
// Catastrophic overflow — the panic meter (TINS technical rule #132)
//
// The zoo-wide panic meter is the "container". It rises as the escape gets
// noisy (chases, orders, captures) and bleeds down when the players lie low.
// When it overflows (panic >= capacity) the zoo flips into LOCKDOWN: robots
// drop their First-Law caution (robotDecision is called with lockdown=true) and
// speed up. Lockdown clears only once panic drains back below a LOW watermark —
// hysteresis so it doesn't flicker on and off at the brim.
// ---------------------------------------------------------------------------

/** Tunables for the panic/overflow loop. Centralized for Phase-5 balancing. */
export const PANIC = {
  /** Passive drain (points/sec) while nothing is actively escalating. */
  DECAY_PER_SEC: 5,
  /**
   * Added per *effective* pursuer this tick (points/sec each). The pursuit count
   * is passed through a concave (sqrt) curve in {@link stepPanic}, so the first
   * chaser matters a lot and a swarm has diminishing returns — a full pack can no
   * longer pin the meter at capacity, and shedding pursuers (e.g. letting a robot
   * peel off to chase a wandering decoy) tips the balance back toward recovery.
   */
  RISE_PER_PURSUIT_PER_SEC: 3,
  /** One-shot spike when a player is caught by a robot. */
  RISE_PER_CATCH: 25,
  /** One-shot bump per Second-Law order issued (ties orders to the container). */
  RISE_PER_ORDER: 8,
  /**
   * Fraction of capacity panic must fall back below before LOCKDOWN lifts.
   * 0.3 = drain to 30% to recover — punishing but not permanent.
   */
  RECOVERY_FRACTION: 0.3,
} as const;

/**
 * The per-tick panic inputs the server tallies and hands to {@link stepPanic}.
 * Keeping these as plain counts (not live entity refs) keeps the math pure and
 * trivially testable.
 */
export interface PanicEvents {
  /** How many robots are actively pursuing a target this tick. */
  pursuingRobots: number;
  /** How many players were caught this tick (usually 0 or 1). */
  catches: number;
  /** How many Second-Law orders were issued this tick. */
  orders: number;
}

/**
 * Advance the panic meter and the lockdown flag for one tick, in place, and
 * return the same object. Pure: all time-dependence comes through `dt`, all
 * escalation through `events`. The overflow → lockdown transition (and the
 * hysteretic recovery) is the single authoritative definition of the rule.
 */
export function stepPanic(world: WorldState, events: PanicEvents, dt: number): WorldState {
  // Concave pursuit term: a swarm can't out-rise decay (1→1, 4→2, 6→~2.45
  // effective pursuers), but one chaser still moves the meter. Keeps "break
  // contact to recover" as the skill, vs. a swarm pinning panic at capacity.
  const pursuers = Math.sqrt(Math.max(0, events.pursuingRobots));
  const rise =
    pursuers * PANIC.RISE_PER_PURSUIT_PER_SEC * dt +
    events.catches * PANIC.RISE_PER_CATCH +
    events.orders * PANIC.RISE_PER_ORDER;
  const fall = PANIC.DECAY_PER_SEC * dt;

  world.panic = clamp(world.panic + rise - fall, 0, world.panicCapacity);

  if (!world.lockdown) {
    // Overflow: the container brimmed over. Chaos ensues.
    if (world.panic >= world.panicCapacity) world.lockdown = true;
  } else {
    // Recover only once it has drained well below the brim (hysteresis).
    if (world.panic <= world.panicCapacity * PANIC.RECOVERY_FRACTION) {
      world.lockdown = false;
    }
  }
  return world;
}

/** Clamp `v` into the inclusive range [min, max]. */
export function clamp(v: number, min: number, max: number): number {
  if (v < min) return min;
  if (v > max) return max;
  return v;
}

/**
 * Default world bounds for the ambient `wanderAvoid` drift (idle decoys) and the
 * `homeBiasedWanderStep` clamp. The tilemap world's real movement clamp is the
 * per-tile solidity grid (out-of-bounds is solid in `moveWithCollision`), not these
 * literals — they're just a sane fallback for the input-less wander helpers.
 */
export const WORLD = {
  minX: 0,
  minY: 0,
  maxX: 1000,
  maxY: 1000,
} as const;

export interface Bounds {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

// (The old bounds-clamping `applyInput` was removed once the tilemap world made
// movement collision-aware: both server and client now integrate through
// `moveWithCollision` against the generated solidity grid. `WORLD`/`Bounds` above
// remain — they're the default clamp for the ambient `wanderAvoid` /
// `homeBiasedWanderStep` drift.)

// ---------------------------------------------------------------------------
// Collision-aware movement against a tile solidity grid (both sides, identical)
//
// The tilemap world (shared/src/world.ts) gives every cell a solid flag. Movement
// must stop at walls/fences/trunks/water and SLIDE along them. This lives here, in
// the deterministic core, so the server (authority) and the client (prediction)
// integrate movement bit-identically — no rubber-banding at walls.
// Kept dependency-free (no world.ts import) to avoid a cycle:
// step.ts is the lowest-level module. The collision grid + dims + tile size are
// passed in; the world edge is treated as solid (out-of-bounds → solid) so a
// player can only leave through the gate gap.
// ---------------------------------------------------------------------------

/**
 * Whether the cell at tile (tx, ty) is solid. Out-of-bounds is SOLID (the world
 * edge is a wall). Mirrors world.ts `tileSolid` but inlined here to keep step.ts
 * free of any world.ts import (which would create step→world→rng→step).
 */
function cellSolid(collision: Uint8Array, mapW: number, mapH: number, tx: number, ty: number): boolean {
  if (tx < 0 || ty < 0 || tx >= mapW || ty >= mapH) return true;
  return collision[ty * mapW + tx] === 1;
}

/**
 * Whether an axis-aligned box centered at (cx, cy) with half-extent `radius`
 * overlaps any solid tile. Samples every tile cell the box's extent touches.
 * Exported so the steering layer (movement.ts) probes obstacles with the EXACT
 * same test the integrator uses — two implementations could disagree at a tile
 * edge and stutter an NPC against a wall.
 */
export function boxHitsSolid(
  cx: number,
  cy: number,
  radius: number,
  collision: Uint8Array,
  mapW: number,
  mapH: number,
  tile: number,
): boolean {
  const minTx = Math.floor((cx - radius) / tile);
  const maxTx = Math.floor((cx + radius) / tile);
  const minTy = Math.floor((cy - radius) / tile);
  const maxTy = Math.floor((cy + radius) / tile);
  for (let ty = minTy; ty <= maxTy; ty++) {
    for (let tx = minTx; tx <= maxTx; tx++) {
      if (cellSolid(collision, mapW, mapH, tx, ty)) return true;
    }
  }
  return false;
}

/**
 * Advance an entity one step with axis-separated sliding collision, IN PLACE.
 *
 * The entity is treated as an AABB of half-extent `radius`. We try the X move
 * first: if the box at the new X (current Y) overlaps a solid tile we reject the X
 * move (keep x), else commit it. Then we try Y independently with the committed X.
 * Axis separation is what produces SLIDING — pushing into a wall diagonally keeps
 * the clear axis. The world edge is solid, so positions are implicitly clamped to
 * [radius, mapW*tile - radius] without a separate clamp call.
 *
 * PURE + DETERMINISTIC given its args: server and client call this with the same
 * collision grid (regenerated from the same seed), radius, and dt, so prediction
 * and authority agree and there is no rubber-banding.
 *
 * @param entity     mutated in place ({x, y})
 * @param dx,dy      input axes (typically in [-1, 1])
 * @param dt         seconds this step
 * @param speed      world units/sec at full axis deflection
 * @param collision  solidity grid (1 = solid), length mapW*mapH, row-major
 * @param mapW,mapH  grid size in tiles
 * @param tile       tile size in world units
 * @param radius     entity half-extent in world units
 */
export function moveWithCollision(
  entity: { x: number; y: number },
  dx: number,
  dy: number,
  dt: number,
  speed: number,
  collision: Uint8Array,
  mapW: number,
  mapH: number,
  tile: number,
  radius: number,
): void {
  const nx = entity.x + dx * speed * dt;
  if (!boxHitsSolid(nx, entity.y, radius, collision, mapW, mapH, tile)) {
    entity.x = nx;
  }
  const ny = entity.y + dy * speed * dt;
  if (!boxHitsSolid(entity.x, ny, radius, collision, mapW, mapH, tile)) {
    entity.y = ny;
  }
}
