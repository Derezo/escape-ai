/**
 * Per-species side-quests — the ONE source of truth for what each animal must do
 * before the gate will let it out. Shared by:
 *   - the server (initializes + advances quest progress, gates the escape in
 *     server/game/quests.js + stealth.js),
 *   - the client HUD (surfaces the active quest's title + progress, main.ts),
 *   - the help widget's Goal blurb (client/src/help.ts).
 *
 * Three underlying mechanics keep the SERVER logic small while the flavor varies
 * per species:
 *   - 'fetch'    (ape only): carry the disguise Clipboard to the gate (need 1).
 *   - 'activate' (the robot-controllers — elephant, peacock, parrot): tap N
 *                distinct keeper terminals (need 3).
 *   - 'reach'    (the other ten): walk back to your own enclosure / home
 *                (need 1) — completes when you stand on your species' quest
 *                object tile.
 *
 * PURE + DETERMINISTIC: no Math.random / Date.now. The table is a fixed literal,
 * keyed by species, so questForSpecies(key) is a pure lookup. This mirrors the
 * species roster's purity contract (species.ts) — the quest definitions can never
 * drift between client and server.
 */

import { SPECIES_KEYS } from './species.js';

/** The three underlying quest mechanics the server knows how to advance. */
export type QuestType = 'reach' | 'fetch' | 'activate';

/** One species' side-quest: identity + mechanic + the copy the UI shows. */
export interface QuestDef {
  /** The species key this quest belongs to (matches SPECIES_KEYS). */
  species: string;
  /** Which mechanic the server advances it with. */
  type: QuestType;
  /** Short HUD title (≤ ~22 chars), e.g. "Reach your den". */
  title: string;
  /** One-line, ability-themed flavor shown in the help / on hover. */
  blurb: string;
  /** Target count: reach/fetch = 1, activate = 3. */
  need: number;
}

/** How many distinct terminals an 'activate' quest needs. */
const ACTIVATE_NEED = 3;

/**
 * The fixed species → quest assignment. Every species in SPECIES_KEYS has an
 * entry; this is the single place that decides each animal's side-quest. Themed
 * to each species' identity / housing kind (see world.ts SPECIES_HOUSING). Titles
 * are kept short for the HUD; blurbs carry the ability-flavored line.
 */
export const QUEST_BY_SPECIES: Record<string, QuestDef> = {
  // FETCH — the ape is the disguise courier; its quest is to deliver the prop.
  ape: {
    species: 'ape',
    type: 'fetch',
    title: 'Courier the Clipboard',
    blurb: 'Carry the disguise Clipboard all the way to the gate and walk it out.',
    need: 1,
  },

  // ACTIVATE — the robot-controllers tap keeper terminals to open the way.
  elephant: {
    species: 'elephant',
    type: 'activate',
    title: 'Tap 3 terminals',
    blurb: 'Lean on three keeper terminals — your bulk forces every console it touches.',
    need: ACTIVATE_NEED,
  },
  peacock: {
    species: 'peacock',
    type: 'activate',
    title: 'Tap 3 terminals',
    blurb: 'Dazzle three keeper terminals into standing the patrols down.',
    need: ACTIVATE_NEED,
  },
  parrot: {
    species: 'parrot',
    type: 'activate',
    title: 'Tap 3 terminals',
    blurb: 'Mimic the keeper codes at three terminals to clear your route.',
    need: ACTIVATE_NEED,
  },

  // REACH — the other ten return to their own home before slipping out.
  bird: {
    species: 'bird',
    type: 'reach',
    title: 'Return to the aviary',
    blurb: 'Flit home to your aviary perch one last time before the break.',
    need: 1,
  },
  rat: {
    species: 'rat',
    type: 'reach',
    title: 'Back to your cage',
    blurb: 'Skitter back through the bars to your cage to grab your stash.',
    need: 1,
  },
  chameleon: {
    species: 'chameleon',
    type: 'reach',
    title: 'Reach the reptile house',
    blurb: 'Cloak your way back into the reptile house to gather your nerve.',
    need: 1,
  },
  skunk: {
    species: 'skunk',
    type: 'reach',
    title: 'Den up first',
    blurb: 'Slink back to your den before you stink up the whole escape.',
    need: 1,
  },
  mole: {
    species: 'mole',
    type: 'reach',
    title: 'Tunnel home',
    blurb: 'Burrow back to your den mound and surface where you started.',
    need: 1,
  },
  cheetah: {
    species: 'cheetah',
    type: 'reach',
    title: 'Sprint to your paddock',
    blurb: 'Dash a victory lap back to your paddock before the long run.',
    need: 1,
  },
  tortoise: {
    species: 'tortoise',
    type: 'reach',
    title: 'Bask at your pond',
    blurb: 'Plod back to your pond for one last bask, shell and all.',
    need: 1,
  },
  kangaroo: {
    species: 'kangaroo',
    type: 'reach',
    title: 'Bound to your pen',
    blurb: 'Leap back into your pen to gather the mob before you bolt.',
    need: 1,
  },
  owl: {
    species: 'owl',
    type: 'reach',
    title: 'Return to your roost',
    blurb: 'Wing it home to your roost and hush the night before you go.',
    need: 1,
  },
  fox: {
    species: 'fox',
    type: 'reach',
    title: 'Slip back to your den',
    blurb: 'Slip past the keepers to your den and leave a decoy behind.',
    need: 1,
  },
};

/**
 * The quest for a species — a pure, deterministic lookup. Falls back to a generic
 * 'reach' quest for an unknown key (never expected for a playable species, but
 * keeps the function total so callers never get undefined).
 */
export function questForSpecies(species: string): QuestDef {
  const def = QUEST_BY_SPECIES[species];
  if (def) return def;
  return {
    species,
    type: 'reach',
    title: 'Reach your home',
    blurb: 'Find your enclosure before the gate will let you out.',
    need: 1,
  };
}

/** Every species in SPECIES_KEYS has exactly one quest def (parity invariant). */
export const QUEST_COUNT: number = SPECIES_KEYS.filter(
  (k) => QUEST_BY_SPECIES[k] !== undefined,
).length;
