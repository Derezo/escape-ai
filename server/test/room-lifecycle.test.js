'use strict';

/**
 * Room-lifecycle hardening regression (game/caves-of-steel feature):
 *
 *   A. Client-supplied room names are validated + clamped (socket/lobby.js
 *      sanitizeRoom): a safe charset, 1-32 chars, else the pre-warmed
 *      DEFAULT_ROOM fallback. This bounds how many DISTINCT room worlds a client
 *      can mint, which bounds the room-world leak surface.
 *
 *   B. A room's world (generated map + entity Set + WorldState) is RECLAIMED when
 *      its last member leaves (socket/connection.js cleanup on disconnect — and
 *      the same branch in socket/lobby.js leaveRoom on a room switch). Before this
 *      fix every distinct room name leaked its world forever. DEFAULT_ROOM is the
 *      pre-warmed fallback and is intentionally NOT reclaimed.
 *
 * Invariants under test:
 *   1. Joining a valid room name creates a resident world (world.hasRoom true).
 *   2. sanitizeRoom rejects odd/over-long/empty names back to DEFAULT_ROOM and
 *      accepts well-formed ones unchanged.
 *   3. After the LAST member of a NON-default room disconnects, that room's world
 *      is reclaimed (world.hasRoom false) — driven through the REAL
 *      connection.cleanup teardown, not a hand-rolled copy.
 *   4. The DEFAULT_ROOM world is NOT reclaimed when its last member leaves.
 *   5. A non-last leave does NOT reclaim the room (a still-occupied room survives).
 *
 * Zero new deps: Node's built-in test runner over the CommonJS server modules,
 * with fake sockets + plain Maps for the membership/connectedPlayers state (no
 * live socket.io server needed).
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const config = require('../config');
const world = require('../game/world');
const lobby = require('../socket/lobby');
const connection = require('../socket/connection');

/** A minimal stand-in for a socket.io Socket: just an id + no-op room ops. */
function fakeSocket(id) {
  return { id, join() {}, leave() {}, emit() {}, on() {} };
}

/** Drive the REAL disconnect teardown for one socket against shared maps. */
function disconnect(socket, connectedPlayers, rooms) {
  connection.cleanup(socket, {
    io: { to: () => ({ emit() {} }) }, // broadcastLobbyState target; harmless no-op
    connectedPlayers,
    rooms,
    state: {},
    db: null, // bare harness: no persistence
  });
}

test('sanitizeRoom: accepts well-formed names, rejects junk back to DEFAULT_ROOM', () => {
  // Accepted: charset [a-zA-Z0-9_-], 1-32 chars, trimmed.
  assert.equal(lobby.sanitizeRoom('arena-1'), 'arena-1', 'hyphen + alnum allowed');
  assert.equal(lobby.sanitizeRoom('Room_2'), 'Room_2', 'underscore + mixed case allowed');
  assert.equal(lobby.sanitizeRoom('  spaced  '), 'spaced', 'surrounding whitespace is trimmed');
  assert.equal(lobby.sanitizeRoom('a'.repeat(32)), 'a'.repeat(32), 'exactly 32 chars allowed');

  // Rejected -> DEFAULT_ROOM.
  assert.equal(lobby.sanitizeRoom('/admin'), config.DEFAULT_ROOM, 'path-ish char rejected');
  assert.equal(lobby.sanitizeRoom('a'.repeat(33)), config.DEFAULT_ROOM, '33 chars too long');
  assert.equal(lobby.sanitizeRoom('a'.repeat(50)), config.DEFAULT_ROOM, '50 chars too long');
  assert.equal(lobby.sanitizeRoom('a b'), config.DEFAULT_ROOM, 'interior space rejected');
  assert.equal(lobby.sanitizeRoom(''), config.DEFAULT_ROOM, 'empty rejected');
  assert.equal(lobby.sanitizeRoom('   '), config.DEFAULT_ROOM, 'whitespace-only rejected');
  assert.equal(lobby.sanitizeRoom('emoji\u{1F600}'), config.DEFAULT_ROOM, 'non-ascii rejected');
  assert.equal(lobby.sanitizeRoom(null), config.DEFAULT_ROOM, 'non-string rejected');
  assert.equal(lobby.sanitizeRoom(undefined), config.DEFAULT_ROOM, 'undefined rejected');
  assert.equal(lobby.sanitizeRoom(42), config.DEFAULT_ROOM, 'number rejected');
});

test('room lifecycle: a sanitized join creates a world; last leave reclaims it (non-default only)', async () => {
  await world.loadSharedWorld();

  const ROOM = 'room-lifecycle-test-room';
  // Start from a clean slate so prior runs / the suite order can't mask the
  // create+reclaim transition.
  world.removeRoom(ROOM);
  assert.equal(world.hasRoom(ROOM), false, 'precondition: room world not resident yet');

  try {
    // --- (1) the sanitized name materializes a resident world ----------------
    const room = lobby.sanitizeRoom(ROOM);
    assert.equal(room, ROOM, 'a well-formed name passes through unchanged');
    world.getOrCreateRoomWorld(room); // what lobby:join does after sanitize
    assert.equal(world.hasRoom(ROOM), true, 'joining a valid room creates its world');

    // --- (5) a non-last leave keeps the room resident ------------------------
    const connectedPlayers = new Map();
    const rooms = new Map([[ROOM, new Set(['sockA', 'sockB'])]]);
    connectedPlayers.set('sockA', { id: 'pA', room: ROOM });
    connectedPlayers.set('sockB', { id: 'pB', room: ROOM });

    disconnect(fakeSocket('sockA'), connectedPlayers, rooms);
    assert.equal(rooms.get(ROOM).size, 1, 'one member remains after the first leave');
    assert.equal(world.hasRoom(ROOM), true, 'a still-occupied room is NOT reclaimed');

    // --- (3) the LAST leave reclaims the (non-default) room world ------------
    disconnect(fakeSocket('sockB'), connectedPlayers, rooms);
    assert.equal(rooms.has(ROOM), false, 'membership entry dropped when the room empties');
    assert.equal(world.hasRoom(ROOM), false, 'the empty room world is reclaimed (no leak)');
  } finally {
    world.removeRoom(ROOM);
  }
});

test('room lifecycle: the pre-warmed DEFAULT_ROOM world is NOT reclaimed on empty', async () => {
  await world.loadSharedWorld();

  const DEFAULT = config.DEFAULT_ROOM;
  // Ensure the default world is resident (the engine pre-warms it at init; create
  // it here so the test stands alone without the full engine boot).
  world.getOrCreateRoomWorld(DEFAULT);
  assert.equal(world.hasRoom(DEFAULT), true, 'precondition: default world resident');

  const connectedPlayers = new Map();
  const rooms = new Map([[DEFAULT, new Set(['sockOnly'])]]);
  connectedPlayers.set('sockOnly', { id: 'pOnly', room: DEFAULT });

  // The last member of DEFAULT_ROOM leaves.
  disconnect(fakeSocket('sockOnly'), connectedPlayers, rooms);

  assert.equal(rooms.has(DEFAULT), false, 'membership entry dropped when default empties');
  assert.equal(
    world.hasRoom(DEFAULT),
    true,
    'DEFAULT_ROOM stays resident — it is the pre-warmed fallback, not reclaimed',
  );
});
