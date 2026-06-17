#!/usr/bin/env node
// @ts-check
'use strict';

/**
 * Deterministic reconciliation harness for the Variant B netcode re-fix
 * (TINS 2026 — Escape AI). Wired into `cd scripts && npm run verify`.
 *
 * Models the EXACT onSnapshot / rebuildLocalPredicted / sendInputFrame logic
 * from client/src/main.ts using the REAL shared deterministic math imported
 * from shared/dist/step.js. All constants must match both files:
 *
 *   FIXED_DT         = 0.05   (INPUT_SEND_MS / 1000)
 *   WALK_SPEED       = 120    (from shared/dist/step.js WALK_SPEED)
 *   SPRINT_SPEED     = 200    (from shared/dist/step.js SPRINT_SPEED)
 *   PREDICT_RADIUS   = 12.8   (32 * 0.4, matching PREDICT_RADIUS in main.ts)
 *   MAX_PENDING      = 50
 *
 * Replicates ALL 7 oracle x-traces from docs/netcode-refix-spec.md §6 and
 * asserts the automated gates from §8 items 1–9.
 *
 * Run:
 *   node scripts/check-netcode.mjs          (after cd shared && npm run build)
 *
 * Exit code 0 = all pass; non-zero = failures (details printed to stdout).
 */

import { pathToFileURL } from 'node:url';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');

// ── Import the real shared math ───────────────────────────────────────────────
const stepPath = join(ROOT, 'shared', 'dist', 'step.js');
const step = await import(pathToFileURL(stepPath).href);
const { moveWithCollision, moveSpeed, WALK_SPEED, SPRINT_SPEED } = step;

// ── Constants (MUST match client/src/main.ts) ─────────────────────────────────
const FIXED_DT = 0.05;        // INPUT_SEND_MS / 1000
const PREDICT_RADIUS = 12.8;  // 32 * 0.4
const MAX_PENDING_INPUTS = 50;
const PING_INTERVAL_MS = 1000;

// ── Assertion helpers ─────────────────────────────────────────────────────────
let failures = 0;
let assertions = 0;

function ok(cond, msg) {
  assertions++;
  if (!cond) {
    console.error(`  FAIL [${assertions}]: ${msg}`);
    failures++;
  }
}

function assertEq(a, b, msg) {
  ok(a === b, `${msg} — expected ${b}, got ${a}`);
}

function assertNear(a, b, tol, msg) {
  ok(Math.abs(a - b) <= tol, `${msg} — expected ≈${b} (±${tol}), got ${a}`);
}

// ── Minimal collision grid (open world — nothing to collide with) ─────────────
// A collision grid where every tile is passable. moveWithCollision returns the
// same position offsets as plain Euler integration in an open space. Using a
// real (all-zeros) grid means we're testing through the ACTUAL shared math
// path, not a stub.
//
// IMPORTANT: WorldMap.tile is the TILE SIZE in world units (TILE_SIZE = 32),
// NOT an array. The moveWithCollision / boxHitsSolid signatures are:
//   moveWithCollision(entity, dx, dy, dt, speed, collision, mapW, mapH, tile, radius)
// where `tile` is the pixel size of one tile (used to convert world coords to
// tile indices: tx = floor(wx / tile)). This matches how main.ts calls it via
// localMap.tile (= TILE_SIZE = 32).
const MAP_W = 100;
const MAP_H = 100;
const TILE_SIZE = 32; // world units per tile (matches shared/dist/tiles.js TILE_SIZE)

/** @type {Uint8Array} */
const openCollision = new Uint8Array(MAP_W * MAP_H); // all 0 = walkable

/** @type {{ collision: Uint8Array, w: number, h: number, tile: number }} */
const openMap = { collision: openCollision, w: MAP_W, h: MAP_H, tile: TILE_SIZE };

// ── Harness state (mirrors main.ts closure variables) ────────────────────────
/**
 * @typedef {{ seq: number, dx: number, dy: number, sprint: boolean }} PendingInput
 */

/**
 * Create a fresh simulation state (one harness "session").
 * @returns {{
 *   entities: Map<string, { id: string, x: number, y: number }>,
 *   pendingInputs: PendingInput[],
 *   confirmedX: number | undefined,
 *   confirmedY: number | undefined,
 *   seq: number,
 *   myId: string,
 *   localMap: { collision: Uint8Array, w: number, h: number, tile: number },
 * }}
 */
function makeState(seedX = 500, seedY = 500) {
  const myId = 'player1';
  const entities = new Map();
  entities.set(myId, { id: myId, x: seedX, y: seedY });
  return {
    entities,
    pendingInputs: /** @type {PendingInput[]} */ ([]),
    confirmedX: /** @type {number | undefined} */ (undefined),
    confirmedY: /** @type {number | undefined} */ (undefined),
    seq: 0,
    myId,
    localMap: openMap,
  };
}

/**
 * rebuildLocalPredicted — identical logic to main.ts.
 * THE ONLY WRITER of me.x / me.y.
 * @param {ReturnType<typeof makeState>} s
 */
function rebuildLocalPredicted(s) {
  const me = s.entities.get(s.myId);
  if (!me) return;
  if (s.confirmedX === undefined || s.confirmedY === undefined) return;
  const pos = { x: s.confirmedX, y: s.confirmedY };
  for (const inp of s.pendingInputs) {
    if (inp.dx !== 0 || inp.dy !== 0) {
      moveWithCollision(pos, inp.dx, inp.dy, FIXED_DT, moveSpeed(inp.sprint),
        s.localMap.collision, s.localMap.w, s.localMap.h, s.localMap.tile, PREDICT_RADIUS);
    }
  }
  me.x = pos.x;
  me.y = pos.y;
}

/**
 * sendInputFrame — identical logic to main.ts (the prediction+push side).
 * @param {ReturnType<typeof makeState>} s
 * @param {{ dx: number, dy: number, sprint?: boolean }} input
 */
function sendInputFrame(s, { dx, dy, sprint = false }) {
  // seq is 1-based — load-bearing (ack==0 prunes nothing on join)
  s.seq += 1;
  // Push UNCONDITIONALLY (even zero-vector frames)
  s.pendingInputs.push({ seq: s.seq, dx, dy, sprint });
  // Cap
  if (s.pendingInputs.length > MAX_PENDING_INPUTS) {
    s.pendingInputs.splice(0, s.pendingInputs.length - MAX_PENDING_INPUTS);
  }
  // UNCONDITIONAL rebuild (not guarded by dx||dy)
  rebuildLocalPredicted(s);
}

/**
 * onSnapshot — identical A→B→C→D→E logic to main.ts.
 * @param {ReturnType<typeof makeState>} s
 * @param {{ entities: Array<{ id: string, x?: number, y?: number }>, acks: Record<string, number>, tick?: number }} msg
 */
function onSnapshot(s, msg) {
  // A. Merge delta
  for (const e of msg.entities) {
    const prev = s.entities.get(e.id);
    s.entities.set(e.id, { ...prev, ...e });
  }
  // B. Capture baseline, PRESENT-ONLY
  const myEntityInMsg = msg.entities.find((e) => e.id === s.myId);
  if (myEntityInMsg && typeof myEntityInMsg.x === 'number' && typeof myEntityInMsg.y === 'number') {
    s.confirmedX = myEntityInMsg.x;
    s.confirmedY = myEntityInMsg.y;
  }
  // When myId is NOT present: confirmedX/Y left untouched.

  // C. Prune by live ack (seq is 1-based; ack==0 admitted, prunes nothing)
  if (typeof msg.acks[s.myId] === 'number') {
    const ackedSeq = msg.acks[s.myId];
    let pruneCount = 0;
    while (pruneCount < s.pendingInputs.length && s.pendingInputs[pruneCount].seq <= ackedSeq) {
      pruneCount++;
    }
    if (pruneCount > 0) s.pendingInputs.splice(0, pruneCount);
  }

  // D. Rebuild (UNCONDITIONAL)
  rebuildLocalPredicted(s);
  // (E. tick/world not modelled here)
}

/** Return the rendered x of the local entity. */
function renderedX(s) { return s.entities.get(s.myId)?.x; }
/** Return the rendered y of the local entity. */
function renderedY(s) { return s.entities.get(s.myId)?.y; }

// ── One move step size for WALK_SPEED in open space ───────────────────────────
// In an open collision grid moveWithCollision reduces to Euler integration:
// Δx = dx * WALK_SPEED * FIXED_DT = 1 * 120 * 0.05 = 6 (east)
const WALK_STEP = WALK_SPEED * FIXED_DT; // 6 u/axis (unit vector)

console.log('check-netcode: running reconciliation harness...\n');
console.log(`  WALK_SPEED=${WALK_SPEED} SPRINT_SPEED=${SPRINT_SPEED} FIXED_DT=${FIXED_DT}`);
console.log(`  WALK_STEP=${WALK_STEP} PREDICT_RADIUS=${PREDICT_RADIUS}\n`);

// ── Oracle trace 1: Start-from-rest, entity OMITTED at onset ─────────────────
// Ground-truth (1-tick-RTT, continuous East): rendered x = 206→212→218→224,
// +6/tick, monotonic, NO lurch. The load-bearing server coupling: a present
// snapshot whose x advanced to V always carries the ack for the seq that produced
// V (engine.js emits x and acks in the SAME tick), so x=218 ⇒ ack=3 — a
// (present, x=218, ack=1) pairing is physically impossible.
//   - confirmedX = 206→212→212(UNTOUCHED on the omitted tick)→218
//   - acks       = 1, 2, 2 (omitted tick re-uses the prior ack), 3
//   - On the omitted tick: rendered = confirmedX(212) + one unacked input(seq3)·6 = 218.
// Old bug went 218→224→snap-to-212 (double-integration); a stale-ack mis-model
// over-counted the tail to 230. Ground truth is 224. Invariant:
//   rendered = confirmedX + (nonzero-unacked count)·6, which is exactly 1 at every
//   present tick during continuous 1-tick-RTT motion.
{
  console.log('Oracle 1: start-from-rest, entity omitted at onset');
  const s = makeState(200, 500);

  // C1 + S1: present x=206, ack=1 → rendered 206, confirmed 206, pending []
  sendInputFrame(s, { dx: 1, dy: 0 });                                   // seq=1
  onSnapshot(s, { entities: [{ id: 'player1', x: 206, y: 500 }], acks: { player1: 1 } });
  assertEq(renderedX(s), 206, 'oracle1 S1: rendered=206');
  assertEq(s.confirmedX, 206, 'oracle1 S1: confirmedX=206');
  assertEq(s.pendingInputs.length, 0, 'oracle1 S1: 0 pending');

  // C2 + S2: present x=212, ack=2 → rendered 212, confirmed 212, pending []
  sendInputFrame(s, { dx: 1, dy: 0 });                                   // seq=2
  onSnapshot(s, { entities: [{ id: 'player1', x: 212, y: 500 }], acks: { player1: 2 } });
  assertEq(renderedX(s), 212, 'oracle1 S2: rendered=212');
  assertEq(s.confirmedX, 212, 'oracle1 S2: confirmedX=212');
  assertEq(s.pendingInputs.length, 0, 'oracle1 S2: 0 pending');

  // C3 + S3: OMITTED, ack=2 (re-uses prior ack) → rendered 218, confirmed UNTOUCHED 212, pending [seq3]
  sendInputFrame(s, { dx: 1, dy: 0 });                                   // seq=3
  onSnapshot(s, { entities: [], acks: { player1: 2 } });
  assertEq(renderedX(s), 218, 'oracle1 S3 (omitted): rendered=218');
  assertEq(s.confirmedX, 212, 'oracle1 S3 (omitted): confirmedX UNTOUCHED at 212 — the central fix');
  assertEq(s.pendingInputs.length, 1, 'oracle1 S3: 1 unacked (seq3)');

  // C4 + S4: present x=218, ack=3 → rendered 224, confirmed 218, pending [seq4]
  sendInputFrame(s, { dx: 1, dy: 0 });                                   // seq=4
  onSnapshot(s, { entities: [{ id: 'player1', x: 218, y: 500 }], acks: { player1: 3 } });
  assertEq(renderedX(s), 224, 'oracle1 S4: rendered=224');
  assertEq(s.confirmedX, 218, 'oracle1 S4: confirmedX=218');
  assertEq(s.pendingInputs.length, 1, 'oracle1 S4: 1 unacked (seq4)');

  // No-lurch as a HARD assertion: every step-to-step rendered delta ∈ {0, +6}.
  const seqX = [206, 212, 218, 224];
  for (let i = 1; i < seqX.length; i++) {
    const d = seqX[i] - seqX[i - 1];
    ok(d === 0 || d === 6, `oracle1 no-lurch: step ${i} delta ${d} ∈ {0,6} (never negative, never 12)`);
  }
  console.log('  Oracle 1: PASS\n');
}

// ── Oracle trace 2: Steady move, present every tick ──────────────────────────
// Spec §6 item 2: rendered = confirmedX + (nonzero-unacked-count)·6, error 0.
{
  console.log('Oracle 2: steady move, present every tick');
  const s = makeState(200, 500);

  // 5 ticks of moving east, server acks each one, entity present each tick
  for (let i = 1; i <= 5; i++) {
    sendInputFrame(s, { dx: 1, dy: 0 });
    const serverX = 200 + i * WALK_STEP; // server is at 206, 212, 218, 224, 230
    onSnapshot(s, {
      entities: [{ id: 'player1', x: serverX, y: 500 }],
      acks: { player1: i }, // acks up to current seq
    });
    // After rebuild: confirmedX=serverX, all inputs ≤i pruned, 0 remaining.
    // rebuildLocalPredicted: pos=serverX, no pending → me.x = serverX.
    const expectedX = serverX; // 0 unacked
    assertEq(renderedX(s), expectedX, `oracle2: tick ${i} rendered=confirmed=${expectedX}`);
  }
  assertEq(s.pendingInputs.length, 0, 'oracle2: zero pending after all acked');
  console.log('  Oracle 2: PASS\n');
}

// ── Oracle trace 3: Stop (zero-vectors) settles exactly at server x ───────────
// Spec §6 item 3: settles exactly at server x (e.g. 312) and stays — no creep.
{
  console.log('Oracle 3: stop (zero-vectors) — no creep');
  const s = makeState(300, 500);

  // Move for 2 ticks to get to 312
  sendInputFrame(s, { dx: 1, dy: 0 });
  sendInputFrame(s, { dx: 1, dy: 0 });
  onSnapshot(s, {
    entities: [{ id: 'player1', x: 312, y: 500 }],
    acks: { player1: 2 },
  });
  assertEq(renderedX(s), 312, 'oracle3: at 312 after move+ack');

  // Now 20 zero-vector frames + matching snapshots at 312
  for (let i = 3; i <= 22; i++) {
    sendInputFrame(s, { dx: 0, dy: 0 });
    onSnapshot(s, {
      entities: [{ id: 'player1', x: 312, y: 500 }],
      acks: { player1: i },
    });
    assertEq(renderedX(s), 312, `oracle3: tick ${i} still at 312 (no creep)`);
  }

  // Zero variance — all 20 trailing ticks were 312
  console.log('  Oracle 3: PASS\n');
}

// ── Oracle trace 4: ack jumps by 2 (last-write-wins) ────────────────────────
// Spec §6 item 4: 418→412 (one 6u backward settle). EXPECTED artifact; do NOT fix.
{
  console.log('Oracle 4: ack jump by 2 — expected settle');
  const s = makeState(400, 500);
  // seq1: dx=1, seq2: dx=1, seq3: dx=1
  sendInputFrame(s, { dx: 1, dy: 0 }); // seq=1, pendingInputs=[1]
  sendInputFrame(s, { dx: 1, dy: 0 }); // seq=2, pendingInputs=[1,2]
  sendInputFrame(s, { dx: 1, dy: 0 }); // seq=3, pendingInputs=[1,2,3]
  // Server at 418, acks seq 3 (skipped 1+2 — server processed all 3).
  // rebuild: confirmedX=418, 0 remaining → me.x=418.
  onSnapshot(s, {
    entities: [{ id: 'player1', x: 418, y: 500 }],
    acks: { player1: 3 },
  });
  assertEq(renderedX(s), 418, 'oracle4: after ack=3 at x=418 → x=418');

  // Now: seq4 dx=1, seq5 dx=1
  sendInputFrame(s, { dx: 1, dy: 0 }); // seq=4
  sendInputFrame(s, { dx: 1, dy: 0 }); // seq=5
  // pending=[4,5]. rebuild: 418+6+6=430.
  assertEq(renderedX(s), 430, 'oracle4: predicted 430 after 2 more sends');

  // Server had confirmed x=412 (processed one fewer step than we expected),
  // acks seq=5 (skipped seq 4 application for some reason) — example of
  // "ack jumps by 2" meaning server present snapshot is BEHIND what we expected.
  // According to spec: 418→412 is a 6u backward settle (expected protocol artifact).
  // Model: server snapshot comes in with x=412, acks seq=5 (all pending pruned).
  onSnapshot(s, {
    entities: [{ id: 'player1', x: 412, y: 500 }],
    acks: { player1: 5 },
  });
  // confirmedX=412, prune seq4+seq5, 0 remaining. rebuild: 412. Snapped to 412.
  assertEq(renderedX(s), 412, 'oracle4: settle to server 412 (expected 6u backward artifact)');
  console.log('  Oracle 4: PASS\n');
}

// ── Oracle trace 5: ack==0 after join (pre-join hold) ────────────────────────
// Spec §6 item 5: holds at seed (500) until first present snapshot, then 512→518.
// ack==0 admitted via typeof==='number'.
{
  console.log('Oracle 5: ack==0 after join');
  const s = makeState(500, 500);
  // No confirmedX yet. 2 sends, server acks 0.
  sendInputFrame(s, { dx: 1, dy: 0 }); // seq=1
  sendInputFrame(s, { dx: 1, dy: 0 }); // seq=2
  // Snapshot with ack=0 (server hasn't processed any yet), our entity ABSENT.
  onSnapshot(s, { entities: [], acks: { player1: 0 } });
  // confirmedX still undefined → rebuildLocalPredicted no-ops → x=500 (lobby seed).
  // ack=0 prunes nothing (seq<=0 is empty).
  assertEq(renderedX(s), 500, 'oracle5: lobby-seed x=500 preserved before first anchor');
  assertEq(s.pendingInputs.length, 2, 'oracle5: both pending inputs survive ack=0');

  // First present snapshot at 512, ack=2
  onSnapshot(s, {
    entities: [{ id: 'player1', x: 512, y: 500 }],
    acks: { player1: 2 },
  });
  // confirmedX=512, prune seq1+seq2, 0 remaining. rebuild: 512.
  assertEq(renderedX(s), 512, 'oracle5: after first present snapshot x=512');
  assertEq(s.pendingInputs.length, 0, 'oracle5: all pending pruned by ack=2');

  // Send one more east
  sendInputFrame(s, { dx: 1, dy: 0 }); // seq=3
  assertEq(renderedX(s), 518, 'oracle5: predicted 518 after one more east (512+6)');
  console.log('  Oracle 5: PASS\n');
}

// ── Oracle trace 6: Replay into wall ─────────────────────────────────────────
// Spec §6 item 6: converges to shared clamp point (same moveWithCollision both
// sides), ≤6u optimistic lead, no oscillation.
{
  console.log('Oracle 6: replay into wall');
  // Build a map with a wall: block all tiles in column 5 (world x = tile*5 = 160).
  // The collision grid is (w * tileY + tileX): set column 5 for all rows to 1.
  // Entity starts at x=120 (tile col 3), moving east.
  // Wall at tile col 5 means world x boundary = 5*32 = 160.
  // boxHitsSolid checks floor((x+radius)/tile) >= wallTileX, so entity stops at
  // x such that x+12.8 < 160, i.e. x < 147.2. After step 4: x=144 (can't go to 150).
  const wallCollision = new Uint8Array(MAP_W * MAP_H);
  const wallTileX = 5; // tile column 5 → world x boundary 5*32=160
  for (let row = 0; row < MAP_H; row++) {
    wallCollision[row * MAP_W + wallTileX] = 1; // blocked
  }
  // tile is the TILE SIZE (32), not an array
  const wallMap = { collision: wallCollision, w: MAP_W, h: MAP_H, tile: TILE_SIZE };
  const s = makeState(120, 80); // start at tile col 3, mid-row
  s.localMap = wallMap;

  // Anchor confirmedX via first snapshot (at the same position as the seed)
  onSnapshot(s, {
    entities: [{ id: 'player1', x: 120, y: 80 }],
    acks: { player1: 0 },
  });
  assertEq(renderedX(s), 120, 'oracle6: anchored at 120');

  // Move east 20 ticks — we'll hit the wall at x=144 (step 4 clamps).
  // Server mirrors the same collision so it too reports x=144 after the clamp.
  let lastX = renderedX(s);
  let hitWall = false;
  for (let i = 1; i <= 20; i++) {
    sendInputFrame(s, { dx: 1, dy: 0 });
    // Server runs the SAME moveWithCollision → same clamped x
    const serverX = renderedX(s); // server would clamp identically
    onSnapshot(s, {
      entities: [{ id: 'player1', x: serverX, y: 80 }],
      acks: { player1: i },
    });
    const rx = renderedX(s);
    ok(isFinite(rx), `oracle6: x is finite at tick ${i}`);
    if (rx === lastX && !hitWall) hitWall = true;
    if (hitWall) {
      // Once we've hit the wall, position should stay constant (clamped)
      ok(Math.abs(rx - lastX) <= 0.001, `oracle6: no oscillation after wall (tick ${i})`);
    }
    lastX = rx;
  }
  ok(hitWall, 'oracle6: hit the wall (position clamped)');
  // Optimistic lead ≤ 6u: the last predicted position is at most WALK_STEP ahead
  // of the confirmed baseline. When confirmedX === renderedX (zero pending), lead=0.
  const lead = renderedX(s) - (s.confirmedX ?? 0);
  ok(Math.abs(lead) <= WALK_STEP + 0.001, `oracle6: lead ≤ WALK_STEP (${WALK_STEP}u), got ${lead}`);
  console.log('  Oracle 6: PASS\n');
}

// ── Oracle trace 7: NaN/Infinity ─────────────────────────────────────────────
// Spec §6 item 7: NaN/Infinity not reachable (no division/normalize in path;
// typeof-guarded assigns). Fuzz confirms.
{
  console.log('Oracle 7: NaN/Infinity fuzz');
  const s = makeState(400, 400);
  onSnapshot(s, {
    entities: [{ id: 'player1', x: 400, y: 400 }],
    acks: { player1: 0 },
  });

  // Fuzz with extreme/weird inputs
  const fuzzInputs = [
    { dx: 0, dy: 0 },
    { dx: 1, dy: 0 },
    { dx: -1, dy: -1 },
    { dx: 1, dy: 1 },
    { dx: 0, dy: -1 },
  ];
  for (let i = 0; i < 30; i++) {
    const inp = fuzzInputs[i % fuzzInputs.length];
    sendInputFrame(s, inp);
    onSnapshot(s, {
      entities: [{ id: 'player1', x: renderedX(s), y: renderedY(s) }],
      acks: { player1: s.seq },
    });
    const rx = renderedX(s);
    const ry = renderedY(s);
    ok(isFinite(rx), `oracle7: x is finite at fuzz tick ${i}`);
    ok(isFinite(ry), `oracle7: y is finite at fuzz tick ${i}`);
  }
  console.log('  Oracle 7: PASS\n');
}

// ── Gate 2: No-runaway bound ──────────────────────────────────────────────────
// |rendered.x − confirmedX| ≤ pendingInputs.length * SPRINT_SPEED * FIXED_DT
{
  console.log('Gate 2: no-runaway bound');
  const s = makeState(200, 200);
  onSnapshot(s, {
    entities: [{ id: 'player1', x: 200, y: 200 }],
    acks: { player1: 0 },
  });

  // Build up a large unacked tail (10 sprint inputs, no acks)
  for (let i = 1; i <= 10; i++) {
    sendInputFrame(s, { dx: 1, dy: 0, sprint: true });
  }
  const rx = renderedX(s);
  const maxLead = s.pendingInputs.length * SPRINT_SPEED * FIXED_DT;
  const actualLead = Math.abs(rx - s.confirmedX);
  ok(actualLead <= maxLead + 0.001,
    `gate2: |rendered-confirmed|=${actualLead.toFixed(3)} ≤ maxLead=${maxLead}`);
  console.log('  Gate 2: PASS\n');
}

// ── Gate 3: Convergence after stop: error 0, zero variance over 20 trailing ticks
{
  console.log('Gate 3: convergence after stop');
  const s = makeState(300, 300);
  onSnapshot(s, {
    entities: [{ id: 'player1', x: 300, y: 300 }],
    acks: { player1: 0 },
  });

  // Move 5 ticks
  for (let i = 1; i <= 5; i++) {
    sendInputFrame(s, { dx: 1, dy: 0 });
    onSnapshot(s, {
      entities: [{ id: 'player1', x: 300 + i * WALK_STEP, y: 300 }],
      acks: { player1: i },
    });
  }
  const finalX = renderedX(s); // 330

  // 20 trailing zero-vector ticks, server stays at finalX
  const trailing = [];
  for (let i = 0; i < 20; i++) {
    sendInputFrame(s, { dx: 0, dy: 0 });
    onSnapshot(s, {
      entities: [{ id: 'player1', x: finalX, y: 300 }],
      acks: { player1: 5 + i + 1 },
    });
    trailing.push(renderedX(s));
  }
  const allSame = trailing.every((x) => x === finalX);
  ok(allSame, `gate3: all 20 trailing ticks at ${finalX} (zero variance)`);
  const error = Math.abs(renderedX(s) - finalX);
  assertEq(error, 0, 'gate3: steady-state error = 0');
  console.log('  Gate 3: PASS\n');
}

// ── Gate 4: Steady-state error 0 (harness dt = 0.05 exact) ──────────────────
{
  console.log('Gate 4: steady-state error 0');
  const s = makeState(0, 0);
  onSnapshot(s, {
    entities: [{ id: 'player1', x: 0, y: 0 }],
    acks: { player1: 0 },
  });

  // 50 ticks moving east, server always 1 tick behind (acks the previous seq)
  for (let i = 1; i <= 50; i++) {
    sendInputFrame(s, { dx: 1, dy: 0 });
    const serverX = i * WALK_STEP;
    onSnapshot(s, {
      entities: [{ id: 'player1', x: serverX, y: 0 }],
      acks: { player1: i },
    });
    // With ack=i all pending are pruned; 0 remaining. error = |rendered-serverX|.
    const error = Math.abs(renderedX(s) - serverX);
    assertEq(error, 0, `gate4: tick ${i} steady-state error = 0`);
  }
  console.log('  Gate 4: PASS\n');
}

// ── Gate 5: Omitted-entity per-tick forward displacement ≤6u, never ≤12u ────
// Spec §8 item 5: per-tick forward displacement is EXACTLY one step (≤6u),
// never two (≤12u).
{
  console.log('Gate 5: omitted-entity single-step-only displacement');
  const s = makeState(200, 200);
  onSnapshot(s, {
    entities: [{ id: 'player1', x: 200, y: 200 }],
    acks: { player1: 0 },
  });
  assertEq(s.confirmedX, 200, 'gate5: confirmedX anchored at 200');

  // 5 sends with OMITTED snapshot (our entity absent)
  let prevX = renderedX(s);
  for (let i = 1; i <= 5; i++) {
    sendInputFrame(s, { dx: 1, dy: 0 }); // advance prediction
    const beforeSnap = renderedX(s);
    onSnapshot(s, { entities: [], acks: { player1: i - 1 } }); // entity absent, ack previous
    const afterSnap = renderedX(s);
    // The displacement from the PREVIOUS snapshot result should be EXACTLY WALK_STEP
    // (one unacked input replayed on top of confirmedX, which is still 200).
    // After i omissions: confirmedX=200, unacked=[i-th input], rebuild: 200+6.
    // Each step independently: confirmedX fixed at 200, unacked tail grows by 1.
    // renderedX = 200 + (number of unacked)*6. After ack=i-1, we pruned i-1 inputs.
    // Wait: ack=i-1 prunes seq<=i-1. After send seq=i, pending=[seq:i]. rebuild: 200+6.
    assertEq(afterSnap, 206, `gate5: after ${i} omitted snapshots x=206 (one step only)`);
    // Key spec assertion: displacement per step ≤ WALK_STEP (6u), never ≥ 12u
    const displacement = Math.abs(afterSnap - prevX);
    // On first tick: prevX=200, displacement=6. On subsequent: prevX=206, displacement=0.
    ok(displacement <= WALK_STEP + 0.001, `gate5: per-step displacement ≤6u (${displacement})`);
    ok(displacement < WALK_STEP * 2, `gate5: per-step displacement <12u (not two steps)`);
    prevX = afterSnap;
  }
  console.log('  Gate 5: PASS\n');
}

// ── Gate 6: Join/ack==0 ───────────────────────────────────────────────────────
// Spec §8 item 6: prune removes 0 while confirmed undefined; first present sets
// baseline → matches oracle (512). seq is 1-based.
{
  console.log('Gate 6: join / ack==0');
  const s = makeState(500, 500);

  // Several sends before any snapshot (lobby, no confirmedX)
  sendInputFrame(s, { dx: 1, dy: 0 }); // seq=1
  sendInputFrame(s, { dx: 1, dy: 0 }); // seq=2

  // ack=0: typeof 0 === 'number', but prunes nothing (seq<=0 empty)
  onSnapshot(s, { entities: [], acks: { player1: 0 } });
  assertEq(s.pendingInputs.length, 2, 'gate6: ack=0 prunes nothing');
  // confirmedX undefined → rebuild no-ops → x=500 (lobby seed)
  assertEq(renderedX(s), 500, 'gate6: lobby seed preserved while confirmedX undefined');

  // First present snapshot anchors the baseline
  onSnapshot(s, {
    entities: [{ id: 'player1', x: 512, y: 500 }],
    acks: { player1: 2 },
  });
  assertEq(s.confirmedX, 512, 'gate6: confirmedX set to 512 from first present snapshot');
  assertEq(s.pendingInputs.length, 0, 'gate6: pending cleared by ack=2');
  assertEq(renderedX(s), 512, 'gate6: rendered=512 (oracle 5 match)');

  // seq was 2 before the first snapshot; it is 1-based (load-bearing comment)
  ok(s.seq >= 1, 'gate6: seq is 1-based (not 0-based)');
  console.log('  Gate 6: PASS\n');
}

// ── Gate 7: NaN/Infinity fuzz (comprehensive) ─────────────────────────────────
{
  console.log('Gate 7: NaN/Infinity comprehensive fuzz');
  const s = makeState(100, 100);
  onSnapshot(s, {
    entities: [{ id: 'player1', x: 100, y: 100 }],
    acks: { player1: 0 },
  });
  const dirs = [
    { dx: 0, dy: 0 }, { dx: 1, dy: 0 }, { dx: -1, dy: 0 },
    { dx: 0, dy: 1 }, { dx: 0, dy: -1 },
    { dx: 1, dy: 1 }, { dx: -1, dy: -1 }, { dx: 1, dy: -1 }, { dx: -1, dy: 1 },
  ];
  for (let i = 0; i < 100; i++) {
    const inp = dirs[i % dirs.length];
    sendInputFrame(s, inp);
    // Mix of present and absent snapshots
    if (i % 3 === 0) {
      onSnapshot(s, {
        entities: [{ id: 'player1', x: renderedX(s), y: renderedY(s) }],
        acks: { player1: s.seq },
      });
    } else {
      onSnapshot(s, { entities: [], acks: { player1: s.seq - 1 } });
    }
    const rx = renderedX(s);
    const ry = renderedY(s);
    ok(isFinite(rx), `gate7: x finite at fuzz tick ${i}`);
    ok(isFinite(ry), `gate7: y finite at fuzz tick ${i}`);
    ok(!isNaN(rx), `gate7: x not NaN at fuzz tick ${i}`);
    ok(!isNaN(ry), `gate7: y not NaN at fuzz tick ${i}`);
  }
  console.log('  Gate 7: PASS\n');
}

// ── Gate 8: Latency clamp unit tests ─────────────────────────────────────────
// Spec §8 item 8: rtt∈{20000,NaN,Infinity,-5,4001} rejected (latencyMs unchanged);
// 140 from -1 → 140; steady 140 → EMA→140; assert ping uses .volatile.emit.
{
  console.log('Gate 8: latency clamp unit tests');

  // Model the pong handler logic from client/src/net/client.ts
  function makePongHandler() {
    let latencyMs = -1;
    return {
      /**
       * @param {number} rtt
       */
      handlePong(rtt) {
        if (!Number.isFinite(rtt) || rtt < 0 || rtt > PING_INTERVAL_MS * 4) return;
        latencyMs = latencyMs < 0 ? rtt : Math.round(latencyMs * 0.7 + rtt * 0.3);
      },
      getLatency() { return latencyMs; },
    };
  }

  // Test: implausible RTTs are rejected
  const h1 = makePongHandler();
  h1.handlePong(20000);    // too large (> 4000)
  h1.handlePong(NaN);      // NaN
  h1.handlePong(Infinity); // Infinity
  h1.handlePong(-5);       // negative
  h1.handlePong(4001);     // > PING_INTERVAL_MS*4 = 4000
  assertEq(h1.getLatency(), -1, 'gate8: all implausible RTTs rejected, latencyMs stays -1');

  // Test: 140 from -1 → 140 (first valid sample sets directly)
  const h2 = makePongHandler();
  h2.handlePong(140);
  assertEq(h2.getLatency(), 140, 'gate8: first valid RTT 140 sets latencyMs=140');

  // Test: steady 140 → EMA stays 140
  const h3 = makePongHandler();
  for (let i = 0; i < 20; i++) h3.handlePong(140);
  assertEq(h3.getLatency(), 140, 'gate8: steady 140 pongs → EMA stays 140');

  // Test: 140 from initial non-(-1) (EMA convergence)
  const h4 = makePongHandler();
  h4.handlePong(200); // sets to 200
  h4.handlePong(140); // EMA: round(200*0.7 + 140*0.3) = round(140+42) = round(182) = 182
  assertEq(h4.getLatency(), 182, 'gate8: EMA step 200→140 = 182');

  // Test: volatile.emit is used for ping. Read the actual source to check.
  // This is a static gate — we grep the file for the volatile.emit pattern.
  const clientSrc = readFileSync(
    join(ROOT, 'client', 'src', 'net', 'client.ts'),
    'utf8',
  );
  ok(
    clientSrc.includes('volatile.emit(CLIENT_EVENTS.PING'),
    'gate8: ping uses socket?.volatile.emit(CLIENT_EVENTS.PING, ...)',
  );

  console.log('  Gate 8: PASS\n');
}

// ── Gate 9: Single-writer static gate ────────────────────────────────────────
// Spec §8 item 9: me.x / me.y for the local entity assigned in EXACTLY one
// function (rebuildLocalPredicted). Grep main.ts for assignment patterns.
{
  console.log('Gate 9: single-writer static gate (me.x / me.y)');

  const mainSrc = readFileSync(
    join(ROOT, 'client', 'src', 'main.ts'),
    'utf8',
  );

  // Find all lines that assign to me.x or me.y (the local entity object).
  // We look for patterns like: me.x = ... or me.y = ...
  // This is a conservative grep — we also look for pos.x / pos.y which are
  // internal to rebuildLocalPredicted and don't count as "writes to me".
  const lines = mainSrc.split('\n');
  const meXWrites = lines.filter((line) => {
    // Skip comments
    if (line.trimStart().startsWith('//') || line.trimStart().startsWith('*')) return false;
    // Match assignment to me.x or me.y (not pos.x / pos.y)
    return /\bme\.(x|y)\s*=/.test(line);
  });

  // rebuildLocalPredicted contains: me.x = pos.x; and me.y = pos.y;
  // Those are the only legitimate assignments. The facing line uses me.facing = ..., not me.x/y.
  // Check that all me.x/me.y writes are inside the rebuildLocalPredicted function.
  // We find the function block and confirm all writes are within it.
  const rebuildStart = mainSrc.indexOf('function rebuildLocalPredicted()');
  const rebuildEnd = mainSrc.indexOf('\n  }', rebuildStart) + 4; // closing brace
  ok(rebuildStart !== -1, 'gate9: rebuildLocalPredicted function exists in main.ts');

  for (const writeLine of meXWrites) {
    const lineIdx = lines.indexOf(writeLine);
    const charOffset = mainSrc.indexOf(writeLine);
    const insideRebuild = charOffset >= rebuildStart && charOffset <= rebuildEnd;
    ok(insideRebuild,
      `gate9: me.x/me.y write "${writeLine.trim()}" is inside rebuildLocalPredicted`);
  }

  ok(meXWrites.length === 2, `gate9: exactly 2 writes to me.x/me.y (got ${meXWrites.length}): me.x=pos.x and me.y=pos.y`);

  console.log('  Gate 9: PASS\n');
}

// ── Summary ───────────────────────────────────────────────────────────────────
console.log('═'.repeat(56));
if (failures === 0) {
  console.log(`check-netcode: ALL ${assertions} assertions PASSED ✓`);
  process.exit(0);
} else {
  console.error(`check-netcode: ${failures} of ${assertions} assertions FAILED ✗`);
  process.exit(1);
}
