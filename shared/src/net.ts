/**
 * Authoritative network contract. BOTH client and server import these names and
 * payload shapes — never hardcode an event string anywhere else.
 *
 * Mirrors ARCHITECTURE.md "Network contract":
 *   Client -> server: `auth:login {username, token?, species?}`,
 *     `lobby:join {room, name, species?}`, `input {seq, dx, dy, sprint?, action?}`, `ping {t}`
 *   Server -> client: `auth:result {ok, ...}`, `lobby:state {players}`,
 *     `snapshot {tick, entities, acks, world?}`, `pong {t}`, `map {seed, version, tile, w, h}`
 */

import type { Entity, Input, Player, WorldState } from './types.js';

/** Event names the CLIENT emits (server listens for these). */
export const CLIENT_EVENTS = {
  AUTH_LOGIN: 'auth:login',
  LOBBY_JOIN: 'lobby:join',
  INPUT: 'input',
  PING: 'ping',
  /** Ask the server for the current leaderboard (sent on opening the L panel and
   *  re-sent on a sort change / while the panel is open — see LeaderboardRequest). */
  LEADERBOARD_REQUEST: 'leaderboard:request',
} as const;

/** Event names the SERVER emits (client listens for these). */
export const SERVER_EVENTS = {
  AUTH_RESULT: 'auth:result',
  LOBBY_STATE: 'lobby:state',
  SNAPSHOT: 'snapshot',
  PONG: 'pong',
  MAP: 'map',
  /** The leaderboard reply to LEADERBOARD_REQUEST (top-N rows + the asker's rank). */
  LEADERBOARD_DATA: 'leaderboard:data',
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
 *   - `interact` use the nearest terminal / pick up the disguise prop / COLLECT
 *                food from the nearest food source (a disjoint target class from
 *                terminals — food sources live inside enclosures, terminals on roads)
 *   - `order`    issue a Second-Law order to the nearest robot
 *   - `ability`  trigger this species' special (climb/fly/squeeze/smash)
 *   - `feed`     give the nearest feedable animal its liked food → it FOLLOWS you
 *                (a dedicated verb, not overloaded onto `interact`, so it never
 *                collides with the terminal/`activate`-quest path)
 */
export type PlayerAction = 'interact' | 'order' | 'ability' | 'feed';

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

/**
 * Which column the leaderboard sorts by, descending (best first). 'score' is the
 * composite (shared/src/score.ts); the rest sort by a single raw counter so a
 * reviewer can rank by any metric the datatable shows. The server validates the
 * key against this set and falls back to 'score' on anything unknown.
 */
export type LeaderboardSort =
  | 'score'
  | 'escapes'
  | 'questsCompleted'
  | 'animalsStolen'
  | 'foodCollected'
  | 'caught'
  | 'ordersIssued'
  | 'abilitiesUsed'
  | 'playSeconds'
  | 'games';

/**
 * Payload for `leaderboard:request`. The client asks for the top `limit` rows by
 * `sort`. Both optional — the server clamps `limit` to a sane max and defaults
 * `sort` to 'score'. The asker's OWN row is always returned (in `you`) even when
 * it falls outside the top-N, so a player can always see their standing.
 */
export interface LeaderboardRequest {
  sort?: LeaderboardSort;
  /** How many top rows to return (server-clamped, e.g. 1..200). Default ~100. */
  limit?: number;
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
  /** Food units collected from food sources (cumulative). */
  foodCollected: number;
  /** Following animals stolen away from other players (cumulative). */
  animalsStolen: number;
  /** Side-quest events completed (cumulative). */
  questsCompleted: number;
  /** Animals escaped through the gate, broken down by species (cumulative).
   *  Stored server-side as a JSON TEXT column; absent on legacy rows. */
  escapesBySpecies?: Record<string, number>;
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
  /**
   * True when the server has a usable saved session for this account: a returning
   * player resumes their CURRENT (in-game-reborn) species — the menu SKIPS the
   * species picker and joins straight in. Absent/false for a brand-new account.
   */
  resumed?: boolean;
  /** The species the resuming player will spawn as (set iff `resumed`). */
  resumeSpecies?: string;
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
 * One row in the leaderboard datatable: a player's display name, all persisted
 * stat counters (so the client can render — and re-sort — every column without a
 * second round-trip), and the SERVER-COMPUTED composite `score` + its 1-based
 * `rank` under the active sort. The server is authoritative for both `score` and
 * `rank`; the client never recomputes rank (it only mirrors `score` for a preview
 * via the shared scorer). `escapesBySpecies` rides along for the expandable
 * per-species breakdown. No user ids / tokens — purely public, display-only data.
 */
export interface LeaderboardRow {
  /** 1-based rank under the active sort (1 = top). Server-assigned. */
  rank: number;
  /** Public display name (the account username). */
  name: string;
  /** The composite score (shared/src/score.ts), computed server-side. */
  score: number;
  escapes: number;
  caught: number;
  ordersIssued: number;
  abilitiesUsed: number;
  playSeconds: number;
  foodCollected: number;
  animalsStolen: number;
  questsCompleted: number;
  games: number;
  /** Per-species escape counts, for the expandable breakdown. */
  escapesBySpecies?: Record<string, number>;
  /** Species used most recently (a small avatar in the row), when known. */
  lastSpecies?: string;
}

/**
 * Payload for `leaderboard:data` — the reply to `leaderboard:request`. Carries the
 * top-`limit` rows under `sort`, the `total` number of ranked accounts (so the UI
 * can show "rank N of total"), and the asker's OWN row in `you` (present even when
 * it's outside the returned `rows`, so the player always sees their standing). The
 * `sort` is echoed so a client that changed sorts mid-flight can ignore a stale reply.
 */
export interface LeaderboardMsg {
  /** The sort the rows are ordered by (echoes the request, server-validated). */
  sort: LeaderboardSort;
  /** Top-N rows, already ranked + ordered best-first under `sort`. */
  rows: LeaderboardRow[];
  /** Total number of ranked accounts in the store (for "of N"). */
  total: number;
  /** The requesting player's own ranked row, or null if they have no account/stats. */
  you: LeaderboardRow | null;
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
  [CLIENT_EVENTS.LEADERBOARD_REQUEST]: (payload: LeaderboardRequest) => void;
}

export interface ServerToClientEvents {
  [SERVER_EVENTS.AUTH_RESULT]: (payload: AuthResult) => void;
  [SERVER_EVENTS.LOBBY_STATE]: (payload: LobbyState) => void;
  [SERVER_EVENTS.SNAPSHOT]: (payload: SnapshotMsg) => void;
  [SERVER_EVENTS.PONG]: (payload: Pong) => void;
  [SERVER_EVENTS.MAP]: (payload: MapMsg) => void;
  [SERVER_EVENTS.LEADERBOARD_DATA]: (payload: LeaderboardMsg) => void;
}
