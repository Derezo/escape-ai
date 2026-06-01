# Archived finding — Stat-field names enumerated across four server files (resolved)

*Archived 2026-05-31 during the findings-closeout plan (Phase 0). This was a deferred
item in `FINDINGS_OUTSIDE_SCOPE.md` that turned out to be **already resolved** by code
that landed after it was filed — so it was deleted from the live backlog and its
narrative preserved here for the audit trail.*

## The original finding (paraphrased)

> The per-player stat verbs `{escapes, caught, ordersIssued, abilitiesUsed}` (+
> `playSeconds`/`games`) were listed in four places — `server/db.js` `DELTA_COLUMNS`,
> `server/game/engine.js` `flushStatsDelta` (zeroing), `server/socket/connection.js`
> (disconnect read), and `server/game/stealth.js` `bumpStat` (lazy-init shape). Adding a
> future stat meant touching all four. Deferred as low-risk DRY: the schema was stable,
> it was 4 lines × 4 sites (not logic duplication), and the obvious fix (a shared
> field-list constant) would have re-coupled `stealth.js` (game math) to a stats module,
> working against the deliberate decoupling.

## Why it's resolved (verified 2026-05-31)

A consolidating module — `server/game/stats-delta.js` — landed at commit `e10ecd7`
("Animal collection Phase 1") and became the single owner of the in-memory accumulator
shape: `zeroDelta()`, `bumpStat`, `hasAny()`, `reset()`. Re-checking the four sites the
finding named, against current code:

1. `server/db.js` `DELTA_COLUMNS` — still enumerates the camelCase→snake_case **SQL
   column** map. This is intrinsic to DB persistence and the finding's own "why deferred"
   already accepted it.
2. `server/game/engine.js` `flushStatsDelta` — **no longer enumerates**; it calls
   `statsDelta.hasAny(delta)` then `statsDelta.reset(delta)`.
3. `server/socket/connection.js` (disconnect) — **no longer enumerates**; it spreads
   `{ ...(player.statsDelta || {}), playSeconds }` and lets `db.incStats` handle each key.
4. `server/game/stealth.js` — **no longer defines** `bumpStat`; it imports it from
   `stats-delta.js` and only calls it. The deliberate decoupling is intact:
   `stats-delta.js` `require`s nothing (no DB/stats-schema coupling, no cycle).

The stat set also grew (`foodCollected`, `animalsStolen`, `questsCompleted`, and three
by-species JSON maps) — i.e. the finding's own "revisit if the set grows" trigger fired
**and was handled by the new module**, not by re-touching four sites. The duplication the
finding described no longer exists; only the intrinsic SQL map remains.

The live backlog entry was therefore deleted (per the "delete the entry; git history is
the audit trail" convention), and this archive note records the resolution.
