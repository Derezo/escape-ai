import { test } from 'node:test';
import assert from 'node:assert/strict';

import { computeScore, computeScoreBreakdown, SCORE_WEIGHTS } from '../dist/score.js';
import { SPECIES_KEYS } from '../dist/species.js';

/** A fresh all-zero stat input. */
function zero() {
  return {
    escapes: 0,
    questsCompleted: 0,
    animalsStolen: 0,
    foodCollected: 0,
    caught: 0,
    playSeconds: 0,
    escapesBySpecies: {},
  };
}

test('an all-zero account scores 0', () => {
  assert.equal(computeScore(zero()), 0);
});

test('score is floored at 0 — captures alone never go negative', () => {
  const s = { ...zero(), caught: 50 };
  assert.equal(computeScore(s), 0);
});

test('each escape is worth PER_ESCAPE before other terms', () => {
  // 1 escape, but give enough playSeconds that efficiency is negligible-ish; we
  // just assert the escape term is present and dominant.
  const s = { ...zero(), escapes: 1, playSeconds: 3600 };
  const { terms, score } = computeScoreBreakdown(s);
  const escTerm = terms.find((t) => t.label.startsWith('Escapes'));
  assert.equal(escTerm.points, SCORE_WEIGHTS.PER_ESCAPE);
  // 1 escape/hour * EFFICIENCY_PER_ESCAPE_PER_HOUR efficiency on top.
  assert.equal(score, SCORE_WEIGHTS.PER_ESCAPE + SCORE_WEIGHTS.EFFICIENCY_PER_ESCAPE_PER_HOUR);
});

test('quests, steals, and food each add their weighted contribution', () => {
  const base = { ...zero(), escapes: 1, playSeconds: 3600 };
  const withExtras = {
    ...base,
    questsCompleted: 2,
    animalsStolen: 3,
    foodCollected: 4,
  };
  const delta = computeScore(withExtras) - computeScore(base);
  assert.equal(
    delta,
    2 * SCORE_WEIGHTS.PER_QUEST + 3 * SCORE_WEIGHTS.PER_STEAL + 4 * SCORE_WEIGHTS.PER_FOOD,
  );
});

test('time efficiency rewards a brisk player over a slow one with equal escapes', () => {
  const fast = { ...zero(), escapes: 5, playSeconds: 600 }; // 30/hour
  const slow = { ...zero(), escapes: 5, playSeconds: 36000 }; // 0.5/hour
  assert.ok(computeScore(fast) > computeScore(slow));
});

test('efficiency bonus is capped (early-session burst cannot explode the score)', () => {
  const burst = { ...zero(), escapes: 100, playSeconds: 1 }; // absurd escapes/hour
  const { terms } = computeScoreBreakdown(burst);
  const eff = terms.find((t) => t.label === 'Time efficiency');
  assert.equal(eff.points, SCORE_WEIGHTS.EFFICIENCY_MAX);
});

test('species variety adds a per-species bonus, and full roster adds the headline', () => {
  const oneSpecies = { ...zero(), escapes: 1, playSeconds: 3600, escapesBySpecies: { ape: 1 } };
  const allSpecies = {
    ...zero(),
    escapes: SPECIES_KEYS.length,
    playSeconds: 3600,
    escapesBySpecies: Object.fromEntries(SPECIES_KEYS.map((k) => [k, 1])),
  };
  const { terms: t1 } = computeScoreBreakdown(oneSpecies);
  assert.equal(
    t1.find((t) => t.label.startsWith('Species variety')).points,
    SCORE_WEIGHTS.PER_SPECIES_VARIETY,
  );
  const { terms: tAll } = computeScoreBreakdown(allSpecies);
  assert.ok(tAll.some((t) => t.label === 'All-species master'));
  assert.equal(
    tAll.find((t) => t.label === 'All-species master').points,
    SCORE_WEIGHTS.ALL_SPECIES_BONUS,
  );
});

test('the capture penalty is capped at half the escape value', () => {
  const s = { ...zero(), escapes: 2, caught: 1000, playSeconds: 3600 };
  const { terms } = computeScoreBreakdown(s);
  const pen = terms.find((t) => t.label.startsWith('Caught'));
  // cap = floor(2 * PER_ESCAPE / 2) = PER_ESCAPE
  assert.equal(pen.points, -SCORE_WEIGHTS.PER_ESCAPE);
});

test('garbage / missing fields coerce to 0 rather than NaN', () => {
  assert.equal(computeScore({}), 0);
  assert.equal(computeScore({ escapes: NaN, caught: 'x', playSeconds: -5 }), 0);
});

test('computeScore equals the sum of breakdown terms (floored)', () => {
  const s = {
    ...zero(),
    escapes: 7,
    questsCompleted: 9,
    animalsStolen: 2,
    foodCollected: 30,
    caught: 3,
    playSeconds: 1800,
    escapesBySpecies: { ape: 4, bird: 3 },
  };
  const { score, terms } = computeScoreBreakdown(s);
  const summed = Math.max(0, terms.reduce((a, t) => a + t.points, 0));
  assert.equal(score, summed);
  assert.equal(computeScore(s), score);
});
