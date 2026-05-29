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
  HOST: process.env.HOST || '0.0.0.0',

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
  // How many seconds a robot stays stood-down after being ordered (Second Law).
  ORDER_DURATION_SECS: parseFloat(process.env.ORDER_DURATION_SECS) || 2,
  // The square zoo spans [0, WORLD_MAX] on both axes (mirrors shared WORLD).
  // Players are clamped inside it so the perimeter gate is the only way out.
  WORLD_MAX: parseFloat(process.env.WORLD_MAX) || 1000,

  // Ambient NPC drift speeds (mirror shared WANDER). A robot with nothing to
  // chase PATROLS at PATROL_SPEED (slower than ROBOT_SPEED so a real chase still
  // reads as faster); idle decoy animals drift at WANDER_ANIMAL_SPEED. Both ride
  // the deterministic shared wanderStep — see shared/src/step.ts.
  PATROL_SPEED: parseFloat(process.env.PATROL_SPEED) || 60,
  WANDER_ANIMAL_SPEED: parseFloat(process.env.WANDER_ANIMAL_SPEED) || 40,

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

  // Environment helpers
  NODE_ENV,
  isProduction: NODE_ENV === 'production',
  isDevelopment: NODE_ENV !== 'production'
};
