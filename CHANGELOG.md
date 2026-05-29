# Changelog

All notable changes to TINS 2026. Update this file in every commit.

## 0.2 — *The Caves of Steel* (jam build)

- 0.2.2: **Phase 2 — Three Laws stealth core.** The Asimov reference is now a
  working mechanic, not a name-drop.
  - **Shared:** new deterministic Three-Laws math in `shared/src/step.ts` —
    `updateHumanLikeness`, `firstLawProtects`, `freezeThreshold`, `robotDecision`,
    `dist2`, and a centralized `STEALTH` tunables block. Pure functions, reused by
    the server (no duplication).
  - **Server:** new `server/game/stealth.js` orchestrates the NPC sim, loading the
    shared ESM math once via dynamic `import()` (server is CJS). Each tick: players'
    human-likeness rises while still / collapses while fleeing; robots run the
    First-Law freeze, pursue prey-looking animals, obey Second-Law orders (standdown
    + suspicion gain — the double-edged element), decay suspicion, and a catch hook
    soft-respawns caught players. New config tunables (ROBOT_SPEED, ORDER_DURATION,
    etc.). Engine `init()` is now async to await the shared import before the first tick.
  - **Fixed a one-shot-action race:** an action-less movement frame could clobber a
    queued `order` before the engine tick consumed it (client send and tick are both
    ~20Hz but not phase-locked). Actions now latch onto `player.pendingAction` and are
    cleared only when the engine consumes them.
  - **Client:** edge-triggered action keys (E interact / Q order / Space ability);
    HUD shows a human-likeness bar + carrying state; the renderer reflects the Laws
    visually — animals gain a bright outline as they look human, robots tint by mode
    (blue frozen / green ordered / red pursue / gray idle) with an orange suspicion ring.
  - Verified end-to-end against a live server: human-likeness 0→1 while still, robots
    freeze/pursue correctly, orders register (suspicion → 0.99, `ordered` mode observed).
  - *Known balance gap for Phase 5:* full-speed movement always exceeds the sprint
    threshold, so looking human currently requires standing still — needs a walk/sprint
    tuning pass.

- 0.2.1: **Phase 1 — multiplayer scale first.** Extended the world model and proved
  the netcode syncs 20 players plus a populated world with no desync.
  - **Shared:** `Entity` gained typed optional fields `kind`
    (`animal|robot|pen|terminal|gate`), `species`, `humanLikeness`, `suspicion`; new
    `WorldState` (`panic`/`panicCapacity`/`lockdown`) + `INITIAL_WORLD_STATE`; `Snapshot`
    and `SnapshotMsg` now carry an optional `world`; `InputMsg` gained an optional
    discrete `action` (`interact|order|ability`) for Phase 2.
  - **Server:** new `server/game/world.js` owns per-room world entities and `WorldState`,
    spawning a deterministic starter layout (4 pens, 6 robots, 8 idle animals, 3
    terminals, 1 gate). The engine merges world props into the delta/full snapshot diff
    (props ride only on full refreshes), tags players `kind:'animal'`, and attaches
    `world` to every snapshot. Players now spawn spread out instead of stacked at origin.
  - **Client:** Phaser renderer draws entities distinctly per `kind` (pens beneath
    mobile entities); HUD shows the panic meter + lockdown flag; fixed a latent bug where
    `lobby:state` pruning would have deleted world props (now prunes players only).
  - **Tooling:** new `scripts/sim-clients.js` headless load harness (20 bots @ 20Hz).
    Scale test result: 20/20 synced, 20Hz, 42 entities/full-snapshot, <3ms RTT,
    ~67 KB/s/client — no desync, no bandwidth blowup.

- 0.2.0: Rules dropped; committed to the game design. **The Caves of Steel** — a
  co-op (≤20 player) animal-escape game where Asimov's Three Laws of Robotics are the
  stealth mechanic and a global panic meter catastrophically overflows into lockdown.
  - **Bonus rule #31 (Act of Sutskever) invoked**, replacing the quicksave rule #116
    with an LLM-generated "double-edged element" rule. Transcript in
    `docs/ACT_OF_SUTSKEVER.md` (screenshot ships alongside before submission).
  - **Docs:** added `docs/ASIMOV_REFERENCE.md` (verified Three-Laws wording + Easter
    eggs) and `docs/ACT_OF_SUTSKEVER.md`; README now describes the game and maps each
    Rule-O-Matic rule to where it is satisfied.

## 0.1

- 0.1.2: Nicknamed the kit **KINS** ("KINS Is Not a Starter-kit") — a recursive
  backronym in the TINS tradition. Added as a README tagline and the GitHub repo
  description; repo name and package names unchanged.
- 0.1.1: Split third-party attributions out of `LICENSE` into
  `THIRD_PARTY_NOTICES.md` so `LICENSE` is pure zlib text and GitHub detects the
  license. README points at the new notices file.
- 0.1.0: Initial game-agnostic starter kit scaffolded ahead of the jam.
  - **Client:** Vite + TypeScript + Phaser 3 with a swappable `IRenderer`
    (`PhaserRenderer` default), Socket.IO client wrapper with ping/pong latency,
    WASD/arrow input at the server tick rate, client-side prediction + snapshot
    reconciliation, and a latency/player-count HUD. Build uses relative asset
    paths so it is Capacitor-safe.
  - **Server:** Express + Socket.IO authoritative server adapted from
    `Derezo/galaxy-miner` — `deps`-injection socket orchestrator, modular lobby
    and connection handlers, a fixed 20 Hz engine with delta/full snapshot
    broadcast, and disconnect cleanup. Game-specific logic stripped to a
    move-a-point demo. `/health` endpoint included.
  - **Shared:** TypeScript module of entity/input/snapshot types, the authoritative
    net contract (`net.ts`), a pure deterministic `applyInput` step used by both
    sides, the `IRenderer` interface, and a Babylon.js 3D-fallback guide.
  - **Android:** Capacitor wired into the client (`webDir: dist`,
    `androidScheme: https`) with the platform scaffolded; `docs/ANDROID.md`
    documents the verified APK path.
  - **Assets & tooling:** zero-dependency placeholder sprite (SVG) and SFX (WAV)
    generators, a VPS deploy script for the server, `docs/PLAYBOOK.md` mapping each
    Rule-O-Matic category to this stack, plus `ARCHITECTURE.md`, `README.md`, and
    `CLAUDE.md`.
  - **Workflow:** commit-msg hook reminding contributors to update the changelog
    and docs; installer in `scripts/hooks/`.
  - **License:** released under the zlib license (`LICENSE`); `"license": "Zlib"`
    declared in each package.json.
