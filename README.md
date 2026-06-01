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
| Deploy | nginx + pm2 on a VPS (env-driven) | `scripts/provision-escape.sh`, `scripts/deploy-server.sh` |

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

**One command** — `scripts/run-dev.sh` builds `shared/`, starts the server (`:3000`)
and the Vite client (`:5173`) together, and tears both down on Ctrl-C:

```bash
./scripts/run-dev.sh                 # install-if-needed, then run server + client
./scripts/run-dev.sh --clean         # also wipe local dev data (fresh accounts/stats)
./scripts/run-dev.sh --force-install # reinstall deps even if up to date
./scripts/run-dev.sh --server-only   # or --client-only
SERVER_PORT=3001 CLIENT_PORT=5180 ./scripts/run-dev.sh   # override ports
```

It only runs `npm install` when `node_modules` is missing or a lockfile changed
(no needless reinstall), and it **auto-kills** anything already on the dev ports
before starting — so a stale process from a previous run never blocks it. Each
service runs in its own process group, so Ctrl-C takes down `npm`'s `node --watch`
/ `vite` grandchildren too (no orphans).

<details><summary>…or run the three steps by hand</summary>

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
</details>

Open the printed Vite URL in **two or more browser tabs** — each joins the default
room as an escaped animal. The manual opens on first load (toggle with **H**/**?**).
Reach the **gate** on the right edge to escape — but the gate is locked until you've
finished your **side-quest** (shown in the HUD). The HUD also shows latency, the panic
meter, your human-likeness, the lockdown state, and what you're carrying.

**Controls:**

| Key | Action |
|-----|--------|
| **WASD** / **arrows** | Walk — staying still reads as *human* and freezes the keeper-robots |
| **Shift** | Sprint — fast, but reads as *prey* (robots may give chase) |
| **E** | Interact — use a terminal, pick up a disguise prop, or collect food |
| **F** | Feed the nearest animal its liked food → it joins your herd and follows you |
| **Q** | Order a robot to stand down (Second Law) — but every order raises the panic meter |
| **Space** | Your species ability (a big on-screen effect everyone sees) |
| **I** | Inventory — collected food and which species each feeds |
| **H** / **?** | Toggle the in-game manual |

**Herd & escape.** Collecting food (**E**) and feeding animals (**F**) builds a herd
that follows you to the gate — a bigger herd scores more, and you can *steal* followers
fed by rivals. Finish your side-quest, gather your herd, and reach the gate together.

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

The game deploys to a VPS as a **single origin**: nginx terminates TLS, serves the
static client bundle from disk, and reverse-proxies only `/socket.io/` + `/health`
to a loopback-bound node process. Because client and server share one origin there
is **no CORS surface** — production CORS stays locked (`origin: false`). The node
process runs under a dedicated, login-disabled (`nologin`) system user via that
user's own pm2; the port it binds is **loopback-only and never opened in the
firewall**.

### Configuration — `scripts/deploy.env`

All host/user/domain/port values are env-driven and live in **one** gitignored
file. Nothing about your infrastructure is hard-coded in the committed scripts —
the host, the SSH login user, and the public domain have **no defaults** and the
scripts error out if they are unset.

```bash
cp scripts/deploy.env.example scripts/deploy.env
# edit scripts/deploy.env — set DEPLOY_HOST, DEPLOY_USER, APP_DOMAIN, etc.
```

| Variable | Required | Meaning |
|----------|----------|---------|
| `DEPLOY_HOST`  | **yes** | VPS hostname rsync/ssh connects to |
| `DEPLOY_USER`  | **yes** | SSH **login** user (a sudoer) used to deploy |
| `APP_DOMAIN`   | **yes** | public hostname the game is served at (nginx + TLS) |
| `APP_USER`     | no (`escape`) | dedicated **nologin** user that owns the files & runs node |
| `REMOTE_PATH`  | no (`/var/www/$APP_USER`) | deploy root on the VPS |
| `APP_PORT`     | no (`3390`) | loopback port node binds; proxied by nginx, never public |
| `PM2_NAME`     | no (`$APP_USER`) | pm2 process name (also the `pm2-$APP_USER.service` unit) |
| `SSH_KEY`      | no (`~/.ssh/id_ed25519`) | private key for the connection |

### One-time provisioning (run once on the VPS)

`scripts/provision-escape.sh` is idempotent and creates everything securely:
the `nologin` app user (no shell, no password, can't ssh in), the deploy dirs with
tight ownership, a per-user pm2 systemd unit that resurrects the process on reboot,
the nginx vhost (static client + socket/health proxy), a Let's Encrypt certificate,
and the firewall rules (allows the web edge; keeps the app port closed).

```bash
# copy your scripts/deploy.env to the VPS next to the script, then, on the VPS:
sudo bash provision-escape.sh
# or pass values inline:
sudo APP_DOMAIN=escape.example.com APP_USER=escape APP_PORT=3390 bash provision-escape.sh
```

> If DNS for `APP_DOMAIN` doesn't resolve to the box yet, run with `SKIP_CERTBOT=1`
> to provision everything but TLS, then rerun once DNS is live to issue the cert.

### Deploy (from your dev machine, repeatably)

`scripts/deploy-server.sh` builds `shared/` + the client bundle locally (baking
`VITE_SERVER_URL=https://$APP_DOMAIN`), rsyncs `server/`, `shared/`, and the client
bundle to the VPS, installs production deps remotely, hands ownership to the app
user, zero-downtime-reloads pm2, and health-checks.

```bash
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

**Audio.** Zero-dep placeholder blips boot the game with sound on every action:

```bash
node scripts/gen-placeholder-sfx.js       # → assets/sfx/*.wav (synthesized, zero-dep)
```

For a real audio identity there's a **Suno generation pipeline** ([sunoapi.org](https://sunoapi.org/)),
themed eerie/creepy horror — *light and spooky* music, *punchy* SFX.
`asset-pipeline/manifest.json` is the single source of truth for every music track and
SFX; `asset-pipeline/theme.json` is the editable global aesthetic. The Python scripts
(stdlib-only) read **`SUNOAPI_KEY` from your system environment** — never a repo file:

```bash
export SUNOAPI_KEY=...                             # your sunoapi.org key (system env, not .env)

cd scripts && npm run audio                        # codegen client bindings + drift gate (free)
python3 scripts/generate-sfx.py --list             # status of every asset (free, no network)
python3 scripts/generate-sfx.py --key=robot_alert --dry-run   # preview the request (free)

python3 scripts/generate-sfx.py --key=robot_alert  # generate one (spends credits)
python3 scripts/generate-music.py --generate-all --only must  # the must-have batch
python3 scripts/change-sfx-track.py --key=robot_alert --sample=2   # prefer the 2nd sample
```

Generation is **user-run and spends credits**; `--dry-run`/`--list`/`--credits` are free.
Each run downloads both samples to the gitignored `asset-pipeline/output/<key>/`, auto-places
sample #1 at the manifest target, and writes a provenance JSON. SFX fall back to a synth WAV
until their `.mp3` exists, so the game always has sound. Full guide (cost notes, prompt
best-practices, how to add an asset): [`docs/AUDIO_PIPELINE.md`](docs/AUDIO_PIPELINE.md).

> The API sits behind Cloudflare bot protection, so the client sends browser-like headers; a
> `403 error code: 1010` means a header/IP block, **not** a bad key.

`scripts/gen-placeholder-sprites.js` still emits simple static SVGs as a fallback reference.

## Development workflow

Read [`CLAUDE.md`](CLAUDE.md) before contributing. Two standing rules:

- **Every commit** updates [`CHANGELOG.md`](CHANGELOG.md) and any docs whose
  behavior changed. A commit-msg hook reminds you — install it with
  `bash scripts/hooks/install.sh`.
- **After completing a plan**, run `/plan-validation-and-review` before calling the
  work done.

## Layout

```
client/         Vite + TS + Phaser app (entry: client/src/main.ts)
server/         Node + Socket.IO authoritative server (entry: server/index.js)
shared/         TS types, net contract, deterministic step(), renderer interface
scripts/        asset/audio generators, Suno pipeline (sunoapi/, audio/), deploy, hooks/
asset-pipeline/ Suno audio contracts: theme.json + manifest.json (output/ gitignored)
docs/           PLAYBOOK.md, AUDIO_PIPELINE.md, ANDROID.md, ASIMOV_REFERENCE.md, ACT_OF_SUTSKEVER.md
assets/         generated sprites, tiles, sfx (+ music/ once generated)
```

## License

zlib. See [LICENSE](LICENSE). Third-party npm dependencies retain their own
licenses, listed in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
