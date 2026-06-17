'use strict';

/**
 * Connection handler — transport-level concerns.
 * Events: ping (latency echo), disconnect (cleanup).
 */

const { CLIENT_EVENTS, SERVER_EVENTS } = require('../../shared/dist/net.js');
const { broadcastLobbyState } = require('./lobby');
const follow = require('../game/follow');
const session = require('../game/session');
const world = require('../game/world');
const engine = require('../game/engine');
const config = require('../config');
const { limiter } = require('./rate-limit');

/**
 * @param {import('socket.io').Socket} socket
 * @param {object} deps  shared dependencies (see socket/index.js)
 */
function register(socket, deps) {
  const { io, connectedPlayers, rooms, state } = deps;

  // Latency measurement: echo the client's timestamp straight back.
  // Contract: client emits `ping {t}`, server replies `pong {t}` — names from the
  // shared net contract (CLIENT_EVENTS.PING / SERVER_EVENTS.PONG). 'disconnect' is
  // a socket.io built-in lifecycle event (not part of our net contract), so it
  // stays a literal.
  socket.on(CLIENT_EVENTS.PING, (payload) => {
    const t = payload && typeof payload === 'object' ? payload.t : payload;
    socket.emit(SERVER_EVENTS.PONG, { t });
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

  // Drop this socket's per-socket AOI delta memory (engine.lastSentBySocket) for
  // the same reason — socket.id is unique per connection, so a stale entry would
  // otherwise linger forever after the player leaves.
  engine.clearSocket(socket.id);

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
    // Persist the full mid-run snapshot so a rejoin resumes exactly here (species,
    // position, quest progress, food bag, score) — version-stamped so a worldgen
    // bump falls back to a clean pen spawn on restore (see socket/lobby.js).
    const snap = session.snapshot(player);
    if (snap) db.saveSession(player.userId, snap);
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
        // Reclaim the now-empty room's world (generated map + entity Set +
        // WorldState). Safe to do the same beat as the membership teardown: the
        // engine's tick/snapshot loops iterate `rooms`, not roomWorlds, so once
        // the room is dropped from `rooms` no tick will touch (or resurrect) it.
        // DEFAULT_ROOM is the pre-warmed fallback — keep it resident to avoid
        // regenerate-churn on every lobby cycle.
        if (player.room !== config.DEFAULT_ROOM) world.removeRoom(player.room);
      } else {
        broadcastLobbyState(io, connectedPlayers, rooms, player.room);
      }
    }
  }
}

module.exports = { register, cleanup };
