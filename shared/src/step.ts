/**
 * Deterministic simulation step + math utils.
 *
 * CRITICAL: everything here MUST be pure and deterministic so the server
 * (authoritative) and the client (prediction) produce bit-identical results for
 * the same inputs. That means:
 *   - no Math.random()
 *   - no Date.now() / performance.now()
 *   - no DOM, no Node APIs, no I/O
 * `dt` is always passed in by the caller (the fixed-tick loop on the server, the
 * frame/accumulator loop on the client).
 */

import type { Entity, Input } from './types.js';

/** Clamp `v` into the inclusive range [min, max]. */
export function clamp(v: number, min: number, max: number): number {
  if (v < min) return min;
  if (v > max) return max;
  return v;
}

/** Linear interpolation from `a` to `b` by factor `t` (t is NOT clamped). */
export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

/**
 * World bounds the authoritative simulation clamps positions into. Kept here so
 * client prediction and server agree. Override per-genre at hour 0 if needed by
 * passing explicit bounds to `applyInput`.
 */
export const WORLD = {
  minX: 0,
  minY: 0,
  maxX: 1000,
  maxY: 1000,
} as const;

export interface Bounds {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

/**
 * Apply one input frame to an entity, in place, and return it.
 *
 * Movement is `pos += axis * speed * dt`, then clamped to `bounds`. Identical
 * math on both sides keeps prediction and authority in sync.
 *
 * @param entity  entity to advance (mutated and returned)
 * @param input   player intent (dx/dy axis values, typically in [-1, 1])
 * @param dt      delta time in seconds for this step
 * @param speed   units per second at full axis deflection
 * @param bounds  world clamp; defaults to WORLD
 */
export function applyInput(
  entity: Entity,
  input: Input,
  dt: number,
  speed: number,
  bounds: Bounds = WORLD,
): Entity {
  entity.x = clamp(entity.x + input.dx * speed * dt, bounds.minX, bounds.maxX);
  entity.y = clamp(entity.y + input.dy * speed * dt, bounds.minY, bounds.maxY);
  return entity;
}
