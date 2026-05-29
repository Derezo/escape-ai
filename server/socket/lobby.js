'use strict';

/**
 * Lobby + input handler.
 * Events: lobby:join {room, name}, input {seq, dx, dy}
 *
 * A "player" is the game-agnostic synced entity: a movable point. The engine
 * reads `player.input` each tick and integrates it into `player.x/y`.
 */

const { v4: uuidv4 } = require('uuid');
const world = require('../game/world');

const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, n));

// Per-room monotonic join counter, used to deterministically spread spawns so
// that ~20 players don't all stack on the origin. Survives leaves (it only
// climbs) so concurrent joiners never share a spawn slot.
const joinCountByRoom = new Map();

// Spawn players on a grid in the world's lower-left corner, stepping right then
// wrapping down. Keeps them clear of the world props spawned by game/world.js.
const SPAWN_ORIGIN_X = 50;
const SPAWN_ORIGIN_Y = 50;
const SPAWN_STEP = 40;
const SPAWN_COLS = 5;

/** Deterministic spawn position for the Nth joiner of a room. */
function spawnPositionFor(joinIndex) {
  const col = joinIndex % SPAWN_COLS;
  const row = Math.floor(joinIndex / SPAWN_COLS);
  return {
    x: SPAWN_ORIGIN_X + col * SPAWN_STEP,
    y: SPAWN_ORIGIN_Y + row * SPAWN_STEP
  };
}

/**
 * @param {import('socket.io').Socket} socket
 * @param {object} deps  shared dependencies (see socket/index.js)
 */
function register(socket, deps) {
  const { io, connectedPlayers, rooms, state } = deps;

  socket.on('lobby:join', (payload = {}) => {
    const room = typeof payload.room === 'string' && payload.room.trim()
      ? payload.room.trim()
      : 'default';
    const name = typeof payload.name === 'string' && payload.name.trim()
      ? payload.name.trim().slice(0, 32)
      : 'anon';

    // If this socket was already in a room, leave it first.
    const existing = connectedPlayers.get(socket.id);
    if (existing && existing.room && existing.room !== room) {
      leaveRoom(socket, connectedPlayers, rooms, existing.room);
    }

    // Ensure the room's world (static props + WorldState) exists before the
    // first player starts receiving snapshots for it.
    world.getOrCreateRoomWorld(room);

    // Deterministically spread spawns so players don't all stack on the origin.
    const joinIndex = joinCountByRoom.get(room) || 0;
    joinCountByRoom.set(room, joinIndex + 1);
    const spawn = spawnPositionFor(joinIndex);

    // Create / reset the player as a fresh movable point at its spawn slot.
    const player = {
      id: uuidv4(),
      socketId: socket.id,
      room,
      name,
      x: spawn.x,
      y: spawn.y,
      kind: 'animal',
      inputSeq: 0,            // highest seq the client has sent
      lastProcessedSeq: 0,    // highest seq the engine has simulated
      input: { seq: 0, dx: 0, dy: 0 }
    };
    connectedPlayers.set(socket.id, player);

    // Track room membership and join the Socket.IO room for broadcasts.
    let members = rooms.get(room);
    if (!members) {
      members = new Set();
      rooms.set(room, members);
    }
    members.add(socket.id);
    socket.join(room);

    // Record the active room in this socket's closure state.
    state.room = room;
    state.playerId = player.id;
    state.name = name;

    broadcastLobbyState(io, connectedPlayers, rooms, room);
  });

  socket.on('input', (payload = {}) => {
    const player = connectedPlayers.get(socket.id);
    if (!player) return;

    const seq = Number.isFinite(payload.seq) ? payload.seq : player.inputSeq + 1;
    // Ignore stale/out-of-order inputs.
    if (seq < player.inputSeq) return;

    const dx = clamp(Number(payload.dx) || 0, -1, 1);
    const dy = clamp(Number(payload.dy) || 0, -1, 1);

    player.inputSeq = seq;
    player.input = { seq, dx, dy };
  });
}

/** Remove a socket from a room's membership set (and the room itself if empty). */
function leaveRoom(socket, connectedPlayers, rooms, room) {
  socket.leave(room);
  const members = rooms.get(room);
  if (!members) return;
  members.delete(socket.id);
  if (members.size === 0) rooms.delete(room);
}

/** Emit the current player roster of a room to everyone in that room. */
function broadcastLobbyState(io, connectedPlayers, rooms, room) {
  const members = rooms.get(room);
  if (!members) return;

  const players = [];
  for (const socketId of members) {
    const p = connectedPlayers.get(socketId);
    if (p) players.push({ id: p.id, name: p.name, x: p.x, y: p.y });
  }

  io.to(room).emit('lobby:state', { players });
}

module.exports = { register, broadcastLobbyState, leaveRoom };
