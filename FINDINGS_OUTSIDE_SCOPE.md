# Findings Outside Scope

Open backlog of real, concrete issues surfaced during a phase but deliberately
deferred. When a later phase closes an item, **delete the entry** (git history is
the audit trail).

## Open

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
