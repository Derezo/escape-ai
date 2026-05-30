# TINS 2026

### KINS — *KINS Is Not a Starter-kit*

> (It is, though. In the grand recursive tradition of TINS Is Not SpeedHack,
> the name denies what the repo plainly is.)

A multiplayer browser game built for the [TINS 2026](https://tins.amarillion.org/2026/)
72-hour game jam. Browser-first, with an Android build via Capacitor.

TINS ("TINS Is Not SpeedHack") is a 72-hour jam where a handful of random
**Rule-O-Matic** rules — spanning Genre, Gameplay, Graphics, Technical, Sound,
Story, and Bonus — are announced at the start and every entry must satisfy them.
Source code must be submitted, and entries are judged on Art / Genre / Tech.

This repo began as a deliberately **game-agnostic starter kit** so that when the
rules dropped at hour 0 we could write *gameplay*, not boilerplate (that hour-0 plan
lives in [`docs/PLAYBOOK.md`](docs/PLAYBOOK.md)). The rules have now dropped — this is
the game we are building.

## The game — *Escape AI*

A **co-op multiplayer animal-escape** game for up to **20 players**. You are animals
that have escaped your enclosures in a megazoo run by humaniform positronic
**keeper-robots**, and you must reach the perimeter gate together. The robots obey
**Asimov's Three Laws of Robotics** — so if you make yourself *look human enough*, the
First Law forbids them from touching you. Issue orders they must obey (Second Law),
bait them away from hazards (Third Law), and watch the zoo-wide **panic meter**: let
it **overflow** and the zoo slams into **lockdown**.

### Rule-O-Matic mapping

| Rule | How we satisfy it | Where |
|------|-------------------|-------|
| **Genre #157 — "It's a Zoo!"** | Co-op breakout *from* a zoo; you play the animals. | gameplay |
| **Artistic #84 — sci-fi author** | **Isaac Asimov**: the Three Laws *are* the stealth mechanic. | [`docs/ASIMOV_REFERENCE.md`](docs/ASIMOV_REFERENCE.md) |
| **Technical #132 — catastrophic overflow** | Global **panic meter** → overflow flips a **lockdown** world state. | `shared/`, server tick |
| ~~**Technical #116 — quicksave**~~ | **Replaced** via the Bonus rule below. | — |
| **Bonus #31 — Act of Sutskever** | Invoked once; replaces #116 with an LLM-generated "double-edged element" rule, satisfied by the Second-Law order mechanic. | [`docs/ACT_OF_SUTSKEVER.md`](docs/ACT_OF_SUTSKEVER.md) |

> The Act-of-Sutskever transcript and its screenshot ship in `docs/` as the bonus
> rule requires.

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

Open the printed Vite URL in **two or more browser tabs** — each joins the default
room as an escaped animal. The manual opens on first load (toggle with **H**/**?**).
**Walk** with WASD/arrows (stay still to look human and freeze the keeper-robots),
**Shift** to sprint, **Q** to order a robot, **Space** for your species ability, and
reach the **gate** on the right edge to escape. The HUD shows latency, the panic
meter, your human-likeness, and the lockdown state.

You're assigned one of **14 playable species** (cycling by join order), each with a
distinct, Three-Laws-tied **Space** ability — disguise (ape carry, chameleon cloak,
tortoise shell), evasion (bird flit, rat skitter, mole burrow, kangaroo leap, cheetah
dash), robot-control (elephant shove, peacock dazzle, parrot mimic, skunk stink), and
panic-meta (owl hush, fox decoy). Each fires a spectacular on-screen effect every
player can see.

> Build `shared/` first (step 1) — the server loads its compiled `dist/` at boot.

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

**Animated sprite library (the zoo).** Creatures render as 8-directional animated
sprites from a packed atlas, generated programmatically from vector SVG — a reusable
template system (`scripts/sprites/`) where each species declares geometry against a
shared body archetype (quadruped / biped / bird / serpent / robot) so all 15 creatures
stay cohesive and symmetric. The pipeline:

```bash
node scripts/gen-sprites.js              # vector SVG frames → assets/sprites/frames/ (zero-dep)
node scripts/build-atlas.js              # rasterise + pack → assets/sprites/atlas.{png,json} (needs sharp)
node scripts/verify-atlas.js             # headless gate: every frame key present, no orphans
# or all three:  cd scripts && npm run sprites
```

`sharp` is a `scripts/`-only dev dependency; the **committed** `atlas.{png,json}` means a
clean clone runs without it. If the atlas is missing, the renderer falls back to the
original geometric shapes (the kit still boots with zero art). Edit a species in
`scripts/sprites/species/<name>.js` (or add one + a `registry.js` line) and rerun.

Audio (placeholder, zero deps):

```bash
node scripts/gen-placeholder-sfx.js       # → assets/sfx/*.wav
```

`scripts/gen-placeholder-sprites.js` still emits the simple static single-shape SVGs as
a fallback reference. Heavier Modia-derived generators (ElevenLabs / Suno) are
documented in the playbook and installed only if a rule calls for them.

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
docs/     PLAYBOOK.md (hour-0 guide), ANDROID.md, ASIMOV_REFERENCE.md, ACT_OF_SUTSKEVER.md
assets/   generated placeholder sprites + sfx
```

## License

zlib. See [LICENSE](LICENSE). Third-party npm dependencies retain their own
licenses, listed in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
