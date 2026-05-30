'use strict';

/**
 * Connection handler — transport-level concerns.
 * Events: ping (latency echo), disconnect (cleanup).
 */

const { broadcastLobbyState } = require('./lobby');
const follow = require('../game/follow');
const { limiter } = require('./rate-limit');

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
    cleanup(socket, { io, connectedPlayers, rooms, state, db: deps.db });
  });
}

/**
 * Remove a socket's player from global state and its room, then refresh the
 * room's lobby view. Safe to call even if the socket never joined a room.
 */
function cleanup(socket, deps) {
  const { io, connectedPlayers, rooms, state, db } = deps;

  const player = connectedPlayers.get(socket.id);
  connectedPlayers.delete(socket.id);

  // Free this socket's rate-limiter buckets so limiter state can't grow
  // unboundedly across reconnects (socket.id is unique per connection).
  limiter.drop(socket.id);

  // Persist this session's stats before dropping the player. Attribute play time
  // (session length) plus any stat deltas the engine hadn't yet flushed this
  // tick. Guarded: only an authenticated player (userId) has an account to
  // credit, and db may be absent in a bare test harness.
  if (db && player && player.userId) {
    const joinedAt = (state && state.joinedAt) || Date.now();
    const playSeconds = Math.max(0, Math.round((Date.now() - joinedAt) / 1000));
    // Flush the session: play time plus whatever the engine hadn't yet flushed
    // this tick. Spread the full accumulator (owned by game/stats-delta.js — all
    // counters, including the new food/steal/quest scalars AND the by-species
    // escapes map) so a disconnect mid-session never silently drops a stat.
    // db.incStats handles each key (the scalars via +=, escapesBySpecies via a
    // JSON read-modify-write) and ignores the rest.
    const delta = { ...(player.statsDelta || {}), playSeconds };
    player.statsDelta = null;
    db.incStats(player.userId, delta);
  }

  if (player && player.room) {
    // Animal collection: free any animals this player was leading so they revert to
    // idle drift instead of chasing a disconnected ghost. Done before the room
    // membership teardown, while the player + room are still resolvable. (The
    // per-tick stepFollowers backstop also catches this, but doing it here frees
    // them the same tick rather than on the next follower step.)
    follow.releaseFollowersOf(player.room, player.id);

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
