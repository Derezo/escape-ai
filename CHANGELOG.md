# Changelog

All notable changes to TINS 2026. Update this file in every commit.

## 0.1

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
