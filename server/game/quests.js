'use strict';

/**
 * Per-species side-quest progress + gate-gating (Phase 6, server authoritative).
 *
 * Every player carries a tiny `player.quest` object derived from the ONE shared
 * quest model (shared/dist/quests.js, surfaced via world.questForSpecies). The
 * quest must be COMPLETE before the perimeter gate will let that animal out (see
 * stealth.checkEscape, which calls isComplete() before flipping `escaped`).
 *
 * Three mechanics, one small advance() each:
 *   - 'reach'    : stand on your own species' questObject tile (done = need = 1).
 *   - 'activate' : interact at N DISTINCT keeper terminals (done counts up to need).
 *   - 'fetch'    : carry the disguise prop to the gate (done = need = 1, at the
 *                  gate). The fetch completes the same tick the carrier reaches
 *                  the gate, so the escape can proceed immediately.
 *
 * The quest object rides the snapshot via toEntity (engine.js forwards
 * player.quest as plain JSON through the Entity index signature — no net.ts
 * change). This module owns ONLY the progress rules; geometry is local squared-
 * distance so quests.js has no dependency on stealth.js (which requires it).
 */

const config = require('../config');
const world = require('./world');

// Reach radius for the 'reach' quest: a generous brush of the species'
// questObject tile counts as "home". RECT_SIZE * 1.5 mirrors the gate's escape
// reach (stealth.checkEscape) so "arriving" feels the same everywhere.
const REACH_MULT = 1.5;

/** Squared distance between two {x,y} points (local; avoids a stealth.js dep). */
function dist2(a, b) {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  return dx * dx + dy * dy;
}

/**
 * Build a fresh quest-progress object for a species from the shared def. Called
 * on join (lobby.js) and on respawn (stealth.respawnPlayer) so a player always
 * carries the quest for its CURRENT species, reset to zero progress.
 * @param {string} species
 * @returns {{type:string,title:string,blurb:string,done:number,need:number,complete:boolean}}
 */
function makeQuest(species) {
  const def = world.questForSpecies(species);
  return {
    type: def.type,
    title: def.title,
    blurb: def.blurb,
    done: 0,
    need: def.need,
    complete: false,
  };
}

/**
 * (Re)initialize a player's quest for its current species, in place. Also clears
 * the per-player terminal-tracking Set used by 'activate' quests and the
 * transient questBlocked stamp. Idempotent.
 * @param {object} player
 */
function initPlayer(player) {
  if (!player || !player.species) return;
  player.quest = makeQuest(player.species);
  // Distinct-terminal tracker for 'activate' quests (ids already counted).
  player.questTerminals = new Set();
  // Transient "you reached the gate without a complete quest" tick stamp.
  player.questBlocked = 0;
}

/** True once a player's quest is complete (the gate-gate condition). */
function isComplete(player) {
  return !!(player && player.quest && player.quest.complete === true);
}

/**
 * Mark a quest complete (idempotent). Centralized so every mechanic flips the
 * same fields the same way: done is pinned to need, complete set true.
 * @param {object} quest
 */
function markComplete(quest) {
  quest.done = quest.need;
  quest.complete = true;
}

/**
 * Per-tick 'reach' advance: if the player's quest is a 'reach' and it's not yet
 * complete, complete it when the player stands within REACH_MULT*RECT_SIZE of its
 * OWN species' questObject. Called from engine.integratePlayers each tick (cheap:
 * a single distance test for reach-type players, a no-op for others).
 * @param {object} player
 * @param {string} roomName
 */
function stepReach(player, roomName) {
  const quest = player.quest;
  if (!quest || quest.complete || quest.type !== 'reach') return;
  const target = world
    .getWorldEntities(roomName)
    .find((e) => e.kind === 'questObject' && e.species === player.species);
  if (!target) return;
  const reach = config.RECT_SIZE * REACH_MULT;
  if (dist2(player, target) <= reach * reach) {
    markComplete(quest);
  }
}

/** True if the player is within RECT_SIZE of any terminal; returns the nearest
 *  terminal entity (or null) so 'activate' can count it by id. */
function nearestTerminal(player, roomName) {
  const r2 = config.RECT_SIZE * config.RECT_SIZE;
  let nearest = null;
  let nearestD2 = Infinity;
  for (const e of world.getWorldEntities(roomName)) {
    if (e.kind !== 'terminal') continue;
    const d2 = dist2(player, e);
    if (d2 <= r2 && d2 < nearestD2) {
      nearestD2 = d2;
      nearest = e;
    }
  }
  return nearest;
}

/**
 * 'activate' advance, fired from applyAction's 'interact' branch: if the player's
 * quest is an 'activate' and it's near a terminal it hasn't tapped before, count
 * that DISTINCT terminal toward `need`. Completes when done >= need. No-op for
 * non-activate quests or repeat taps of the same terminal.
 * @param {object} player
 * @param {string} roomName
 * @returns {boolean} true if progress was made this call (a new terminal counted)
 */
function onInteract(player, roomName) {
  const quest = player.quest;
  if (!quest || quest.complete || quest.type !== 'activate') return false;
  const term = nearestTerminal(player, roomName);
  if (!term) return false;
  if (!player.questTerminals) player.questTerminals = new Set();
  if (player.questTerminals.has(term.id)) return false; // already counted
  player.questTerminals.add(term.id);
  quest.done = Math.min(quest.need, player.questTerminals.size);
  if (quest.done >= quest.need) markComplete(quest);
  return true;
}

/**
 * 'fetch' advance, evaluated at the gate (stealth.checkEscape): the ape's quest
 * completes the instant it is CARRYING the disguise prop AND within the gate's
 * escape reach. Called BEFORE the gate check, so the same tick the carrier
 * reaches the gate both completes the quest and lets the escape proceed.
 * @param {object} player
 * @param {{x:number,y:number}} gate
 * @param {number} gateReach  the gate's escape reach (world units)
 */
function stepFetchAtGate(player, gate, gateReach) {
  const quest = player.quest;
  if (!quest || quest.complete || quest.type !== 'fetch') return;
  if (!player.carrying) return;
  if (dist2(player, gate) <= gateReach * gateReach) {
    markComplete(quest);
  }
}

module.exports = {
  makeQuest,
  initPlayer,
  isComplete,
  stepReach,
  onInteract,
  stepFetchAtGate,
};
