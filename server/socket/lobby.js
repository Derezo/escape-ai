'use strict';

/**
 * Lobby + input handler.
 * Events: lobby:join {room, name}, input {seq, dx, dy}
 *
 * A "player" is the game-agnostic synced entity: a movable point. The engine
 * reads `player.input` each tick and integrates it into `player.x/y`.
 */

const { v4: uuidv4 } = require('uuid');
const { CLIENT_EVENTS, SERVER_EVENTS } = require('../../shared/dist/net.js');
const world = require('../game/world');
const quests = require('../game/quests');
const follow = require('../game/follow');
const session = require('../game/session');
const engine = require('../game/engine');
const config = require('../config');
const speciesRoster = require('./species-roster');
const { limiter } = require('./rate-limit');

// Seconds → ticks for the post-restore grace window (TICK_RATE Hz, default 20).
const secsToTicks = (secs) => Math.max(0, Math.round(secs * (config.TICK_RATE || 20)));

const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, n));

// The verbs `input` may carry. 'interact' (use a terminal / collect food), 'order'
// (Second-Law command), 'ability' (species power), 'feed' (give an animal its liked
// food so it follows you — the animal-collection verb).
const ACTIONS = new Set(['interact', 'order', 'ability', 'feed']);

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

// Room names are attacker-controlled (client-supplied on lobby:join) and each
// DISTINCT name allocates a full room world (generated map + entity Set +
// WorldState) in world.js. We constrain the name to a safe charset + bounded
// length so a client can't (a) mint unbounded distinct rooms with junk strings
// to grow the room-world leak surface, or (b) smuggle odd chars (paths, spaces,
// control bytes) into logs / room keys. Anything that doesn't match falls back
// to the pre-warmed DEFAULT_ROOM. Pure + exported so it's unit-testable without
// a live socket.
const ROOM_NAME_RE = /^[a-zA-Z0-9_-]{1,32}$/;
function sanitizeRoom(raw) {
  if (typeof raw !== 'string') return config.DEFAULT_ROOM;
  const trimmed = raw.trim();
  return ROOM_NAME_RE.test(trimmed) ? trimmed : config.DEFAULT_ROOM;
}

/**
 * @param {import('socket.io').Socket} socket
 * @param {object} deps  shared dependencies (see socket/index.js)
 */
function register(socket, deps) {
  const { io, connectedPlayers, rooms, state } = deps;

  socket.on(CLIENT_EVENTS.LOBBY_JOIN, (payload = {}) => {
    // Rate-limit (coarse): lobby:join is rare; an over-rate join is dropped with
    // no state change (no room churn, no extra spawn). The client may retry.
    if (!limiter.allow(socket.id, 'lobby:join')) return;

    // Validate + clamp the client-supplied room name (see sanitizeRoom): a safe
    // charset, 1–32 chars, else the pre-warmed DEFAULT_ROOM fallback.
    const room = sanitizeRoom(payload.room);

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

    // Per-room join counter (climbs across leaves) — used to cycle the species
    // roster evenly for un-picked joiners.
    const joinIndex = joinCountByRoom.get(room) || 0;
    joinCountByRoom.set(room, joinIndex + 1);

    // RESUME: a returning player with a saved mid-run session for THIS room at a
    // matching worldVersion resumes their CURRENT species (and is restored to its
    // position/quest/inventory/score below). The version guard (session.isUsableFor)
    // means a worldgen bump cleanly degrades to a fresh pen spawn for the saved
    // species rather than stranding the avatar in a relocated wall.
    const savedSession = state.session;
    const resuming = session.isUsableFor(savedSession, room);

    // Species: a usable saved session wins (resume the reborn species); else honor
    // the player's pick (payload.species, or the one stashed at auth time) when
    // valid; else assign one off the join index so the shared roster cycles evenly.
    const roster = speciesRosterKeys();
    const savedSpecies =
      savedSession && speciesRoster.isPlayableSpecies(savedSession.species)
        ? savedSession.species
        : undefined;
    const pick = typeof payload.species === 'string' ? payload.species : state.desiredSpecies;
    const species = savedSpecies
      ? savedSpecies
      : (speciesRoster.isPlayableSpecies(pick) ? pick : roster[joinIndex % roster.length]);

    // Spawn the player in their OWN species' pen (with a stable per-player jitter),
    // NOT the gate-side block — the gate is where robots patrol, and spawning there
    // could drop the player onto a robot and chain-catch them. Resolved AFTER the
    // species above so the pen matches the avatar. (A post-spawn grace window —
    // player.spawnSafeUntilTick below — is the second guard against re-catch.) A
    // resuming player's exact x/y is restored from the snapshot AFTER creation.
    const playerId = uuidv4();
    const spawn = world.spawnForSpecies(room, species, playerId);

    // Create / reset the player as a fresh movable point at its spawn slot.
    const player = {
      // Reuse the id generated above (the spawn jitter is keyed to it).
      id: playerId,
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
      // Post-respawn catch-immunity deadline (set by stealth.catchPlayer /
      // respawnPlayer). 0 at join — the pen spawn is robot-free, so no join grace
      // is needed; it guards the catch→respawn→catch chain.
      spawnSafeUntilTick: 0,
      // Start of the current run for escape-time-by-species (spawn→gate timing).
      // Stamped to the live tick below (join and resume both start the clock now);
      // re-stamped on every respawn (stealth.respawnPlayer).
      spawnedAtTick: 0,
      fx: null,               // active ability-effect echo for the client FX layer
      inputSeq: 0,            // highest seq the client has sent
      lastProcessedSeq: 0,    // highest seq the engine has simulated
      input: { seq: 0, dx: 0, dy: 0 },
      // Latched one-shot action awaiting the next engine tick. Kept OUTSIDE
      // `input` so a later action-less movement frame can't clobber it before
      // the engine reads it (client send rate and tick rate are both ~20Hz but
      // not phase-locked, so without a latch an order frame races and is lost).
      pendingAction: null,
      // Phase 6 per-species side-quest: each animal must complete its quest
      // before the gate will let it out. Initialized below from the shared quest
      // model (quests.initPlayer sets player.quest + questTerminals + questBlocked).
      quest: null,
      questTerminals: null,
      questBlocked: 0,
      // Animal collection: the player's food bag (foodKey → count), filled by
      // collecting at food sources and spent by feeding animals. (Re)initialized
      // below by follow.initPlayer; declared here so the shape is documented.
      inventory: {},
      // The running round score + the last gate award (a one-shot client toast).
      scoreTotal: 0,
      lastScore: null
    };
    // Derive the quest for this player's species (reach/fetch/activate). Done
    // AFTER the species is resolved above, so the quest matches the avatar.
    quests.initPlayer(player);
    // Initialize the food bag (empty) for the animal-collection loop.
    follow.initPlayer(player);

    // RESUME: overlay the saved mid-run state onto the fresh player — exact x/y,
    // quest progress (incl. the tapped-terminal Set), inventory, and running score
    // — so the rejoin drops back in where it left off rather than at the pen spawn.
    // Then stamp the post-spawn catch-immunity grace (same guard catchPlayer uses)
    // so restoring near the gate/robots can't instantly re-catch the player. Only
    // runs when the snapshot is version-matched for this room (else the fresh pen
    // spawn above stands). The session is consumed once (cleared) so a later
    // re-join in the same socket session doesn't re-apply a stale snapshot.
    if (resuming) {
      session.restore(player, savedSession);
      player.spawnSafeUntilTick = engine.getCurrentTick() + secsToTicks(config.SPAWN_GRACE_SECS);
      state.session = null;
    }
    // Start this run's escape-time clock at the live tick (fresh spawn AND resume —
    // a resumed player's spawn→gate time is measured from the rejoin, not the
    // original spawn). Re-stamped on every later respawn (stealth.respawnPlayer).
    player.spawnedAtTick = engine.getCurrentTick();
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
    // risk on the seed itself. The event name is SERVER_EVENTS.MAP, imported from
    // the shared net contract (the same constant the client subscribes to).
    // Payload shape mirrors MapMsg {seed, version, tile, w, h}.
    socket.emit(SERVER_EVENTS.MAP, world.getMapMeta(room));

    // Immediately seed this socket with a ONE-TIME full snapshot (all players +
    // all static world props), so a player joining an already-populated room sees
    // the whole world at once instead of waiting up to FULL_REFRESH_INTERVAL ticks
    // (~5s) for the next room-wide full refresh — the "lag before spawn". Emitted
    // AFTER the map so the client has the seed to regenerate the world before it
    // places these entities (Socket.IO preserves per-socket emit order). This is
    // read-only on sim state and does NOT disturb the room's delta memory.
    engine.sendFullSnapshotTo(socket, room);

    broadcastLobbyState(io, connectedPlayers, rooms, room);
  });

  socket.on(CLIENT_EVENTS.INPUT, (payload = {}) => {
    // Rate-limit (tight but generous): the legit input stream is ~20 Hz; the cap
    // sustains 40/sec with a 60-packet burst, so normal play is never throttled
    // and only a pathological flood is shed. A dropped frame is safe — the engine
    // keeps the last good input until the next accepted frame arrives.
    if (!limiter.allow(socket.id, 'input')) return;

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
  if (members.size === 0) {
    rooms.delete(room);
    // Reclaim the room's world (generated map + entity Set + WorldState) once the
    // last member leaves — the engine's tick/snapshot loops iterate `rooms`, not
    // roomWorlds, so removing it the same beat as the membership entry is safe (no
    // tick resurrects it mid-step). DEFAULT_ROOM is the pre-warmed fallback; keep
    // it resident to avoid regenerate-churn on every lobby cycle.
    if (room !== config.DEFAULT_ROOM) world.removeRoom(room);
  }
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

  io.to(room).emit(SERVER_EVENTS.LOBBY_STATE, { players });
}

module.exports = { register, broadcastLobbyState, sanitizeRoom };
