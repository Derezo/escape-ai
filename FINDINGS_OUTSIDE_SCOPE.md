# Findings Outside Scope

Open backlog of real, concrete issues surfaced during a phase but deliberately
deferred. When a later phase closes an item, **delete the entry** (git history is
the audit trail).

## Open

### Panic recovery is slow while any robot stays in contact
- **Status:** open — balance feel, low priority.
- **Surfaced:** Phase 3 (overflow + lockdown), 2026-05-29.
- **Detail:** In lockdown every robot pursues the player (First Law dropped). While
  even one robot is pursuing, panic rise (`RISE_PER_PURSUIT_PER_SEC` 3/sec) nearly
  cancels decay (`DECAY_PER_SEC` 4/sec), so draining from 100 to the 30% recovery
  watermark takes a long time unless the player fully breaks contact. Recovery is
  correct ("punishing, recoverable") but may feel too slow in playtesting.
- **Fix options:** tune `PANIC.DECAY_PER_SEC` / `RISE_PER_PURSUIT_PER_SEC` /
  `RECOVERY_FRACTION`; or time-box lockdown instead of purely panic-gating it.
- **Refs:** `shared/src/step.ts` (`PANIC`, `stepPanic`), `server/game/stealth.js` (`stepPanic`).
- **Effort:** S (tunables).
