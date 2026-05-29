# Findings Outside Scope

Open backlog of real, concrete issues surfaced during a phase but deliberately
deferred. When a later phase closes an item, **delete the entry** (git history is
the audit trail).

## Open

### Stealth balance: looking human requires standing still
- **Status:** open — deferred to Phase 5 (balance pass).
- **Surfaced:** Phase 2 (Three Laws stealth core), 2026-05-29.
- **Detail:** `applyInput` moves players at full `PLAYER_SPEED` (200), which always
  exceeds `STEALTH.SPRINT_THRESHOLD` (150), so *any* movement collapses
  `humanLikeness`. You can only build/keep a human disguise while completely still,
  which makes "walk past a robot looking human" impossible.
- **Fix options:** add a walk/sprint distinction (shift = sprint), raise the sprint
  threshold above normal speed, or have human-likeness decay gently while walking and
  only crash while sprinting. All are tunables in `shared/src/step.ts` `STEALTH`.
- **Refs:** `shared/src/step.ts` (`updateHumanLikeness`, `STEALTH.SPRINT_THRESHOLD`),
  `server/game/stealth.js` (`stepPlayerHumanLikeness`).
- **Effort:** S (a few tunables + maybe a sprint input bit).

### Panic recovery is slow while any robot stays in contact
- **Status:** open — deferred to Phase 5 (balance pass).
- **Surfaced:** Phase 3 (overflow + lockdown), 2026-05-29.
- **Detail:** In lockdown every robot pursues the player (First Law dropped). While
  even one robot is pursuing, panic rise (`RISE_PER_PURSUIT_PER_SEC` 3/sec) nearly
  cancels decay (`DECAY_PER_SEC` 4/sec), so draining from 100 to the 30% recovery
  watermark takes ~70s unless the player fully breaks contact. Recovery is correct
  ("punishing, recoverable") but may feel too slow in practice.
- **Fix options:** tune `PANIC.DECAY_PER_SEC` / `RISE_PER_PURSUIT_PER_SEC` /
  `RECOVERY_FRACTION`; or make lockdown duration time-boxed instead of purely panic-gated.
- **Refs:** `shared/src/step.ts` (`PANIC`, `stepPanic`), `server/game/stealth.js` (`stepPanic`).
- **Effort:** S (tunables).

### World has no walls; players can move off-map indefinitely
- **Status:** open — deferred (level design / Phase 4–5).
- **Surfaced:** Phase 3 testing, 2026-05-29.
- **Detail:** The server integrates player movement without clamping (intentional, to
  match unbounded client prediction), and there are no enclosure/perimeter collisions
  yet, so a fleeing player can travel to e.g. (5000, 5000). Fine for the netcode demo,
  but the zoo needs bounds/walls for real level design and for the gate to be the only exit.
- **Fix options:** add wall/pen collision in `shared/step.ts` and clamp to the zoo
  perimeter (keep client prediction bounds in sync); make the perimeter gate the sole exit.
- **Refs:** `server/game/engine.js` (`integratePlayers`), `client/src/main.ts`
  (`PREDICTION_BOUNDS`), `shared/src/step.ts` (`WORLD`).
- **Effort:** M.
