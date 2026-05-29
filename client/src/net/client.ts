/**
 * NetClient — thin wrapper over socket.io-client that speaks the shared network
 * contract (shared/src/net.ts). Event names and payload shapes come from
 * `@shared/net`; nothing here hardcodes a wire string.
 *
 *   Client -> server: auth:login {username,token?,species?}, lobby:join {room,name,species?},
 *                      input {seq,dx,dy}, ping {t}
 *   Server -> client: auth:result {ok,...}, lobby:state {players},
 *                      snapshot {tick,entities,acks}, pong {t}
 */

import { io, type Socket } from 'socket.io-client';
import {
  CLIENT_EVENTS,
  SERVER_EVENTS,
  type AuthLogin,
  type AuthResult,
  type LobbyJoin,
  type InputMsg,
  type Ping,
  type Pong,
  type LobbyState,
  type SnapshotMsg,
  type MapMsg,
} from '@shared/net';

/** How often (ms) to send a ping for the latency estimate. */
const PING_INTERVAL_MS = 1000;

export class NetClient {
  private socket?: Socket;
  /** Smoothed round-trip latency in ms; -1 until the first pong arrives. */
  private latencyMs = -1;
  private pingTimer?: ReturnType<typeof setInterval>;

  private snapshotCb: (msg: SnapshotMsg) => void = () => {};
  private lobbyCb: (msg: LobbyState) => void = () => {};
  private authCb: (msg: AuthResult) => void = () => {};
  private mapCb: (msg: MapMsg) => void = () => {};

  /** Open the connection. Wires server->client handlers and starts the ping loop. */
  connect(url: string): void {
    this.socket = io(url, {
      transports: ['websocket', 'polling'],
      autoConnect: true,
    });

    // Auth reply (the login flow's success/failure for auth:login). Registered
    // here alongside the other server->client handlers; the cb defaults to a
    // no-op until menu.ts registers via onAuthResult().
    this.socket.on(SERVER_EVENTS.AUTH_RESULT, (msg: AuthResult) => {
      this.authCb(msg);
    });

    this.socket.on(SERVER_EVENTS.SNAPSHOT, (msg: SnapshotMsg) => {
      this.snapshotCb(msg);
    });

    this.socket.on(SERVER_EVENTS.LOBBY_STATE, (msg: LobbyState) => {
      this.lobbyCb(msg);
    });

    // The world map (seed-only) — sent once on join. The client regenerates the
    // full WorldMap from the seed (see main.ts onMap). Registered here; the cb
    // defaults to a no-op until main.ts registers via onMap().
    this.socket.on(SERVER_EVENTS.MAP, (msg: MapMsg) => {
      this.mapCb(msg);
    });

    // Latency: server echoes our timestamp back in pong {t}; rtt = now - t.
    this.socket.on(SERVER_EVENTS.PONG, (msg: Pong) => {
      const rtt = Date.now() - msg.t;
      // Exponential moving average to keep the HUD readable.
      this.latencyMs = this.latencyMs < 0 ? rtt : Math.round(this.latencyMs * 0.7 + rtt * 0.3);
    });

    this.socket.on('connect', () => this.startPingLoop());
    this.socket.on('disconnect', () => this.stopPingLoop());
  }

  /**
   * Emit auth:login {username, token?, species?}. The server replies with
   * auth:result (register the handler via onAuthResult). Undefined fields are
   * omitted so the wire payload stays minimal:
   *   - token present   → session restore (auto-login on a returning player)
   *   - token absent     → claim the username (server issues a fresh token)
   *   - species present → the returning player's pick (drives spawn assignment)
   */
  login(username: string, token?: string, species?: string): void {
    const payload: AuthLogin = { username };
    if (token !== undefined) payload.token = token;
    if (species !== undefined) payload.species = species;
    this.socket?.emit(CLIENT_EVENTS.AUTH_LOGIN, payload);
  }

  /** Register the auth-result handler (login success/failure). */
  onAuthResult(cb: (msg: AuthResult) => void): void {
    this.authCb = cb;
  }

  /** Emit lobby:join {room, name, species?}. `species` rides along when chosen. */
  join(room: string, name: string, species?: string): void {
    const payload: LobbyJoin = { room, name };
    if (species !== undefined) payload.species = species;
    this.socket?.emit(CLIENT_EVENTS.LOBBY_JOIN, payload);
  }

  /** Emit input {seq, dx, dy} (plus any extra forward-compatible fields). */
  sendInput(input: InputMsg): void {
    this.socket?.emit(CLIENT_EVENTS.INPUT, input);
  }

  /** Register the snapshot handler. */
  onSnapshot(cb: (msg: SnapshotMsg) => void): void {
    this.snapshotCb = cb;
  }

  /** Register the lobby-state handler. */
  onLobbyState(cb: (msg: LobbyState) => void): void {
    this.lobbyCb = cb;
  }

  /** Register the map handler (the seed-only world map, sent once on join). */
  onMap(cb: (msg: MapMsg) => void): void {
    this.mapCb = cb;
  }

  /** Current smoothed latency in ms, or -1 if not yet measured. */
  get latency(): number {
    return this.latencyMs;
  }

  /** This socket's connection id (stable per connection), or undefined pre-connect. */
  get socketId(): string | undefined {
    return this.socket?.id;
  }

  disconnect(): void {
    this.stopPingLoop();
    this.socket?.disconnect();
    this.socket = undefined;
  }

  private startPingLoop(): void {
    this.stopPingLoop();
    const sendPing = () => {
      const payload: Ping = { t: Date.now() };
      this.socket?.emit(CLIENT_EVENTS.PING, payload);
    };
    sendPing(); // immediate first sample
    this.pingTimer = setInterval(sendPing, PING_INTERVAL_MS);
  }

  private stopPingLoop(): void {
    if (this.pingTimer) {
      clearInterval(this.pingTimer);
      this.pingTimer = undefined;
    }
  }
}
