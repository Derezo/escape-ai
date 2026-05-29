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
const speciesRoster = require('./species-roster');

const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, n));

// The verbs `input` may carry. 'interact' (use a terminal / stand down a robot),
// 'order' (Second-Law command), 'ability' (species power — Phase 4 stub).
const ACTIONS = new Set(['interact', 'order', 'ability']);

// Per-room monotonic join counter, used to deterministically spread spawns so
// that ~20 players don't all stack on the origin. Survives leaves (it only
// climbs) so concurrent joiners never share a spawn slot.
const joinCountByRoom = new Map();

// The species roster is the ONE source of truth in shared/src/species.ts; the
// server reads the cached keys via ./species-roster (loaded at boot). A joining
// player WITHOUT an explicit species pick is assigned one by join index
// (cycling), reusing the same monotonic counter that spreads spawns. Species
// drives the player's edge-triggered 'ability' (see game/stealth.js applyAbility
// and the per-species blurbs in shared/src/species.ts). Fallback list is used
// only on the (impossible-in-practice) chance the roster cache hasn't warmed.
const SPECIES_FALLBACK = ['ape'];

/** The roster keys in cycle order — shared cache, with a 1-element fallback. */
function speciesRosterKeys() {
  const keys = speciesRoster.getKeys();
  return keys.length ? keys : SPECIES_FALLBACK;
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

    // Identity: an authenticated socket's username (set by auth.js on auth:login)
    // is authoritative — it overrides whatever name the payload carries. An
    // un-authed client (legacy / never sent auth:login) falls back to the payload
    // name so nothing breaks. The real client always auths first.
    const name = state.username
      ? state.username
      : (typeof payload.name === 'string' && payload.name.trim()
        ? payload.name.trim().slice(0, 32)
        : 'anon');

    // If this socket was already in a room, leave it first.
    const existing = connectedPlayers.get(socket.id);
    if (existing && existing.room && existing.room !== room) {
      leaveRoom(socket, connectedPlayers, rooms, existing.room);
    }

    // Ensure the room's world (generated map + entities + WorldState) exists
    // before the first player starts receiving snapshots for it.
    world.getOrCreateRoomWorld(room);

    // Deterministically spread spawns over the MAP's spawn points (just inside
    // the gate) so players don't all stack on one tile. The per-room join counter
    // (climbs across leaves) keeps concurrent joiners off the same slot; we cycle
    // through the spawns list by join index.
    const joinIndex = joinCountByRoom.get(room) || 0;
    joinCountByRoom.set(room, joinIndex + 1);
    const rm = world.getRoomMap(room);
    const spawn = rm.spawns.length
      ? rm.spawns[joinIndex % rm.spawns.length]
      : { x: 50, y: 50 };

    // Species: honor the player's pick (payload.species, or the one stashed at
    // auth time) when it's a valid playable species; otherwise assign one off the
    // join index so the shared roster cycles evenly.
    const roster = speciesRosterKeys();
    const pick = typeof payload.species === 'string' ? payload.species : state.desiredSpecies;
    const species = speciesRoster.isPlayableSpecies(pick)
      ? pick
      : roster[joinIndex % roster.length];

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
      // The authenticated account this player belongs to (null if un-authed), so
      // the engine / disconnect can attribute persistent stats. See db.js.
      userId: state.userId || null,
      // Per-player stat-delta accumulator (escapes/caught/orders/abilities). The
      // game math (stealth.js) bumps these on the rare edge ticks; the engine
      // flushes a non-empty delta to the DB and zeroes it. Created lazily there.
      statsDelta: null,
      // Three-Laws stealth state (Phase 2). humanLikeness rises while behaving
      // human (slow/still) and drops while fleeing; carrying the disguise prop
      // floors it. Both start blank — a fresh "animal" reads as pure prey.
      humanLikeness: 0,
      carrying: false,
      // 8-way facing for the directional sprite; updated each tick from input.
      facing: 's',
      // Species-ability timers. Each is a tick deadline; an effect is active
      // while currentTick < the field. Read with `|| 0` so unset = off.
      flitUntilTick: 0,       // bird flit + kangaroo leap: briefly uncatchable
      skitterUntilTick: 0,    // rat skitter + mole burrow: invisible to perception
      cloakUntilTick: 0,      // chameleon: humanLikeness floored to 1
      dashUntilTick: 0,       // cheetah: speed-burst multiplier
      shellUntilTick: 0,      // tortoise: immovable + uncatchable + likeness held
      abilityCdUntilTick: 0,  // generic per-ability cooldown gate
      fx: null,               // active ability-effect echo for the client FX layer
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

    // Ship the room's map SEED (not the tiles) to the joining socket only, so it
    // regenerates the identical tilemap via the shared generateWorld(seed) for
    // rendering AND collision-aware prediction. The server owns the seed
    // (seedFromString(room)); the client never computes it, so there's no parity
    // risk on the seed itself. The event name is the literal 'map' (matches
    // SERVER_EVENTS.MAP in shared/src/net.ts; the server is CJS so we don't import
    // the ESM net module). Payload shape mirrors MapMsg {seed, version, tile, w, h}.
    socket.emit('map', world.getMapMeta(room));

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
