/**
 * Per-species liked food — the ONE source of truth for what each animal will
 * follow you out for. Shared by:
 *   - the world generator (places one food source per species in its home,
 *     shared/src/world.ts),
 *   - the server (collect/feed/follow rules in server/game/follow.js, which reads
 *     the table via the same dynamic-import-and-cache as quests),
 *   - the client (inventory overlay + food-source tint/label in
 *     client/src/inventory.ts + render/phaser.ts).
 *
 * ONE food per species, each liked by EXACTLY ONE species, chosen to be
 * species-appropriate by common knowledge (ape→banana, elephant→peanuts, …).
 * Feeding an animal its liked food recruits it as a follower; the species→food
 * mapping is 1:1 so "find the right food" is a real sub-goal.
 *
 * PURE + DETERMINISTIC: a fixed literal table keyed by species, mirroring the
 * quests.ts / species.ts purity contract — the mapping can never drift between
 * client and server. `foodForSpecies(key)` is TOTAL (never undefined) so the
 * generator and server never have to branch on a missing entry.
 */

import { SPECIES_KEYS } from './species.js';

/** One species' liked food: identity + the copy/art hints the UI shows for it. */
export interface FoodDef {
  /** The species that likes this food (matches SPECIES_KEYS). */
  species: string;
  /** Stable food key — inventory map key, entity.foodKey, world spec meta.foodKey. */
  key: string;
  /** Display label, e.g. 'Banana'. */
  label: string;
  /** 0xRRGGBB renderer tint for the on-map food source + inventory chip. */
  tint: number;
  /** Emoji fallback for the DOM inventory chip (zero-art). */
  icon: string;
  /** One-line player-facing flavor. */
  blurb: string;
}

/**
 * The fixed species → liked-food assignment. Every species in SPECIES_KEYS has
 * exactly one entry; this is the single place that decides each animal's food.
 * Each `key` is unique (no two foods share one) and `skunk` ≠ `mole`.
 */
export const FOOD_BY_SPECIES: Record<string, FoodDef> = {
  ape:       { species: 'ape',       key: 'banana',     label: 'Banana',      tint: 0xffd24a, icon: '🍌', blurb: 'A ripe banana — no ape can resist trailing it out.' },
  bird:      { species: 'bird',      key: 'seeds',      label: 'Seed Mix',    tint: 0xd8b46a, icon: '🌾', blurb: 'A scatter of songbird seed — the little flyer trails right after.' },
  rat:       { species: 'rat',       key: 'cheese',     label: 'Cheese',      tint: 0xf2c94c, icon: '🧀', blurb: 'A pungent wedge of cheese — the rat will shadow you for it.' },
  elephant:  { species: 'elephant',  key: 'peanuts',    label: 'Peanuts',     tint: 0xc8a26a, icon: '🥜', blurb: 'A trunkful of peanuts — the elephant lumbers along behind you.' },
  chameleon: { species: 'chameleon', key: 'crickets',   label: 'Crickets',    tint: 0x8fae5a, icon: '🦗', blurb: 'Live crickets — the chameleon stalks them all the way to the gate.' },
  peacock:   { species: 'peacock',   key: 'berries',    label: 'Berries',     tint: 0x9b59b6, icon: '🫐', blurb: 'A handful of bright berries — the peacock struts after them.' },
  skunk:     { species: 'skunk',     key: 'grubs',      label: 'Grubs',       tint: 0xb08968, icon: '🐛', blurb: 'Fat grubs — the skunk snuffles along in your wake.' },
  mole:      { species: 'mole',      key: 'earthworms', label: 'Earthworms',  tint: 0xd98ca0, icon: '🪱', blurb: 'A can of earthworms — the mole surfaces and follows the smell.' },
  cheetah:   { species: 'cheetah',   key: 'steak',      label: 'Raw Steak',   tint: 0xc0392b, icon: '🥩', blurb: 'A slab of raw meat — the cheetah pads after the scent of blood.' },
  parrot:    { species: 'parrot',    key: 'cracker',    label: 'Cracker',     tint: 0xe8c468, icon: '🍪', blurb: '"Polly want a cracker?" — the parrot follows you anywhere for it.' },
  tortoise:  { species: 'tortoise',  key: 'lettuce',    label: 'Lettuce',     tint: 0x7fbf5a, icon: '🥬', blurb: 'A crisp lettuce leaf — the tortoise plods after it, slow but sure.' },
  kangaroo:  { species: 'kangaroo',  key: 'carrot',     label: 'Carrot',      tint: 0xe67e22, icon: '🥕', blurb: 'A fat carrot — the kangaroo bounds along beside you for it.' },
  owl:       { species: 'owl',       key: 'mouse',      label: 'Field Mouse', tint: 0x9c8b7a, icon: '🐭', blurb: 'A plump field mouse — the owl glides silently after you.' },
  fox:       { species: 'fox',       key: 'grapes',     label: 'Wild Grapes', tint: 0x7d3c98, icon: '🍇', blurb: 'Sweet wild grapes — the fox trots after them with a grin.' },
};

/** The food defs in roster (SPECIES_KEYS) order, so any list view is stable. */
export const FOODS: FoodDef[] = SPECIES_KEYS.map((k) => FOOD_BY_SPECIES[k]).filter(
  (d): d is FoodDef => d !== undefined,
);

/** Just the food keys, in roster order. */
export const FOOD_KEYS: string[] = FOODS.map((f) => f.key);

/**
 * The food a species likes — a pure, deterministic, TOTAL lookup. Falls back to
 * a generic 'kibble' for an unknown key (never expected for a playable species,
 * but keeps the function total so the generator/server never get undefined).
 */
export function foodForSpecies(species: string): FoodDef {
  const def = FOOD_BY_SPECIES[species];
  if (def) return def;
  return { species, key: 'kibble', label: 'Kibble', tint: 0xc8a26a, icon: '🍖', blurb: 'Generic feed.' };
}

/** Fast lookup by food key. Returns undefined for an unknown key. */
export function foodByKey(key: string): FoodDef | undefined {
  return FOODS.find((f) => f.key === key);
}

/** True if `key` is a valid food key (used to validate inventory writes). */
export function isFoodKey(key: unknown): key is string {
  return typeof key === 'string' && FOOD_KEYS.includes(key);
}

/** Every species in SPECIES_KEYS has exactly one food def (parity invariant). */
export const FOOD_COUNT: number = SPECIES_KEYS.filter(
  (k) => FOOD_BY_SPECIES[k] !== undefined,
).length;
