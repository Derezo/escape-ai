'use strict';

/**
 * Authoritative game engine — fixed-tick simulation loop.
 *
 * Game-agnostic: the only "gameplay" is that each player is a point that moves
 * according to its latest input. The genre-specific rules drop at hour 0; this
 * loop is the netcode skeleton they plug into.
 *
 * Each tick:
 *   1. advance currentTick
 *   2. integrate every player's latest input into its position
 *   3. broadcast `snapshot {tick, entities, acks}` to each room
 *
 * Delta vs. full broadcast:
 *   - Every FULL_REFRESH_INTERVAL ticks we send a *full* snapshot (every entity
 *     in the room) so late joiners and drifted clients resync.
 *   - On other ticks we send a *delta*: only entities whose serialized state
 *     changed since the last snapshot sent to that room.
 *   Correctness over cleverness — the delta is a simple per-entity dirty check.
 */

const config = require('../config');

// Full snapshot every N ticks (default 100 = 5s at 20Hz). Between fulls we
// send deltas containing only changed entities.
const FULL_REFRESH_INTERVAL = 100;

// --- injected dependencies (set by init) ---
let io = null;
let connectedPlayers = null; // Map<socketId, player>
let rooms = null; // Map<roomName, Set<socketId>>

// --- loop state ---
let running = false;
let currentTick = 0;
let lastTickTime = 0;
let timer = null;

// Per-room memory of the last entity state we broadcast, for delta diffing.
// Map<roomName, Map<entityId, string>> where the string is the serialized snapshot.
const lastSentByRoom = new Map();

/**
 * Wire up the engine. Call once at boot, before start().
 * @param {import('socket.io').Server} socketIo
 * @param {Map<string, object>} players  shared connectedPlayers map
 * @param {Map<string, Set<string>>} roomsMap  shared rooms map
 */
function init(socketIo, players, roomsMap) {
  io = socketIo;
  connectedPlayers = players;
  rooms = roomsMap;
}

function start() {
  if (running) return;
  running = true;
  lastTickTime = Date.now();
  tick();
}

function stop() {
  running = false;
  if (timer) {
    clearTimeout(timer);
    timer = null;
  }
}

/** The fixed-tick loop. Self-schedules to hold a steady TICK_RATE. */
function tick() {
  if (!running) return;

  currentTick++;

  const now = Date.now();
  const dt = (now - lastTickTime) / 1000; // seconds since last tick
  lastTickTime = now;

  try {
    integratePlayers(dt);
    broadcastSnapshots();
  } catch (err) {
    // Never let one bad tick kill the loop.
    console.error('[engine] tick error:', err);
  }

  // Schedule next tick, compensating for the work we just did.
  const interval = 1000 / config.TICK_RATE;
  const elapsed = Date.now() - now;
  const delay = Math.max(0, interval - elapsed);
  timer = setTimeout(tick, delay);
}

/** Apply each player's latest input to its position. */
function integratePlayers(dt) {
  if (!connectedPlayers) return;

  for (const player of connectedPlayers.values()) {
    const input = player.input;
    if (!input) continue;

    const dx = input.dx || 0;
    const dy = input.dy || 0;

    if (dx !== 0 || dy !== 0) {
      player.x += dx * config.PLAYER_SPEED * dt;
      player.y += dy * config.PLAYER_SPEED * dt;
    }

    // Record the last input sequence we've now simulated, so the snapshot's
    // `acks` lets clients reconcile their prediction.
    player.lastProcessedSeq = input.seq;
  }
}

/** Serialize one player into a snapshot entity. */
function toEntity(player) {
  return {
    id: player.id,
    x: player.x,
    y: player.y,
    name: player.name
  };
}

/** Broadcast a snapshot to every active room. */
function broadcastSnapshots() {
  if (!rooms) return;

  const isFull = currentTick % FULL_REFRESH_INTERVAL === 0;

  for (const [roomName, socketIds] of rooms) {
    if (!socketIds || socketIds.size === 0) continue;

    // Build this room's entity list + acks, and diff against what we last sent.
    let lastSent = lastSentByRoom.get(roomName);
    if (!lastSent) {
      lastSent = new Map();
      lastSentByRoom.set(roomName, lastSent);
    }

    const entities = [];
    const acks = {};
    const seenIds = new Set();

    for (const socketId of socketIds) {
      const player = connectedPlayers.get(socketId);
      if (!player) continue;

      const entity = toEntity(player);
      seenIds.add(entity.id);
      acks[entity.id] = player.lastProcessedSeq || 0;

      const serialized = JSON.stringify(entity);
      if (isFull || lastSent.get(entity.id) !== serialized) {
        entities.push(entity);
        lastSent.set(entity.id, serialized);
      }
    }

    // Drop delta-memory for entities that left the room.
    for (const id of lastSent.keys()) {
      if (!seenIds.has(id)) lastSent.delete(id);
    }

    // On a delta tick with nothing changed, still send a heartbeat so clients
    // keep advancing their tick clock and receive fresh acks.
    io.to(roomName).emit('snapshot', {
      tick: currentTick,
      entities,
      acks
    });
  }
}

module.exports = {
  init,
  start,
  stop,
  // Read-only accessors used by the /health endpoint.
  getCurrentTick: () => currentTick,
  isRunning: () => running,
  FULL_REFRESH_INTERVAL
};
