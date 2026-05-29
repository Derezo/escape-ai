'use strict';

/**
 * Lobby + input handler.
 * Events: lobby:join {room, name}, input {seq, dx, dy}
 *
 * A "player" is the game-agnostic synced entity: a movable point. The engine
 * reads `player.input` each tick and integrates it into `player.x/y`.
 */

const { v4: uuidv4 } = require('uuid');

const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, n));

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

    // Create / reset the player as a fresh movable point at the origin.
    const player = {
      id: uuidv4(),
      socketId: socket.id,
      room,
      name,
      x: 0,
      y: 0,
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
