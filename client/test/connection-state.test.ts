/**
 * Unit tests for the pure connection-state machine (the 5-second overlay
 * threshold, the reason/error → diagnostic mapping, and the attempt counter).
 *
 * Runs under Node's built-in test runner with native TypeScript support
 * (`node --test test/*.test.ts`; the project pins node >= 22). The module under
 * test is deliberately dependency-free — no DOM, no socket, no `@shared` alias —
 * so this imports its `.ts` source directly with zero build step and zero extra
 * dependencies, matching the repo's zero-dep test convention.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  ConnectionState,
  THRESHOLD_MS,
  HIDE_LINGER_MS,
  HEADLINE,
} from '../src/net/connection-state.ts';

test('never-connected: overlay hidden just under threshold, shown at threshold', () => {
  const s = new ConnectionState();
  const t0 = 1000;
  s.markConnecting(t0);
  // A failing first connect (no prior connection → connect_error, not reconnect_*).
  s.onConnectError(t0, 'xhr poll error');

  assert.equal(s.tick(t0 + THRESHOLD_MS - 1).showOverlay, false, 'hidden at 4999ms');
  const v = s.tick(t0 + THRESHOLD_MS);
  assert.equal(v.showOverlay, true, 'shown at exactly 5000ms');
  assert.equal(v.headline, HEADLINE);
});

test('a reconnect before the threshold prevents the overlay entirely', () => {
  const s = new ConnectionState();
  const t0 = 0;
  s.markConnecting(t0);
  s.onConnect(t0); // established
  s.onDisconnect(t0 + 1000, 'transport close');
  assert.equal(s.tick(t0 + 3000).showOverlay, false, 'still under threshold');
  s.onConnect(t0 + 3500); // reconnected at 2.5s of outage
  assert.equal(s.tick(t0 + 9000).showOverlay, false, 'never crossed 5s → no overlay');
});

test('intentional teardown keeps the overlay hidden past the threshold', () => {
  const s = new ConnectionState();
  const t0 = 0;
  s.markConnecting(t0);
  s.onConnect(t0);
  s.setIntentional(true); // app calls NetClient.disconnect()
  s.onDisconnect(t0 + 100, 'io client disconnect');
  assert.equal(s.tick(t0 + THRESHOLD_MS + 5000).showOverlay, false);
});

test('io server disconnect is surfaced (drives the manual-retry path)', () => {
  const s = new ConnectionState();
  const t0 = 0;
  s.markConnecting(t0);
  s.onConnect(t0);
  s.onDisconnect(t0 + 100, 'io server disconnect');
  const v = s.tick(t0 + 100 + THRESHOLD_MS);
  assert.equal(v.showOverlay, true);
  assert.match(v.detail, /Server closed the connection/, 'friendly summary present');
  assert.match(v.detail, /io server disconnect/, 'raw reason present');
});

test('attempts increment on connect_error and reconnect_attempt, reset on connect', () => {
  const s = new ConnectionState();
  const t0 = 0;
  s.markConnecting(t0);
  s.onConnectError(t0, 'websocket error'); // attempt 1
  s.onConnectError(t0 + 100, 'websocket error'); // attempt 2
  let v = s.tick(t0 + THRESHOLD_MS);
  assert.match(v.detail, /attempt 2/, 'counts connect_error');

  // Manager-driven reconnection (after a prior connection) is authoritative.
  s.onReconnectAttempt(t0 + 200, 7);
  v = s.tick(t0 + THRESHOLD_MS + 200);
  assert.match(v.detail, /attempt 7/, 'takes the manager attempt number');

  s.onConnect(t0 + 300);
  // After reconnect (past any linger) the view is hidden and the counter is reset:
  v = s.tick(t0 + 300 + HIDE_LINGER_MS + 1);
  assert.equal(v.showOverlay, false);
});

test('detail carries both a friendly summary and the raw reason/error/transport', () => {
  const s = new ConnectionState();
  const t0 = 0;
  s.markConnecting(t0);
  s.onConnect(t0);
  s.onConnectError(t0 + 50, 'websocket error', 'polling');
  s.onDisconnect(t0 + 50, 'ping timeout');
  const v = s.tick(t0 + 50 + THRESHOLD_MS);
  assert.equal(v.showOverlay, true);
  assert.match(v.detail, /Server unresponsive/, 'friendly summary');
  assert.match(v.detail, /ping timeout/, 'raw reason');
  assert.match(v.detail, /websocket error/, 'raw error');
  assert.match(v.detail, /via polling/, 'transport');
  assert.match(v.detail, /\d+s offline/, 'offline duration');
});

test('overlay lingers briefly after reconnect, then hides (anti-flicker)', () => {
  const s = new ConnectionState();
  const t0 = 0;
  s.markConnecting(t0);
  s.onConnect(t0);
  s.onDisconnect(t0 + 10, 'transport close');
  assert.equal(s.tick(t0 + 10 + THRESHOLD_MS).showOverlay, true, 'overlay shown');
  const reconnectAt = t0 + 10 + THRESHOLD_MS + 100;
  s.onConnect(reconnectAt);
  assert.equal(s.tick(reconnectAt + HIDE_LINGER_MS - 1).showOverlay, true, 'still lingering');
  assert.equal(s.tick(reconnectAt + HIDE_LINGER_MS + 1).showOverlay, false, 'hidden after linger');
});
