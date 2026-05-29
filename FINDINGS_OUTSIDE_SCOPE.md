# Findings Outside Scope

Open backlog of real, concrete issues surfaced during a phase but deliberately
deferred. When a later phase closes an item, **delete the entry** (git history is
the audit trail).

## Open

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
