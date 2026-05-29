/**
 * Deterministic seeded PRNG — the random source for world generation.
 *
 * CRITICAL: like step.ts, everything here is pure and deterministic. The server
 * (authoritative) and the client (which regenerates the same world from the same
 * seed) MUST produce bit-identical map data, so we cannot use Math.random. We
 * build a mulberry32 generator on top of the FNV-1a {@link hash32} already in
 * step.ts (a tiny, well-distributed, V8-stable 32-bit hash), seeded from an
 * integer the server picks per room.
 *
 * Usage:
 *   const rng = mulberry32(seedFromString(roomName));
 *   const n   = randInt(rng, 1, 6);
 *   const t   = pick(rng, ['grass', 'dirt']);
 */

import { hash32 } from './step.js';

/**
 * Turn a room name (or any string) into a 32-bit integer seed. Just {@link hash32}
 * under an intention-revealing name — the server seeds a room's world with this so
 * the same room always generates the same map (survives reconnects), and the
 * client regenerates it from the seed the server sends over the wire.
 */
export function seedFromString(s: string): number {
  return hash32(s);
}

/**
 * mulberry32 — a fast, well-distributed 32-bit PRNG. Returns a function that
 * yields a float in [0, 1) on each call, advancing its internal state. Pure given
 * its seed: the same seed always produces the same sequence, on any V8 (server +
 * client), because all the arithmetic is forced back into uint32 via `>>> 0` and
 * {@link Math.imul}.
 */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return function next(): number {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1) >>> 0;
    t = (t ^ (t + Math.imul(t ^ (t >>> 7), t | 61))) >>> 0;
    return ((t ^ (t >>> 14)) >>> 0) / 0x100000000;
  };
}

/** A random integer in the inclusive range [lo, hi]. `rng` is a mulberry32 stream. */
export function randInt(rng: () => number, lo: number, hi: number): number {
  return lo + Math.floor(rng() * (hi - lo + 1));
}

/** Pick a uniformly-random element of `arr`. Caller guarantees `arr` is non-empty. */
export function pick<T>(rng: () => number, arr: readonly T[]): T {
  return arr[Math.floor(rng() * arr.length)];
}

/**
 * Fisher–Yates shuffle, IN PLACE, deterministic given `rng`. Returns the same
 * array for chaining. Used by world-gen to scatter species across plots without
 * Math.random, so client and server land the same animal in the same enclosure.
 */
export function shuffle<T>(rng: () => number, arr: T[]): T[] {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    const tmp = arr[i];
    arr[i] = arr[j];
    arr[j] = tmp;
  }
  return arr;
}
