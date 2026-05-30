/**
 * The composite player-SCORE — the ONE definition shared by client and server.
 *
 * The leaderboard ranks players by a single "score" derived from the persisted
 * per-account stat counters (escapes, quests, steals, food, play time, the
 * by-species escape breakdown, captures). It is computed PURELY from those
 * counters — nothing is stored, so every existing account gets a fair score the
 * instant the feature ships, with no backfill or second source of truth to keep
 * in sync (cf. how the renderer derives gait from `species` rather than a wire
 * field).
 *
 * Parasite.io / agar-style shaping: reward skill and EFFICIENCY, not raw grind.
 * Escapes are the spine; a herd led out, stolen animals, and species variety are
 * the mastery multipliers; play-time efficiency rewards getting a lot done per
 * minute (a soft diminishing-returns curve, so an idle marathon can't out-rank
 * brisk skilled play); captures are a gentle, capped penalty.
 *
 * SERVER-AUTHORITATIVE: the server computes the leaderboard rows from its own DB
 * (never trusting a client). The client imports this same function ONLY to show a
 * live preview / explain the breakdown identically — it can never inflate its own
 * rank because the server's number is the one that ships in `leaderboard:data`.
 *
 * Pure + deterministic: same counters in → same score out, no clock, no rng, no
 * IO. That's what lets both sides agree and what makes it unit-testable.
 */

import { SPECIES_KEYS } from './species.js';

/**
 * The counters the score is computed from — a structural subset of the persisted
 * `UserStats` (net.ts). Kept as its own minimal input type so the scorer has no
 * dependency on the wire/display-only fields (timestamps, lastSpecies); any object
 * shaped like UserStats satisfies it.
 */
export interface ScoreInput {
  /** Successful gate escapes (the spine of the score). */
  escapes: number;
  /** Side-quest completions. */
  questsCompleted: number;
  /** Followers stolen from rival players (the PvP payoff). */
  animalsStolen: number;
  /** Food units collected (a small, soft signal — means, not end). */
  foodCollected: number;
  /** Times caught by a keeper robot (a capped penalty). */
  caught: number;
  /** Total play time across sessions, seconds (efficiency denominator). */
  playSeconds: number;
  /** Per-species escape counts (drives the species-variety mastery bonus). */
  escapesBySpecies?: Record<string, number>;
}

/**
 * Score weights + curve tunables. Exported so the client breakdown can label each
 * term with the exact same numbers the server scored with (no magic-number drift).
 * Chosen so a single clean escape (~SCORE_PER_ESCAPE) dwarfs a pile of food, and a
 * varied, quest-completing, theft-savvy player clearly out-ranks a one-trick grind.
 */
export const SCORE_WEIGHTS = {
  /** Each escape — the dominant term; escaping is the whole game. */
  PER_ESCAPE: 1000,
  /** Each side-quest completed (every escape needs one, but reach/activate/fetch
   *  variety + repetition shows spatial skill). */
  PER_QUEST: 250,
  /** Each follower STOLEN from a rival — the high-risk PvP play. */
  PER_STEAL: 120,
  /** Each food unit collected — a soft signal, deliberately tiny. */
  PER_FOOD: 15,
  /** Penalty per capture (subtracted; the total is floored at 0). */
  PER_CAUGHT: 40,
  /** One-time bonus per DISTINCT species ever escaped as — rewards learning every
   *  animal's playstyle rather than spamming one. */
  PER_SPECIES_VARIETY: 300,
  /** Full roster mastery: escaped as EVERY playable species → a headline bonus. */
  ALL_SPECIES_BONUS: 2500,
  /** Time-efficiency: bonus points awarded as escapes-per-hour, scaled by this, so
   *  a brisk player out-scores a slow one with the same escape count. Capped below. */
  EFFICIENCY_PER_ESCAPE_PER_HOUR: 400,
  /** Cap on the total efficiency bonus, so a handful of escapes in the first minute
   *  of a session (huge escapes/hour) can't explode the score. */
  EFFICIENCY_MAX: 4000,
  /** Floor (seconds) under the play-time denominator, so a brand-new account with a
   *  few seconds of play can't divide-by-near-zero into an absurd efficiency. */
  MIN_PLAY_SECONDS_FOR_EFFICIENCY: 60,
} as const;

/** One additive/penalty/multiplier line in the score, for the client breakdown. */
export interface ScoreTerm {
  /** Human-readable label, e.g. "Escapes ×12". */
  label: string;
  /** Signed points contributed by this term (already rounded). */
  points: number;
}

/** The score plus its itemized terms (the client renders the terms as a tooltip). */
export interface ScoreBreakdown {
  /** The final composite score (integer, floored at 0). */
  score: number;
  /** Each contributing term, in display order (escapes first). */
  terms: ScoreTerm[];
}

/** Coerce a possibly-absent/NaN counter to a finite, non-negative integer. */
function n(v: unknown): number {
  const x = Number(v);
  return Number.isFinite(x) && x > 0 ? Math.floor(x) : 0;
}

/** Count of DISTINCT species the player has escaped as (>0 each). */
function uniqueSpeciesEscaped(bySpecies: Record<string, number> | undefined): number {
  if (!bySpecies || typeof bySpecies !== 'object') return 0;
  let count = 0;
  for (const key of SPECIES_KEYS) if (n(bySpecies[key]) > 0) count += 1;
  return count;
}

/**
 * Compute the composite score AND its itemized breakdown for one player's stats.
 * Pure: same input → same output. The total is floored at 0 (a capture-heavy new
 * account can't go negative). Use `computeScore` when only the number is needed.
 * @param s the player's persisted counters (a UserStats-shaped object)
 */
export function computeScoreBreakdown(s: ScoreInput): ScoreBreakdown {
  const W = SCORE_WEIGHTS;
  const escapes = n(s.escapes);
  const quests = n(s.questsCompleted);
  const steals = n(s.animalsStolen);
  const food = n(s.foodCollected);
  const caught = n(s.caught);
  const playSeconds = n(s.playSeconds);

  const terms: ScoreTerm[] = [];
  const push = (label: string, points: number): void => {
    if (points !== 0) terms.push({ label, points });
  };

  push(`Escapes ×${escapes}`, escapes * W.PER_ESCAPE);
  push(`Quests ×${quests}`, quests * W.PER_QUEST);
  push(`Steals ×${steals}`, steals * W.PER_STEAL);
  push(`Food ×${food}`, food * W.PER_FOOD);

  // Species variety: a per-species unlock bonus + a full-roster headline bonus.
  const unique = uniqueSpeciesEscaped(s.escapesBySpecies);
  push(`Species variety ×${unique}`, unique * W.PER_SPECIES_VARIETY);
  if (unique >= SPECIES_KEYS.length && SPECIES_KEYS.length > 0) {
    push('All-species master', W.ALL_SPECIES_BONUS);
  }

  // Time efficiency: escapes-per-hour, scaled + capped. A near-zero playtime floor
  // prevents a divide-by-tiny blow-up; zero escapes → zero efficiency (no bonus).
  let efficiency = 0;
  if (escapes > 0) {
    const denomSeconds = Math.max(W.MIN_PLAY_SECONDS_FOR_EFFICIENCY, playSeconds);
    const escapesPerHour = (escapes * 3600) / denomSeconds;
    efficiency = Math.min(W.EFFICIENCY_MAX, escapesPerHour * W.EFFICIENCY_PER_ESCAPE_PER_HOUR);
    efficiency = Math.round(efficiency);
  }
  push('Time efficiency', efficiency);

  // Capture penalty (subtracted). Capped so an unlucky session can't crater a
  // strong record: at most half the escape value is ever lost to captures.
  const rawCaughtPenalty = caught * W.PER_CAUGHT;
  const caughtPenaltyCap = Math.floor((escapes * W.PER_ESCAPE) / 2);
  const caughtPenalty = Math.min(rawCaughtPenalty, caughtPenaltyCap);
  push(`Caught ×${caught}`, -caughtPenalty);

  const raw = terms.reduce((sum, t) => sum + t.points, 0);
  const score = Math.max(0, Math.round(raw));
  return { score, terms };
}

/** The composite score only (sum of all terms, floored at 0). */
export function computeScore(s: ScoreInput): number {
  return computeScoreBreakdown(s).score;
}
