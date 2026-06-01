'use strict';

/**
 * Server configuration.
 * All values come from process.env (loaded via dotenv in index.js) with
 * sensible defaults so the server boots with zero configuration.
 */

const NODE_ENV = process.env.NODE_ENV || 'development';

module.exports = {
  // Network
  PORT: parseInt(process.env.PORT, 10) || 3000,
  // Loopback by default: the node port must NEVER face the public internet on its
  // own — in production the edge is nginx + TLS, and the port is loopback-only and
  // closed in ufw. Defaulting to 127.0.0.1 means an exposed bind requires an
  // explicit, deliberate HOST=0.0.0.0 (e.g. LAN testing), instead of being the
  // accidental fallback if pm2's env injection or the firewall ever lapses.
  HOST: process.env.HOST || '127.0.0.1',

  // The room a joiner lands in when it sends no (or a blank) room name — the
  // single source of truth for the lobby fallback AND the boot warm-up (engine.init
  // pre-generates this room so the first joiner doesn't pay world-gen on the event
  // loop). Keep lobby.js's fallback and the warm-up reading this one constant.
  DEFAULT_ROOM: process.env.DEFAULT_ROOM || 'default',

  // Persistence: SQLite file for username-only accounts + per-user stats. A
  // relative path is resolved against the server dir (see db.js); the data/
  // directory is created on boot and gitignored.
  DB_PATH: process.env.DB_PATH || './data/escapeai.db',

  // Authoritative simulation
  // Tick rate in Hz; how many times per second the engine steps + broadcasts.
  TICK_RATE: parseInt(process.env.TICK_RATE, 10) || 20,
  // Units per second a player point moves at full input magnitude.
  PLAYER_SPEED: parseFloat(process.env.PLAYER_SPEED) || 200,
  // Units per second a robot NPC chases at. Deliberately slower than players so
  // disguise/space/bluffing matters — you can outrun a pursuing robot.
  ROBOT_SPEED: parseFloat(process.env.ROBOT_SPEED) || 120,
  // Multiplier applied to ROBOT_SPEED while the world is in lockdown: the First
  // Law is suspended (Phase 3 tuning) and robots move with intent.
  ROBOT_LOCKDOWN_SPEED_MULT: parseFloat(process.env.ROBOT_LOCKDOWN_SPEED_MULT) || 1.5,
  // World-unit radius for "touching": how close a pursuing robot must get to a
  // player-animal to catch it, and how close a player must be to a robot/terminal
  // to issue a Second-Law order or interact. Roughly one entity rect.
  RECT_SIZE: parseFloat(process.env.RECT_SIZE) || 32,
  // Post-spawn safety window (seconds). After a catch-respawn or escape-respawn a
  // player is catch-immune for this long, so a robot near the respawn point can't
  // chain-catch the player into an infinite loop. The player can still act — only
  // catch-immune. (No join grace needed: the species-pen spawn is robot-free.)
  SPAWN_GRACE_SECS: parseFloat(process.env.SPAWN_GRACE_SECS) || 2,
  // How many seconds a robot stays stood-down after being ordered (Second Law).
  ORDER_DURATION_SECS: parseFloat(process.env.ORDER_DURATION_SECS) || 2,
  // After reaching the gate, how many seconds the player holds the "ESCAPED!"
  // win state before respawning as a fresh animal (new species) back at spawn.
  // The round-based loop: escape → brief celebration → new run.
  ESCAPE_CELEBRATION_SECS: parseFloat(process.env.ESCAPE_CELEBRATION_SECS) || 4,
  // The square zoo spans [0, WORLD_MAX] on both axes. This mirrors the shared
  // generator's MAP_W * TILE = 128 * 32 = 4096 world units. It's only a backstop
  // for the mole/kangaroo teleport clamps — the AUTHORITATIVE movement bound is
  // the per-room collision grid (out-of-bounds is solid), so players are walled
  // in regardless of this value. Overridable by env for tuning/tests.
  WORLD_MAX: parseFloat(process.env.WORLD_MAX) || 4096,

  // Ambient NPC drift speeds (mirror shared WANDER). A robot with nothing to
  // chase PATROLS at PATROL_SPEED (slower than ROBOT_SPEED so a real chase still
  // reads as faster); idle decoy animals drift at WANDER_ANIMAL_SPEED. Both ride
  // the deterministic shared wanderStep — see shared/src/step.ts.
  // PATROL_SPEED was 60 when idle robots merely drifted in place; with real
  // waypoint patrol across the ~12k-unit junction loop, 60 made a lap take
  // minutes. 90 keeps patrol clearly slower than a chase (ROBOT_SPEED 120) while
  // a lap reads in a reasonable time. Still overridable by env for tuning.
  PATROL_SPEED: parseFloat(process.env.PATROL_SPEED) || 90,
  WANDER_ANIMAL_SPEED: parseFloat(process.env.WANDER_ANIMAL_SPEED) || 40,

  // Robot behavior FSM (NPC movement refactor). A robot patrols the generated
  // path loop (PATROL_SPEED), breaks off to INVESTIGATE a suspicious-but-distant
  // animal at INVESTIGATE.SPEED (between patrol and chase), then resumes patrol.
  INVESTIGATE: {
    // Detection ring (multiple of the shared PERCEPTION_RADIUS) for "something's
    // off over there" — WIDER than the close pursue range, so a low-likeness
    // animal/player triggers a detour before it's close enough to chase.
    RADIUS_MULT: parseFloat(process.env.INVESTIGATE_RADIUS_MULT) || 1.5,
    // Move speed while heading to a last-known position (medium — between patrol
    // 90 and pursue 120, so a robot zeroing in on a clue reads as more urgent).
    SPEED: parseFloat(process.env.INVESTIGATE_SPEED) || 110,
    // Seconds a robot lingers at the last-known spot before resuming patrol.
    LINGER_SECS: parseFloat(process.env.INVESTIGATE_LINGER_SECS) || 2.5
  },

  // Global pathfinding (shared/dist/pathfind.js A*). NPCs cache a coarse waypoint
  // route to a fixed goal and recompute only on a slow cadence — the route is
  // followed via the existing steerAround for the local slide. These tune the
  // recompute cadence and the "thread the gate" chokepoint band.
  PATHFIND: {
    // Ticks between recomputes of a cached path (also recomputed on goal change /
    // path exhaustion). ~30 ticks ≈ 1.5s at 20Hz: cheap, and re-plans often enough
    // to recover from a transient block while keeping the return-home look ambient.
    REPATH_TICKS: parseInt(process.env.PATHFIND_REPATH_TICKS, 10) || 30,
    // Within this many tiles of the gate-inside goal, a returning animal follows the
    // path waypoint with HIGH FIDELITY (no ambient-wander blend) so the 2-tile gate
    // is threaded deterministically — the open-field drift only applies further out.
    GATE_BAND_TILES: parseFloat(process.env.PATHFIND_GATE_BAND_TILES) || 3,
    // Arrive radius (tiles) for advancing along the DENSE (1-tile) waypoint list.
    // Kept BELOW 1 so the body targets the immediate next tile center (an
    // axis-aligned step the sliding integrator threads cleanly) instead of skipping
    // ahead to a diagonal waypoint that would clip a wall corner near the gate.
    ARRIVE_TILES: parseFloat(process.env.PATHFIND_ARRIVE_TILES) || 0.6,
    // Return-home WATCHDOG (Phase 5A): seconds a returning-home animal may go WITHOUT
    // net progress toward its enclosure before it is hard-released at its home center
    // (so a stuck-on-a-fence animal stops drifting forever). The normal return
    // completes in a few seconds, far under this; a stalled one trips it. Converted to
    // ticks server-side. Progress is "got measurably closer to home since last check".
    RETURN_WATCHDOG_SECS: parseFloat(process.env.PATHFIND_RETURN_WATCHDOG_SECS) || 10,
    // Squared world-unit distance a returning animal must close since its last
    // progress checkpoint to count as "making progress" (resets the watchdog clock).
    // Below this it's considered stalled and the watchdog timer keeps running.
    RETURN_PROGRESS_EPS2: parseFloat(process.env.PATHFIND_RETURN_PROGRESS_EPS2) || 64,
    // Ticks a penned animal HOLDS one ambient-wander destination before re-rolling to
    // a new reachable interior tile. ~50 ticks ≈ 2.5s at 20Hz: long enough that the
    // A* path is followed to completion (the saunter reads as deliberate, not twitchy)
    // and the per-animal repath cost stays amortized to a fraction of a search/tick.
    // The pen-wander A* targets a tile chosen by hash(id:bucket) over this bucket.
    PEN_TARGET_TICKS: parseInt(process.env.PATHFIND_PEN_TARGET_TICKS, 10) || 50
  },

  // Species abilities (Phase 4). Each species has one edge-triggered power fired
  // by the 'ability' action; these are the server-orchestrated tunables. Timed
  // effects convert seconds -> ticks via TICK_RATE (deterministic, no wall clock).
  ABILITY: {
    // BIRD "flit": seconds the bird is briefly uncatchable (flying over a wall).
    BIRD_FLIT_SECS: parseFloat(process.env.BIRD_FLIT_SECS) || 1.5,
    // RAT "skitter": seconds the rat is invisible to robot perception (squeezing
    // through a gap / behind cover).
    RAT_SKITTER_SECS: parseFloat(process.env.RAT_SKITTER_SECS) || 2,
    // ELEPHANT "shove": seconds a shoved robot stays stunned (honored like an
    // order standdown), plus the reach (multiple of RECT_SIZE) and how far the
    // robot is knocked back (world units).
    ELEPHANT_STUN_SECS: parseFloat(process.env.ELEPHANT_STUN_SECS) || 2,
    ELEPHANT_REACH_MULT: parseFloat(process.env.ELEPHANT_REACH_MULT) || 2,
    ELEPHANT_PUSH_UNITS: parseFloat(process.env.ELEPHANT_PUSH_UNITS) || 24,

    // --- The zoo expansion (Phase C). One ability per new species. ---
    // CHAMELEON "cloak": seconds humanLikeness is floored to 1.0 (perfect disguise,
    // even while moving) — the premier First-Law tool. Double-edged: cloaking near a
    // robot raises its suspicion.
    CHAMELEON_CLOAK_SECS: parseFloat(process.env.CHAMELEON_CLOAK_SECS) || 3,
    // PEACOCK "dazzle": AoE stand-down. Seconds each robot in radius is ordered, and
    // the radius (world units). Loud — latches one panic order per robot dazzled.
    PEACOCK_DAZZLE_SECS: parseFloat(process.env.PEACOCK_DAZZLE_SECS) || 2,
    PEACOCK_RADIUS: parseFloat(process.env.PEACOCK_RADIUS) || 140,
    // SKUNK "stink": seconds the dropped hazard zone lingers, and its radius. Robots
    // refuse to step into it (Third-Law self-preservation).
    SKUNK_STINK_SECS: parseFloat(process.env.SKUNK_STINK_SECS) || 5,
    SKUNK_RADIUS: parseFloat(process.env.SKUNK_RADIUS) || 70,
    // MOLE "burrow": teleport distance along facing (world units) + seconds briefly
    // unseen on resurfacing.
    MOLE_BURROW_DIST: parseFloat(process.env.MOLE_BURROW_DIST) || 90,
    MOLE_UNSEEN_SECS: parseFloat(process.env.MOLE_UNSEEN_SECS) || 1,
    // CHEETAH "dash": seconds of a speed burst + the speed multiplier. Fast reads as
    // prey, so humanLikeness crashes (the double edge, via updateHumanLikeness).
    CHEETAH_DASH_SECS: parseFloat(process.env.CHEETAH_DASH_SECS) || 1.5,
    CHEETAH_SPEED_MULT: parseFloat(process.env.CHEETAH_SPEED_MULT) || 2,
    // PARROT "mimic": seconds the nearest robot stands down — like an order but WITH
    // NO suspicion (a perfect human-voice mimic). Still latches panic.
    PARROT_ORDER_SECS: parseFloat(process.env.PARROT_ORDER_SECS) || 2.5,
    // TORTOISE "shell": seconds immovable + uncatchable, humanLikeness held.
    TORTOISE_SHELL_SECS: parseFloat(process.env.TORTOISE_SHELL_SECS) || 3,
    // KANGAROO "leap": hop distance along facing (world units) + seconds uncatchable
    // mid-air.
    KANGAROO_LEAP_DIST: parseFloat(process.env.KANGAROO_LEAP_DIST) || 130,
    KANGAROO_AIR_SECS: parseFloat(process.env.KANGAROO_AIR_SECS) || 0.6,
    // OWL "hush": flat panic drained off the room meter (anti-overflow team utility).
    OWL_HUSH_AMOUNT: parseFloat(process.env.OWL_HUSH_AMOUNT) || 30,
    // FOX "decoy": seconds the spawned human-looking decoy lasts + its humanLikeness
    // (robots prefer to chase it, peeling pursuit off the team).
    FOX_DECOY_SECS: parseFloat(process.env.FOX_DECOY_SECS) || 5,
    FOX_DECOY_HL: parseFloat(process.env.FOX_DECOY_HL) || 0.5,

    // Generic per-ability cooldown (seconds) so powers can't be spammed. The
    // original four keep a small/zero cooldown to preserve their current feel.
    COOLDOWN_SECS: parseFloat(process.env.ABILITY_COOLDOWN_SECS) || 4
  },

  // Keeper terminals (the 'activate'/'order' quest targets). A terminal carries a
  // shared activation lock (terminal.activatedBy + activatedTick) that everyone
  // sees (drives the client LED) and that blocks OTHER players from counting it.
  // The lock auto-clears DEACTIVATE_SECS after activation so a terminal frees up
  // for the next player — WITHOUT touching anyone's per-player quest tally.
  TERMINAL: {
    // Seconds a terminal stays locked to its activator before the per-tick sweep
    // (world.pruneExpired) releases it. Converted to ticks server-side.
    DEACTIVATE_SECS: parseFloat(process.env.TERMINAL_DEACTIVATE_SECS) || 15
  },

  // Animal collection (food / follow / steal / score). Feeding an animal its
  // liked food recruits it as a follower that trails you to the gate. All timing
  // is in seconds here and converted to ticks server-side (deterministic).
  FOLLOW: {
    // Seconds each feed grants. Accumulative across feeds, up to CAP_SECS.
    GRANT_SECS: parseFloat(process.env.FOLLOW_GRANT_SECS) || 15,
    // Hard ceiling on a follower's remaining time, so it can't be parked forever.
    CAP_SECS: parseFloat(process.env.FOLLOW_CAP_SECS) || 60,
    // Follower chase speed (units/sec). Above the walk speed (120) so a follower
    // keeps up with a walking owner, but below sprint (200) so SPRINTING sheds it
    // — an emergent cost of sprinting (which also crashes your own disguise).
    SPEED: parseFloat(process.env.FOLLOW_SPEED) || 150,
    // Don't close inside this distance (units) — the follower trails, it doesn't
    // jitter on top of the owner.
    STOP_DIST: parseFloat(process.env.FOLLOW_STOP_DIST) || 40,
    // Chain spacing (units): each link trails this far behind the PREVIOUS link
    // (player → f1 → f2 → …) so the herd reads as a line, not a pile. Mirrors
    // STOP_DIST (the head-of-chain's own trail distance to the player).
    GAP: parseFloat(process.env.FOLLOW_GAP) || 40,
    // Grace window (seconds) after a follow timer lapses: the animal keeps lagging
    // in the chain, and a quick re-feed snaps it back. Only once grace elapses with
    // no re-feed does it detach and drift home. A short "it's losing interest" beat.
    GRACE_SECS: parseFloat(process.env.FOLLOW_GRACE_SECS) || 2,
    // Scoring at the gate: your own animal, each WILD follower, each STOLEN
    // follower (worth more — the competitive theft payoff).
    SCORE_OWN: parseFloat(process.env.SCORE_OWN) || 100,
    SCORE_FOLLOWER: parseFloat(process.env.SCORE_FOLLOWER) || 50,
    SCORE_STOLEN: parseFloat(process.env.SCORE_STOLEN) || 120,
    // Seconds after a player ESCAPES before the herd it led out (its followers,
    // despawned at the gate so no one sees a ghost herd) reappears back inside its
    // home pen. Converted to ticks server-side via secsToTicks (deterministic).
    RESPAWN_SECS: parseFloat(process.env.FOLLOW_RESPAWN_SECS) || 15
  },

  // Environment helpers
  NODE_ENV,
  isProduction: NODE_ENV === 'production',
  isDevelopment: NODE_ENV !== 'production'
};
