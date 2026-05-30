/**
 * Per-species locomotion — a data-driven gait registry + deterministic applicators.
 *
 * Different animals should MOVE differently: a tortoise crawls, a kangaroo hops
 * (lurch then pause), a bird glides with a flutter. This is expressed as a TABLE
 * keyed by species, not a per-species if/else — adding a species (or a new gait)
 * is one row, no orchestrator change. The same registry is the single source of
 * truth for BOTH sides: the server applies the speed modifier authoritatively;
 * the client imports the same table by `e.species` to drive cosmetic motion (the
 * bird's vertical bob), so the gait costs ZERO wire bytes.
 *
 * Everything time-dependent is PURE + DETERMINISTIC: the only inputs are integer
 * `tick` and `hash32(id)` (a per-entity phase so a herd doesn't move in unison).
 * No Math.random, no clock. Position stays server-authoritative; the bird flutter
 * is the one explicitly client-cosmetic effect and never touches collision.
 */

import { hash32, moveWithCollision } from './step.js';

/**
 * How a species moves. `walk` and `crawl` animate identically with today's art
 * (both use the walk cycle); the distinction is the speed multiplier + readiness
 * for future gait-specific frames. `hop`/`fly` carry their cadence/bob params.
 */
export type Gait = 'walk' | 'hop' | 'fly' | 'crawl';

/** A species' movement profile. Optional blocks apply only to their gait. */
export interface LocomotionProfile {
  gait: Gait;
  /** Base-speed multiplier applied every tick (tortoise 0.5, bird slightly faster). */
  speedMult: number;
  /** hop only: the burst/pause rhythm in ticks (kangaroo lurch then hold). */
  cadence?: { hopTicks: number; pauseTicks: number };
  /** fly only: client-cosmetic vertical bob (pixels of amplitude, ticks per cycle). */
  bob?: { ampPx: number; periodTicks: number };
}

/** Fallback for robots and any species not explicitly listed. */
export const DEFAULT_LOCOMOTION: LocomotionProfile = { gait: 'walk', speedMult: 1 };

/**
 * Per-species overrides. Add a row to extend — no code branch anywhere needs to
 * know about it. Tuned for the 14-species zoo; only the three with a distinctive
 * real-world gait are listed, the rest fall back to a plain walk.
 */
export const LOCOMOTION: Record<string, LocomotionProfile> = {
  // Half speed, steady. With current art this just reads as a slow walk.
  tortoise: { gait: 'crawl', speedMult: 0.5 },
  // Hop-hop-hop-pause: a fast lurch for hopTicks, then a hold for pauseTicks. The
  // burst speed conserves mean distance (see gaitSpeed) so it's a real lurch, not
  // slow-on-average. Period = 16 ticks ≈ 0.8s at 20Hz.
  kangaroo: { gait: 'hop', speedMult: 1.0, cadence: { hopTicks: 6, pauseTicks: 10 } },
  // Glides slightly faster than it walks; the airborne flutter is a client-only
  // vertical bob (collision is unchanged — flight is cosmetic, see ARCHITECTURE).
  bird: { gait: 'fly', speedMult: 1.15, bob: { ampPx: 4, periodTicks: 18 } },
};

/** The locomotion profile for a species (DEFAULT for robots / unlisted species). */
export function locomotionFor(species: string | undefined): LocomotionProfile {
  return (species !== undefined && LOCOMOTION[species]) || DEFAULT_LOCOMOTION;
}

/**
 * The effective movement speed for ONE tick given the species gait.
 *
 * - walk / crawl / fly → a flat `speedMult` (tortoise is always half speed).
 * - hop → a burst/pause cadence: during the burst window the speed is
 *   `speedMult · period/hopTicks` (so the average over a full cycle ≈ a steady
 *   walk — a genuine forward lurch, not just slower), and 0 during the pause. The
 *   cycle phase is offset per entity by `hash32(id) % period` so a pen of
 *   kangaroos hop out of sync while each stays deterministic.
 *
 * Pure: the only time input is the integer `tick`; same (species, id, tick,
 * baseSpeed) → same speed on every machine.
 */
export function gaitSpeed(
  species: string | undefined,
  id: string,
  tick: number,
  baseSpeed: number,
): number {
  const profile = locomotionFor(species);
  const base = baseSpeed * profile.speedMult;
  if (profile.gait === 'hop' && profile.cadence) {
    const { hopTicks, pauseTicks } = profile.cadence;
    const period = hopTicks + pauseTicks;
    const phase = hash32(id) % period; // per-entity offset, deterministic
    const t = (tick + phase) % period;
    return t < hopTicks ? base * (period / hopTicks) : 0;
  }
  return base; // walk, crawl, fly
}

/**
 * Move one NPC a single step in a desired UNIT direction, applying its species
 * gait (speed multiplier / hop cadence) and the shared sliding collision. The
 * single entry point every animal movement path routes through, so the gait is
 * applied in exactly one place (chain-follow, ambient wander, return-home all
 * call this). Mutates `entity.{x,y}` in place via moveWithCollision.
 *
 * Robots are intentionally NOT routed through here (they're mechanical — plain
 * walk + their own patrol speeds + speedBoost). Pure + deterministic: the only
 * time-dependent term is gaitSpeed, anchored to integer tick + hash32(id).
 *
 * @param entity     mutated in place; needs id (gait phase) + species (gait) + x,y
 * @param dirX,dirY  the desired unit heading (already steered around obstacles)
 * @param baseSpeed  the behavior's base speed (FOLLOW.SPEED, WANDER_ANIMAL_SPEED, …)
 */
export function locomotionStep(
  entity: { id: string; x: number; y: number; species?: string },
  dirX: number,
  dirY: number,
  tick: number,
  dt: number,
  baseSpeed: number,
  collision: Uint8Array,
  mapW: number,
  mapH: number,
  tile: number,
  radius: number,
): void {
  const speed = gaitSpeed(entity.species, entity.id, tick, baseSpeed);
  if (speed <= 0) return; // hop pause-phase: hold position this tick
  moveWithCollision(entity, dirX, dirY, dt, speed, collision, mapW, mapH, tile, radius);
}
