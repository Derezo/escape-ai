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

  // Environment helpers
  NODE_ENV,
  isProduction: NODE_ENV === 'production',
  isDevelopment: NODE_ENV !== 'production'
};
