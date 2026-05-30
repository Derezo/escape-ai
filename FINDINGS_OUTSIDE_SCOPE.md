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
  around to a gate. Short-range open chases (the common case) work fine.
- **Why deferred:** a MOVING target has no fixed goal tile, so the cached-path model
  doesn't apply directly — pursue would need a per-tick (or fast-cadence) repath to the
  target's current tile, which is more cost + risk of jittery near-corner chasing. Both
  adversarial design critiques recommended deferring it to a measured follow-up; the user
  confirmed "defer pursue."
- **Suggested approach if picked up:** in the pursue branch, when the straight-line
  heading to the target is wall-blocked (a cheap `boxHitsSolid` look-ahead), fast-repath
  A* to the target's current tile (cadence ~3–5 ticks) and follow the first waypoint via
  the SAME dense-path + near-wall-direct logic Phase 4 added; keep the raw `steerAround`
  for the open-line case. Reuse `followPathToGoal` with the target tile as the goal.
- **Refs:** `server/game/stealth.js` `stepRobots` (the `decision.mode === 'pursue'`
  block); `server/game/behaviors.js` `moveTowardPoint` (the pattern to mirror);
  `shared/src/pathfind.ts` `findPath`.
- **Effort:** M.

### Stat-field names enumerated across four server files (low-priority DRY)
- **Status:** open — deliberate deferral, low risk.
- **Surfaced:** `/plan-validation-and-review` of the AI-Escape accounts plan, 2026-05-29
  (dedup scan).
- **Detail:** the per-player stat verbs `{escapes, caught, ordersIssued, abilitiesUsed}`
  (+`playSeconds`/`games`) are listed in four places: `server/db.js` `DELTA_COLUMNS`
  (the canonical camelCase→snake_case map), `server/game/engine.js` `flushStatsDelta`
  (zeroing), `server/socket/connection.js` (disconnect read), and `server/game/stealth.js`
  `bumpStat` (lazy init shape). Adding a future stat means touching all four.
- **Why deferred:** the schema is stable (fixed game verbs), it's 4 lines × 4 sites (not
  logic duplication), and the obvious fix — a shared field-list constant — would re-couple
  `stealth.js` (game math) to a stats module, working against the deliberate decoupling
  (`bumpStat` exists precisely so stealth.js imports no DB/stats schema). Revisit only if
  the stat set grows materially.
- **Refs:** `server/db.js` `DELTA_COLUMNS`; `server/game/engine.js` `flushStatsDelta`;
  `server/socket/connection.js`; `server/game/stealth.js` `bumpStat`.
- **Effort:** S.

### Client dev-dependency advisory: esbuild ≤0.24.2 via Vite (2 moderate)
- **Status:** open — pre-existing, out of scope, needs a human decision.
- **Surfaced:** `/plan-validation-and-review` of the 0.2.9 gameplay-depth plan, 2026-05-29
  (the plan touched no client dependencies; flagged by `npm audit` in `client/`).
- **Detail:** `npm audit` in `client/` reports 2 moderate vulns — `esbuild <=0.24.2`
  (GHSA-67mh-4wv8-2f99: a dev server can be coerced into sending requests / reading
  responses) pulled in transitively by `vite <=6.4.1`. **Dev-only** (esbuild/Vite are
  not in the shipped static bundle), so production exposure is nil; the risk is a
  local dev machine on an untrusted network.
- **Fix options:** the only `npm audit fix` path is `--force`, which installs
  `vite@8` — a **breaking major bump**. Defer to a deliberate Vite upgrade pass
  (re-verify the client build + Capacitor `base: './'` afterward), not an auto-fix.
- **Refs:** `client/package.json` (Vite dev dependency); advisory
  GHSA-67mh-4wv8-2f99.
- **Effort:** M (major-version upgrade + build re-verification).

### Spawn fallback can add a still-solid tile (relies on the reachability carve)
- **Status:** open — pre-existing, low risk, out of scope of the map-overhaul plan.
- **Surfaced:** `/plan-validation-and-review` of the map-overhaul plan, 2026-05-29
  (code-comprehension review). The plan did not touch the spawn-generation block.
- **Detail:** in `shared/src/world.ts` `generateWorld`, the final spawn fallback (when the
  block scan and the gate-row widen both find nothing) pushes a spawn tile *without*
  re-checking that it's non-solid. It's the reachability carve that later guarantees the
  spawn is walkable, and the `validity` test asserts every final spawn is non-solid — so
  the end state is safe. But the fallback itself is undefended: if the carve ever failed to
  reach that tile (it throws on non-convergence first), a solid spawn could slip through.
- **Why deferred:** the path is unchanged by this plan, never fires on the tested seed set,
  and is covered by the `validity` (spawns non-solid) + reachability tests. A defensive
  collision check on the fallback tile would be cheap but belongs to a spawn-hardening pass,
  not the map overhaul.
- **Refs:** `shared/src/world.ts` `generateWorld` spawn fallback (the `if (spawns.length === 0)`
  block); `shared/test/world.test.mjs` `validity:` + `reachability:` tests.
- **Effort:** S.
