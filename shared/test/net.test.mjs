/**
 * Net contract guard — shared/src/net.ts is elevated to a first-class contract by
 * CLAUDE.md ("Net events are a contract"), yet nothing in the shared suite touched
 * it. This file guards the RUNTIME-OBSERVABLE surface of that contract: the two
 * event-name maps CLIENT_EVENTS (client emits) and SERVER_EVENTS (server emits).
 *
 * What this CAN and CANNOT test:
 *   - The payload SHAPES (AuthLogin, InputMsg, SnapshotMsg, MapMsg, ...) and the
 *     typed ClientToServerEvents / ServerToClientEvents maps are TypeScript types.
 *     They are ERASED at build time and do not exist in dist/net.js, so a .mjs test
 *     cannot introspect them. Their correctness is enforced by `tsc --strict` at
 *     build, not here.
 *   - The event-NAME maps are real frozen-shaped `as const` objects that survive to
 *     runtime. They are the wire's identity layer: a typo, a duplicate string, or a
 *     client/server name collision would silently cross wires. Those are exactly the
 *     drift classes this test catches.
 *
 * Imports the built dist (../dist/net.js), matching every other .mjs test here.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { CLIENT_EVENTS, SERVER_EVENTS } from '../dist/net.js';

// The exact current contract, pinned. These lists were dumped from dist/net.js
// (node -e Object.keys/Object.values) so they mirror the real exports byte-for-byte.
// Editing net.ts (add / remove / rename an event) WITHOUT updating these lists is a
// deliberate trip: it forces "the contract changed — did you mean to?" into review.
const EXPECTED_CLIENT_KEYS = ['AUTH_LOGIN', 'LOBBY_JOIN', 'INPUT', 'PING', 'LEADERBOARD_REQUEST', 'CHAT_SEND'];
const EXPECTED_SERVER_KEYS = ['AUTH_RESULT', 'LOBBY_STATE', 'SNAPSHOT', 'PONG', 'MAP', 'LEADERBOARD_DATA', 'CHAT_MESSAGE'];

const EXPECTED_CLIENT_VALUES = ['auth:login', 'lobby:join', 'input', 'ping', 'leaderboard:request', 'chat:send'];
const EXPECTED_SERVER_VALUES = ['auth:result', 'lobby:state', 'snapshot', 'pong', 'map', 'leaderboard:data', 'chat:message'];

/**
 * All-lowercase event name. The contract uses TWO legitimate shapes:
 *   - namespaced 'namespace:verb' (auth:login, lobby:join, leaderboard:request, ...)
 *   - bare single-token verbs (input, ping, pong, map, snapshot)
 * Both are real and intentional in net.ts, so the guard accepts either. What it
 * rejects is uppercase, whitespace, empty halves, or stray punctuation — i.e. a
 * malformed wire name.
 */
const EVENT_NAME_RE = /^[a-z]+(:[a-z]+)?$/;

test('CLIENT_EVENTS has exactly the expected key set (event added/removed/renamed → fail)', () => {
  assert.deepEqual(Object.keys(CLIENT_EVENTS).sort(), [...EXPECTED_CLIENT_KEYS].sort());
});

test('SERVER_EVENTS has exactly the expected key set (event added/removed/renamed → fail)', () => {
  assert.deepEqual(Object.keys(SERVER_EVENTS).sort(), [...EXPECTED_SERVER_KEYS].sort());
});

test('CLIENT_EVENTS maps each key to the exact expected wire string', () => {
  for (let i = 0; i < EXPECTED_CLIENT_KEYS.length; i++) {
    assert.equal(CLIENT_EVENTS[EXPECTED_CLIENT_KEYS[i]], EXPECTED_CLIENT_VALUES[i]);
  }
});

test('SERVER_EVENTS maps each key to the exact expected wire string', () => {
  for (let i = 0; i < EXPECTED_SERVER_KEYS.length; i++) {
    assert.equal(SERVER_EVENTS[EXPECTED_SERVER_KEYS[i]], EXPECTED_SERVER_VALUES[i]);
  }
});

test('CLIENT_EVENT values are unique (no two client keys share a wire string)', () => {
  const values = Object.values(CLIENT_EVENTS);
  assert.equal(new Set(values).size, values.length);
});

test('SERVER_EVENT values are unique (no two server keys share a wire string)', () => {
  const values = Object.values(SERVER_EVENTS);
  assert.equal(new Set(values).size, values.length);
});

test('no event string is shared between client and server maps (directions are disjoint)', () => {
  const clientValues = new Set(Object.values(CLIENT_EVENTS));
  const collisions = Object.values(SERVER_EVENTS).filter((v) => clientValues.has(v));
  assert.deepEqual(collisions, [], `client/server event-name collision: ${collisions.join(', ')}`);
});

test('every event value is a non-empty lowercase event name (namespace:verb or bare verb)', () => {
  for (const v of [...Object.values(CLIENT_EVENTS), ...Object.values(SERVER_EVENTS)]) {
    assert.equal(typeof v, 'string');
    assert.ok(v.length > 0, 'event name must be non-empty');
    assert.match(v, EVENT_NAME_RE, `event "${v}" is not a lowercase namespace:verb / bare-verb name`);
  }
});

test('total event count is 13 (6 client + 7 server) — coarse add/remove tripwire', () => {
  const clientCount = Object.keys(CLIENT_EVENTS).length;
  const serverCount = Object.keys(SERVER_EVENTS).length;
  assert.equal(clientCount, 6);
  assert.equal(serverCount, 7);
  assert.equal(clientCount + serverCount, 13);
});
