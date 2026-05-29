/**
 * Core serializable game types shared by client and server.
 *
 * Everything here is a plain data shape — no methods, no class instances —
 * so it round-trips cleanly through Socket.IO / JSON. The renderer never sees
 * anything richer than these objects (see ARCHITECTURE.md: "Entities are plain
 * serializable objects `{id, x, y, ...}`; renderer-agnostic").
 */

/**
 * The atomic thing the world is made of. The index signature lets the hour-0
 * gameplay rules bolt on arbitrary fields (hp, color, team, z, ...) without
 * editing this file or breaking serialization.
 */
export interface Entity {
  id: string;
  x: number;
  y: number;
  name?: string;
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
 * Authoritative world state broadcast by the server each tick. The client
 * interpolates between snapshots and reconciles its prediction against them.
 */
export interface Snapshot {
  tick: number;
  entities: Entity[];
}
