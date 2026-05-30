'use strict';

/**
 * Small stateless helpers shared by the server-side orchestrators (stealth.js,
 * follow.js). They were independently duplicated in both modules; centralizing
 * here removes the copies without a require cycle (stealth requires follow, so
 * follow can't require stealth — but both can require this leaf module, which
 * depends only on config).
 */

const config = require('../config');

/** Seconds → whole ticks (deterministic; no wall clock). The single definition,
 *  so a TICK_RATE change can't desync two copies of the conversion. */
function secsToTicks(secs) {
  return Math.round(secs * config.TICK_RATE);
}

/**
 * Resolve a connected player by its game id within a room. Takes the live maps as
 * arguments (each orchestrator holds its own refs handed over at init) so this
 * helper stays stateless.
 * @param {Map<string, object>} connectedPlayers  Map<socketId, player>
 * @param {Map<string, Set<string>>} rooms        Map<roomName, Set<socketId>>
 * @param {string} roomName
 * @param {string} playerId
 * @returns {object|null}
 */
function findPlayerById(connectedPlayers, rooms, roomName, playerId) {
  if (!connectedPlayers || !rooms) return null;
  const members = rooms.get(roomName);
  if (!members) return null;
  for (const socketId of members) {
    const p = connectedPlayers.get(socketId);
    if (p && p.id === playerId) return p;
  }
  return null;
}

module.exports = { secsToTicks, findPlayerById };
