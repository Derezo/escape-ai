# CLAUDE.md

Guidance for Claude Code working in this repository. Keep it light — game-specific
rules get added once the TINS Rule-O-Matic rules are announced.

## What this is

A game-agnostic multiplayer starter kit for the TINS 2026 jam. Browser-first
(Phaser 3 / Vite / TypeScript), Socket.IO authoritative server, Android via
Capacitor. Read `ARCHITECTURE.md` for the binding contract and `docs/PLAYBOOK.md`
for the hour-0 plan. The netcode is adapted from `Derezo/galaxy-miner`.
Released under the zlib license (see `LICENSE`); keep that notice intact.

## Commands

```bash
# shared — build first; client imports its source, server consumes its dist
cd shared  && npm install && npm run build

# server — authoritative loop, http://localhost:3000
cd server  && npm install && npm run dev      # or: npm start

# client — Vite dev server; open two tabs to see sync
cd client  && npm install && npm run dev
cd client  && npm run build                    # static bundle → client/dist

# assets (zero deps)
node scripts/gen-placeholder-sprites.js
node scripts/gen-placeholder-sfx.js
```

## Architecture rules

- **One source of truth for cross-side logic.** Anything client and server must
  agree on — the net contract, movement integration, math — lives in `shared/`
  exactly once. Never duplicate it into `client/` or `server/`.
- **Server is authoritative.** It runs the fixed tick and owns state. The client
  predicts locally and reconciles to server snapshots; server positions win.
- **Net events are a contract.** Event names and payload shapes are defined in
  `shared/src/net.ts`. Change them there, and update both sides in the same commit.
- **Renderer is swappable.** Gameplay talks to `IRenderer`, never to Phaser or
  Babylon directly. A 3D rule is a renderer swap — see `shared/BABYLON_FALLBACK.md`.
- **Keep the web build Capacitor-safe.** `vite.config.ts` uses `base: './'` so
  assets load in the Android WebView. Don't change it. `VITE_SERVER_URL` is baked
  at build time — set it before building the Android bundle.

## Coding standards

- TypeScript `strict` on client and shared. No new TS/lint errors.
- Match the surrounding code's style, naming, and idiom. Prefer small modules;
  extract rather than grow a file unboundedly.
- No secrets in the repo. Config comes from `.env` (copy from `.env.example`).
- No dead or duplicate code. If you add a function, wire it in or don't add it.
- Server logging is intentional operational output; debug `console.log` is not —
  remove it before committing.

## Workflow

- **Every commit updates `CHANGELOG.md`** and any docs whose behavior changed.
  When code and docs disagree, fix one of them in the same commit — never leave
  them in conflict. A commit-msg hook reminds you; install with
  `bash scripts/hooks/install.sh`.
- **After completing a plan, run `/plan-validation-and-review`** before claiming the
  work is done. It traces requirements, checks connectivity, hunts dead/duplicate
  code, and runs build + tests. It costs a little time and is worth it — it is the
  gate between "looks done" and "is done."
- For medium-or-larger work, prefer parallel subagents on independent pieces over
  one long serial pass.
- Verify before claiming done: build the client, boot the server, and where it
  matters, test sync across two clients.
