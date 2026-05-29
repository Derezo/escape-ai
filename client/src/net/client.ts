/**
 * NetClient — thin wrapper over socket.io-client that speaks the shared network
 * contract (shared/src/net.ts). Event names and payload shapes come from
 * `@shared/net`; nothing here hardcodes a wire string.
 *
 *   Client -> server: lobby:join {room,name}, input {seq,dx,dy}, ping {t}
 *   Server -> client: lobby:state {players}, snapshot {tick,entities,acks}, pong {t}
 */

import { io, type Socket } from 'socket.io-client';
import {
  CLIENT_EVENTS,
  SERVER_EVENTS,
  type LobbyJoin,
  type InputMsg,
  type Ping,
  type Pong,
  type LobbyState,
  type SnapshotMsg,
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

  /** Open the connection. Wires server->client handlers and starts the ping loop. */
  connect(url: string): void {
    this.socket = io(url, {
      transports: ['websocket', 'polling'],
      autoConnect: true,
    });

    this.socket.on(SERVER_EVENTS.SNAPSHOT, (msg: SnapshotMsg) => {
      this.snapshotCb(msg);
    });

    this.socket.on(SERVER_EVENTS.LOBBY_STATE, (msg: LobbyState) => {
      this.lobbyCb(msg);
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

  /** Emit lobby:join {room, name}. */
  join(room: string, name: string): void {
    const payload: LobbyJoin = { room, name };
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
