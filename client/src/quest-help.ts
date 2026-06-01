/**
 * Quest step help — the human-readable "what do I actually do?" text for the
 * current quest step, surfaced by the HUD's ⓘ info icon (main.ts builds the icon +
 * the detail panel; this module owns the COPY).
 *
 * Some steps have a guide arrow (collect/recruit/activate/order/fetch/escort/reach
 * all resolve a world target in main.ts's questGuideFor); the 'ability' steps
 * deliberately have NONE — the action fires anywhere, so there's nothing to point
 * at. That left ability-first quests (owl "Hush the alarm", mole "Burrow once",
 * chameleon "Cloak once") reading as a mystery: no arrow AND no hint of which key
 * performs the action. This text closes that gap for EVERY step by pairing the
 * action+keybind with the step's flavor blurb.
 *
 * Keybinds mirror ACTION_KEYS in main.ts (E interact/collect, Q order, Space
 * ability, F feed) — keep them in sync.
 */

import { speciesByKey } from '@shared/species';

/** The current quest step, as the client sees it on its own snapshot entity. */
export interface QuestStepInfo {
  /** Current step mechanic (QuestProgress.type — always steps[stepIndex].kind). */
  kind: string;
  /** The step's one-line flavor (QuestProgress.blurb). */
  blurb: string;
  /** The owner's species, for the ability verb on 'ability' steps. */
  species: string;
  /** Target count for the step (need > 1 → "two", etc., kept simple as the number). */
  need: number;
}

/**
 * The concrete "do this" instruction for a step kind — the action + keybind, so the
 * player knows exactly what to press. For 'ability' it names the species' own verb
 * (owl → hush, mole → burrow) so "Hush the alarm" becomes "Press Space to hush".
 */
export function questActionHint(info: QuestStepInfo): string {
  const n = info.need > 1 ? info.need : 1;
  switch (info.kind) {
    case 'ability': {
      const verb = speciesByKey(info.species)?.ability ?? 'use your ability';
      return `Press Space to ${verb} — it counts the moment it fires, anywhere.`;
    }
    case 'collect':
      return n > 1
        ? `Press E at a feeding station to gather food — ${n} times.`
        : `Press E at a feeding station to gather food.`;
    case 'recruit':
      return n > 1
        ? `Carry an animal's food, then press F beside it to recruit it — ${n} animals. The arrow points at one you can feed right now (or at food if your bag is empty).`
        : `Carry an animal's food, then press F beside it to recruit it. The arrow points at one you can feed right now (or at food if your bag is empty).`;
    case 'activate':
      return `Press E at a keeper terminal — ${n} different ones. The arrow routes you to the next free console.`;
    case 'order':
      return n > 1
        ? `Press Q next to a robot (or E at a terminal) to order it — ${n} times.`
        : `Press Q next to a robot (or E at a terminal) to order one aside.`;
    case 'fetch':
      return `Press E to grab the Clipboard, then carry it out through the gate (the arrow points there).`;
    case 'escort':
      return n > 1
        ? `Lead your ${n} followers out through the gate together — keep them close so the herd holds.`
        : `Lead your follower out through the gate (the arrow points there).`;
    case 'reach':
      return `Head back to your own home — the arrow points at it.`;
    default:
      return `Follow the arrow to your objective.`;
  }
}

/**
 * The full detail text for the ⓘ panel: the action instruction first (what to
 * press), then the step's flavor blurb for context. Two lines joined by a newline;
 * the panel renders them stacked.
 */
export function questHelpText(info: QuestStepInfo): string {
  const action = questActionHint(info);
  const blurb = info.blurb?.trim();
  return blurb ? `${action}\n${blurb}` : action;
}
