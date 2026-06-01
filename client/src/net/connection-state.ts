/**
 * ConnectionState — the pure, framework-free core of the "Unable to connect…
 * retrying" overlay. It is fed socket.io lifecycle events (via NetClient) plus a
 * monotonic clock (`tick(nowMs)`), and emits a flat {@link ConnectionView} the UI
 * renders without any further logic.
 *
 * Deliberately DOM-free, socket-free, and dependency-free (no `@shared/*` alias,
 * no `import.meta`): the 5-second threshold and the reason/error → diagnostic
 * mapping are exactly the bits worth unit-testing, and keeping the module plain
 * ES2020 lets `node --test` run its `.ts` test directly (Node ≥ 22) with no build
 * step or extra dependency. socket.io is a client-only concern, so this is NOT
 * shared/ contract code — it never crosses the wire.
 *
 * Threshold semantics: the overlay shows once we have been continuously
 * NOT-connected for >= THRESHOLD_MS, measured from `since` — the moment we left
 * `connected`, or (on first load, before we have ever connected) the time
 * `markConnecting()` was called at `NetClient.connect()`. A reconnect that lands
 * before the threshold resets `since`, so a brief blip never flashes the overlay.
 * On reconnect we keep the overlay up for a short HIDE_LINGER_MS so a threshold
 * that was just crossed doesn't flicker off-then-on under rapid flapping.
 *
 * Time is injected, never read: `tick(nowMs)` is a pure function of the events
 * seen so far and the clock the caller passes, which makes the whole state
 * machine deterministic and trivial to test.
 */

/** Continuous-outage duration (ms) before the overlay appears. */
export const THRESHOLD_MS = 5000;

/** How long (ms) the overlay lingers after a reconnect, to avoid flicker. */
export const HIDE_LINGER_MS = 500;

/** The flat, render-ready view the UI consumes — no logic left for the caller. */
export interface ConnectionView {
  /** True once the outage has lasted >= THRESHOLD_MS (and not an intentional teardown). */
  showOverlay: boolean;
  /** The headline line. Constant copy while shown; '' when hidden. */
  headline: string;
  /** A friendly summary line plus a raw diagnostic line (reason · error · transport · attempts · offline). */
  detail: string;
}

/** The headline copy, kept here so the test and the UI agree on one string. */
export const HEADLINE = 'Unable to connect… retrying';

type Status = 'connected' | 'connecting';

/**
 * Map a socket.io disconnect `reason` / connect-error message to a short,
 * human-readable summary. Falls back to a generic line for unmapped strings so
 * the box is never blank. The raw string is still shown on the second line, so
 * nothing is hidden.
 */
function friendlySummary(reason: string | undefined, errorMsg: string | undefined): string {
  switch (reason) {
    case 'io server disconnect':
      return 'Server closed the connection';
    case 'ping timeout':
      return 'Server unresponsive';
    case 'transport close':
    case 'transport error':
      return 'Network connection lost';
    case 'parse error':
      return 'Bad data from server';
    case 'io client disconnect':
      // We normally suppress the overlay for our own teardown; if it is ever
      // shown for this reason it's a forced manual retry in progress.
      return 'Reconnecting…';
    default:
      break;
  }
  // No disconnect reason (we never established a connection): classify by the
  // connect-error message, which is the only signal on a first-load failure.
  const e = (errorMsg ?? '').toLowerCase();
  if (e.includes('xhr poll') || e.includes('websocket') || e.includes('timeout') || e.includes('failed')) {
    return "Can't reach the server";
  }
  return 'Connection problem';
}

export class ConnectionState {
  private status: Status = 'connecting';
  /** Intentional app-initiated teardown: suppress the overlay entirely. */
  private intentional = false;
  /**
   * Timestamp (ms) we left `connected`, or the connect() call time on first
   * load. Undefined only before the first `markConnecting()`/event.
   */
  private since: number | undefined;
  /** Last clock value handed to tick(), so view() reflects "now" between ticks. */
  private now = 0;
  /** Monotonic attempt counter (connect_error + reconnect_attempt), reset on connect. */
  private attempts = 0;
  private lastReason: string | undefined;
  private lastError: string | undefined;
  private lastTransport: string | undefined;
  /** True once the overlay has shown this outage; cleared after the reconnect linger. */
  private shown = false;
  /** While set, keep the overlay visible until this time even though we reconnected. */
  private lingerUntil = 0;

  /**
   * The connection attempt has begun (call from NetClient.connect()). Establishes
   * the `since` anchor for the first-load case, where no disconnect has occurred
   * yet but we may never connect.
   */
  markConnecting(nowMs: number): void {
    this.now = nowMs;
    this.intentional = false;
    if (this.status !== 'connected' && this.since === undefined) {
      this.since = nowMs;
    }
  }

  onConnect(nowMs: number): void {
    this.now = nowMs;
    const wasShown = this.shown;
    this.status = 'connected';
    this.since = undefined;
    this.attempts = 0;
    this.lastReason = undefined;
    this.lastError = undefined;
    // Keep the overlay up briefly so a just-crossed threshold doesn't flicker.
    if (wasShown) this.lingerUntil = nowMs + HIDE_LINGER_MS;
    this.shown = false;
  }

  onDisconnect(nowMs: number, reason: string): void {
    this.now = nowMs;
    this.status = 'connecting';
    this.lastReason = reason;
    if (this.since === undefined) this.since = nowMs;
    // Our own teardown (NetClient.disconnect) reports 'io client disconnect';
    // setIntentional() is called first, so this stays suppressed.
  }

  onConnectError(nowMs: number, message: string, transport?: string): void {
    this.now = nowMs;
    this.status = 'connecting';
    this.lastError = message;
    if (transport) this.lastTransport = transport;
    this.attempts += 1;
    if (this.since === undefined) this.since = nowMs;
  }

  onReconnectAttempt(nowMs: number, attempt: number): void {
    this.now = nowMs;
    this.status = 'connecting';
    // The manager's attempt number is authoritative once it starts counting.
    this.attempts = Math.max(this.attempts, attempt);
    if (this.since === undefined) this.since = nowMs;
  }

  onReconnectFailed(nowMs: number): void {
    this.now = nowMs;
    this.status = 'connecting';
    if (this.since === undefined) this.since = nowMs;
  }

  /** Mark the next disconnect as intentional (app teardown) — suppress the overlay. */
  setIntentional(value: boolean): void {
    this.intentional = value;
  }

  /** Advance the clock and recompute. Pure w.r.t. the injected time. */
  tick(nowMs: number): ConnectionView {
    this.now = nowMs;
    return this.view();
  }

  /** Current render-ready view at the last-seen clock value. */
  view(): ConnectionView {
    const now = this.now;
    const connected = this.status === 'connected';
    const offlineFor = this.since === undefined ? 0 : now - this.since;

    let show = false;
    if (this.intentional) {
      show = false;
    } else if (connected) {
      // Reconnected: honor the brief anti-flicker linger, then hide.
      show = now < this.lingerUntil;
    } else {
      show = offlineFor >= THRESHOLD_MS;
    }
    if (show) this.shown = true;

    if (!show) {
      return { showOverlay: false, headline: '', detail: '' };
    }

    const summary = friendlySummary(this.lastReason, this.lastError);
    const parts: string[] = [];
    if (this.lastReason) parts.push(this.lastReason);
    if (this.lastError) parts.push(`"${this.lastError}"`);
    if (this.lastTransport) parts.push(`via ${this.lastTransport}`);
    parts.push(`attempt ${this.attempts}`);
    parts.push(`${Math.max(0, Math.round(offlineFor / 1000))}s offline`);
    const detail = `${summary}\n${parts.join(' · ')}`;

    return { showOverlay: true, headline: HEADLINE, detail };
  }
}
