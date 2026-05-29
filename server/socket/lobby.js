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

// The verbs `input` may carry. 'interact' (use a terminal / stand down a robot),
// 'order' (Second-Law command), 'ability' (species power — Phase 4 stub).
const ACTIONS = new Set(['interact', 'order', 'ability']);

// Per-room monotonic join counter, used to deterministically spread spawns so
// that ~20 players don't all stack on the origin. Survives leaves (it only
// climbs) so concurrent joiners never share a spawn slot.
const joinCountByRoom = new Map();

// The species roster. A joining player is assigned one by join index (cycling),
// reusing the same monotonic counter that spreads spawns. Species drives the
// player's edge-triggered 'ability' (see game/stealth.js applyAction):
//   ape → carry (disguise courier)   bird → flit (briefly uncatchable)
//   rat → skitter (briefly unseen)    elephant → shove (stun + push a robot)
const SPECIES_ROSTER = ['ape', 'bird', 'rat', 'elephant'];

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

    // Deterministically spread spawns so players don't all stack on the origin,
    // and assign a species off the same join index so the roster cycles evenly.
    const joinIndex = joinCountByRoom.get(room) || 0;
    joinCountByRoom.set(room, joinIndex + 1);
    const spawn = spawnPositionFor(joinIndex);
    const species = SPECIES_ROSTER[joinIndex % SPECIES_ROSTER.length];

    // Create / reset the player as a fresh movable point at its spawn slot.
    const player = {
      id: uuidv4(),
      socketId: socket.id,
      room,
      name,
      x: spawn.x,
      y: spawn.y,
      kind: 'animal',
      // Which species this player is — drives the edge-triggered 'ability'.
      species,
      // Three-Laws stealth state (Phase 2). humanLikeness rises while behaving
      // human (slow/still) and drops while fleeing; carrying the disguise prop
      // floors it. Both start blank — a fresh "animal" reads as pure prey.
      humanLikeness: 0,
      carrying: false,
      // Species-ability timers (Phase 4). Each is a tick deadline; an effect is
      // active while currentTick < the field. Read with `|| 0` so unset = off.
      flitUntilTick: 0,       // bird: briefly uncatchable
      skitterUntilTick: 0,    // rat: briefly invisible to robot perception
      inputSeq: 0,            // highest seq the client has sent
      lastProcessedSeq: 0,    // highest seq the engine has simulated
      input: { seq: 0, dx: 0, dy: 0 },
      // Latched one-shot action awaiting the next engine tick. Kept OUTSIDE
      // `input` so a later action-less movement frame can't clobber it before
      // the engine reads it (client send rate and tick rate are both ~20Hz but
      // not phase-locked, so without a latch an order frame races and is lost).
      pendingAction: null
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

    // Optional one-shot action carried alongside movement (Phase 2). Only the
    // three known verbs are accepted. We LATCH it onto player.pendingAction
    // rather than into `input`, so that a subsequent action-less movement frame
    // arriving before the next engine tick can't overwrite (drop) it. The
    // engine consumes and clears pendingAction once per tick. A frame that
    // carries no action leaves any already-latched action intact.
    const action = ACTIONS.has(payload.action) ? payload.action : null;
    if (action) player.pendingAction = action;

    // Sprint (Shift): full speed but reads as fleeing prey. Default = walk.
    const sprint = payload.sprint === true;

    player.inputSeq = seq;
    player.input = { seq, dx, dy, sprint };
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
