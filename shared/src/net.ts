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
  LOBBY_JOIN: 'lobby:join',
  INPUT: 'input',
  PING: 'ping',
} as const;

/** Event names the SERVER emits (client listens for these). */
export const SERVER_EVENTS = {
  LOBBY_STATE: 'lobby:state',
  SNAPSHOT: 'snapshot',
  PONG: 'pong',
} as const;

export type ClientEvent = (typeof CLIENT_EVENTS)[keyof typeof CLIENT_EVENTS];
export type ServerEvent = (typeof SERVER_EVENTS)[keyof typeof SERVER_EVENTS];

// --- Client -> server payloads ---------------------------------------------

/** Payload for `lobby:join`. */
export interface LobbyJoin {
  room: string;
  name: string;
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
  [key: string]: unknown;
}

/** Payload for `ping`. `t` is the client clock stamp echoed back in `pong`. */
export interface Ping {
  t: number;
}

// --- Server -> client payloads ---------------------------------------------

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
 * Optional typed maps for socket.io's generic ServerToClientEvents /
 * ClientToServerEvents. Importing these is not required but documents the wire.
 */
export interface ClientToServerEvents {
  [CLIENT_EVENTS.LOBBY_JOIN]: (payload: LobbyJoin) => void;
  [CLIENT_EVENTS.INPUT]: (payload: InputMsg) => void;
  [CLIENT_EVENTS.PING]: (payload: Ping) => void;
}

export interface ServerToClientEvents {
  [SERVER_EVENTS.LOBBY_STATE]: (payload: LobbyState) => void;
  [SERVER_EVENTS.SNAPSHOT]: (payload: SnapshotMsg) => void;
  [SERVER_EVENTS.PONG]: (payload: Pong) => void;
}
