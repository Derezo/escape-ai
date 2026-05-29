'use strict';

/**
 * Socket orchestrator (dependency-injection style, lifted from galaxy-miner).
 *
 * Owns the shared multiplayer state and wires it into every per-socket handler:
 *   - connectedPlayers: Map<socketId, player>   the synced movable points
 *   - rooms:            Map<roomName, Set<socketId>>  membership per room
 *
 * On each connection we build a `deps` bundle (io, socket, shared maps, and a
 * per-socket `state` closure for {playerId, room, name}) and hand it to the
 * modular handlers. The returned object exposes the shared maps so the engine
 * can read them.
 */

const lobby = require('./lobby');
const connection = require('./connection');

module.exports = function initSockets(io) {
  // Shared, server-wide state.
  const connectedPlayers = new Map(); // socketId -> player
  const rooms = new Map();             // roomName -> Set<socketId>

  io.on('connection', (socket) => {
    // Per-socket closure state. Handlers read/write {playerId, room, name}.
    const state = { playerId: null, room: null, name: null };

    const deps = {
      io,
      socket,
      connectedPlayers,
      rooms,
      state
    };

    // Register modular handlers.
    lobby.register(socket, deps);
    connection.register(socket, deps);
  });

  // Public API for external modules (engine.js reads these maps).
  return { io, connectedPlayers, rooms };
};
