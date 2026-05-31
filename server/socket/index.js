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

const auth = require('./auth');
const lobby = require('./lobby');
const connection = require('./connection');
const leaderboard = require('./leaderboard');
const chat = require('./chat');

module.exports = function initSockets(io, db) {
  // Shared, server-wide state.
  const connectedPlayers = new Map(); // socketId -> player
  const rooms = new Map();             // roomName -> Set<socketId>

  io.on('connection', (socket) => {
    // Per-socket closure state. Handlers read/write {playerId, room, name} and,
    // once authenticated, {userId, username, token, desiredSpecies, joinedAt}.
    const state = { playerId: null, room: null, name: null };

    const deps = {
      io,
      socket,
      connectedPlayers,
      rooms,
      state,
      db
    };

    // Register modular handlers. Auth first so an authenticated identity is on
    // `state` before lobby:join arrives (the client auths before joining).
    auth.register(socket, deps);
    lobby.register(socket, deps);
    connection.register(socket, deps);
    // Leaderboard: on-demand ranking query; reads `state.userId` for the asker's
    // own row, so it's registered after auth (which populates it).
    leaderboard.register(socket, deps);
    // Chat: room-wide text chat; reads the socket's player record (set by lobby) for
    // the authoritative sender identity, so it's registered after lobby.
    chat.register(socket, deps);
  });

  // Public API for external modules (engine.js reads these maps).
  return { io, connectedPlayers, rooms };
};
