/**
 * Core serializable game types shared by client and server.
 *
 * Everything here is a plain data shape — no methods, no class instances —
 * so it round-trips cleanly through Socket.IO / JSON. The renderer never sees
 * anything richer than these objects (see ARCHITECTURE.md: "Entities are plain
 * serializable objects `{id, x, y, ...}`; renderer-agnostic").
 */

/**
 * What an entity *is* in The Caves of Steel. Plain string union so it stays
 * serializable; the renderer and the deterministic step() branch on it.
 *   - `animal`   a player-controlled escapee (also covers idle pen animals)
 *   - `robot`    a Three-Laws keeper-robot (server-driven NPC)
 *   - `pen`      an enclosure / holding area (static)
 *   - `terminal` an interactable that issues Second-Law orders (static)
 *   - `gate`     a perimeter or zone door (static, openable)
 *   - `prop`     a carryable disguise item (the Clipboard) — the ape's courier prop
 */
export type EntityKind = 'animal' | 'robot' | 'pen' | 'terminal' | 'gate' | 'prop' | 'hazard' | 'questObject' | 'food';

/**
 * The 8 facing directions in screen space (y-down), used to pick the right
 * directional sprite animation. These strings ARE the `dir` segment of every
 * atlas frame key (`<species>_<state>_<dir>_<frame>`) — they must match the
 * sprite generator's contract (scripts/sprites/contract.js DIRECTIONS) exactly.
 * `facingFromVec` in step.ts maps a movement vector to one of these.
 */
export type Dir8 = 's' | 'se' | 'e' | 'ne' | 'n' | 'nw' | 'w' | 'sw';

/**
 * Which spectacular ability effect is active / just fired on an entity. Drives
 * the client FX layer (particles/tweens/glow/shake). Defined here (not in
 * step.ts) so types.ts has no import cycle with step.ts.
 */
export type FxKind =
  | 'flit' | 'skitter' | 'shove' | 'carry'
  | 'cloak' | 'dazzle' | 'stink' | 'burrow'
  | 'dash' | 'mimic' | 'shell' | 'leap' | 'hush' | 'decoy'
  // Animal-collection feedback (Phase: food/follow): a food pickup, a successful
  // feed-to-follow, and a steal (feeding away another player's follower).
  | 'collect' | 'feed' | 'steal';

/**
 * The render-echo of an ability effect, carried in the snapshot so ANY client
 * can show FX for ANY player/robot (not just the local one). `startTick` is the
 * rising edge the client triggers a one-shot burst on; `untilTick` drives any
 * sustained FX (a glow that lasts the effect). The gameplay timers
 * (flitUntilTick, etc.) remain server-side as the source of truth; `fx` is the
 * compact echo derived from them at serialization time.
 */
export interface EntityFx {
  kind: FxKind;
  startTick: number;
  untilTick: number;
}

/**
 * A player's live side-quest progress (Phase 6), as it rides the snapshot. The
 * static quest DEFINITIONS live in quests.ts (QuestDef); this is the per-player
 * mutable view the server owns and the client HUD reads. `done`/`need` drive the
 * progress readout; `complete` gates the escape gate server-side.
 */
export interface QuestProgress {
  /** The mechanic: 'reach' your home, 'fetch' the prop to the gate, 'activate' terminals. */
  type: 'reach' | 'fetch' | 'activate';
  /** Short HUD title, e.g. "Reach your den". */
  title: string;
  /** One-line, ability-themed flavor. */
  blurb: string;
  /** Progress so far (0..need). */
  done: number;
  /** Target count (reach/fetch = 1, activate = 3). */
  need: number;
  /** True once the quest is satisfied — the gate will then let this animal out. */
  complete: boolean;
}

/**
 * The atomic thing the world is made of. The index signature lets gameplay
 * rules bolt on arbitrary fields without breaking serialization; the named
 * optional fields below are the ones The Caves of Steel reads on both sides, so
 * they're typed (rather than hidden in the index signature) for safety.
 */
export interface Entity {
  id: string;
  x: number;
  y: number;
  name?: string;
  /** What this entity is. Absent on the bare starter-kit point; defaults to a player animal. */
  kind?: EntityKind;
  /** For `animal`: which species (drives the special ability). */
  species?: string;
  /** For `animal`: 0..1 how human this looks to robots right now (First-Law stealth). */
  humanLikeness?: number;
  /** For `robot`: 0..1 how convinced it is that a nearby "human" is faking it. */
  suspicion?: number;
  /** For `animal` (player): true once it has reached the gate and escaped (win). */
  escaped?: boolean;
  /** 8-way facing for directional sprite animation. Absent → renderer derives from motion. */
  facing?: Dir8;
  /** Active/just-fired ability effect, for one-shot + sustained FX on any client. */
  fx?: EntityFx;
  /** For `animal` (player): its per-species side-quest progress (Phase 6). */
  quest?: QuestProgress;
  /** For `animal` (player): the last tick it brushed the gate WITHOUT a complete quest. */
  questBlocked?: number;

  // --- Animal collection (food / follow / steal / score) -------------------
  // All optional; serialized onto the snapshot by engine.toEntity (player fields)
  // or written directly on the world entity (follower fields). They ride the
  // delta diff like every other entity field.

  /** For `food`: which food key this source dispenses (drives tint/label + feed match). */
  foodKey?: string;
  /** For an `animal` follower: the playerId currently leading it (its owner). */
  followerOf?: string;
  /** For an `animal` follower: the tick the follow lapses (server-authoritative TICKS). */
  followUntilTick?: number;
  /** For an `animal` follower: the tick the CURRENT follow window started — the
   *  client decaying-ring denominator: frac = (followUntilTick - tick)/(followUntilTick - followSince). */
  followSince?: number;
  /** For an `animal` follower: true if it was STOLEN from another player (worth more at the gate). */
  stolen?: boolean;
  /** For `animal` (player): the owner's collected-food bag, foodKey → count. Owner's own entity only. */
  inventory?: Record<string, number>;
  /** For `animal` (player): the award stamped on the escape edge (a one-shot client toast). */
  lastScore?: { points: number; herd: number; stolen: number; tick: number };
  /** For `animal` (player): the running session/round score (persists across respawns). */
  scoreTotal?: number;

  [key: string]: unknown;
}

/**
 * A connected human (or bot) controlling an entity. Players ARE entities so the
 * renderer and step() treat them uniformly; subtype only adds connection-level
 * bookkeeping.
 */
export interface Player extends Entity {
  /** Last input sequence number the server has processed (for reconciliation). */
  lastAckSeq?: number;
}

/**
 * One frame of player intent. `seq` is a monotonically increasing per-client
 * counter the client stamps on every input so the server can ack it and the
 * client can reconcile prediction. `dx`/`dy` are a normalized-ish move vector
 * in the range [-1, 1] per axis (raw axis values; step() applies speed * dt).
 */
export interface Input {
  seq: number;
  dx: number;
  dy: number;
}

/**
 * Global per-room state that isn't tied to a single entity — the "container"
 * for the catastrophic-overflow rule. Lives alongside the entity list in every
 * snapshot so all clients render the same meter and lockdown state.
 */
export interface WorldState {
  /** Current fill of the zoo-wide alarm/panic meter (0..panicCapacity). */
  panic: number;
  /** Capacity of the panic meter; reaching it triggers overflow → lockdown. */
  panicCapacity: number;
  /** True once panic has overflowed: robots drop First-Law caution, doors seal. */
  lockdown: boolean;
}

/** A freshly-initialized, calm world. */
export const INITIAL_WORLD_STATE: WorldState = {
  panic: 0,
  panicCapacity: 100,
  lockdown: false,
};

// The authoritative per-tick wire payload is `SnapshotMsg` in net.ts (it also
// carries input `acks` for reconciliation). There is no separate `Snapshot`
// type — net.ts owns the contract so client and server import one shape.
