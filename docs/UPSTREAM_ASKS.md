# Upstream Asks

Open issues in an upstream dependency that this repo can't fix from its own code —
only by consuming a fixed upstream release. Each entry has a reproducer you can run
today and a gating signal that tells us when the upstream fix has landed.

Resolved items move to `docs/archive/` — the gating signal is the durable proof the
fix shipped.

## Open

### esbuild ≤0.24.2 dev-server SSRF (GHSA-67mh-4wv8-2f99), pulled in by Vite 5
- **Status:** open — waiting on a deliberate Vite-major upgrade in this repo.
- **Upstream:** `esbuild` (the advisory), surfaced through `vite`'s bundled esbuild.
  Advisory: <https://github.com/advisories/GHSA-67mh-4wv8-2f99> — a running esbuild dev
  server can be coerced by any website into sending requests and reading the responses.
- **Reproducer (run today):**
  ```bash
  cd client && npm audit
  # → 2 moderate: esbuild <=0.24.2 (GHSA-67mh-4wv8-2f99) via vite <=6.4.1
  npm ls esbuild      # → esbuild@0.21.5 (transitive, under vite@5.4.x)
  ```
- **Scope / why it's upstream, not a code workaround:** esbuild/Vite are **dev-only** —
  neither ships in the static `client/dist` bundle, so deployed/Android exposure is nil.
  The risk is a local dev machine on an untrusted network. The repo cannot patch esbuild
  from its own code; the only fix is to consume a Vite major that bundles esbuild ≥0.25.
  Vite 5.4.x never bumped its esbuild past the vulnerable range, so `vite@^5.4.0` can't
  resolve to a patched esbuild — this is genuinely gated on an upstream (major) release we
  haven't adopted yet.
- **Upstream fix / how it resolves here:** bump the `client` `vite` devDependency to a
  major that bundles esbuild ≥0.25 — **Vite 6** is the minimal patched target (`npm audit
  fix --force` jumps all the way to `vite@8`). This is a breaking major bump, so it belongs
  in a deliberate upgrade pass, not an auto-fix: after bumping, re-verify the client build,
  the Capacitor `base: './'` relative-asset emit (`client/vite.config.ts:11`), and the
  parent-dir `publicDir` resolution, then run the gating test below.
- **Gating signal (auto-detects the fix):** `cd client && npm audit` reports **0 moderate**
  (the esbuild advisory clears once the bundled esbuild is ≥0.25). The repo-wide
  `node scripts/verify.mjs` aggregator does not yet assert audit-clean; when the Vite upgrade
  lands, add an `npm audit --audit-level=moderate` gate (in `client/`) to the aggregator so a
  regression re-fails — at which point this entry moves to `docs/archive/`.
- **Repo-side note:** also tracked as a deferred backlog item in `FINDINGS_OUTSIDE_SCOPE.md`
  ("Client dev-dependency advisory") because the *action* (the Vite-major upgrade pass) is
  repo-side work; this file records the *upstream gap* that necessitates it.
