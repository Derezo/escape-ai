# Findings Outside Scope

Open backlog of real, concrete issues surfaced during a phase but deliberately
deferred. When a later phase closes an item, **delete the entry** (git history is
the audit trail).

## Open

### Client bundle is one ~1.6 MB chunk — no code-splitting (Android startup on mid-range)
- **Status:** open — deliberately deferred from the Android touch-controls plan (Phase 4).
- **Surfaced:** Android-compatibility audit, 2026-06-01 (lifecycle/perf dimension, finding M9).
- **Detail:** `client/dist/assets/index-*.js` is ~1.6 MB (gzip ~393 KB) — Phaser + socket.io +
  the A* pathfinder + the intro/leaderboard all in one chunk, with no `manualChunks` in
  `client/vite.config.ts`. On a 2 GB mid-range phone this means a startup parse/JIT stall and
  memory pressure. (The APK itself is ~69 MB, dominated by the bundled assets, not this JS.)
- **Why deferred:** code-splitting via dynamic `import()` interacts with Capacitor's
  `base: './'` relative-asset loading inside the WebView (`vite.config.ts:11`) — a chunk that
  loads with a wrong base 404s on `file://`/`https://localhost`. That needs its own careful
  build + on-device verification pass; it's the lowest-value, highest-risk item in the audit
  and unrelated to making the controls work. The game already loads and runs on the emulator.
- **Suggested approach if picked up:** lazy-load the Babylon fallback (only needed on a 3D
  rule), then dynamic-`import()` the intro + leaderboard modules; after each split, rebuild
  with `VITE_SERVER_URL` set, `cap sync`, and confirm on a device that every chunk loads (no
  404 in the WebView console) and the game still reaches the world. Document 1.6 MB as the
  baseline if splitting proves not worth the risk.
- **Refs:** `client/vite.config.ts:11` (`base: './'`); `client/dist/assets/index-*.js`;
  `client/src/render/babylon.ts` (the swappable 3D renderer); `client/src/intro.ts`,
  `client/src/leaderboard.ts`.
- **Effort:** M (build reconfiguration + per-chunk on-device verification).

### Client dev-dependency advisory: esbuild ≤0.24.2 via Vite (2 moderate)
- **Status:** open — pre-existing, out of scope, needs a human decision.
- **Surfaced:** `/plan-validation-and-review` of the 0.2.9 gameplay-depth plan, 2026-05-29
  (the plan touched no client dependencies; flagged by `npm audit` in `client/`).
- **Detail:** `npm audit` in `client/` reports 2 moderate vulns — `esbuild <=0.24.2`
  (GHSA-67mh-4wv8-2f99: a dev server can be coerced into sending requests / reading
  responses) pulled in transitively by Vite. The client is **currently on Vite 5.4.21
  (esbuild 0.21.5)** — Vite 5.4.x never bumped its bundled esbuild past the vulnerable
  range, so `vite@^5.4.0` cannot resolve to a patched esbuild. **Dev-only** (esbuild/Vite
  are not in the shipped static bundle), so production exposure is nil; the risk is a
  local dev machine on an untrusted network.
- **Fix options:** the minimal patched target is **Vite 6** (the first major to ship
  esbuild ≥0.25); `npm audit fix --force` jumps to `vite@8`. Either way it's a **breaking
  major bump**. Defer to a deliberate Vite upgrade pass (re-verify the client build +
  Capacitor `base: './'` + parent-dir `publicDir` afterward), not an auto-fix. Tracked as
  an upstream ask in `docs/UPSTREAM_ASKS.md` (with a gating test that auto-detects the fix).
- **Refs:** `client/package.json` (`vite` dev dependency); `client/vite.config.ts:11`
  (`base: './'`); advisory GHSA-67mh-4wv8-2f99; `docs/UPSTREAM_ASKS.md`.
- **Effort:** M (major-version upgrade + build re-verification).

### Doorway depth is a marker, not an elevated wall-face render
- **Status:** open — low priority (cosmetic/robustness), needs a human eyeball call.
- **Surfaced:** 2026-05-31, Pen/Pathing/Rendering overhaul (Phase 6 visual validation).
- **Detail:** the "visible doorway above the second layer" requirement ships as a yellow
  chevron marker drawn above the roof at each building's south gate (`buildDoorwayMarker`,
  `client/src/render/phaser.ts`). Directional wall tiles (`WALL_EXT_MID/*_END/CORNER_*`)
  exist in the contract and the generator stamps them; the renderer draws them on the deco
  layer UNDER the roof. There is no distinct "wall face above the second layer" depth
  render — when the roof is opaque (player outside) the south wall/door tiles are occluded
  by the roof, so the chevron is the only above-roof entrance cue. Headless screenshots
  confirm the chevron is visible and the roof fades on entry, but can't isolate a wall-face
  depth effect from the roof.
- **Why deferred:** the user-facing entrance cue works (chevron + roof fade); a true
  elevated wall-face render is a renderer depth-layering change best judged by a human
  eyeball, not a headless screenshot.
- **Suggested approach if picked up:** either (a) accept the chevron as the entrance cue
  and close this, or (b) add a render assertion/effect so south-wall door tiles read at a
  depth between the floor and the roof (entrance visible before entry).
- **Refs:** `client/src/render/phaser.ts` (`buildDoorwayMarker`, `buildRoofTiles`,
  `updateRoofFade`, `DEPTH_*` constants); `shared/src/tiles.ts` wall defs (lines 153–161).
- **Effort:** S.

### Client front-end (chat/menu) has no automated test harness
- **Status:** open — known coverage gap, larger than a single fix (no client test runner exists).
- **Surfaced:** findings audit, 2026-05-31 (test-coverage discovery lens).
- **Detail:** the client has no unit/integration test runner (no vitest/jest, no `test`
  script in `client/package.json`). The socket-level `scripts/e2e-*.js` harnesses and the
  CDP `e2e-chat-focus.js` cover the wire contract + the chat focus guard, but the
  timer-driven chat bubble queue (3 s drain, re-entrancy guard, cancel-on-open), the
  unread badge state, and the menu clickgate → splash → login flow (`client/src/menu.ts`;
  `client/src/chat.ts`) are unexercised by any committed test.
- **Why deferred:** writing these needs a client test runner (jsdom/vitest) stood up first,
  plus audio/timer mocking — materially more than a single bug fix, and the jam kit
  intentionally uses script-based (not unit) client testing today.
- **Suggested approach if picked up:** stand up vitest + jsdom in `client/`, mock the audio
  module + fake timers, then cover: chat open clears unread + cancels bubbles; bubble queue
  drains at `BUBBLE_MS`; menu gate dismiss on first gesture; splash gated behind the gate
  fade. (The new `scripts/verify.mjs` aggregator has a `client typecheck` gate but no
  client unit gate to add this to yet.)
- **Refs:** `client/src/chat.ts`; `client/src/menu.ts`; `scripts/e2e-chat-focus.js`;
  `client/package.json` (no test runner).
- **Effort:** L.

### Robot entity wire shape leaks A*-path scratch fields (optional hardening)
- **Status:** open — low priority; pre-existing, surfaced by the pursue-A* validation.
- **Surfaced:** findings-closeout Phase 4 validation (multiplayer-debug-tester), 2026-05-31.
- **Detail:** `server/game/engine.js` serialises robot entities for the snapshot delta via
  `JSON.stringify` on the raw world-entity object with NO field whitelist. Robots accumulate
  server-only scratch as they run — `headAngle`, and the A*-path cache `path` / `pathIndex` /
  `pathGoalTx` / `pathGoalTy` / `pathRepathTick`. These already rode the wire for any
  guard/investigate/return robot before Phase 4; Phase 4 only made a patrol-only robot also
  emit them the first time it enters pursue. The client renderer reads none of them (it uses
  `kind`/`x`/`y`/`facing`/`mode`/`suspicion`/`fx`), so this is NOT a desync — just a larger
  per-robot delta than necessary (a `path` array of waypoints on every pursuing/guarding
  robot).
- **Why deferred:** purely a wire-size/cleanliness optimisation, not a correctness or sync
  bug; the client already tolerates the fields. Out of scope of the pursue-A* fix.
- **Suggested approach if picked up:** whitelist the robot wire shape in `engine.js`
  `diffEntity` (project only the render-relevant fields), or move robot path-cache scratch
  onto a side Map keyed by id (off the serialised entity) so it never reaches `JSON.stringify`.
  Measure the snapshot byte delta before/after with `scripts/sim-clients.js`.
- **Refs:** `server/game/engine.js` (`diffEntity` / snapshot loop); `server/game/stealth.js`
  (`followPathToGoal` writes `path`/`pathIndex`/`pathRepathTick`); `server/game/behaviors.js`
  (`headAngle`).
- **Effort:** M.

### Dead function `penInteriorCells` in server/game/stealth.js
- **Status:** open — pre-existing dead code (surfaced by `/plan-validation-and-review`, not
  introduced by the findings-closeout plan; out of scope per the validation skill's rule).
- **Surfaced:** `/plan-validation-and-review` of the findings-closeout plan, 2026-05-31
  (dead-code scan).
- **Detail:** `server/game/stealth.js:1088` defines `function penInteriorCells(roomName,
  species, rm)` which is never called anywhere (the contained-wander code uses
  `interiorFreeCells()` / `pickContainedTarget` directly). Confirmed untouched by every
  commit of the findings-closeout plan — it predates it.
- **Why deferred:** the Phase-1 dead-code sweep was scoped to symbols the plan's own edits
  touched; this is in an unrelated region of `stealth.js`, so per the validation skill it's
  reported, not folded into this batch. It's a safe one-line-ish deletion when picked up.
- **Suggested approach if picked up:** delete the function; grep-confirm no caller (none
  today) and that no test references it.
- **Refs:** `server/game/stealth.js:1088`.
- **Effort:** Trivial.

### Inbound `input.seq` not validated as a non-negative integer (low-risk hardening)
- **Status:** open — pre-existing input-validation gap (surfaced by `/plan-validation-and-review`;
  out of scope — the room-validation Phase 3 touched a different region of `lobby.js`).
- **Surfaced:** `/plan-validation-and-review` of the findings-closeout plan, 2026-05-31
  (server-logic review).
- **Detail:** `server/socket/lobby.js:273` accepts `payload.seq` when `Number.isFinite(seq)`
  — a finite but negative or non-integer seq passes. The downstream `if (seq < player.inputSeq)
  return` (line 275) rejects stale values, so the practical blast radius is tiny (a negative
  seq only "takes" on the very first input, before `inputSeq` advances; dx/dy are clamped,
  action is whitelisted, sprint is strict-boolean). Not a vulnerability, but the seq guard
  should mirror the strictness of the other input fields.
- **Why deferred:** pre-existing and negligible-impact; input-validation policy is the
  multiplayer-security-auditor's surface, and this region wasn't in the plan's scope.
- **Suggested approach if picked up:** require `Number.isInteger(payload.seq) && payload.seq >= 0`
  (else fall back to `player.inputSeq + 1`), consistent with the clamp/whitelist applied to the
  other `input` fields.
- **Refs:** `server/socket/lobby.js:273-293` (the `input` handler).
- **Effort:** Trivial.
