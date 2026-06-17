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
import { ConnectionState, type ConnectionView } from './connection-state';
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
  type LeaderboardRequest,
  type LeaderboardMsg,
  type ChatMessage,
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
  private leaderboardCb: (msg: LeaderboardMsg) => void = () => {};
  private chatCb: (msg: ChatMessage) => void = () => {};

  /**
   * The connection-health state machine that drives the "Unable to connect…
   * retrying" overlay. NetClient is its single owner: it feeds the real socket.io
   * lifecycle events in, and main.ts reads views out via {@link onConnectionChange}
   * and the {@link tickConnection} clock. See connection-state.ts.
   */
  private conn = new ConnectionState();
  private connChangeCb: (view: ConnectionView) => void = () => {};

  /** Open the connection. Wires server->client handlers and starts the ping loop. */
  connect(url: string): void {
    // Anchor the connection-health clock at the connect() call so the 5s overlay
    // threshold counts from "we started trying" even on a first load that never
    // succeeds (no disconnect has happened yet to anchor it otherwise).
    this.conn.markConnecting(Date.now());

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

    // The leaderboard reply (to leaderboard:request). Registered here; the cb
    // defaults to a no-op until the leaderboard overlay registers via onLeaderboard().
    this.socket.on(SERVER_EVENTS.LEADERBOARD_DATA, (msg: LeaderboardMsg) => {
      this.leaderboardCb(msg);
    });

    // A global-chat line broadcast to the room. Registered here; the cb defaults to
    // a no-op until the chat widget registers via onChat().
    this.socket.on(SERVER_EVENTS.CHAT_MESSAGE, (msg: ChatMessage) => {
      this.chatCb(msg);
    });

    // Latency: server echoes our timestamp back in pong {t}; rtt = now - t.
    this.socket.on(SERVER_EVENTS.PONG, (msg: Pong) => {
      const rtt = Date.now() - msg.t;
      // Drop implausible samples before they corrupt the EMA. A valid rtt is
      // non-negative (clock can't go backward), finite (NaN/Infinity from a bad
      // msg.t would poison the EMA forever), and below 4× the ping interval (~4s).
      // A genuine 4s RTT means the connection is effectively dead — the connection-
      // state overlay will surface that; tainting the HUD counter adds no signal.
      if (!Number.isFinite(rtt) || rtt < 0 || rtt > PING_INTERVAL_MS * 4) return;
      // Exponential moving average to keep the HUD readable.
      this.latencyMs = this.latencyMs < 0 ? rtt : Math.round(this.latencyMs * 0.7 + rtt * 0.3);
    });

    // --- Connection health (drives the "Unable to connect… retrying" overlay) ---
    // Socket-level lifecycle: connect / connect_error / disconnect. The ping loop
    // start/stop rides along the connect/disconnect edges (unchanged behavior).
    this.socket.on('connect', () => {
      this.conn.onConnect(Date.now());
      this.startPingLoop();
      this.emitConnChange();
    });

    this.socket.on('connect_error', (err: Error) => {
      // Each failed connection/handshake attempt — the workhorse signal on a
      // first-load failure, where the manager's reconnect_* events don't fire.
      const transport = this.socket?.io?.engine?.transport?.name;
      this.conn.onConnectError(Date.now(), err.message, transport);
      this.emitConnChange();
    });

    this.socket.on('disconnect', (reason: string) => {
      this.stopPingLoop();
      this.conn.onDisconnect(Date.now(), reason);
      // socket.io does NOT auto-reconnect after a server-forced disconnect, so
      // re-arm the retry ourselves. (Our own intentional teardown reports
      // 'io client disconnect' and is suppressed via setIntentional() in
      // disconnect(), so it never reaches this branch.)
      if (reason === 'io server disconnect') this.socket?.connect();
      this.emitConnChange();
    });

    // Manager-level reconnection lifecycle (only fires after a prior successful
    // connection that dropped). `this.socket.io` is the shared Manager.
    this.socket.io.on('reconnect_attempt', (attempt: number) => {
      this.conn.onReconnectAttempt(Date.now(), attempt);
      this.emitConnChange();
    });
    this.socket.io.on('reconnect_failed', () => {
      this.conn.onReconnectFailed(Date.now());
      this.emitConnChange();
    });
  }

  /** Register the connection-health handler (drives the connection-loss overlay). */
  onConnectionChange(cb: (view: ConnectionView) => void): void {
    this.connChangeCb = cb;
  }

  /** Push the current connection view to the registered handler. */
  private emitConnChange(): void {
    this.connChangeCb(this.conn.view());
  }

  /**
   * Advance the connection-health clock and return the fresh view. main.ts calls
   * this on a steady interval so the 5s overlay threshold (and the "Ns offline"
   * readout) update even when no socket event has fired. Pure w.r.t. `nowMs`.
   */
  tickConnection(nowMs: number): ConnectionView {
    return this.conn.tick(nowMs);
  }

  /** Force an immediate reconnection attempt (the overlay's "Retry now" button). */
  retry(): void {
    this.socket?.connect();
  }

  /** Whether the socket is currently connected. */
  get connected(): boolean {
    return this.socket?.connected ?? false;
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

  /**
   * Emit input {seq, dx, dy} (plus any extra forward-compatible fields). Sent as
   * VOLATILE: while disconnected, socket.io buffers emits and flushes them on
   * reconnect — for real-time movement that means a burst of stale inputs would
   * replay the moment we reconnect. Volatile drops them instead, which is the
   * correct semantics here (only the latest movement matters; the server is
   * authoritative and the client re-predicts from the next snapshot).
   */
  sendInput(input: InputMsg): void {
    this.socket?.volatile.emit(CLIENT_EVENTS.INPUT, input);
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

  /** Emit leaderboard:request {sort?, limit?}. The server replies with
   *  leaderboard:data (register the handler via onLeaderboard). Sent on opening
   *  the L panel, on a sort-change, and on the while-open poll. */
  requestLeaderboard(req: LeaderboardRequest = {}): void {
    this.socket?.emit(CLIENT_EVENTS.LEADERBOARD_REQUEST, req);
  }

  /** Register the leaderboard-data handler (the reply to requestLeaderboard). */
  onLeaderboard(cb: (msg: LeaderboardMsg) => void): void {
    this.leaderboardCb = cb;
  }

  /** Emit chat:send {text}. The server validates/trims/caps it and broadcasts a
   *  chat:message to everyone in the room (register the handler via onChat). */
  sendChat(text: string): void {
    this.socket?.emit(CLIENT_EVENTS.CHAT_SEND, { text });
  }

  /** Register the chat-message handler (a global-chat line from the server). */
  onChat(cb: (msg: ChatMessage) => void): void {
    this.chatCb = cb;
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
    // Mark this as an intentional app-initiated teardown BEFORE we disconnect so
    // the connection-health machine suppresses the overlay for the resulting
    // 'io client disconnect' (we don't want "Unable to connect" on a clean exit).
    this.conn.setIntentional(true);
    this.socket?.disconnect();
    this.socket = undefined;
  }

  private startPingLoop(): void {
    this.stopPingLoop();
    const sendPing = () => {
      const payload: Ping = { t: Date.now() };
      // Volatile: if the socket is temporarily buffering (reconnecting), we drop
      // stale pings rather than replay a burst of them on reconnect. A skipped ping
      // sample is invisible (the next one arrives at most PING_INTERVAL_MS later);
      // a burst of replayed pings would spike the EMA wildly. This mirrors how
      // sendInput is emitted volatile (real-time movement, same semantics).
      this.socket?.volatile.emit(CLIENT_EVENTS.PING, payload);
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
