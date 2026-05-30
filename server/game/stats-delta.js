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
 *   - ownEscapesBySpecies { [species]: count } — the player's OWN gate escapes by
 *                       the species it WAS (excludes followers; the denominator for
 *                       average escape time). JSON, like escapesBySpecies.
 *   - escapeSecsBySpecies { [species]: seconds } — cumulative spawn→gate time, by
 *                       the player's species. Paired with ownEscapesBySpecies to
 *                       derive an average. JSON read-modify-write (summed).
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
    ownEscapesBySpecies: {},
    escapeSecsBySpecies: {},
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
 * Record one escape for a given species (the by-species breakdown — counts the
 * player's OWN animal plus every follower led out, each by its own species).
 * Lazily creates the accumulator + its escapesBySpecies map. No-op on a falsy
 * player.
 * @param {object} player
 * @param {string} species
 */
function bumpEscapedSpecies(player, species) {
  if (!player || !species) return;
  player.statsDelta ||= zeroDelta();
  const m = (player.statsDelta.escapesBySpecies ||= {});
  m[species] = (m[species] || 0) + 1;
}

/**
 * Record the player's OWN escape (one per gate pass, the species it WAS) plus how
 * long that run took, so an average escape-time per species can be derived
 * (escapeSecsBySpecies / ownEscapesBySpecies). Followers are NOT counted here —
 * only the player's own spawn→gate duration. Lazily creates the accumulator + its
 * maps. No-op on a falsy player/species; a non-finite/negative duration still
 * counts the escape but adds no time.
 * @param {object} player
 * @param {string} species   the species the player escaped AS
 * @param {number} secs      spawn→gate elapsed time in seconds
 */
function bumpOwnEscape(player, species, secs) {
  if (!player || !species) return;
  player.statsDelta ||= zeroDelta();
  const counts = (player.statsDelta.ownEscapesBySpecies ||= {});
  counts[species] = (counts[species] || 0) + 1;
  const s = Number(secs);
  if (Number.isFinite(s) && s > 0) {
    const times = (player.statsDelta.escapeSecsBySpecies ||= {});
    times[species] = (times[species] || 0) + s;
  }
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
  // Any non-empty by-species map (escapes, own-escape counts, or escape-time sums)
  // also makes the delta worth a flush.
  return (
    (!!delta.escapesBySpecies && Object.keys(delta.escapesBySpecies).length > 0) ||
    (!!delta.ownEscapesBySpecies && Object.keys(delta.ownEscapesBySpecies).length > 0) ||
    (!!delta.escapeSecsBySpecies && Object.keys(delta.escapeSecsBySpecies).length > 0)
  );
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
  delta.ownEscapesBySpecies = {};
  delta.escapeSecsBySpecies = {};
}

module.exports = { zeroDelta, bumpStat, bumpEscapedSpecies, bumpOwnEscape, hasAny, reset };
