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
export type EntityKind = 'animal' | 'robot' | 'pen' | 'terminal' | 'gate' | 'prop';

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

/**
 * Authoritative world state broadcast by the server each tick. The client
 * interpolates between snapshots and reconciles its prediction against them.
 */
export interface Snapshot {
  tick: number;
  entities: Entity[];
  world?: WorldState;
}
