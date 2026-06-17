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
 * Per-socket Area-of-Interest (AOI) culling:
 *   - The room holds ~140 entities, most of them idle pen animals that drift a
 *     fraction of a pixel every tick. Pre-AOI we broadcast the WHOLE room to every
 *     socket each tick; the sub-pixel drift defeated the delta diff, so ~105
 *     entities (~530-835 KB/s) shipped per client per tick — flooding the client
 *     pipe into inbound head-of-line blocking (broken movement, climbing RTT).
 *   - Now each socket receives ONLY the entities within config.AOI_RADIUS of THAT
 *     player (plus its own entity, unconditionally). The cull is per-socket, so the
 *     delta memory is per-socket too (see lastSentBySocket).
 *
 * Delta broadcast + the full-refresh FLUSH tick:
 *   - EVERY tick we send a *delta*: only IN-AOI entities that are NEW to this socket
 *     (just entered its AOI) or whose serialized state changed since the last
 *     snapshot we sent it. Static props don't change (and NPC positions are quantized
 *     to whole pixels in toEntity so sub-pixel drift no longer counts as a change), so
 *     they ride only when they first ENTER this socket's AOI — see the force-send
 *     invariant in broadcastSnapshots.
 *   - Every FULL_REFRESH_INTERVAL ticks is a "flush" tick. It is STILL a delta (FIX 1
 *     below), but it can NOT be deferred by the slow-client coalescer — it always
 *     emits, flushing any accumulated pending delta. It is the backstop that resyncs a
 *     client which fell behind under slow-consumer suppression.
 *
 *   FIX 1 — full-refresh trim. The full-refresh tick used to RE-SEND every in-AOI
 *   entity to every socket, even ones whose serialization the socket already had. A
 *   real client re-creates Phaser views/textures for a batch of entities on such a
 *   burst → a periodic ~5s stall. With per-socket lastSent memory (P1) + the
 *   AOI-entry force-send invariant already repainting re-entering entities, that
 *   re-send is pure waste: lastSent holds EXACTLY what we CONFIRMED sending this
 *   socket, so `!lastSent.has(id)` (AOI-new) ∪ `lastSent.get(id) !== serialized`
 *   (changed) already covers every entity the socket could be missing. A client that
 *   genuinely missed a delta still recovers: the entity it missed will either change
 *   again (caught by the dirty diff) or — because a missed emit means the socket's
 *   TCP stream stalled, and Socket.IO/WebSocket is an ordered reliable stream — it was
 *   not actually lost, just delayed. (The slow-client path defers but never drops:
 *   lastSent only advances on a CONFIRMED emit, and the pending-delta accumulator
 *   re-sends precisely the deferred entities on the next flush.) So the full tick now
 *   behaves like a normal delta tick that simply can't be deferred.
 *   Correctness over cleverness — the delta is a simple per-entity dirty check.
 */

const config = require('../config');
const { SERVER_EVENTS } = require('../../shared/dist/net.js');
const world = require('./world');
const stealth = require('./stealth');
const quests = require('./quests');
const follow = require('./follow');
const statsDelta = require('./stats-delta');
const session = require('./session');

// Full snapshot every N ticks (default 100 = 5s at 20Hz). Between fulls we
// send deltas containing only changed entities.
const FULL_REFRESH_INTERVAL = 100;

// The FIXED simulation timestep, in seconds: exactly one tick's worth of time at
// the nominal TICK_RATE (1/20 = 0.05s by default). EVERY per-second-rate system in
// the sim is integrated with THIS dt — movement (shared moveWithCollision), the
// suspicion decay (SUSPICION_DECAY_PER_SEC * dt), human-likeness (updateHumanLikeness),
// and the panic meter (shared stepPanic) — NOT the wall-clock elapsed time.
//
// WHY FIXED, not wall-clock (the FIX-2 invariant):
//   1. CLIENT PARITY. The client predicts its own movement by replaying each pending
//      input through the SAME shared moveWithCollision at a FIXED step (client
//      main.ts FIXED_DT = INPUT_SEND_MS/1000 = 0.05s) — it explicitly does NOT use
//      wall-clock dt. If the server integrates the same input with a wall-clock dt
//      that momentarily differs (a GC pause or scheduler hiccup stretches one tick's
//      elapsed time), the server's authoritative position diverges from the client's
//      prediction for that input, and the next snapshot yanks the avatar (the
//      reconciliation snap). A fixed step makes server and client arithmetic
//      bit-identical, so prediction reconciles with zero residual.
//   2. DETERMINISM. With a fixed dt, replaying the same inputs from the same state
//      always yields the same trajectory — no dependence on real elapsed time. This
//      is the project's no-wall-clock-in-sim law (timing is in TICKS).
//   3. NO BIG-STEP JUMPS. A wall-clock dt spike (event-loop stall) made a single
//      tick integrate a large step — robots/NPCs teleported forward that tick
//      ("strange robot movement"). A fixed step is immune: a late tick still moves
//      everything exactly one nominal step; the only visible effect of a stall is
//      that the tick simply happens late (the self-scheduler below absorbs that by
//      shortening the next delay), never that the world lurches.
//
// Every dt-consuming system here is per-second-rate math (`rate * dt`) tuned against
// the 20Hz nominal step (constants named `_PER_SEC`), and NONE of them reads a wall
// clock — they all consume this single passed-in dt. So feeding the fixed step to
// the whole tick keeps suspicion/panic/likeness ticking at exactly their nominal,
// designed rate. (The loop still measures real elapsed time below, but ONLY to hold
// the wall-clock TICK_RATE cadence — that scheduling math is separate from sim dt.)
const FIXED_DT = 1 / config.TICK_RATE;

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

// Per-SOCKET memory of the last entity state we broadcast to that socket, for
// delta diffing. It MUST be per-socket (not per-room) because AOI culling gives
// each socket a different entity subset — a room-wide memory would wrongly skip an
// entity for socket B just because socket A was sent it. Keyed by socket id; the
// inner Map is entityId -> serialized snapshot string (what this socket last saw).
// Dropped on disconnect (clearSocket, wired from connection.js) so it can't leak.
// Map<socketId, Map<entityId, string>>
const lastSentBySocket = new Map();

// Per-SOCKET accumulated entity delta for slow-client coalescing.
//
// When a client falls behind (last input arrived > SLOW_CLIENT_THRESHOLD_MS ago),
// we skip emitting a snapshot that tick and instead accumulate the entity changes
// here. On the next "send" tick (fresh input or full-refresh), we emit the UNION
// of all accumulated entity updates — so no delta is ever lost, just deferred.
//
// The correctness invariant: lastSentBySocket always advances (dirty-check uses it
// as the "already acknowledged" baseline), so accumulated deltas are exactly the
// entities that changed between the last emission and now. Flushing the accumulator
// sends precisely those. Map<socketId, Map<entityId, entity>>
const pendingDeltaBySocket = new Map();

// If the most recent input from a socket arrived more than this many milliseconds
// ago, the client is considered "slow" (event loop blocked — typical of an Android
// WebView spinning on snapshot processing). We skip emitting a snapshot for that
// socket this tick and accumulate the delta instead. Normal clients send input
// every 50 ms; 65 ms is above the normal interval but below a typical slow-
// consumer spin (80 ms), so normal play is never rate-limited.
const SLOW_CLIENT_THRESHOLD_MS = 65;

// Squared AOI radius — computed once so the hot per-entity cull is a cheap dist2
// compare with no per-call sqrt. (config.AOI_RADIUS is the human-facing tunable.)
const AOI_RADIUS2 = config.AOI_RADIUS * config.AOI_RADIUS;

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
  // WARM the default room at boot: generateWorld() (the 128x128 tile fill +
  // collision + reachability carve, ~5-13ms) runs SYNCHRONOUSLY inside the
  // lobby:join handler the first time a room is created, which blocks the event
  // loop — stalling every other room's tick/snapshot mid-join. Pre-building the
  // common room here (idempotent: getOrCreateRoomWorld caches per room) moves that
  // cost off the join path so the first joiner spawns without the hitch. Seed +
  // WORLD_GEN_VERSION are identical whether built now or lazily, so determinism /
  // client parity are unchanged. Non-default rooms still build lazily on first join.
  world.getOrCreateRoomWorld(config.DEFAULT_ROOM);
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

  // SIM dt is the FIXED timestep — NOT the wall-clock elapsed time. See FIXED_DT for
  // the full rationale: a fixed step keeps the server's integration bit-identical to
  // the client's fixed-step prediction (no reconciliation snap) and immune to
  // event-loop stalls (no big-step NPC jumps on a late tick). The wall clock is read
  // ONLY for the self-scheduling cadence below — never to advance the simulation.
  const now = Date.now();

  try {
    integratePlayers(FIXED_DT);
    stepNpcs(FIXED_DT);
    broadcastSnapshots();
  } catch (err) {
    // Never let one bad tick kill the loop.
    console.error('[engine] tick error:', err);
  }

  // Schedule next tick, compensating for the work we just did. This is the ONLY
  // place real elapsed time is used: to hold the wall-clock TICK_RATE cadence. A
  // tick that ran late (stall) simply schedules its successor sooner (delay floors
  // at 0) — the sim never compensates by integrating a larger step. lastTickTime is
  // retained for diagnostics / future drift accounting; the sim no longer reads it.
  lastTickTime = now;
  const interval = 1000 / config.TICK_RATE;
  const elapsed = Date.now() - now;
  const delay = Math.max(0, interval - elapsed);
  timer = setTimeout(tick, delay);
}

/** Apply each player's next QUEUED input to its position, advance its stealth state,
 *  and fire any one-shot action it carried this tick. */
function integratePlayers(dt) {
  if (!connectedPlayers) return;

  for (const player of connectedPlayers.values()) {
    // ── INPUT FIFO drain (FIX 3): ONE input per tick ─────────────────────────────
    // The client sends ~1 input/frame (~20Hz); the engine ticks ~20Hz; the two are
    // NOT phase-locked, so occasionally two inputs land between ticks. We drain the
    // queue ONE per tick (one fixed step), carrying any surplus to later ticks, and
    // ack ONLY the seq we actually integrate (player.lastProcessedSeq below). That is
    // the whole point of option (b):
    //   - INPUT FIDELITY: every queued input gets its own fixed-step integration, so
    //     the older of two same-gap inputs is no longer dropped (the old single-slot
    //     overwrite lost it while still acking the newer seq → the client pruned an
    //     input it never saw applied → a small position deficit, the "6u drop").
    //   - ONE STEP PER TICK: we never integrate two inputs in one tick, so a burst
    //     can't speed the player up (option (a)'s risk). A surplus simply trickles
    //     out one-per-tick on following ticks.
    //   - CLIENT RECONCILIATION STAYS HONEST: the client keeps every input whose seq
    //     is still unacked in its pending buffer and replays them at FIXED_DT. Because
    //     we ack only the integrated seq, an input still sitting in our queue is also
    //     still unacked → the client keeps predicting it → the predicted and (soon-to-
    //     be) authoritative positions agree when we DO integrate it next tick.
    //
    // When the queue is EMPTY we HOLD the last integrated input (player.input is left
    // as-is): the player keeps moving with its last good frame for movement continuity
    // (mirrors the client, which keeps replaying its unacked tail), and lastProcessedSeq
    // is NOT advanced (we integrated nothing new this tick, so there is nothing new to
    // ack). A rate-limited / dropped frame is therefore safe: the held input carries on.
    if (player.inputQueue && player.inputQueue.length > 0) {
      // Dequeue the OLDEST input and promote it to player.input — the single
      // "this tick's integrated input" view that the facing + human-likeness reads
      // below (and stealth.stepPlayerHumanLikeness) consume, so they stay coherent
      // with the move we're about to apply.
      player.input = player.inputQueue.shift();
    }
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

    // Side-quest progress (multi-step): advance a CURRENT 'reach' step when the
    // player stands on its own species' home (questObject) tile. Run BEFORE
    // checkEscape so arriving home and reaching the gate the same tick still
    // escapes. stepReach no-ops unless the active step is a 'reach' (other step
    // kinds advance at the gate / on interact / on their event hooks).
    if (player.quest && !player.quest.complete) {
      quests.stepReach(player, player.room);
    }

    // Win + respawn lifecycle: reaching the gate escapes (shows the banner);
    // after a brief celebration the player respawns as a fresh animal. The gate
    // is GATED on quest completion (stealth.checkEscape).
    const speciesBefore = player.species;
    stealth.checkEscape(player, player.room, currentTick);
    // REBIRTH EDGE: checkEscape's respawn rolls the player into the next species.
    // When that happens, persist the new identity + a fresh session snapshot so a
    // rejoin resumes as the reborn species (not the original). Edge-driven — only
    // the rare respawn tick writes; the common case compares two strings and moves
    // on. Guarded for tests / un-authed players (no db / no userId).
    if (db && player.userId && player.species !== speciesBefore) {
      db.setLastSpecies(player.userId, player.species);
      const snap = session.snapshot(player);
      if (snap) db.saveSession(player.userId, snap);
    }

    // Consume the latched one-shot action (order / interact / ability), if any.
    // Cleared immediately so it fires once per press; lobby.js latches it onto
    // pendingAction so an action-less movement frame can't drop it pre-tick.
    if (player.pendingAction) {
      stealth.applyAction(player, player.pendingAction, player.room, currentTick);
      player.pendingAction = null;
    }

    // Record the seq we ACTUALLY simulated this tick, so the snapshot's `acks` lets
    // clients reconcile. `input` is the frame we drained from the FIFO (or, on an
    // empty-queue hold tick, the last integrated frame) — so this acks exactly the
    // input whose movement is now reflected in player.x/y, never a seq we skipped.
    // On a hold tick it re-stamps the same seq (a no-op ack), which is correct: we
    // integrated nothing new, so the client's unacked tail (including any input still
    // sitting in our queue) is preserved for replay until we drain + ack it.
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
    // Re-materialize any escaped-herd animals whose 15s respawn timer has elapsed,
    // back inside their home pen, BEFORE the idle/robot steps so a freshly respawned
    // animal is perceived + drifts this same tick (no one-tick lag, mirrors how
    // stepIdleAnimals runs before stepRobots). A no-op when the room's queue is empty.
    follow.stepRespawns(roomName, currentTick);
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

/**
 * The ONLY world-entity fields the client renders. The live NPC objects accumulate
 * a lot of server-internal state at runtime — the A* `path` waypoint array (30+
 * points on a patrolling robot!), FSM scratch (`patrolIndex`, `localLoop`,
 * `headAngle`, `pathGoalTx`…), return-home bookkeeping — none of which the client
 * needs (it derives gait from `species` via the shared locomotion registry). That
 * scratch was riding the wire via the Entity index signature AND mutating every
 * tick, which both bloated each entity ~3× (a robot serialized to ~450B instead of
 * ~140B) AND defeated the delta diff (the path/headAngle change every tick). This
 * whitelist is the companion to AOI culling + quantization: it ships only the
 * client-visible projection of the entity, so a stationary prop serializes
 * identically tick-over-tick and an NPC carries just its render state.
 *
 * Fields are added only when present (so a robot doesn't carry `species`, an animal
 * doesn't carry `mode`, etc.) to keep deltas tight and the dirty-check honest.
 */
const WORLD_WIRE_FIELDS = [
  // Common
  'name', 'kind',
  // animal / food / questObject identity + render
  'species', 'humanLikeness', 'facing', 'foodKey', 'meta',
  // robot render
  'mode', 'suspicion',
  // terminal contention LED (the only terminal field the client reads)
  'activatedBy',
  // prop (the carryable clipboard) carrier
  'carrierId',
  // follower render (the decaying follow-ring + steal flagging)
  'followerOf', 'followUntilTick', 'followSince', 'stolen', 'returningHome',
  // sticky/echo render flags
  'escaped', 'fx'
];

/**
 * Project a live world (NPC/animal/food/prop/hazard) entity onto its WIRE shape:
 * the whitelisted client-visible fields (WORLD_WIRE_FIELDS), with x/y QUANTIZED to
 * whole pixels.
 *
 * Quantization rationale: idle pen animals drift ~2px/tick and patrolling robots
 * move every tick, but at full float precision even a truly-stationary prop can
 * jitter sub-pixel and serialize-differ. Rounding x/y to integer pixels collapses
 * that: an entity that hasn't moved a whole pixel serializes IDENTICALLY and drops
 * out of the delta. At 32px tiles, whole-pixel rounding is far below anything the
 * eye can see, and the client interpolates between snapshots, so movement stays
 * smooth. Returns a FRESH object — never mutates the live entity (stealth.js /
 * follow.js own those and integrate at full precision).
 *
 * @param {object} entity  a live world entity
 * @returns {object} a wire-ready, whitelisted, position-quantized copy
 */
function serializeWorldEntity(entity) {
  const wire = {
    id: entity.id,
    x: Math.round(entity.x),
    y: Math.round(entity.y)
  };
  for (const f of WORLD_WIRE_FIELDS) {
    if (entity[f] !== undefined) wire[f] = entity[f];
  }
  return wire;
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
    // Forward the CURRENT activate-step's counted terminal ids so the client hint
    // can skip terminals this player already tapped. Spread into a FRESH object so
    // we never mutate the live player.quest (which would leak into the delta-diff
    // stringify / parity). Only attach activatedIds when non-empty, to keep deltas
    // small and avoid sending an empty array on non-activate steps.
    entity.quest = player.questTerminals && player.questTerminals.size
      ? { ...player.quest, activatedIds: [...player.questTerminals] }
      : player.quest;
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

/** Broadcast a snapshot to every active room, PER SOCKET, with AOI culling. */
function broadcastSnapshots() {
  if (!rooms) return;

  // The periodic "flush" tick (FIX 1). It is no longer a force-send-everything full
  // snapshot — it is a normal per-socket delta that simply can NOT be deferred by the
  // slow-client coalescer (it always emits, draining any held pending delta). The name
  // `isFull` is retained because it still gates the un-deferrable flush; what changed
  // is that it no longer overrides the per-entity dirty check below.
  const isFlushTick = currentTick % FULL_REFRESH_INTERVAL === 0;

  for (const [roomName, socketIds] of rooms) {
    if (!socketIds || socketIds.size === 0) continue;

    // Build the room's candidate entity set ONCE per tick (it's the same for every
    // socket; only the per-socket AOI cull differs). Players serialize via toEntity;
    // world props are quantized to whole pixels so sub-pixel NPC drift stops riding
    // the delta. acks is room-wide (every player's lastProcessedSeq), but we only
    // ATTACH the entry for the receiving player below — a socket doesn't need rival
    // ack values. We keep the full map here and pick from it per socket.
    const worldState = world.getWorldState(roomName);
    const allAcks = {};
    const candidates = []; // { entity, x, y } for every player + world entity
    for (const socketId of socketIds) {
      const player = connectedPlayers.get(socketId);
      if (!player) continue;
      const entity = toEntity(player);
      allAcks[entity.id] = player.lastProcessedSeq || 0;
      candidates.push({ entity, x: player.x, y: player.y });
    }
    for (const raw of world.getWorldEntities(roomName)) {
      const entity = serializeWorldEntity(raw);
      candidates.push({ entity, x: entity.x, y: entity.y });
    }

    // Now emit a SOCKET-SPECIFIC snapshot: each player sees only what's within
    // config.AOI_RADIUS of THEM (plus their own entity, unconditionally).
    for (const socketId of socketIds) {
      const me = connectedPlayers.get(socketId);
      if (!me) continue;

      // Per-socket delta memory: what THIS socket currently knows about. Each socket
      // gets a different AOI subset, so the memory MUST be per-socket — sharing it
      // would skip an entity for one socket because another socket already saw it.
      let lastSent = lastSentBySocket.get(socketId);
      if (!lastSent) {
        lastSent = new Map();
        lastSentBySocket.set(socketId, lastSent);
      }

      const entities = [];
      const seenIds = new Set(); // ids IN-AOI this tick (for the AOI-exit prune below)

      for (const c of candidates) {
        // AOI test. The player's OWN entity is always in range (it's at the centre),
        // so the dist2 compare admits it; rival players + world entities pass only
        // within AOI_RADIUS. Squared distance — no sqrt in the hot loop.
        const dx = c.x - me.x;
        const dy = c.y - me.y;
        if (dx * dx + dy * dy > AOI_RADIUS2) continue; // culled: outside this socket's AOI

        seenIds.add(c.entity.id);
        const serialized = JSON.stringify(c.entity);

        // THE AOI-ENTRY FORCE-SEND INVARIANT (the subtle correctness bug):
        // When an entity ENTERS this socket's AOI (it was culled last tick, so the
        // socket has NO lastSent memory of it), we MUST send it in full THIS tick —
        // even if its serialization is byte-identical to the last time this socket
        // saw it long ago. A pure dirty-check (`lastSent.get(id) !== serialized`)
        // would WRONGLY skip an unchanged-but-re-entering entity, leaving it invisible
        // on the client. `lastSent.has(id)` is exactly the "did this socket know about
        // it last tick" test: a miss means it just entered AOI → force-send. A hit
        // falls through to the normal dirty check.
        //
        // FIX 1: the flush tick (isFlushTick) is NO LONGER an override here. It used
        // to be `if (isFull || isNewToSocket || changed)`, which re-sent every in-AOI
        // entity every FULL_REFRESH_INTERVAL ticks regardless of whether the socket
        // already had it — a periodic ~5s batch the real client choked on (Phaser
        // view/texture re-creation). lastSent holds EXACTLY what we CONFIRMED sending
        // this socket, so (AOI-new ∪ changed) already covers everything the socket
        // could be missing; re-sending an entity whose serialization the socket
        // already holds is pure waste. The flush tick still matters — but only as the
        // un-deferrable emit below (it flushes the slow-client accumulator), NOT as a
        // force-resend of unchanged state.
        const isNewToSocket = !lastSent.has(c.entity.id);
        if (isNewToSocket || lastSent.get(c.entity.id) !== serialized) {
          entities.push(c.entity);
        }
        lastSent.set(c.entity.id, serialized);
      }

      // AOI-EXIT: drop delta-memory for any entity the socket knew about that is no
      // longer in range (or left the room). We do NOT send a "removed" signal — the
      // client keeps the entity in its map at its last position, but AOI_RADIUS is far
      // larger than the client viewport, so a just-exited entity is well off-screen and
      // never visibly stale; if the player walks back, the force-send above repaints it
      // before it could reach the screen edge. (If we ever shrink AOI below the
      // viewport, this is where a remove-id list would be added to the contract.)
      for (const id of lastSent.keys()) {
        if (!seenIds.has(id)) lastSent.delete(id);
      }

      // ── Slow-client coalescing ────────────────────────────────────────────────
      //
      // If the client is behind (event loop blocked — typical of an Android WebView
      // spinning on each received snapshot), snapshot messages pile up in its TCP
      // receive buffer. Subsequent messages (including pong responses) queue behind
      // them, causing RTT to climb without bound.
      //
      // Solution: detect slowness via the recency of the last input we received from
      // this socket. Normal clients send inputs every 50 ms; a client whose event loop
      // is blocked stops sending inputs (timer callbacks don't fire during a spin).
      // When the last input arrived > SLOW_CLIENT_THRESHOLD_MS ago, we hold back the
      // snapshot this tick and accumulate the delta. On the next "send-allowed" tick
      // (fresh input OR a flush tick), we emit the UNION of all accumulated entity
      // updates. This ensures no entity change is lost — it is just deferred by at
      // most one extra send interval. Pong responses travel on the same
      // connection but are emitted outside this path (in the ping handler) and are
      // never held back, so the RTT measurement drains freely.
      //
      // Per-socket accumulator: Map<entityId, entity> — latest entity object wins,
      // so applying it in order is equivalent to processing each queued snapshot
      // individually (the merge is associative and commutative for last-writer-wins).
      let pendingDelta = pendingDeltaBySocket.get(socketId);
      if (!pendingDelta) {
        pendingDelta = new Map();
        pendingDeltaBySocket.set(socketId, pendingDelta);
      }

      // Accumulate this tick's delta into the per-socket pending buffer. Entity
      // objects reference the same candidate array as this tick, which is fine — we
      // emit before the next tick mutates the live world (the engine is synchronous
      // and single-threaded). New entries overwrite stale ones (latest always wins).
      for (const e of entities) pendingDelta.set(e.id, e);

      // Decide whether to emit this tick. A flush tick (isFlushTick) ALWAYS emits — it
      // is the un-deferrable backstop that resyncs a client which missed deltas during
      // slow-consumer suppression (it drains the pending-delta accumulator below).
      // Otherwise, only emit if the client showed signs of life recently (last input
      // arrived within SLOW_CLIENT_THRESHOLD_MS). No lastInputAt means the client
      // joined but hasn't sent an input yet — treat as "active" so the join snapshot
      // reaches the client without waiting for the first key-press.
      const lastInputAge = me.lastInputAt ? (Date.now() - me.lastInputAt) : 0;
      const clientIsActive = lastInputAge <= SLOW_CLIENT_THRESHOLD_MS;

      if (!isFlushTick && !clientIsActive) {
        // Client appears slow: hold back and keep accumulating. The pong handler
        // (in the ping socket.on handler, NOT in this path) still fires immediately
        // when the client sends a ping, so RTT stays clean for fast messages.
        continue; // eslint-disable-line no-continue
      }

      // Flush the accumulated delta (this tick's entities PLUS any held from prior
      // ticks). FIX 1: a flush tick no longer rebuilds the whole AOI subset — the
      // accumulator holds exactly the (AOI-new ∪ changed) entities seen since the
      // last emit, so this drains precisely what the socket is owed and nothing more.
      const entitiesToSend = [...pendingDelta.values()];
      pendingDelta.clear();

      // Attach ONLY the receiving player's ack (clients reconcile against their own
      // lastProcessedSeq). Even on a delta tick with nothing changed we still emit so
      // the client keeps advancing its tick clock and gets a fresh ack; the tiny
      // WorldState rides every tick so panic/lockdown stays current.
      const acks = {};
      if (typeof allAcks[me.id] === 'number') acks[me.id] = allAcks[me.id];

      io.to(socketId).emit(SERVER_EVENTS.SNAPSHOT, {
        tick: currentTick,
        entities: entitiesToSend,
        acks,
        world: worldState
      });
    }
  }
}

/**
 * Send a ONE-TIME full snapshot of everything within the joining player's AOI to a
 * single just-joined socket, immediately on join — so a player who joins an
 * already-populated room sees the world around it AT ONCE instead of waiting up to
 * FULL_REFRESH_INTERVAL ticks (~5s) for the next full refresh. Between full
 * refreshes the broadcast is a per-socket delta; without this nudge the new client
 * would render an almost empty world until the next full tick (the "lag before
 * spawn"). AOI-scoped to match what the per-tick broadcast will send (and to keep
 * the join burst lean — no point shipping the far half of the map the client will
 * never look at).
 *
 * It PRIMES this socket's own per-socket delta memory (lastSentBySocket) with what
 * it sends, so the very next broadcast tick doesn't redundantly re-send the same
 * in-AOI entities as "new to socket". This only touches THIS socket's memory — never
 * another socket's — so it can't make a delta wrongly skip an entity for anyone else.
 * Idempotent and side-effect-free on sim state.
 *
 * @param {import('socket.io').Socket} socket  the joining socket
 * @param {string} roomName
 */
function sendFullSnapshotTo(socket, roomName) {
  if (!io || !rooms) return;
  const members = rooms.get(roomName);
  if (!members) return;

  const me = connectedPlayers.get(socket.id);
  if (!me) return;

  // Fresh per-socket delta memory for the joiner, primed with what we send below so
  // the next broadcast tick treats these as already-known (no duplicate force-send).
  let lastSent = lastSentBySocket.get(socket.id);
  if (!lastSent) {
    lastSent = new Map();
    lastSentBySocket.set(socket.id, lastSent);
  }

  const entities = [];
  const acks = {};

  const consider = (entity, ex, ey) => {
    const dx = ex - me.x;
    const dy = ey - me.y;
    if (dx * dx + dy * dy > AOI_RADIUS2) return; // outside the joiner's AOI — skip
    entities.push(entity);
    lastSent.set(entity.id, JSON.stringify(entity));
  };

  // Every player in the room within AOI (includes the just-joined one — it's at the
  // AOI centre, so the dist2 test admits it: the client gets its own spawn position).
  for (const socketId of members) {
    const player = connectedPlayers.get(socketId);
    if (!player) continue;
    const entity = toEntity(player);
    consider(entity, player.x, player.y);
  }
  // The joiner only needs its OWN ack (it reconciles against its own lastProcessedSeq).
  acks[me.id] = me.lastProcessedSeq || 0;

  // Every static world prop (pens, food, gate, robots, idle animals, terminals)
  // within AOI, projected to the SAME wire shape (whitelist + quantize) as the
  // per-tick broadcast (so the primed memory is byte-identical to what the next
  // delta would compare to — no spurious force-resend next tick).
  for (const raw of world.getWorldEntities(roomName)) {
    const entity = serializeWorldEntity(raw);
    consider(entity, entity.x, entity.y);
  }

  socket.emit(SERVER_EVENTS.SNAPSHOT, {
    tick: currentTick,
    entities,
    acks,
    world: world.getWorldState(roomName)
  });
}

/**
 * Drop a socket's per-socket delta memory. Called from connection.js on disconnect
 * so lastSentBySocket / pendingDeltaBySocket can't grow without bound across a
 * session's joins/leaves. (Both maps are keyed by socket.id; stale entries would
 * otherwise linger forever.)
 * @param {string} socketId
 */
function clearSocket(socketId) {
  lastSentBySocket.delete(socketId);
  pendingDeltaBySocket.delete(socketId);
}

module.exports = {
  init,
  start,
  stop,
  // Send a just-joined socket its initial full snapshot (lobby.js calls this on
  // join so a late joiner doesn't wait for the next room-wide full refresh).
  sendFullSnapshotTo,
  // Drop a socket's per-socket AOI delta memory (connection.js calls this on
  // disconnect so lastSentBySocket can't leak across a session's joins/leaves).
  clearSocket,
  // Read-only accessors used by the /health endpoint.
  getCurrentTick: () => currentTick,
  isRunning: () => running,
  FULL_REFRESH_INTERVAL
};
