/**
 * Per-species liked-food model invariants (animal-collection feature).
 *
 * The food table is the shared source of truth for which food each animal will
 * follow you out for; the world generator places one source per species, the
 * server matches a fed food to a species, and the client inventory/renderer read
 * the labels + tints. This pins the model so it can't drift: every species has
 * exactly one food, every food key is unique (no two species share one), the
 * helpers are total/correct, and the lookups round-trip.
 *
 * Zero new deps: Node's built-in test runner over the COMPILED dist. Run with
 * `npm test` (which builds first). Mirrors quests.test.mjs.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  FOOD_BY_SPECIES,
  FOODS,
  FOOD_KEYS,
  FOOD_COUNT,
  foodForSpecies,
  foodByKey,
  isFoodKey,
} from '../dist/food.js';
import { SPECIES_KEYS } from '../dist/species.js';

test('coverage: every species has exactly one food def, and no strays', () => {
  for (const key of SPECIES_KEYS) {
    assert.ok(FOOD_BY_SPECIES[key], `species ${key} should have a food def`);
    assert.equal(FOOD_BY_SPECIES[key].species, key, `food def species matches key ${key}`);
  }
  assert.equal(
    Object.keys(FOOD_BY_SPECIES).length,
    SPECIES_KEYS.length,
    'no food defs beyond the roster',
  );
  assert.equal(FOOD_COUNT, SPECIES_KEYS.length, 'FOOD_COUNT covers the whole roster');
  assert.equal(FOODS.length, SPECIES_KEYS.length, 'FOODS lists one entry per species');
});

test('1:1 mapping: food keys are unique (no two species share a food)', () => {
  assert.equal(new Set(FOOD_KEYS).size, SPECIES_KEYS.length, 'every food key is distinct');
  // skunk and mole are deliberately distinct (the design called this out).
  assert.notEqual(FOOD_BY_SPECIES.skunk.key, FOOD_BY_SPECIES.mole.key, 'skunk food != mole food');
});

test('copy + art: every food has a label, a non-empty blurb, an icon, and a tint', () => {
  for (const f of FOODS) {
    assert.ok(typeof f.label === 'string' && f.label.length > 0, `${f.species} food has a label`);
    assert.ok(typeof f.blurb === 'string' && f.blurb.length > 0, `${f.species} food has a blurb`);
    assert.ok(typeof f.icon === 'string' && f.icon.length > 0, `${f.species} food has an icon`);
    assert.equal(typeof f.tint, 'number', `${f.species} food has a numeric tint`);
  }
});

test('foodForSpecies is total + deterministic, and round-trips through foodByKey', () => {
  for (const key of SPECIES_KEYS) {
    const def = foodForSpecies(key);
    assert.equal(def.species, key, `foodForSpecies(${key}) returns that species' food`);
    assert.equal(foodByKey(def.key)?.key, def.key, `foodByKey round-trips ${def.key}`);
    // Deterministic: same reference object each call (a pure table lookup).
    assert.equal(foodForSpecies(key), def, `foodForSpecies(${key}) is a stable lookup`);
  }
  // Unknown species → a total fallback (never undefined), not in the roster set.
  const fallback = foodForSpecies('not-a-species');
  assert.ok(fallback && typeof fallback.key === 'string', 'unknown species gets a total fallback');
});

test('isFoodKey validates membership', () => {
  for (const key of FOOD_KEYS) assert.ok(isFoodKey(key), `${key} is a valid food key`);
  assert.equal(isFoodKey('banana-republic'), false, 'a non-food string is rejected');
  assert.equal(isFoodKey(undefined), false, 'undefined is rejected');
  assert.equal(isFoodKey(42), false, 'a number is rejected');
});
