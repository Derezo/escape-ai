'use strict';

/**
 * Server-side bridge to the shared species roster.
 *
 * The roster is the ONE source of truth in shared/src/species.ts (compiled to
 * shared/dist/species.js, ESM). The server is CommonJS, so — exactly like
 * game/stealth.js loads shared/dist/step.js — we dynamic-import() the ESM module
 * ONCE at boot and cache `SPECIES_KEYS`, then serve synchronous lookups. This
 * keeps lobby.js's spawn/ability assignment from drifting out of a hand-copied
 * literal; no second roster lives in the server.
 *
 * Until load() resolves, the cache is null and the synchronous accessors fall
 * back gracefully (isPlayableSpecies → false; getKeys → []). index.js awaits
 * load() before the engine starts, so by the time any client connects the cache
 * is warm.
 */

// Cached, in roster (join-cycle) order. Null until load() resolves.
let speciesKeys = null;
let isPlayable = null; // cached shared isPlayableSpecies (validates exact membership)

/**
 * Load + cache the shared species roster. Idempotent; call once at boot.
 * Throws if the expected exports are missing — fail loud rather than fall back
 * to a stale copy.
 * @returns {Promise<string[]>} the cached species keys
 */
async function load() {
  if (speciesKeys) return speciesKeys;
  // Relative to this file (server/socket/) -> shared/dist/species.js.
  const mod = await import('../../shared/dist/species.js');
  if (!Array.isArray(mod.SPECIES_KEYS) || typeof mod.isPlayableSpecies !== 'function') {
    throw new Error(
      'shared/dist/species.js is missing SPECIES_KEYS / isPlayableSpecies. ' +
      'Did you run `npm run build` in shared/?'
    );
  }
  speciesKeys = mod.SPECIES_KEYS.slice();
  isPlayable = mod.isPlayableSpecies;
  return speciesKeys;
}

/** The cached species keys in join-cycle order (empty until load() resolves). */
function getKeys() {
  return speciesKeys || [];
}

/** True if `key` is a valid playable species (false until load() resolves). */
function isPlayableSpecies(key) {
  return isPlayable ? isPlayable(key) : false;
}

module.exports = { load, getKeys, isPlayableSpecies };
