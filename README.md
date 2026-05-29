# TINS 2026

A multiplayer browser game built for the [TINS 2026](https://tins.amarillion.org/2026/)
72-hour game jam. Browser-first, with an Android build via Capacitor.

TINS ("TINS Is Not SpeedHack") is a 72-hour jam where a handful of random
**Rule-O-Matic** rules — spanning Genre, Gameplay, Graphics, Technical, Sound,
Story, and Bonus — are announced at the start and every entry must satisfy them.
Source code must be submitted, and entries are judged on Art / Genre / Tech.

This repo is a deliberately **game-agnostic starter kit**: when the rules drop at
hour 0 we decide the actual game and write *gameplay*, not boilerplate. The hour-0
plan lives in [`docs/PLAYBOOK.md`](docs/PLAYBOOK.md).

> **Game design TBD** — genre and theme are set when the competition rules are
> announced.

## Architecture

See [`ARCHITECTURE.md`](ARCHITECTURE.md) for the binding contract.

| Layer | Tech | Location |
|-------|------|----------|
| Renderer | Phaser 3 (2D default), Babylon.js (3D fallback) | `client/src/render/` |
| Client | TypeScript + Vite | `client/` |
| Netcode | Socket.IO authoritative server, fixed 20 Hz tick | `server/` |
| Shared | TS types + net contract + deterministic `step()` | `shared/` |
| Android | Capacitor wraps the web build | `client/capacitor.config.ts` |
| Deploy | mittonvillage.com VPS | `scripts/deploy-server.sh` |

The renderer sits behind a common `IRenderer` interface, so a "3D" genre rule is a
renderer swap (`PhaserRenderer` → `BabylonRenderer`), not a rewrite — see
[`shared/BABYLON_FALLBACK.md`](shared/BABYLON_FALLBACK.md). Game logic that both
sides must agree on (movement integration, math) lives in `shared/` exactly once
and is linked by client (prediction) and server (authority) alike.

## Lineage — what was adapted from prior projects

This kit distills patterns from three of the author's existing games. The netcode
and asset pipeline are **adaptations**, not copies — game-specific logic (mining,
combat, NPCs, persistence) was stripped, leaving a reusable skeleton.

| Source repo | What was adapted into this kit |
|-------------|--------------------------------|
| [`Derezo/galaxy-miner`](https://github.com/Derezo/galaxy-miner) | The entire server shape: Express + Socket.IO bootstrap, the `deps`-injection socket orchestrator (`server/socket/index.js`), modular per-feature handlers, the fixed-tick authoritative engine with delta/full snapshot broadcast (`server/game/engine.js`), ping/pong latency, and disconnect cleanup. Client-side prediction + server reconciliation follows the same model. |
| [`Derezo/Modia`](https://github.com/Derezo/Modia) | The ESM `@shared` alias pattern (shared logic imported by both client and server), the asset/audio generator approach behind `scripts/gen-placeholder-*`, and the plan-validation → remediation development discipline reflected in this changelog. |
| [`Derezo/parasite`](https://github.com/Derezo/parasite) | The "shared core" boundary (cross-side logic lives in exactly one place), the docs-and-code-stay-in-sync rule, and the build/test pre-commit gate adapted in `scripts/hooks/`. |

The galaxy-miner server in particular is the direct ancestor of `server/` — read its
[CLAUDE.md](https://github.com/Derezo/galaxy-miner) if you want the fuller rationale
behind the tick loop, proximity broadcasting, and shared-constants approach.

## Quick start (development)

Requires **Node 22+**.

```bash
# 1. Build the shared module (client imports its source via Vite alias; building
#    once also produces the dist the server can consume).
cd shared && npm install && npm run build && cd ..

# 2. Start the authoritative server (defaults to http://localhost:3000)
cd server && npm install && npm run dev      # or: npm start
# leave running; in another terminal:

# 3. Start the client dev server
cd client && npm install && npm run dev
```

Open the printed Vite URL in **two browser tabs** — each joins the default room and
you'll see both players' rectangles move in sync (WASD / arrow keys). The HUD shows
latency and player count.

Point the client at another server with `VITE_SERVER_URL`:

```bash
VITE_SERVER_URL=https://your-vps.example.com npm run dev
```

## Production build & deploy

```bash
# Client → static bundle in client/dist (relative asset paths, Capacitor-safe)
cd client && VITE_SERVER_URL=https://your-vps.example.com npm run build

# Server → VPS (edit HOST/REMOTE_PATH at the top of the script first)
./scripts/deploy-server.sh
```

## Android build

Full path in [`docs/ANDROID.md`](docs/ANDROID.md). Summary:

```bash
cd client
VITE_SERVER_URL=https://your-vps.example.com npm run build
npx cap add android        # first time only
npx cap sync
npx cap open android        # then Build > Build APK in Android Studio
```

## Assets

Placeholder art and audio generate with zero external dependencies:

```bash
node scripts/gen-placeholder-sprites.js   # → assets/sprites/*.svg
node scripts/gen-placeholder-sfx.js       # → assets/sfx/*.wav
```

Swap in real assets at hour 0 per the Graphics/Sound rules; heavier
Modia-derived generators (sharp / ElevenLabs / Suno) are documented in the
playbook and installed only if a rule calls for them.

## Development workflow

Read [`CLAUDE.md`](CLAUDE.md) before contributing. Two standing rules:

- **Every commit** updates [`CHANGELOG.md`](CHANGELOG.md) and any docs whose
  behavior changed. A commit-msg hook reminds you — install it with
  `bash scripts/hooks/install.sh`.
- **After completing a plan**, run `/plan-validation-and-review` before calling the
  work done.

## Layout

```
client/   Vite + TS + Phaser app (entry: client/src/main.ts)
server/   Node + Socket.IO authoritative server (entry: server/index.js)
shared/   TS types, net contract, deterministic step(), renderer interface
scripts/  asset/audio generators, deploy-server.sh, hooks/
docs/     PLAYBOOK.md (hour-0 guide), ANDROID.md
assets/   generated placeholder sprites + sfx
```

## License

zlib. See [LICENSE](LICENSE). Third-party npm dependencies retain their own
licenses, listed in `LICENSE`.
