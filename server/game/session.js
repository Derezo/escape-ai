'use strict';

/**
 * Session snapshot (de)serialization — the ONE place that knows the shape of a
 * persisted mid-run player so db.saveSession / db.loadSession stay opaque.
 *
 * A snapshot is the full resumable state: which species the player is, where it
 * was, its side-quest progress (incl. the tapped-terminal Set → array), its food
 * bag, its running score, and the room + that room's worldVersion. The version
 * stamp lets the resume path reject a save made against a DIFFERENT world layout
 * (a WORLD_GEN_VERSION bump moves tiles) and fall back to a clean pen spawn rather
 * than drop the player into a wall.
 *
 * Pure data transforms — no DB, no socket, no clock. The engine/connection layers
 * call snapshot() and hand the result to db.saveSession; lobby.js calls restore()
 * with a loaded snapshot to rebuild the live player fields.
 */

const world = require('./world');

/**
 * Build a persistable snapshot of a live player's mid-run state. Returns null if
 * the player has no room (nothing meaningful to resume).
 * @param {object} player  the live server player object
 * @returns {object|null}
 */
function snapshot(player) {
  if (!player || !player.room) return null;
  const meta = world.getMapMeta(player.room);
  const quest = player.quest
    ? {
        type: player.quest.type,
        done: player.quest.done,
        need: player.quest.need,
        complete: player.quest.complete === true,
      }
    : null;
  return {
    worldVersion: meta ? meta.version : undefined,
    room: player.room,
    species: player.species,
    x: player.x,
    y: player.y,
    quest,
    // The distinct-terminal tracker is a Set on the live player; persist as an array.
    questTerminals:
      player.questTerminals instanceof Set ? [...player.questTerminals] : [],
    inventory:
      player.inventory && typeof player.inventory === 'object' ? { ...player.inventory } : {},
    scoreTotal: Number(player.scoreTotal) || 0,
  };
}

/**
 * Whether a loaded snapshot is usable for the given room: it exists, is for the
 * SAME room, and was saved against the room's CURRENT worldVersion (so its saved
 * x/y still map onto the same tiles). A mismatch means the caller should fall back
 * to a fresh pen spawn for the snapshot's species.
 * @param {object|undefined} snap
 * @param {string} roomName
 * @returns {boolean}
 */
function isUsableFor(snap, roomName) {
  if (!snap || typeof snap !== 'object') return false;
  if (snap.room !== roomName) return false;
  const meta = world.getMapMeta(roomName);
  return !!meta && snap.worldVersion === meta.version;
}

/**
 * Apply a loaded snapshot onto a freshly-built player object, IN PLACE. Restores
 * position, quest progress (rehydrating the terminal Set), inventory, and score.
 * Species is assumed already set on the player (the caller resolves it from the
 * snapshot before quest/spawn init). Only call when isUsableFor(snap, room) — the
 * caller owns the version-mismatch fallback (fresh pen spawn). The post-respawn
 * grace (spawnSafeUntilTick) is also the caller's job (it needs currentTick).
 * @param {object} player
 * @param {object} snap
 */
function restore(player, snap) {
  if (!player || !snap) return;
  if (typeof snap.x === 'number' && typeof snap.y === 'number') {
    player.x = snap.x;
    player.y = snap.y;
  }
  if (snap.quest && player.quest) {
    // Restore progress onto the freshly-derived quest (same species → same type/need).
    player.quest.done = Number(snap.quest.done) || 0;
    player.quest.complete = snap.quest.complete === true;
  }
  player.questTerminals = new Set(Array.isArray(snap.questTerminals) ? snap.questTerminals : []);
  player.inventory =
    snap.inventory && typeof snap.inventory === 'object' ? { ...snap.inventory } : {};
  player.scoreTotal = Number(snap.scoreTotal) || 0;
}

module.exports = { snapshot, isUsableFor, restore };
