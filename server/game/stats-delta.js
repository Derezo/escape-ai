'use strict';

/**
 * The ONE owner of the per-player stat-delta accumulator shape.
 *
 * Persistent stats are accumulated onto `player.statsDelta` during a tick (by the
 * game math) and flushed to SQLite on the rare edge tick where the delta is
 * non-empty (engine.flushStatsDelta) and on disconnect (connection.js). Before
 * this module the zero-shape was hardcoded in THREE places (stealth.bumpStat's
 * lazy-init, engine.anyNonZero, engine.flushStatsDelta's zeroing) — so adding a
 * counter to only some of them meant it silently never persisted or never reset.
 *
 * Centralizing the shape + the bump/has/reset helpers here means a new counter is
 * added in exactly one spot and every site stays correct. This module depends on
 * NOTHING (no require), so stealth.js, follow.js and quests.js can all require it
 * without any cycle.
 *
 * The counters:
 *   - escapes, caught, ordersIssued, abilitiesUsed  (the original four)
 *   - foodCollected     food units picked up from food sources
 *   - animalsStolen     followers stolen away from other players
 *   - questsCompleted   side-quest completions
 *   - escapesBySpecies  { [species]: count } — NOT a flat counter; flushed via a
 *                       JSON read-modify-write in db.incStats (not the col+=x path).
 */

/** A fresh, all-zero delta accumulator. The single definition of the shape. */
function zeroDelta() {
  return {
    escapes: 0,
    caught: 0,
    ordersIssued: 0,
    abilitiesUsed: 0,
    foodCollected: 0,
    animalsStolen: 0,
    questsCompleted: 0,
    escapesBySpecies: {},
  };
}

/**
 * Bump a flat per-player stat counter. Lazily creates the accumulator. No-op on a
 * falsy player. The DB flush (db.incStats) is decoupled — this only accumulates.
 * @param {object} player
 * @param {'escapes'|'caught'|'ordersIssued'|'abilitiesUsed'|'foodCollected'|'animalsStolen'|'questsCompleted'} key
 * @param {number} [by=1]
 */
function bumpStat(player, key, by = 1) {
  if (!player) return;
  player.statsDelta ||= zeroDelta();
  player.statsDelta[key] = (player.statsDelta[key] || 0) + by;
}

/**
 * Record one escape for a given species (the by-species breakdown). Lazily
 * creates the accumulator + its escapesBySpecies map. No-op on a falsy player.
 * @param {object} player
 * @param {string} species
 */
function bumpEscapedSpecies(player, species) {
  if (!player || !species) return;
  player.statsDelta ||= zeroDelta();
  const m = (player.statsDelta.escapesBySpecies ||= {});
  m[species] = (m[species] || 0) + 1;
}

/** True if a delta holds any non-zero scalar OR any by-species escape. */
function hasAny(delta) {
  if (!delta) return false;
  if (
    (delta.escapes || 0) > 0 ||
    (delta.caught || 0) > 0 ||
    (delta.ordersIssued || 0) > 0 ||
    (delta.abilitiesUsed || 0) > 0 ||
    (delta.foodCollected || 0) > 0 ||
    (delta.animalsStolen || 0) > 0 ||
    (delta.questsCompleted || 0) > 0
  ) {
    return true;
  }
  return !!delta.escapesBySpecies && Object.keys(delta.escapesBySpecies).length > 0;
}

/** Zero a delta IN PLACE after a successful flush. */
function reset(delta) {
  if (!delta) return;
  delta.escapes = 0;
  delta.caught = 0;
  delta.ordersIssued = 0;
  delta.abilitiesUsed = 0;
  delta.foodCollected = 0;
  delta.animalsStolen = 0;
  delta.questsCompleted = 0;
  delta.escapesBySpecies = {};
}

module.exports = { zeroDelta, bumpStat, bumpEscapedSpecies, hasAny, reset };
