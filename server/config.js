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
    ELEPHANT_PUSH_UNITS: parseFloat(process.env.ELEPHANT_PUSH_UNITS) || 24
  },

  // Environment helpers
  NODE_ENV,
  isProduction: NODE_ENV === 'production',
  isDevelopment: NODE_ENV !== 'production'
};
