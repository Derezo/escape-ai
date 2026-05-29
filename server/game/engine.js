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
 *   3. broadcast `snapshot {tick, entities, acks, world}` to each room
 *
 * Entities are players merged with the room's static world props (pens, robots,
 * idle animals, terminals, the gate — owned by game/world.js). The WorldState
 * {panic, panicCapacity, lockdown} rides along on every snapshot; it's tiny.
 *
 * Delta vs. full broadcast:
 *   - Every FULL_REFRESH_INTERVAL ticks we send a *full* snapshot (every entity
 *     in the room) so late joiners and drifted clients resync.
 *   - On other ticks we send a *delta*: only entities whose serialized state
 *     changed since the last snapshot sent to that room. Static props don't
 *     change, so they only ride on full refreshes — which is what we want.
 *   Correctness over cleverness — the delta is a simple per-entity dirty check.
 */

const config = require('../config');
const world = require('./world');
const stealth = require('./stealth');

/** Clamp a coordinate into the zoo bounds [0, WORLD_MAX]. */
function clampWorld(v) {
  return v < 0 ? 0 : v > config.WORLD_MAX ? config.WORLD_MAX : v;
}

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
 * Wire up the engine. Call once at boot, before start(). ASYNC because it loads
 * the deterministic Three-Laws math from shared/dist/step.js (ESM) via dynamic
 * import() and caches it — that must resolve before the first synchronous tick,
 * so index.js `await`s this before calling start().
 * @param {import('socket.io').Server} socketIo
 * @param {Map<string, object>} players  shared connectedPlayers map
 * @param {Map<string, Set<string>>} roomsMap  shared rooms map
 */
async function init(socketIo, players, roomsMap) {
  io = socketIo;
  connectedPlayers = players;
  rooms = roomsMap;
  // Hand the live player + room maps to the stealth orchestrator so its ability
  // hooks (e.g. the ape carry hand-off) can scan a room from applyAction.
  stealth.setRefs(players, roomsMap);
  // Load + cache the shared stealth math once, before the loop runs.
  await stealth.loadShared();
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
    stepNpcs(dt);
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

/** Apply each player's latest input to its position, advance its stealth state,
 *  and fire any one-shot action it carried this tick. */
function integratePlayers(dt) {
  if (!connectedPlayers) return;

  for (const player of connectedPlayers.values()) {
    const input = player.input;
    if (!input) continue;

    const dx = input.dx || 0;
    const dy = input.dy || 0;

    if (dx !== 0 || dy !== 0) {
      const speed = stealth.moveSpeed(input.sprint);
      player.x += dx * speed * dt;
      player.y += dy * speed * dt;
      // Keep players inside the zoo (0..WORLD_MAX). The gate is the only way out
      // (see checkEscape); without this they could just walk off the map.
      player.x = clampWorld(player.x);
      player.y = clampWorld(player.y);
    }

    // Three-Laws stealth: how this tick's movement reads to a robot (still =
    // human, fleeing = prey). All math lives in shared; we just feed it speed.
    stealth.stepPlayerHumanLikeness(player, dt);

    // Win check: a player who reaches the perimeter gate has escaped.
    stealth.checkEscape(player, player.room);

    // Consume the latched one-shot action (order / interact / ability), if any.
    // Cleared immediately so it fires once per press; lobby.js latches it onto
    // pendingAction so an action-less movement frame can't drop it pre-tick.
    if (player.pendingAction) {
      stealth.applyAction(player, player.pendingAction, player.room, currentTick);
      player.pendingAction = null;
    }

    // Record the last input sequence we've now simulated, so the snapshot's
    // `acks` lets clients reconcile their prediction.
    player.lastProcessedSeq = input.seq;
  }
}

/** Step the NPC simulation (robots) + the panic/overflow meter for every active
 *  room. Robots move and change mode every tick, so they ride the per-tick delta
 *  diff; the panic meter rides the snapshot's `world` field. */
function stepNpcs(dt) {
  if (!rooms || !stealth.isReady()) return;

  for (const [roomName, socketIds] of rooms) {
    if (!socketIds || socketIds.size === 0) continue;
    const robotEvents = stealth.stepRobots(dt, roomName, connectedPlayers, rooms, currentTick);
    const { enteredLockdown, liftedLockdown } = stealth.stepPanic(dt, roomName, robotEvents);
    // Lockdown transitions are rare and operationally interesting — log them.
    if (enteredLockdown) console.log(`[engine] room "${roomName}" → LOCKDOWN (panic overflowed)`);
    if (liftedLockdown) console.log(`[engine] room "${roomName}" lockdown lifted (panic drained)`);
  }
}

/** Serialize one player into a snapshot entity. Players are tagged 'animal' so
 *  the client can render them alongside the world's idle animals. humanLikeness
 *  and carrying ride along so the client can show stealth feedback (the bar /
 *  prop indicator). Robots serialize their mode/suspicion straight from the
 *  world entity objects, which stealth.stepRobots mutates in place each tick. */
function toEntity(player) {
  return {
    id: player.id,
    x: player.x,
    y: player.y,
    name: player.name,
    kind: 'animal',
    // Species rides along so the client can skin the avatar + label its ability.
    species: player.species,
    humanLikeness: player.humanLikeness || 0,
    carrying: !!player.carrying,
    // Sticky win flag — the client shows a victory state for escaped players.
    escaped: !!player.escaped
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

    // Per-entity dirty check shared by players and world props.
    const diffEntity = (entity) => {
      seenIds.add(entity.id);
      const serialized = JSON.stringify(entity);
      if (isFull || lastSent.get(entity.id) !== serialized) {
        entities.push(entity);
        lastSent.set(entity.id, serialized);
      }
    };

    for (const socketId of socketIds) {
      const player = connectedPlayers.get(socketId);
      if (!player) continue;

      const entity = toEntity(player);
      acks[entity.id] = player.lastProcessedSeq || 0;
      diffEntity(entity);
    }

    // Merge in the room's static world props. They never change, so they only
    // ride on full refreshes — no per-tick bandwidth cost.
    for (const entity of world.getWorldEntities(roomName)) {
      diffEntity(entity);
    }

    // Drop delta-memory for entities that left the room.
    for (const id of lastSent.keys()) {
      if (!seenIds.has(id)) lastSent.delete(id);
    }

    // On a delta tick with nothing changed, still send a heartbeat so clients
    // keep advancing their tick clock and receive fresh acks. The WorldState
    // rides along every tick — it's tiny — so the client always has it fresh.
    io.to(roomName).emit('snapshot', {
      tick: currentTick,
      entities,
      acks,
      world: world.getWorldState(roomName)
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
