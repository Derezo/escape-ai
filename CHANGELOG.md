# Changelog

All notable changes to TINS 2026. Update this file in every commit.

## 0.2 — *The Caves of Steel* (jam build)

- 0.2.10: **Sprite template system + atlas pipeline (Phase A of the visual-polish plan).**
  The renderer drew pure geometric shapes and the generator emitted one static labelled
  SVG per entity — no animation, no directions, no spritesheet. This lays the reusable
  programmatic-SVG foundation for an 8-directional animated zoo, built template-first and
  proven on a reference animal before any fan-out:
  - **Locked contract (`scripts/sprites/contract.js`):** 64×64 frames anchored at centre,
    8 directions (5 authored `s/n/e/se/ne` + 3 mirrored `w/sw/nw`), states `idle`×2 +
    `walk`×4, and the single `frameKey()` (`<species>_<state>_<dir>_<frame>`) that the
    generator, atlas writer, verifier, and (soon) the renderer all share — so parallel
    species builders stay consistent by construction.
  - **Template + palette + anim (`template.js`, `palette.js`, `anim.js`):** SVG primitive
    vocabulary (ellipse/limb/mirrorX/svgDoc, absorbing the old poly/star builders), a
    central 3-tone palette (the four original bases locked to the renderer's SPECIES_TINT),
    and pure phase-math (`bob`/`limbSwing`/`breathe`) so the whole zoo moves in one rhythm.
  - **Five archetypes (`archetypes/{quadruped,biped,bird,serpent,robot}.js`):** shared body
    skeletons; the quadruped base alone amortises across 8 future animals.
  - **Pipeline:** `gen-sprites.js` (zero-dep, emits per-frame SVGs + applies the mirror
    transform) → `build-atlas.js` (sharp; grid-packs to `assets/sprites/atlas.png` +
    Phaser JSON-Hash `atlas.json`, both dims kept under 2048 for the Android WebView) →
    `verify-atlas.js` (zero-dep headless gate: every expected key present, no orphans,
    geometry sane). `sharp` is a `scripts/` devDependency only — the committed atlas means
    a clean clone never needs it to run.
  - **Reference animal (ape):** built end-to-end against the `biped` archetype and verified
    (48 frames → 448×448 atlas, all keys present). Recognisable round-faced knuckle-walker
    with directional facing + walk/idle motion. Foundation locked; fan-out can begin.
  - Verified: `gen-sprites → build-atlas → verify-atlas` all green; visual contact-sheet
    inspection of the ape confirms readable silhouette + correct mirroring.

- 0.2.9: **Gameplay depth — a living, threatening zoo.** The world was static
  (robots stood dead-still until prey wandered into range; the 8 decoy animals never
  moved), so a robot you could see was a robot you could walk past. Three reinforcing
  changes, all built on one new deterministic primitive:
  - **Ambient NPC drift (shared, once):** new `WANDER` tunables + pure `hash32` /
    `wanderVec` / `wanderStep` in `@shared/step`. A heading is derived from an FNV-1a
    hash of the entity id mixed with a slow tick "bucket" (re-rolls ~every 2s) — no
    `Math.random`, no wall clock, so it's bit-deterministic and reusable/testable.
    `wanderStep` biases inward near a bound and clamps to `WORLD`.
  - **Robot patrol:** when `robotDecision` returns `idle`, the orchestrator now walks
    the robot along its `wanderStep` at the slower `PATROL_SPEED` (frozen/ordered robots
    still hold). Robots are a moving threat to route around, not scenery.
  - **Wandering decoys:** new `stepIdleAnimals` drifts the idle world-animals with the
    same `wanderStep` at `WANDER_ANIMAL_SPEED`, stepped *before* robots so they're
    perceived at this tick's positions. A decoy that drifts into perception is chased —
    peeling a robot off the players (emergent live distraction; catching a decoy is
    impossible and decoy-pursuit doesn't feed panic, both as before).
  - **Panic recovery fix (resolves the open `FINDINGS_OUTSIDE_SCOPE` item):** the pursuit
    term in `stepPanic` is now concave (`sqrt` of the pursuer count) and `DECAY_PER_SEC`
    is 4→5, so a swarm can no longer pin the meter at capacity. Net rates: 1 pursuer
    −2/sec (recovers, ~35s full→30%), 4 +1/sec, 6 +2.35/sec — shedding pursuers (incl.
    via a wandering decoy) now meaningfully accelerates the drain. The three features
    reinforce each other.
  - Verified: deterministic replay (identical NPC positions across two runs of the same
    tick sequence), robots patrol + decoys wander + stay in-bounds, a robot chases a
    decoy with no players present, shared builds/typechecks clean, server boots and
    `loadShared` validates the new `wanderStep` export.

- 0.2.8: **Validation remediation** (post `/plan-validation-and-review`). The review
  traced all 11 requirements as implemented + connected, found no architecture
  violations (shared math not duplicated), and gave ship-ready verdicts. Applied the
  small in-scope fixes it surfaced: added `'ordered'` to the shared `RobotMode` type
  (the server sets it; was flowing untyped via the index signature); removed a dead
  `lerp` export and the vestigial `Snapshot` type from shared (the wire type is
  `SnapshotMsg`); stopped the manual's H/? keys from leaking into the movement key set.

- 0.2.7: **Phase 5c — clean-clone verification + README.** Verified the full build
  from a fresh `git clone` (shared build → server install → client build) and a
  runtime boot + 12-bot sync with no errors — the server's dynamic `shared/dist`
  import resolves as long as `shared/` is built first (now called out in the README).
  Rewrote the README Quick-start to describe the actual game (walk/sprint, order,
  ability, escape via the gate) instead of the old move-a-rectangle demo.

- 0.2.6: **Phase 5b — themed sprites + per-species visuals.** The sprite generator's
  `SPRITES` table now matches the real game (ape/bird/rat/elephant/robot/pen/terminal/
  gate/prop; new hexagon + clipboard shapes); stale starter-kit SVGs removed. The
  renderer gives `prop` a distinct pale-clipboard look and draws animals by species
  (shape + per-species tint blended with the id colour), while preserving the Phase-2/3
  stealth feedback. Still shape-based — boots with no image assets.

- 0.2.5: **Phase 5a — playable loop: walk/sprint, world bounds, win condition.**
  - **Walk vs sprint (the key balance fix):** default movement now WALKS at
    `WALK_SPEED` (120, below the sprint threshold) so you can move *and* look human;
    holding **Shift** sprints at full speed but reads as fleeing prey. `WALK_SPEED`/
    `SPRINT_SPEED`/`moveSpeed()` live once in `@shared/step`; server integration and
    client prediction both call `moveSpeed` so they never disagree (the client's
    duplicate `PLAYER_SPEED` constant was removed). `InputMsg` gained `sprint`.
  - **World bounds:** players are clamped to the 1000×1000 zoo, so the perimeter gate
    is the only way out (no more walking off the map).
  - **Win condition:** reaching the gate sets a sticky `escaped` flag — the client
    shows an "🦊 ESCAPED!" banner + chime; escaped players leave the field (robots
    ignore them, they stop feeding panic).
  - Verified live: walk holds humanLikeness at 1.0, sprint collapses it to 0, reaching
    the gate flips `escaped`, movement stays in-bounds.
  - Resolved two `FINDINGS_OUTSIDE_SCOPE` items (still-to-look-human, no world walls).

- 0.2.4: **Phase 4 — Sutskever element, species roles, SFX & the in-game manual.**
  - **Species abilities (server + shared):** players are assigned ape/bird/rat/elephant
    by join order. `prop` added to the `EntityKind` union; a carryable disguise
    **Clipboard** (`prop-1`) is spawned. Abilities (Space): ape carries/hands-off the
    prop (the human-likeness floor), bird *flits* (briefly uncatchable), rat *skitters*
    (briefly invisible to robot perception), elephant *shoves* (stun + push a robot, and
    — double-edged — bumps panic). All timed deterministically off the tick counter.
  - **The double-edged element is now explicit:** the Second-Law order (and the elephant
    shove) help immediately but raise suspicion + panic; the manual calls this out so
    reviewers credit the Act-of-Sutskever replacement rule.
  - **SFX (client):** new `audio.ts` (Web Audio, renderer-independent) loads the
    placeholder WAVs and fires them on actions (order/ability/interact), on the lockdown
    klaxon (the seams left in Phase 3), and on a catch. `vite.config.ts` now bundles the
    repo-root `assets/` via `publicDir`, so sprites/sfx ship at `./sfx/*` (Capacitor-safe)
    with no duplication.
  - **In-game manual (client):** new `manual.ts` overlay (toggle **H** / **?**, opens on
    first load) with the premise, controls, the **verbatim Three Laws**, the species
    guide, the double-edged-order callout, and Asimov Easter eggs (U.S. Robots, Multivac,
    "INSUFFICIENT DATA FOR MEANINGFUL ANSWER"). Covers the recurring TINS in-game-help
    requirement + the STORY beat.
  - Verified: players receive species, prop entity present, abilities fire under 8-bot
    load with no errors; SFX + manual bundle into `dist/`.

- 0.2.3: **Phase 3 — catastrophic overflow → lockdown** (TINS technical rule #132).
  - **Shared:** new deterministic `stepPanic(world, events, dt)` + `PANIC` tunables in
    `shared/src/step.ts`. The panic meter is the "container": it rises from robots
    pursuing players, player catches, and Second-Law orders; decays when players lie
    low; overflows to `lockdown` at capacity and lifts only after draining below 30%
    (hysteresis, so it doesn't flicker at the brim).
  - **Server:** `stepRobots` now tallies pursuit/catch events and `applyAction` latches
    order counts; a new `stepPanic` per room runs the shared overflow math each tick and
    logs lockdown transitions. **Important fix:** only robots chasing real *players*
    stoke panic — chasing idle scenery-animals does not, otherwise the meter climbed to
    overflow with zero player provocation. In lockdown, robots already drop First-Law
    caution (via `robotDecision(…, true)`) and speed up.
  - **Client:** the panic HUD line is now a 10-cell meter bar; a full-screen pulsing-red
    lockdown overlay + "⚠ LOCKDOWN" banner makes overflow unmissable (edge-triggered,
    with a seam left for the Phase-4 klaxon SFX).
  - Verified live: idle player keeps panic at 0; provocation overflows → lockdown; panic
    drains and lockdown lifts once contact is broken.
  - Logged three balance/level items for Phase 5 in `FINDINGS_OUTSIDE_SCOPE.md`
    (still-to-look-human, slow recovery in contact, no world walls).

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
