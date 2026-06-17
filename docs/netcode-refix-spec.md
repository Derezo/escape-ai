# Netcode Reconciliation Re-Fix — Implementation Spec (verification oracle)

> Working doc for the high-latency reconciliation regression re-fix. Delete after the
> fix lands + verifies (per the living-docs convention; the commit is the audit trail).

## Decision: Variant B (separate-baseline / pure-rebuild)

`entities.get(myId).{x,y}` becomes a PURE recomputed function of `(confirmedX/Y, pendingInputs)`
with a SINGLE writer (`rebuildLocalPredicted`). Double-integration is structurally unreachable.

## main.ts changes

### New state (near the `seq`/`pendingInputs` decls, in the `entities`/`myId`/`localMap` closure)
```ts
// The ONLY source of truth for the local player's position. Updated solely from
// snapshots, and ONLY on ticks where our entity is actually present in msg.entities.
// `undefined` until the first snapshot that carries our entity (pre-join / pre-seed).
let confirmedX: number | undefined;
let confirmedY: number | undefined;
```
`PendingInput {seq,dx,dy,sprint}` and `MAX_PENDING_INPUTS = 50` unchanged. `confirmedX/Y`
live OUTSIDE the `entities` map deliberately.

### New primitive (place just above `sendInputFrame`)
```ts
/**
 * Recompute the local player's PREDICTED (rendered) position from the server-
 * confirmed baseline plus every still-unacked input, and write it into the render
 * cache entities.get(myId). PURE w.r.t. (confirmedX/Y, pendingInputs): reads those,
 * writes ONLY entities.get(myId).{x,y}. NEVER reads me.{x,y} as input, NEVER mutates
 * confirmedX/Y — so it cannot accumulate / double-integrate regardless of how often
 * or in what order it is called. Idempotent. The ONLY writer of me.{x,y}.
 */
function rebuildLocalPredicted(): void {
  if (!myId) return;
  const me = entities.get(myId);
  if (!me) return;
  if (confirmedX === undefined || confirmedY === undefined || !localMap) return; // no anchor → leave lobby seed
  const pos = { x: confirmedX, y: confirmedY };  // fresh copy of immutable baseline every call
  for (const inp of pendingInputs) {
    if (inp.dx !== 0 || inp.dy !== 0) {
      moveWithCollision(pos, inp.dx, inp.dy, FIXED_DT, moveSpeed(inp.sprint),
        localMap.collision, localMap.w, localMap.h, localMap.tile, PREDICT_RADIUS);
    }
  }
  me.x = pos.x;
  me.y = pos.y;
}
```

### onSnapshot body — ordering A→B→C→D→E (load-bearing)
- **A. Merge delta (unchanged):** `for (e of msg.entities) entities.set(e.id, {...get, ...e})`.
  Comment: this transiently overwrites local x/y IF present; step D rebuilds it synchronously
  in the same handler — keep A and D in the same synchronous handler.
- **B. Capture baseline, PRESENT-ONLY:** scan `msg.entities` for `e.id === myId`; if found and
  `typeof e.x/e.y === 'number'`, set `confirmedX/Y = e.x/e.y`. If NOT present, LEAVE confirmedX/Y
  UNTOUCHED. ← the central fix.
- **C. Prune by live ack:** if `typeof msg.acks[myId] === 'number'`, `ackedSeq = msg.acks[myId]`;
  splice all front entries with `seq <= ackedSeq`. (seq is 1-based so ack==0 prunes nothing.)
- **D. Rebuild (UNCONDITIONAL):** `rebuildLocalPredicted()`.
- **E. Tail (unchanged):** `latestTick`, `world`.

### sendInputFrame changes
- KEEP: `seq += 1` before use (1-based, load-bearing); `net.sendInput`; unconditional
  `pendingInputs.push({seq,dx,dy,sprint})` every frame incl. zero-vector; the cap; facing prediction.
- REPLACE the in-place prediction block (incl. its `(dx||dy)` guard) with a single UNCONDITIONAL
  `rebuildLocalPredicted();` after the push/cap. Update the FIXED_DT comment: prediction and replay
  are the SAME function so they always agree; residual vs server wall-clock dt is bounded by the
  ≤50 unacked tail and annihilated by the next present-snapshot re-anchor.

### dt: FIXED_DT = 0.05 for both (same function). Correct + only available choice.

## client.ts changes (latency hardening — independent of movement fix)
- **Pong handler (103–107):** after `const rtt = Date.now() - msg.t;` add
  `if (!Number.isFinite(rtt) || rtt < 0 || rtt > PING_INTERVAL_MS * 4) return;` before the EMA.
- **Ping emit (279):** `this.socket?.volatile.emit(CLIENT_EVENTS.PING, payload);`

## VERIFICATION ORACLE (exact x-traces; WALK step = 6u/axis; reproduce to the unit)
1. **Start-from-rest, entity OMITTED at onset (1-tick-RTT, continuous East):** rendered x = **206→212→218→224**, +6/tick, monotonic, no lurch. confirmedX = 206→212→**212 (untouched on the omitted tick)**→218; acks = 1,2,**2 (omitted tick re-uses prior ack)**,3. On the omitted tick rendered = confirmedX(212) + one unacked input(seq3)·6 = 218; the next present tick re-anchors confirmedX to 218 and rendered continues to 224. (Old bug: 218→224→snap-to-212 / runaway to 230.) **NOTE:** server-x and ack advance in the *same* tick, so a (present, x=218, ack=1) pairing is physically impossible — x=218 ⇒ ack=3. Invariant: rendered = confirmedX + (nonzero-unacked tail)·6; during continuous 1-tick-RTT motion the tail is exactly 1.
2. **Steady move, present every tick:** rendered = confirmedX + (nonzero-unacked-count)·6, error 0.
3. **Stop (zero-vectors):** settles exactly at server x (e.g. 312) and stays — no creep.
4. **Last-write-wins ack jumps by 2:** 418 → 412 (one 6u backward settle). EXPECTED protocol artifact; prune stays `seq<=ack`; do NOT client-fix.
5. **ack==0 after join:** holds at seed (500) until first present snapshot, then 512→518. ack==0 admitted via `typeof==='number'`.
6. **Replay into wall:** converges to shared clamp point (same moveWithCollision both sides), ≤6u optimistic lead, no oscillation.
7. **NaN/Infinity:** none reachable (no division/normalize in path; typeof-guarded assigns).

## Automated gates (wire into `cd scripts && npm run verify`)
1. Oracle replication — all 7 traces exact to the unit.
2. No-runaway: `|rendered.x − confirmedX| ≤ pendingInputs.length · SPRINT_SPEED · FIXED_DT` always.
3. Convergence after stop: error 0, zero variance over 20 trailing ticks.
4. Steady-state error 0 (harness dt = 0.05 exact).
5. Omitted-entity: per-tick forward displacement is EXACTLY one step (≤6u), never two (≤12u).
6. Join/ack==0: prune removes 0 while confirmed undefined; first present sets baseline → matches oracle (512). Static comment: seq is 1-based.
7. NaN/Infinity fuzz: rendered x/y always finite.
8. Latency clamp unit test: rtt∈{20000,NaN,Infinity,-5,4001} rejected (latencyMs unchanged); 140 from -1 → 140; steady 140 → EMA→140; assert ping uses `.volatile.emit`.
9. Single-writer static gate: `me.x`/`me.y` (local) assigned in EXACTLY one function (`rebuildLocalPredicted`).
10. Full `npm run verify` green + manual two-tab check.
