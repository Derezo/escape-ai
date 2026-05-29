/**
 * Authoritative network contract. BOTH client and server import these names and
 * payload shapes — never hardcode an event string anywhere else.
 *
 * Mirrors ARCHITECTURE.md "Network contract":
 *   Client -> server: `lobby:join {room, name}`, `input {seq, ...}`, `ping {t}`
 *   Server -> client: `lobby:state {players}`, `snapshot {tick, entities, acks}`, `pong {t}`
 */

import type { Entity, Input, Player, WorldState } from './types.js';

/** Event names the CLIENT emits (server listens for these). */
export const CLIENT_EVENTS = {
  AUTH_LOGIN: 'auth:login',
  LOBBY_JOIN: 'lobby:join',
  INPUT: 'input',
  PING: 'ping',
} as const;

/** Event names the SERVER emits (client listens for these). */
export const SERVER_EVENTS = {
  AUTH_RESULT: 'auth:result',
  LOBBY_STATE: 'lobby:state',
  SNAPSHOT: 'snapshot',
  PONG: 'pong',
  MAP: 'map',
} as const;

export type ClientEvent = (typeof CLIENT_EVENTS)[keyof typeof CLIENT_EVENTS];
export type ServerEvent = (typeof SERVER_EVENTS)[keyof typeof SERVER_EVENTS];

// --- Client -> server payloads ---------------------------------------------

/**
 * Payload for `auth:login`. Username-only accounts with a persisted token
 * (Parasite-style): the client sends a username, plus a previously-issued
 * `token` if it has one in localStorage (→ session restore / auto-login). A
 * returning player may also send their chosen `species`.
 *   - token present & valid → restore that account (username taken from the DB)
 *   - no token, username free → claim it, server issues a fresh token
 *   - no token, username taken → rejected (`name_taken`)
 */
export interface AuthLogin {
  username: string;
  token?: string;
  species?: string;
}

/** Payload for `lobby:join`. `species` is the returning player's pick (optional). */
export interface LobbyJoin {
  room: string;
  name: string;
  species?: string;
}

/**
 * A discrete, non-movement action the player triggers this frame. Movement is
 * the continuous dx/dy; this is the "press a button" intent layer. Resolved by
 * the server against nearby entities (Phase 2+):
 *   - `interact` use the nearest terminal / pick up the disguise prop
 *   - `order`    issue a Second-Law order to the nearest robot
 *   - `ability`  trigger this species' special (climb/fly/squeeze/smash)
 */
export type PlayerAction = 'interact' | 'order' | 'ability';

/**
 * Payload for `input`. Carries an Input plus an optional discrete action and a
 * forward-compatible index signature. `action` is undefined on a pure-movement
 * frame; it fires once on the frame the player presses the key.
 */
export interface InputMsg extends Input {
  action?: PlayerAction;
  /**
   * Whether the player is sprinting this frame (Shift held). Sprinting moves at
   * the full PLAYER_SPEED but reads as fleeing prey (collapses humanLikeness);
   * the default walk is slower but keeps the human disguise. Absent = walk.
   */
  sprint?: boolean;
  [key: string]: unknown;
}

/** Payload for `ping`. `t` is the client clock stamp echoed back in `pong`. */
export interface Ping {
  t: number;
}

// --- Server -> client payloads ---------------------------------------------

/**
 * Persisted per-user stats (server SQLite store). Returned in `AuthResult` so
 * the help widget's Stats tab can render immediately on login, and surfaced
 * again whenever the server re-issues an `auth:result`. All counters are
 * cumulative across sessions; timestamps are ISO strings.
 */
export interface UserStats {
  /** Sessions started (incremented once per successful login). */
  games: number;
  /** Successful gate escapes. */
  escapes: number;
  /** Times caught by a keeper robot. */
  caught: number;
  /** Second-Law orders issued (Q). */
  ordersIssued: number;
  /** Species abilities fired (Space). */
  abilitiesUsed: number;
  /** Total play time accumulated across sessions, in seconds. */
  playSeconds: number;
  /** Species used in the most recent session (drives the selector default). */
  lastSpecies?: string;
  /** When the account was created (ISO 8601). */
  firstSeen?: string;
  /** Most recent login (ISO 8601). */
  lastSeen?: string;
}

/**
 * Payload for `auth:result` — the reply to `auth:login`. On success it carries
 * the issued/echoed `token` (the client persists it), the authoritative
 * `username`, and the user's `stats`. On failure `reason` says why:
 *   - `name_taken` the username is owned by a different account
 *   - `bad_token`  the supplied token is unknown/mismatched (client clears it)
 *   - `invalid`    the username was empty/malformed
 */
export interface AuthResult {
  ok: boolean;
  reason?: 'name_taken' | 'bad_token' | 'invalid';
  token?: string;
  username?: string;
  stats?: UserStats;
}

/** Payload for `lobby:state`. */
export interface LobbyState {
  players: Player[];
}

/**
 * Payload for `snapshot`. `acks` maps a player/socket id to the last input
 * `seq` the server has applied for that player, enabling client reconciliation.
 * `world` carries the global panic/lockdown state (the overflow container); it
 * is sent on full refreshes and whenever it changes.
 */
export interface SnapshotMsg {
  tick: number;
  entities: Entity[];
  acks: Record<string, number>;
  world?: WorldState;
}

/** Payload for `pong`. `t` is the original client stamp from `ping`. */
export interface Pong {
  t: number;
}

/**
 * Payload for `map` — sent ONCE per join (and on room change), never per tick.
 *
 * SEED-ONLY transfer: the 128×128 tilemap (16,384 tiles × 3 layers) would be
 * megabytes on the wire and must never ride the per-tick snapshot. Instead the
 * server sends just the seed it generated the room's world from; each client runs
 * the IDENTICAL deterministic `generateWorld(seed)` (shared/src/world.ts) to
 * reconstruct the same `WorldMap` for rendering AND collision-aware prediction.
 * `version` lets the client assert generator parity (it must equal the shared
 * `WORLD_GEN_VERSION`); `tile`/`w`/`h` let it size its tilemap before generating.
 * Gameplay entities derived from the map (gate, terminals, housing decoys, quest
 * objects) are still server-owned and arrive via `snapshot` — the client never
 * invents them; it only regenerates the static tiles.
 */
export interface MapMsg {
  seed: number;
  version: number;
  tile: number;
  w: number;
  h: number;
}

/**
 * Optional typed maps for socket.io's generic ServerToClientEvents /
 * ClientToServerEvents. Importing these is not required but documents the wire.
 */
export interface ClientToServerEvents {
  [CLIENT_EVENTS.AUTH_LOGIN]: (payload: AuthLogin) => void;
  [CLIENT_EVENTS.LOBBY_JOIN]: (payload: LobbyJoin) => void;
  [CLIENT_EVENTS.INPUT]: (payload: InputMsg) => void;
  [CLIENT_EVENTS.PING]: (payload: Ping) => void;
}

export interface ServerToClientEvents {
  [SERVER_EVENTS.AUTH_RESULT]: (payload: AuthResult) => void;
  [SERVER_EVENTS.LOBBY_STATE]: (payload: LobbyState) => void;
  [SERVER_EVENTS.SNAPSHOT]: (payload: SnapshotMsg) => void;
  [SERVER_EVENTS.PONG]: (payload: Pong) => void;
  [SERVER_EVENTS.MAP]: (payload: MapMsg) => void;
}
