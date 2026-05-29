'use strict';

/**
 * Connection handler — transport-level concerns.
 * Events: ping (latency echo), disconnect (cleanup).
 */

const { broadcastLobbyState } = require('./lobby');

/**
 * @param {import('socket.io').Socket} socket
 * @param {object} deps  shared dependencies (see socket/index.js)
 */
function register(socket, deps) {
  const { io, connectedPlayers, rooms, state } = deps;

  // Latency measurement: echo the client's timestamp straight back.
  // Contract: client emits `ping {t}`, server replies `pong {t}`.
  socket.on('ping', (payload) => {
    const t = payload && typeof payload === 'object' ? payload.t : payload;
    socket.emit('pong', { t });
  });

  socket.on('disconnect', () => {
    cleanup(socket, { io, connectedPlayers, rooms, state });
  });
}

/**
 * Remove a socket's player from global state and its room, then refresh the
 * room's lobby view. Safe to call even if the socket never joined a room.
 */
function cleanup(socket, deps) {
  const { io, connectedPlayers, rooms } = deps;

  const player = connectedPlayers.get(socket.id);
  connectedPlayers.delete(socket.id);

  if (player && player.room) {
    const members = rooms.get(player.room);
    if (members) {
      members.delete(socket.id);
      if (members.size === 0) {
        rooms.delete(player.room);
      } else {
        broadcastLobbyState(io, connectedPlayers, rooms, player.room);
      }
    }
  }
}

module.exports = { register, cleanup };
