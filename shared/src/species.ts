/**
 * The playable species roster — the ONE source of truth shared by:
 *   - the server (spawn/ability assignment in server/socket/lobby.js),
 *   - the client login species selector (client/src/menu.ts),
 *   - the help widget's Species tab (client/src/help.ts).
 *
 * Each entry pairs a species key (which IS the atlas frame prefix and the
 * server's ability switch key) with its human-readable label, its ability verb,
 * the FxKind it fires, and a one-line player-facing blurb. Keeping this here
 * means the roster, the art contract, and the in-game copy can never drift.
 *
 * MUST stay in lockstep with scripts/sprites/registry.js (every species needs
 * atlas art) and server/game/stealth.js (every species needs an ability).
 */

import type { FxKind } from './types.js';

/** One playable species: identity + ability + the copy the UI shows for it. */
export interface SpeciesInfo {
  /** Atlas frame prefix AND the server ability-switch key (e.g. 'ape'). */
  key: string;
  /** Display name (e.g. 'Ape'). */
  label: string;
  /** The ability's verb (e.g. 'carry'). */
  ability: string;
  /** Which client FX the ability fires — mirrors FxKind. */
  fx: FxKind;
  /** One-line player-facing description of what the ability does. */
  blurb: string;
}

/**
 * The 14 playable species in join-cycle order. (The keeper `robot` is an NPC,
 * not playable, so it is not in this list.) Order matters: the server assigns a
 * species by join index modulo this length, so this array's order IS the
 * round-robin spawn order.
 */
export const SPECIES: SpeciesInfo[] = [
  { key: 'ape',       label: 'Ape',       ability: 'carry',   fx: 'carry',   blurb: 'Carries the disguise Clipboard — the courier; the prop keeps a carrier looking human on the move.' },
  { key: 'bird',      label: 'Bird',      ability: 'flit',    fx: 'flit',    blurb: 'A brief hop over reach — momentarily uncatchable.' },
  { key: 'rat',       label: 'Rat',       ability: 'skitter', fx: 'skitter', blurb: 'Briefly unseen by robot perception — squeeze past.' },
  { key: 'elephant',  label: 'Elephant',  ability: 'shove',   fx: 'shove',   blurb: 'Stun & push a robot — loud, so it bumps the panic meter.' },
  { key: 'chameleon', label: 'Chameleon', ability: 'cloak',   fx: 'cloak',   blurb: 'Perfect disguise: humanLikeness floored even while moving — the premier First-Law tool.' },
  { key: 'peacock',   label: 'Peacock',   ability: 'dazzle',  fx: 'dazzle',  blurb: 'Area stand-down: every robot in range is ordered at once. Loud.' },
  { key: 'skunk',     label: 'Skunk',     ability: 'stink',   fx: 'stink',   blurb: 'Drops a lingering hazard zone robots refuse to enter (Third-Law self-preservation).' },
  { key: 'mole',      label: 'Mole',      ability: 'burrow',  fx: 'burrow',  blurb: 'Teleport along your facing, then briefly unseen on resurfacing.' },
  { key: 'cheetah',   label: 'Cheetah',   ability: 'dash',    fx: 'dash',    blurb: 'A speed burst — but fast reads as prey, so your disguise crashes.' },
  { key: 'parrot',    label: 'Parrot',    ability: 'mimic',   fx: 'mimic',   blurb: 'Orders the nearest robot WITH NO suspicion — a perfect human-voice mimic. Still stokes panic.' },
  { key: 'tortoise',  label: 'Tortoise',  ability: 'shell',   fx: 'shell',   blurb: 'Pull into your shell: immovable, uncatchable, humanLikeness held.' },
  { key: 'kangaroo',  label: 'Kangaroo',  ability: 'leap',    fx: 'leap',    blurb: 'A long hop along your facing — uncatchable mid-air.' },
  { key: 'owl',       label: 'Owl',       ability: 'hush',    fx: 'hush',    blurb: 'Drains panic off the room meter — the anti-overflow team utility.' },
  { key: 'fox',       label: 'Fox',       ability: 'decoy',   fx: 'decoy',   blurb: 'Spawns a human-looking decoy robots prefer to chase, peeling pursuit off the team.' },
];

/** Just the species keys, in roster order (server convenience). */
export const SPECIES_KEYS: string[] = SPECIES.map((s) => s.key);

/** Fast lookup by key. Returns undefined for unknown keys (e.g. 'robot'). */
export function speciesByKey(key: string): SpeciesInfo | undefined {
  return SPECIES.find((s) => s.key === key);
}

/** True if `key` is a valid playable species (used to validate join payloads). */
export function isPlayableSpecies(key: unknown): key is string {
  return typeof key === 'string' && SPECIES_KEYS.includes(key);
}
