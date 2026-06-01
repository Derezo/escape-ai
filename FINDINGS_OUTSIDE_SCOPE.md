# Findings Outside Scope

Open backlog of real, concrete issues surfaced during a phase but deliberately
deferred. When a later phase closes an item, **delete the entry** (git history is
the audit trail).

## Open

### Robot PURSUE chase is still reactive (no A* around walls)
- **Status:** open — deliberately deferred (user decision during the pathfinding plan).
- **Surfaced:** NPC pathfinding plan (Phases 1–4), 2026-05-30. Phase 4 routed robot
  PATROL-resume + INVESTIGATE through the new A* (`followPathToGoal`), but left the
  `pursue` branch on the original reactive `steerAround`.
- **Detail:** when a robot is actively chasing a moving player/animal
  (`decision.mode === 'pursue'` in `server/game/stealth.js` `stepRobots`), it steers
  straight at the live target with `steerAround` (one-tile-ahead probe). If the quarry
  rounds a wall/fence, the robot can press into the barrier and lag rather than routing
  around to a gate. Short-range open chases (the common case) work fine. NOTE: the
  `return`(haul) and `exit` states ALSO set `robot.mode = 'pursue'` as a wire/HUD label,
  but they already route A* + `smoothHeading` via `behaviors.moveTowardPoint`. Only the
  perception-driven `decision.mode === 'pursue'` branch is the reactive/unsmoothed one —
  a future implementer must NOT "fix" the already-correct haul/exit paths.
- **Why deferred:** a MOVING target has no fixed goal tile, so the cached-path model
  doesn't apply directly — pursue would need a per-tick (or fast-cadence) repath to the
  target's current tile, which is more cost + risk of jittery near-corner chasing. Both
  adversarial design critiques recommended deferring it to a measured follow-up; the user
  confirmed "defer pursue."
- **Suggested approach if picked up:** in the pursue branch, when the straight-line
  heading to the target is wall-blocked (a cheap `boxHitsSolid` look-ahead), fast-repath
  A* to the target's current tile (cadence ~3–5 ticks) and follow the first waypoint via
  the SAME dense-path + near-wall-direct logic Phase 4 added; keep the raw `steerAround`
  for the open-line case. Reuse `followPathToGoal` with the target tile as the goal. Also
  route the pursue heading through `movement.smoothHeading` (the anti-bounce turn-rate
  limiter added in the NPC anti-bounce plan, 2026-05-31) so a robot chasing a target
  around a corner doesn't flip its heading tick-to-tick — patrol/guard/investigate/return
  already smooth via `robot.headAngle`; pursue is the one robot path left unsmoothed.
- **Refs:** `server/game/stealth.js` `stepRobots` (the `decision.mode === 'pursue'`
  block, ~lines 506–541); `server/game/behaviors.js` `moveTowardPoint` (the pattern to
  mirror, including its `smoothHeading` call); `shared/src/pathfind.ts` `findPath`;
  `shared/src/movement.ts` `smoothHeading`.
- **Effort:** M.

### Cheetah escort quest has no re-feed buffer step (balance, not a hard lock)
- **Status:** open — a balance/playtesting judgment for the game owner, not a correctness bug.
- **Surfaced:** `/plan-validation-and-review` of the multi-step quest feature, 2026-05-30
  (code-comprehension satisfiability check).
- **Detail:** cheetah's quest is a tight 2-step `recruit ×2 → escort ×2`
  (`shared/src/quests.ts` `cheetah`). recruit-need == escort-need (2), so the HAPPY path
  works, and it is NOT a hard soft-lock: feeding re-leashes a lapsed follower, there are
  2–3 feedable decoys in every one of the 14 pens, and a catch runs `resetSteps` (restart
  at step 0). But unlike kangaroo's `recruit ×2 → reach → escort ×2` (the middle `reach`
  gives breathing room to re-feed if a follower lapses on the way home), cheetah has no
  buffer between assembling the herd and needing it intact at the gate. If a follower
  lapses mid-sprint the escort step just won't complete until the player re-feeds — mildly
  punishing, and the cheetah's dash ability keeps the lapse window small.
- **Why deferred:** changing the step list is a deliberate game-design decision (difficulty
  tuning), not a defect fix. The feature ships correct and playable as-is.
- **Suggested approach if picked up:** mirror kangaroo — insert a `reach` (home) step
  between cheetah's recruit and escort, OR drop both needs to 1. Re-pin nothing (quest
  defs are not in the world hash); `shared/test/quests.test.mjs` permits 1..3 steps so a
  3-step cheetah needs NO test update.
- **Refs:** `shared/src/quests.ts` `cheetah` (and `kangaroo` as the buffered pattern);
  `server/game/follow.js` `feedNearbyAnimal` (re-leash on re-feed); `server/game/quests.js`
  `stepEscort`.
- **Effort:** S.

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
  an upstream ask in `docs/UPSTREAM_ASKS.md`.
- **Refs:** `client/package.json` (`vite` dev dependency); `client/vite.config.ts:11`
  (`base: './'`); advisory GHSA-67mh-4wv8-2f99.
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
  unread badge state, and the menu clickgate → splash → login flow (`client/src/menu.ts`,
  356 LOC; `client/src/chat.ts`, 374 LOC) are unexercised by any committed test.
- **Why deferred:** writing these needs a client test runner (jsdom/vitest) stood up first,
  plus audio/timer mocking — materially more than a single bug fix, and the jam kit
  intentionally uses script-based (not unit) client testing today.
- **Suggested approach if picked up:** stand up vitest + jsdom in `client/`, mock the audio
  module + fake timers, then cover: chat open clears unread + cancels bubbles; bubble queue
  drains at `BUBBLE_MS`; menu gate dismiss on first gesture; splash gated behind the gate
  fade.
- **Refs:** `client/src/chat.ts`; `client/src/menu.ts`; `scripts/e2e-chat-focus.js`;
  `client/package.json` (no test runner).
- **Effort:** L.
