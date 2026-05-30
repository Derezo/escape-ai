/**
 * Per-species MULTI-STEP side-quest model invariants.
 *
 * The quest defs are the shared source of truth for the ordered list of things
 * each animal must do before the gate lets it out; the server initializes +
 * advances progress step-by-step and the client HUD surfaces the active step.
 * This pins the redesigned model so it can't drift:
 *   - every species has 1..3 ordered steps,
 *   - the ape's quest ENDS in 'fetch',
 *   - the three controllers (elephant, peacock, parrot) CONTAIN an 'activate' step,
 *   - the other ten END in 'reach' or 'escort' and LEAD with a
 *     collect/recruit/order/ability/activate step (never end on a non-terminal kind),
 *   - every step kind is one of the known mechanics, every need >= 1,
 *   - every title fits the HUD (<= 24 chars) and every blurb is non-empty,
 *   - the back-compat top-level fields mirror the FINAL step,
 *   - questForSpecies is a pure deterministic lookup (same ref each call),
 *   - QUEST_COUNT covers the whole roster.
 *
 * Zero new deps: Node's built-in test runner over the COMPILED dist. Run with
 * `npm test` (which builds first).
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { questForSpecies, QUEST_BY_SPECIES, QUEST_COUNT } from '../dist/quests.js';
import { SPECIES_KEYS } from '../dist/species.js';

const KNOWN_KINDS = new Set([
  'reach', 'fetch', 'activate', 'collect', 'recruit', 'order', 'ability', 'escort',
]);
/** Kinds a multi-step species may LEAD with. */
const LEAD_KINDS = new Set(['collect', 'recruit', 'order', 'ability', 'activate']);

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

test('steps: every species has 1..3 ordered steps of known kinds with need >= 1', () => {
  for (const key of SPECIES_KEYS) {
    const def = questForSpecies(key);
    assert.ok(Array.isArray(def.steps), `${key} has a steps array`);
    assert.ok(def.steps.length >= 1 && def.steps.length <= 3, `${key} has 1..3 steps (got ${def.steps.length})`);
    for (const [i, step] of def.steps.entries()) {
      assert.ok(KNOWN_KINDS.has(step.kind), `${key} step ${i} kind "${step.kind}" is known`);
      assert.ok(Number.isInteger(step.need) && step.need >= 1, `${key} step ${i} need >= 1 (got ${step.need})`);
      assert.ok(step.title.length > 0 && step.title.length <= 24, `${key} step ${i} title fits HUD: "${step.title}"`);
      assert.ok(step.blurb.length > 0, `${key} step ${i} has a blurb`);
    }
  }
});

test('finale: ape ends in fetch; controllers contain activate; the rest end in reach/escort and lead correctly', () => {
  for (const key of SPECIES_KEYS) {
    const def = questForSpecies(key);
    const last = def.steps[def.steps.length - 1];
    const kinds = def.steps.map((s) => s.kind);

    if (FETCH_SPECIES.has(key)) {
      assert.equal(last.kind, 'fetch', `${key} quest ends in fetch`);
      assert.equal(last.need, 1, `${key} fetch need is 1`);
    } else if (ACTIVATE_SPECIES.has(key)) {
      assert.ok(kinds.includes('activate'), `${key} quest contains an activate step`);
      const activate = def.steps.find((s) => s.kind === 'activate');
      assert.equal(activate.need, 3, `${key} activate need is 3`);
      // Controllers are multi-step (lead with the activate, then a follow-up step).
      assert.ok(def.steps.length >= 2, `${key} is multi-step`);
      // The final step is one of the known mechanics (recruit/reach/order/etc).
      assert.ok(KNOWN_KINDS.has(last.kind), `${key} ends on a known kind (got ${last.kind})`);
    } else {
      // The other ten reach-species: multi-step, end in reach OR escort, lead correctly.
      assert.ok(def.steps.length >= 2, `${key} is multi-step (got ${def.steps.length})`);
      assert.ok(last.kind === 'reach' || last.kind === 'escort', `${key} ends in reach/escort (got ${last.kind})`);
      assert.ok(LEAD_KINDS.has(def.steps[0].kind), `${key} leads with a collect/recruit/order/ability/activate step (got ${def.steps[0].kind})`);
    }
  }
});

test('escort: small need (1-2) and always the FINAL gate step (the herd-out finale)', () => {
  // escort is the gate-time herd-out; it must be a quest's last step (so the gate
  // is the final waypoint WITH a herd) and keep its need small so it stays
  // satisfiable from the available animals.
  for (const key of SPECIES_KEYS) {
    const def = questForSpecies(key);
    def.steps.forEach((step, i) => {
      if (step.kind !== 'escort') return;
      assert.equal(i, def.steps.length - 1, `${key} escort is the final step`);
      assert.ok(step.need >= 1 && step.need <= 2, `${key} escort need stays small (got ${step.need})`);
    });
  }
});

test('back-compat: top-level type/title/blurb/need mirror the FINAL step', () => {
  for (const key of SPECIES_KEYS) {
    const def = questForSpecies(key);
    const last = def.steps[def.steps.length - 1];
    assert.equal(def.type, last.kind, `${key} def.type mirrors final step kind`);
    assert.equal(def.title, last.title, `${key} def.title mirrors final step title`);
    assert.equal(def.blurb, last.blurb, `${key} def.blurb mirrors final step blurb`);
    assert.equal(def.need, last.need, `${key} def.need mirrors final step need`);
  }
});

test('copy: every quest has a short overall questTitle and the HUD-fitting steps above', () => {
  for (const key of SPECIES_KEYS) {
    const def = questForSpecies(key);
    assert.ok(def.questTitle.length > 0 && def.questTitle.length <= 24, `${key} questTitle fits HUD: "${def.questTitle}"`);
  }
});

test('purity: questForSpecies is a deterministic lookup (same ref each call)', () => {
  for (const key of SPECIES_KEYS) {
    assert.equal(questForSpecies(key), questForSpecies(key), `${key} lookup is stable`);
    assert.equal(questForSpecies(key), QUEST_BY_SPECIES[key], `${key} returns the table ref`);
  }
  // Unknown species falls back to a total single-step 'reach' quest (stable ref).
  const a = questForSpecies('definitely-not-a-species');
  const b = questForSpecies('definitely-not-a-species');
  assert.equal(a, b, 'fallback is a stable ref');
  assert.equal(a.steps.length, 1, 'fallback is single-step');
  assert.equal(a.type, 'reach', 'unknown species falls back to a reach quest');
  assert.equal(a.need, 1, 'fallback need is 1');
});
