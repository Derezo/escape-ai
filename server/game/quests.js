'use strict';

/**
 * Per-species side-quest progress + gate-gating (server authoritative), now a
 * MULTI-STEP step engine.
 *
 * Every player carries a `player.quest` object derived from the ONE shared quest
 * model (shared/dist/quests.js, surfaced via world.questForSpecies). The shared
 * def is now an ORDERED list of steps (1..3 per species); this module walks that
 * list one step at a time. The WHOLE quest must be complete before the perimeter
 * gate will let that animal out (see stealth.checkEscape, which calls isComplete()
 * before flipping `escaped`).
 *
 * The wire shape (player.quest) mirrors the CURRENT step at the top level so old
 * client readers keep working, and ships the compact `steps` summary + `stepIndex`
 * for the multi-step HUD (see shared/src/types.ts QuestProgress). It rides the
 * snapshot via toEntity (engine.js forwards player.quest as plain JSON through the
 * Entity index signature — no net.ts change).
 *
 * STEP KINDS the server knows how to advance:
 *   - 'reach'    : stand on your own species' questObject tile (per-tick).
 *   - 'fetch'    : carry the disguise prop to the gate (ape final step, at-gate).
 *   - 'escort'   : reach the gate with >= need live followers (at-gate).
 *   - 'activate' : interact at N DISTINCT keeper terminals (on interact).
 *   - 'collect'  : collect N food units (observes follow.collectNearbyFood).
 *   - 'recruit'  : gain N new followers via feed/steal (observes feedNearbyAnimal).
 *   - 'order'    : land N orders on a robot (observes orderNearestRobot).
 *   - 'ability'  : fire your power N times (observes applyAbility fired===true).
 *
 * SINGLE-WRITER + SINGLE-SCORE: every step advance funnels through advance(); the
 * one bumpStat('questsCompleted') fires EXACTLY ONCE per full quest, the tick the
 * LAST step completes. The per-mechanic counters (foodCollected, animalsStolen,
 * ordersIssued, abilitiesUsed) are owned by follow.js / stealth.js — this module
 * only OBSERVES their success edges and never re-bumps them.
 */

const config = require('../config');
const world = require('./world');
const follow = require('./follow');
const { bumpStat } = require('./stats-delta');
const { secsToTicks } = require('./room-utils');

// Reach radius for the 'reach' step: a generous brush of the species' questObject
// tile counts as "home". RECT_SIZE * 1.5 mirrors the gate's escape reach so
// "arriving" feels the same everywhere.
const REACH_MULT = 1.5;

/** Squared distance between two {x,y} points (local; avoids a stealth.js dep). */
function dist2(a, b) {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  return dx * dx + dy * dy;
}

/**
 * Normalize a shared quest def into an ordered steps[] array of
 * {kind,title,blurb,need}. The shared model is now step-array shaped
 * ({species, questTitle, steps:[...]}); this also tolerates the legacy
 * single-step def ({type,title,blurb,need}) so a stale shared/dist still boots
 * (the shared implementer owns the dist conversion + parity bump).
 * @param {object} def
 * @returns {Array<{kind:string,title:string,blurb:string,need:number}>}
 */
function stepsOf(def) {
  if (def && Array.isArray(def.steps) && def.steps.length > 0) {
    return def.steps.map((s) => ({
      kind: s.kind,
      title: s.title,
      blurb: s.blurb,
      need: Math.max(1, s.need || 1),
    }));
  }
  // Legacy single-step fallback (one step from the flat def).
  return [{
    kind: def.type,
    title: def.title,
    blurb: def.blurb,
    need: Math.max(1, def.need || 1),
  }];
}

/**
 * Build a fresh quest-progress object for a species from the shared def. The top
 * level mirrors the CURRENT step (stepIndex 0) so legacy client readers see the
 * active step; `steps` is the compact per-step summary; per-step `done` lives in
 * the steps array so it can be carried per step if ever needed (today only the
 * active step's done rides the top-level fields).
 * @param {string} species
 * @returns {object} QuestProgress
 */
function makeQuest(species) {
  const def = world.questForSpecies(species);
  const defs = stepsOf(def);
  const steps = defs.map((s) => ({
    kind: s.kind,
    title: s.title,
    blurb: s.blurb,
    need: s.need,
    done: 0,
  }));
  const first = steps[0];
  return {
    type: first.kind,   // legacy alias of the current step's kind
    title: first.title,
    blurb: first.blurb,
    done: 0,            // current step progress
    need: first.need,   // current step target
    complete: false,    // whole-quest done (the gate gate)
    stepIndex: 0,
    steps,
  };
}

/**
 * (Re)initialize a player's quest for its current species, in place. Also clears
 * the per-player terminal-tracking Set used by 'activate' steps and the transient
 * questBlocked stamp. Called on join (lobby.js) and respawn (respawnPlayer) — both
 * build from the player's CURRENT species. Idempotent.
 * @param {object} player
 */
function initPlayer(player) {
  if (!player || !player.species) return;
  player.quest = makeQuest(player.species);
  // Distinct-terminal tracker for 'activate' steps (ids already counted). Scoped
  // to the active step — cleared on each activate-step entry + on reset.
  player.questTerminals = new Set();
  // Transient "you reached the gate without a complete quest" tick stamp.
  player.questBlocked = 0;
}

/**
 * Re-zero a player's quest WITHOUT changing species or re-deriving from a new
 * species def (the CATCH rule — keep the same animal, just restart its quest).
 * Rebuilds steps from questForSpecies(player.species), resets stepIndex/done/
 * complete, and clears the terminal Set. Used by stealth.catchPlayer.
 * @param {object} player
 */
function resetSteps(player) {
  if (!player || !player.species) return;
  // Rebuild from the SAME species (catch keeps species; respawn rolls a new one
  // and goes through initPlayer instead).
  player.quest = makeQuest(player.species);
  player.questTerminals = new Set();
  player.questBlocked = 0;
}

/** True once a player's WHOLE quest is complete (the gate-gate condition). */
function isComplete(player) {
  return !!(player && player.quest && player.quest.complete === true);
}

/** The active step object for a player, or null. */
function currentStep(quest) {
  if (!quest || !Array.isArray(quest.steps)) return null;
  return quest.steps[quest.stepIndex] || null;
}

/** Mirror the active step's fields onto the top level (legacy aliases). Called
 *  after every stepIndex change so the wire shape always reflects the live step. */
function syncTopLevel(quest) {
  const step = currentStep(quest);
  if (!step) return;
  quest.type = step.kind;
  quest.title = step.title;
  quest.blurb = step.blurb;
  quest.need = step.need;
  quest.done = step.done;
}

/**
 * Advance the CURRENT step by `amount` (default 1), pinned to its need. When the
 * current step fills, roll stepIndex forward; when the LAST step fills, mark the
 * whole quest complete and bump 'questsCompleted' EXACTLY ONCE. This is the single
 * funnel every mechanic routes completion through — no per-step questsCompleted.
 * @param {object} player
 * @param {number} [amount=1]  units of progress to add to the current step
 * @returns {boolean} true if the quest became complete on THIS call
 */
function bumpCurrent(player, amount) {
  const quest = player.quest;
  if (!quest || quest.complete) return false;
  const step = currentStep(quest);
  if (!step) return false;

  step.done = Math.min(step.need, step.done + (amount || 1));
  quest.done = step.done; // keep the top-level current-step progress in sync

  if (step.done < step.need) return false;

  // Current step filled — advance.
  if (quest.stepIndex >= quest.steps.length - 1) {
    // LAST step done → the whole quest is complete. Pin stepIndex to the last
    // step and flip complete; this is the single questsCompleted edge.
    quest.complete = true;
    syncTopLevel(quest);
    bumpStat(player, 'questsCompleted');
    return true;
  }

  // Move to the next step, re-zeroed.
  quest.stepIndex += 1;
  const next = currentStep(quest);
  next.done = 0;
  // Entering an 'activate' step starts a fresh distinct-terminal tally.
  if (next.kind === 'activate') player.questTerminals = new Set();
  syncTopLevel(quest);
  return false;
}

// --- per-tick / at-gate completion steps ------------------------------------

/**
 * Per-tick 'reach' advance: if the CURRENT step is a 'reach' and not yet
 * complete, complete it when the player stands within REACH_MULT*RECT_SIZE of its
 * OWN species' questObject. Called from engine.integratePlayers each tick (cheap:
 * a single distance test on a reach step, a no-op otherwise).
 * @param {object} player
 * @param {string} roomName
 */
function stepReach(player, roomName) {
  const quest = player.quest;
  if (!quest || quest.complete) return;
  const step = currentStep(quest);
  if (!step || step.kind !== 'reach') return;
  const target = world
    .getWorldEntities(roomName)
    .find((e) => e.kind === 'questObject' && e.species === player.species);
  if (!target) return;
  const reach = config.RECT_SIZE * REACH_MULT;
  if (dist2(player, target) <= reach * reach) {
    bumpCurrent(player, step.need); // a reach step is satisfied in one go
  }
}

/**
 * 'fetch' advance, evaluated at the gate (stealth.checkEscape): the ape's fetch
 * step completes the instant it is CARRYING the disguise prop AND within the
 * gate's escape reach. Called BEFORE the gate gate, so the same tick the carrier
 * reaches the gate both completes the quest and lets the escape proceed.
 * @param {object} player
 * @param {{x:number,y:number}} gate
 * @param {number} gateReach  the gate's escape reach (world units)
 */
function stepFetchAtGate(player, gate, gateReach) {
  const quest = player.quest;
  if (!quest || quest.complete) return;
  const step = currentStep(quest);
  if (!step || step.kind !== 'fetch') return;
  if (!player.carrying) return;
  if (dist2(player, gate) <= gateReach * gateReach) {
    bumpCurrent(player, step.need);
  }
}

/**
 * 'escort' advance, evaluated at the gate (stealth.checkEscape), alongside
 * stepFetchAtGate and BEFORE the isComplete gate. Completes when the player is
 * within gate escape reach AND has >= need LIVE followers (follow.gatherFollowersOf).
 * It only OBSERVES the herd — it never consumes/scores it (scoreEscape still runs
 * once, after isComplete passes). If the player arrives with too few followers the
 * step simply does not complete; checkEscape's isComplete guard then refuses the
 * escape and the HUD shows done<need so the player knows to re-recruit.
 * @param {object} player
 * @param {string} roomName
 * @param {number} currentTick
 */
function stepEscort(player, roomName, currentTick) {
  const quest = player.quest;
  if (!quest || quest.complete) return;
  const step = currentStep(quest);
  if (!step || step.kind !== 'escort') return;
  const gate = world.getWorldEntities(roomName).find((e) => e.kind === 'gate');
  if (!gate) return;
  const reach = config.RECT_SIZE * 1.5; // mirrors checkEscape's gate reach
  if (dist2(player, gate) > reach * reach) return;
  const herd = follow.gatherFollowersOf(roomName, player.id, currentTick).length;
  if (herd >= step.need) {
    bumpCurrent(player, step.need);
  }
}

// --- event-observing steps (collect / recruit / order / ability) ------------

/**
 * 'collect' advance: observe a successful food pickup (follow.collectNearbyFood
 * bumps foodCollected; this only reads the success). Advances the current step by
 * `amount` units actually collected (default 1) so quest progress tracks the bag.
 * No-op unless the current step is a 'collect'.
 * @param {object} player
 * @param {number} [amount=1]  units collected this press
 */
function onCollect(player, amount) {
  const step = currentStep(player.quest);
  if (!step || step.kind !== 'collect') return;
  bumpCurrent(player, amount || 1);
}

/**
 * 'recruit' advance: observe a NEW follower gained. follow.feedNearbyAnimal
 * returns 'fed' | 'stolen'; both can newly capture, but a pure top-up of an
 * existing follower passes newFollower===false and must NOT count. The caller
 * resolves "new follower" via prevOwner !== player.id at feed time.
 * @param {object} player
 * @param {'fed'|'stolen'|null} result
 * @param {boolean} [newFollower=false]  true if this feed gained a NEW follower
 */
function onRecruit(player, result, newFollower) {
  if (result !== 'fed' && result !== 'stolen') return;
  if (!newFollower) return; // a top-up of an existing follower does not count
  const step = currentStep(player.quest);
  if (!step || step.kind !== 'recruit') return;
  bumpCurrent(player, 1);
}

/**
 * 'order' advance: observe an order that actually landed on a robot
 * (orderNearestRobot bumps ordersIssued past its no-target early-return; this only
 * reads that success). One unit per landed order.
 * @param {object} player
 */
function onOrder(player) {
  const step = currentStep(player.quest);
  if (!step || step.kind !== 'order') return;
  bumpCurrent(player, 1);
}

/**
 * 'ability' advance: observe an ability that actually FIRED (applyAbility bumps
 * abilitiesUsed inside its `if (fired)` block; this only reads that success).
 * need is 1 for every ability step.
 * @param {object} player
 */
function onAbility(player) {
  const step = currentStep(player.quest);
  if (!step || step.kind !== 'ability') return;
  bumpCurrent(player, 1);
}

// --- activate (distinct terminals) ------------------------------------------

/** True if the player is within RECT_SIZE of any terminal; returns the nearest
 *  terminal entity (or null) so 'activate' can count it by id. The SINGLE source
 *  of truth for the terminal scan — stealth.js's 'interact' branch reuses this
 *  (via the exported alias) rather than re-walking the entity list. */
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
 * True if `term`'s shared activation lock is currently held by SOMEONE ELSE (not
 * `player`) and still within the DEACTIVATE_SECS window. Such a terminal is
 * unavailable to `player` this interact — no quest count, no terminal-driven robot
 * order. A free terminal, an expired lock, or the player's OWN lock all return
 * false (own re-tap stays a harmless no-op, idempotent via questTerminals.has).
 * Pure read of the world entity; never mutates. Centralizes the lock math so the
 * stealth 'interact' guard and onInteract agree.
 * @param {object} term         a kind:'terminal' world entity (or null)
 * @param {object} player       the acting player
 * @param {number} currentTick
 * @returns {boolean}
 */
function isTerminalLockedByOther(term, player, currentTick) {
  if (!term || !term.activatedBy) return false;
  if (term.activatedBy === player.id) return false; // my own lock — not blocked
  const expiresAt = (term.activatedTick || 0) + secsToTicks(config.TERMINAL.DEACTIVATE_SECS);
  return expiresAt > currentTick; // still within the lock window
}

/**
 * 'activate' advance, fired from applyAction's 'interact' branch: if the CURRENT
 * step is an 'activate' and the player is near a terminal it hasn't tapped before,
 * count that DISTINCT terminal toward the step's need. The distinct-terminal Set
 * is reset per activate step (in bumpCurrent on entry + in resetSteps), so a
 * multi-step quest revisiting terminals starts each activate step's tally fresh.
 * No-op for non-activate steps or repeat taps of the same terminal. A terminal
 * currently locked by ANOTHER player (within DEACTIVATE_SECS) is unavailable — no
 * count. On a real new count it STAMPS the shared world-entity lock
 * (term.activatedBy/activatedTick) so everyone sees it and other players are
 * blocked until the 15s sweep (world.pruneExpired) clears it. The lock is the
 * VISUAL/CONTENTION lock only — it never touches the per-player questTerminals
 * tally (the permanent quest source of truth).
 * @param {object} player
 * @param {string} roomName
 * @param {number} currentTick
 * @returns {boolean} true if progress was made this call (a new terminal counted)
 */
function onInteract(player, roomName, currentTick) {
  const quest = player.quest;
  if (!quest || quest.complete) return false;
  const step = currentStep(quest);
  if (!step || step.kind !== 'activate') return false;
  const term = nearestTerminal(player, roomName);
  if (!term) return false;
  // Locked by another player within the 15s window → unavailable to me this tap.
  if (isTerminalLockedByOther(term, player, currentTick)) return false;
  if (!player.questTerminals) player.questTerminals = new Set();
  if (player.questTerminals.has(term.id)) return false; // already counted
  player.questTerminals.add(term.id);
  // Stamp the SHARED world-entity lock (drives the LED + blocks others). This is
  // a property of the world entity, NOT the player tally — the 15s auto-deactivate
  // clears ONLY these fields and leaves questTerminals untouched.
  term.activatedBy = player.id;
  term.activatedTick = currentTick;
  // done is the distinct-terminal count, capped at need. Drive the step to exactly
  // that value (rather than +1) so the Set is always the source of truth.
  const target = Math.min(step.need, player.questTerminals.size);
  const delta = target - step.done;
  if (delta > 0) bumpCurrent(player, delta);
  return true;
}

module.exports = {
  makeQuest,
  initPlayer,
  resetSteps,
  isComplete,
  // per-tick / at-gate
  stepReach,
  stepFetchAtGate,
  stepEscort,
  // event-observing
  onCollect,
  onRecruit,
  onOrder,
  onAbility,
  onInteract,
  // terminal scan + lock helpers (single source of truth; stealth.js reuses them
  // in the 'interact' branch so the scan isn't duplicated).
  nearestTerminal,
  isTerminalLockedByOther,
};
