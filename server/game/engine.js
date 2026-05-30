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
const quests = require('./quests');
const follow = require('./follow');
const statsDelta = require('./stats-delta');

// Full snapshot every N ticks (default 100 = 5s at 20Hz). Between fulls we
// send deltas containing only changed entities.
const FULL_REFRESH_INTERVAL = 100;

// --- injected dependencies (set by init) ---
let io = null;
let connectedPlayers = null; // Map<socketId, player>
let rooms = null; // Map<roomName, Set<socketId>>
let db = null; // persistence layer (may be null in a bare test harness)

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
 * @param {object} [dbModule]  persistence layer (db.js); optional for tests.
 */
async function init(socketIo, players, roomsMap, dbModule) {
  io = socketIo;
  connectedPlayers = players;
  rooms = roomsMap;
  db = dbModule || null;
  // Hand the live player + room maps to the stealth orchestrator so its ability
  // hooks (e.g. the ape carry hand-off) can scan a room from applyAction.
  stealth.setRefs(players, roomsMap);
  // Same for the follow orchestrator, so stepFollowers can resolve a follower's
  // owner back to the live player object each tick. (follow.js gets the cached
  // shared math separately, via stealth.loadShared → follow.setShared.)
  follow.setRefs(players, roomsMap);
  // Load + cache the shared stealth math once, before the loop runs.
  await stealth.loadShared();
  // Load + cache the shared world generator once, before any room is created —
  // getOrCreateRoomWorld throws if a room is requested before this resolves.
  await world.loadSharedWorld();
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

    // TORTOISE "shell": immovable while shelled (it has bunkered down). Zero the
    // movement intent so position holds, but still run facing/stealth/actions.
    const shelled = (player.shellUntilTick || 0) > currentTick;
    const dx = shelled ? 0 : (input.dx || 0);
    const dy = shelled ? 0 : (input.dy || 0);

    if (dx !== 0 || dy !== 0) {
      // CHEETAH "dash": a brief speed burst while dashUntilTick is in the future.
      // Fast movement reads as fleeing prey, so humanLikeness crashes (the double
      // edge, applied by stepPlayerHumanLikeness via the shared curve).
      const dashing = (player.dashUntilTick || 0) > currentTick;
      const speed = stealth.moveSpeed(input.sprint) * (dashing ? config.ABILITY.CHEETAH_SPEED_MULT : 1);
      // Collision-aware integration: axis-separated sliding against the room's
      // tile collision grid (OOB is solid, so the perimeter wall keeps players
      // in — the gate is the only non-solid gap, see checkEscape). The shared
      // moveWithCollision math lives in step.js; stealth.js owns the cached
      // module + the room-map lookup, so we go through its wrapper.
      stealth.movePlayerWithCollision(player, dx, dy, dt, speed, player.room);
    }

    // Directional facing for sprite animation. Derived from the same authoritative
    // input axes as the move, so a player always faces where it walked; a zero
    // vector holds the last facing (shared.facingFromVec). Rides the snapshot via
    // toEntity. Cheap, deterministic, and identical to the client's prediction.
    player.facing = stealth.facingFromVec(dx, dy, player.facing || 's');

    // Three-Laws stealth: how this tick's movement reads to a robot (still =
    // human, fleeing = prey). All math lives in shared; we just feed it speed.
    // currentTick lets it honor timed effects (chameleon cloak, tortoise shell).
    stealth.stepPlayerHumanLikeness(player, dt, currentTick);

    // Phase 6 side-quest progress: a 'reach' quest completes when the player
    // stands on its own species' home (questObject) tile. Run BEFORE checkEscape
    // so arriving home and reaching the gate the same tick still escapes. No-op
    // for fetch/activate quests (those advance at the gate / on interact).
    if (player.quest && !player.quest.complete) {
      quests.stepReach(player, player.room);
    }

    // Win + respawn lifecycle: reaching the gate escapes (shows the banner);
    // after a brief celebration the player respawns as a fresh animal. The gate
    // is GATED on quest completion (stealth.checkEscape).
    stealth.checkEscape(player, player.room, currentTick);

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

    // Persist any accumulated stat deltas (escapes/caught/orders/abilities) so a
    // session's stats survive even without a disconnect, and an escape is
    // recorded promptly. The deltas are zero on the vast majority of ticks (they
    // only fill on the rare edge tick where an event fired), so this is naturally
    // edge-driven — NO per-tick DB write in the common case. Guarded for tests.
    flushStatsDelta(player);
  }
}

/**
 * Flush a player's pending stat delta to the DB and zero it. No-op unless the
 * player has an account (userId), the DB is wired, and the delta is non-empty —
 * so the hot path stays free of DB writes except on event-edge ticks. The delta
 * shape (which counters exist, what "non-empty" means, and how to zero it) is
 * owned by game/stats-delta.js so this path can never drift out of sync with the
 * bump sites.
 * @param {object} player
 */
function flushStatsDelta(player) {
  if (!db || !player.userId) return;
  const delta = player.statsDelta;
  if (!statsDelta.hasAny(delta)) return;
  db.incStats(player.userId, delta);
  statsDelta.reset(delta);
}

/** Step the NPC simulation (robots) + the panic/overflow meter for every active
 *  room. Robots move and change mode every tick, so they ride the per-tick delta
 *  diff; the panic meter rides the snapshot's `world` field. */
function stepNpcs(dt) {
  if (!rooms || !stealth.isReady()) return;

  for (const [roomName, socketIds] of rooms) {
    if (!socketIds || socketIds.size === 0) continue;
    // Sweep expired temporary entities (skunk hazards, fox decoys) before anyone
    // perceives them this tick, so a lapsed effect stops influencing the sim.
    world.pruneExpired(roomName, currentTick);
    // Drift the idle decoy animals first so robots perceive them at this tick's
    // positions (no one-tick lag) when stepRobots runs its Three-Laws decision.
    // stepIdleAnimals SKIPS active followers (follow.isFollower) so they aren't
    // double-moved by the follower step that runs next.
    stealth.stepIdleAnimals(dt, roomName, currentTick);
    // Move every active follower one step toward its owner (and release lapsed /
    // owner-gone ones). MUST run after stepIdleAnimals (which skipped them) and
    // before stepRobots (so robots perceive followers at this tick's positions).
    follow.stepFollowers(dt, roomName, currentTick);
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
 *  world entity objects, which stealth.stepRobots mutates in place each tick.
 *
 *  `facing` rides along for directional sprite animation; `fx` is the render-echo
 *  of an active ability effect (set by the ability handlers in stealth.js),
 *  forwarded only while still live so a stale effect doesn't re-trigger FX. Both
 *  are plain JSON, so they ride the snapshot's existing delta diff. */
function toEntity(player) {
  const entity = {
    id: player.id,
    x: player.x,
    y: player.y,
    name: player.name,
    kind: 'animal',
    // Species rides along so the client can skin the avatar + label its ability.
    species: player.species,
    humanLikeness: player.humanLikeness || 0,
    carrying: !!player.carrying,
    // 8-way facing for the directional sprite (held facing when standing still).
    facing: player.facing || 's',
    // Sticky win flag — the client shows a victory state for escaped players.
    escaped: !!player.escaped
  };
  // Forward an active ability effect echo (one-shot + sustained FX on any client).
  if (player.fx && player.fx.untilTick >= currentTick) {
    entity.fx = player.fx;
  }
  // Phase 6: forward the player's side-quest so the client HUD can surface it.
  // Plain JSON ({type,title,blurb,done,need,complete}) → rides the delta diff.
  // questBlocked is the last tick this player brushed the gate WITHOUT a complete
  // quest, so the client can flash a "finish your quest" hint near the gate.
  if (player.quest) {
    entity.quest = player.quest;
    if (player.questBlocked) entity.questBlocked = player.questBlocked;
  }
  // Animal collection: the player's food bag rides its OWN entity so the client
  // inventory overlay reads it. Forward it UNCONDITIONALLY (even when empty {}) so
  // a catch/respawn that clears the bag actually clears the client UI — an absent
  // field on a delta would leave the client showing stale food.
  if (player.inventory) entity.inventory = player.inventory;
  // The gate award (a one-shot client toast) rides along only while escaped; the
  // running total rides whenever non-zero. Both are plain JSON on the delta diff.
  if (player.escaped && player.lastScore != null) entity.lastScore = player.lastScore;
  if (player.scoreTotal) entity.scoreTotal = player.scoreTotal;
  return entity;
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
