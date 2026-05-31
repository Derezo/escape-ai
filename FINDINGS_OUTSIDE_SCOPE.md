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
  defs are not in the world hash); update `shared/test/quests.test.mjs` if it asserts
  cheetah's step count.
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
  responses) pulled in transitively by `vite <=6.4.1`. **Dev-only** (esbuild/Vite are
  not in the shipped static bundle), so production exposure is nil; the risk is a
  local dev machine on an untrusted network.
- **Fix options:** the only `npm audit fix` path is `--force`, which installs
  `vite@8` — a **breaking major bump**. Defer to a deliberate Vite upgrade pass
  (re-verify the client build + Capacitor `base: './'` afterward), not an auto-fix.
- **Refs:** `client/package.json` (Vite dev dependency); advisory
  GHSA-67mh-4wv8-2f99.
- **Effort:** M (major-version upgrade + build re-verification).

## Open

### Unused `world` import in server/game/behaviors.js
- **Status:** Open
- **Surfaced:** 2026-05-30 (plan-validation-and-review, robot-capture plan)
- **Pointer:** `server/game/behaviors.js:21` — `const world = require('./world');` has no `world.*` usage anywhere in the file.
- **Why deferred:** Pre-existing (present at base commit `5880ea1`, untouched by the robot-capture plan). Out of scope per the validation skill's in-scope/out-of-scope rule — not traceable to the plan's changes.
- **Effort:** Trivial (delete one line); verify nothing else in the file references it (confirmed none do).

### `formatPlayTime()` duplicated in help.ts and leaderboard.ts (low-priority DRY)
- **Status:** Open
- **Surfaced:** `/plan-validation-and-review` of the global-chat plan, 2026-05-31 (dedup scan).
- **Detail:** a play-time formatter (seconds → "1h 23m" / "12m" / "45s") is defined twice
  with slightly different second-rendering: `client/src/leaderboard.ts:48-55` (used for the
  `playSeconds` column) and `client/src/help.ts:138-146` (used for the Stats-tab "Play time").
- **Why deferred:** Pre-existing — neither function was touched by the chat plan
  (`leaderboard.ts` wasn't modified at all; `help.ts` only gained the `/` controls line). Out
  of scope per the validation skill's in-scope/out-of-scope rule.
- **Suggested approach if picked up:** extract one formatter to a shared client util (e.g.
  `client/src/time.ts`) and import in both; reconcile the seconds-format difference deliberately.
- **Refs:** `client/src/leaderboard.ts:48-55`; `client/src/help.ts:138-146`.
- **Effort:** S.

### `intro_vo_3` voice clip out of sync with rewritten narration text
- **Status:** Open — needs a user-run voice regen (spends ElevenLabs credits).
- **Surfaced:** SFX-audit validation, 2026-05-31. The `intro_vo_3` narration was rewritten
  (manifest `text` + `client/src/intro.ts` `SUBTITLES`) from "…So we pour ourselves into the
  caged ones." to "…We have technology to transfer our human souls into the imprisoned
  creatures now." The text change was committed; the baked clip was NOT regenerated.
- **Detail:** `assets/voice/intro_vo_3.mp3` still SPEAKS the old line, while the on-screen
  subtitle now shows the new (and noticeably longer) line — spoken VO and subtitle mismatch.
  `durationMs: 5747` in the manifest is the OLD line's measured length, so subtitle pacing for
  this beat is also off until the clip is re-measured.
- **Why deferred:** voice generation is user-run and spends credits (per CLAUDE.md / the audio
  pipeline); it is not something the validation pass should trigger automatically.
- **Suggested fix:** `python3 scripts/generate-voice.py --key=intro_vo_3` (re-bakes the clip AND
  re-measures `durationMs`), then commit the new `assets/voice/intro_vo_3.mp3` + the manifest's
  updated `durationMs` + regenerated `client/src/audio.generated.ts`.
- **Refs:** `asset-pipeline/manifest.json` (`intro_vo_3`); `client/src/intro.ts` `SUBTITLES`;
  `assets/voice/intro_vo_3.mp3`; `client/src/audio.generated.ts` `VOICE_META`.
- **Effort:** Trivial (one user-run command + commit).
