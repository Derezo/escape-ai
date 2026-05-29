/**
 * Collision-aware movement gate (step.ts `moveWithCollision`).
 *
 * Proves the axis-separated sliding behavior the server (authority) and client
 * (prediction) both depend on: you stop at a wall face and slide along it when
 * pushing diagonally into it, and you cannot leave the world (the edge is solid).
 * Zero deps: Node's runner over the compiled dist (built by `npm test`).
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { moveWithCollision } from '../dist/step.js';
import { generateWorld, worldToTile, tileSolid } from '../dist/world.js';

const TILE = 32;
const RADIUS = 11; // ~ RECT_SIZE * 0.4 (server uses the same value)

/** A tiny hand-built grid: open field with a solid vertical wall at column wallTx. */
function wallGrid(w, h, wallTx) {
  const collision = new Uint8Array(w * h);
  for (let ty = 0; ty < h; ty++) collision[ty * w + wallTx] = 1;
  return collision;
}

test('stops at a wall face instead of passing through it', () => {
  const w = 10, h = 10, wallTx = 5;
  const collision = wallGrid(w, h, wallTx);
  // Start just left of the wall, moving right hard for many steps.
  const e = { x: 4 * TILE + 16, y: 4 * TILE + 16 };
  for (let i = 0; i < 60; i++) {
    moveWithCollision(e, 1, 0, 1 / 20, 200, collision, w, h, TILE, RADIUS);
  }
  // The wall's left face is at wallTx*TILE; the box (half RADIUS) must not cross it.
  assert.ok(e.x + RADIUS <= wallTx * TILE + 0.001, `stopped before wall face (x=${e.x})`);
  // And it should have advanced right up against it (not stuck far away).
  assert.ok(e.x + RADIUS >= wallTx * TILE - TILE, `pressed up against the wall (x=${e.x})`);
});

test('slides along a wall when pushing diagonally into it', () => {
  const w = 10, h = 10, wallTx = 5;
  const collision = wallGrid(w, h, wallTx);
  const e = { x: 4 * TILE + 16, y: 4 * TILE + 16 };
  const startY = e.y;
  // Push down-right into the wall: X is blocked, Y must keep moving (slide).
  for (let i = 0; i < 30; i++) {
    moveWithCollision(e, 1, 1, 1 / 20, 200, collision, w, h, TILE, RADIUS);
  }
  assert.ok(e.x + RADIUS <= wallTx * TILE + 0.001, 'X stayed blocked by the wall');
  assert.ok(e.y > startY + TILE, `Y slid downward along the wall (Δy=${(e.y - startY).toFixed(1)})`);
});

test('cannot leave the world (out-of-bounds is solid)', () => {
  const map = generateWorld(123);
  // Drop the entity on a known-open tile near a spawn, then shove northwest hard.
  const s = map.spawns[0];
  const e = { x: s.x, y: s.y };
  for (let i = 0; i < 400; i++) {
    moveWithCollision(e, -1, -1, 1 / 20, 300, map.collision, map.w, map.h, map.tile, RADIUS);
  }
  // It must remain inside the playfield (never on a solid tile, never off-grid).
  const tx = worldToTile(e.x, map.tile), ty = worldToTile(e.y, map.tile);
  assert.ok(tx >= 0 && ty >= 0 && tx < map.w && ty < map.h, 'stayed on the grid');
  assert.ok(!tileSolid(map.collision, map.w, map.h, tx, ty), 'never ended on a solid tile');
});

test('free movement on open ground advances by speed*dt', () => {
  const w = 10, h = 10;
  const collision = new Uint8Array(w * h); // fully open
  const e = { x: 5 * TILE, y: 5 * TILE };
  moveWithCollision(e, 1, 0, 1 / 20, 200, collision, w, h, TILE, RADIUS);
  assert.ok(Math.abs(e.x - (5 * TILE + 200 / 20)) < 1e-9, 'moved exactly speed*dt on open ground');
});
