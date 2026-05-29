/**
 * Per-species side-quest model invariants (Phase 6).
 *
 * The quest defs are the shared source of truth for what each animal must do
 * before the gate lets it out; the server initializes + advances progress from
 * them and the client HUD surfaces them. This pins the model so it can't drift:
 * every species has exactly one quest, the mechanic distribution matches the
 * design (ape=fetch, the three controllers=activate, the rest=reach), titles fit
 * the HUD, and questForSpecies is a pure deterministic lookup.
 *
 * Zero new deps: Node's built-in test runner over the COMPILED dist. Run with
 * `npm test` (which builds first).
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { questForSpecies, QUEST_BY_SPECIES, QUEST_COUNT } from '../dist/quests.js';
import { SPECIES_KEYS } from '../dist/species.js';

const ACTIVATE_SPECIES = new Set(['elephant', 'peacock', 'parrot']);
const FETCH_SPECIES = new Set(['ape']);

test('coverage: every species has exactly one quest def, and no strays', () => {
  for (const key of SPECIES_KEYS) {
    assert.ok(QUEST_BY_SPECIES[key], `species ${key} should have a quest def`);
    assert.equal(QUEST_BY_SPECIES[key].species, key, `quest def species matches key ${key}`);
  }
  assert.equal(
    Object.keys(QUEST_BY_SPECIES).length,
    SPECIES_KEYS.length,
    'no quest defs beyond the roster',
  );
  assert.equal(QUEST_COUNT, SPECIES_KEYS.length, 'QUEST_COUNT covers the whole roster');
});

test('mechanics: ape=fetch, the three controllers=activate, the rest=reach', () => {
  for (const key of SPECIES_KEYS) {
    const def = questForSpecies(key);
    if (FETCH_SPECIES.has(key)) {
      assert.equal(def.type, 'fetch', `${key} is a fetch quest`);
      assert.equal(def.need, 1, `${key} fetch need is 1`);
    } else if (ACTIVATE_SPECIES.has(key)) {
      assert.equal(def.type, 'activate', `${key} is an activate quest`);
      assert.equal(def.need, 3, `${key} activate need is 3`);
    } else {
      assert.equal(def.type, 'reach', `${key} is a reach quest`);
      assert.equal(def.need, 1, `${key} reach need is 1`);
    }
  }
});

test('copy: every quest has a short title and a non-empty blurb', () => {
  for (const key of SPECIES_KEYS) {
    const def = questForSpecies(key);
    assert.ok(def.title.length > 0 && def.title.length <= 24, `${key} title fits the HUD: "${def.title}"`);
    assert.ok(def.blurb.length > 0, `${key} has a blurb`);
  }
});

test('purity: questForSpecies is a deterministic lookup (same ref each call)', () => {
  for (const key of SPECIES_KEYS) {
    assert.equal(questForSpecies(key), questForSpecies(key), `${key} lookup is stable`);
  }
  // Unknown species falls back to a total 'reach' quest rather than undefined.
  const unknown = questForSpecies('definitely-not-a-species');
  assert.equal(unknown.type, 'reach', 'unknown species falls back to a reach quest');
  assert.equal(unknown.need, 1, 'fallback need is 1');
});
