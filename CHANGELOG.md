# Changelog

All notable changes to TINS 2026. Update this file in every commit.

## 0.2 — *The Caves of Steel* (jam build)

- 0.2.22: **Fix — species-selector sprites rendered spliced (wrong atlas frames) + validation
  remediation.** Post-implementation review of the accounts plan.
  - **Species sprite splicing (CRITICAL, user-reported):** the login species selector (and the
    help Species tab) animated each sprite with a CSS `@keyframes` + `steps(4)` over
    `background-position`. But a species' four south-walk frames are NOT a contiguous strip in the
    packed atlas — a cycle can wrap to a new row (e.g. elephant: 1600,320 → 1664,320 → 0,384 →
    64,384). CSS `steps()` linearly *interpolates* between keyframe stops, so a row-wrapping frame
    landed `background-position` mid-atlas and rendered two half-creatures spliced together (the
    elephant "split in two"). `client/src/species-sprite.ts` now steps to each frame's EXACT (x,y)
    rect in JS (one interval per element, self-stopping on DOM detach via an `isConnected` check,
    plus an exported `stopSpeciesSprite()` for eager disposal) — never interpolating between rects.
    Verified in a real headless Chrome screenshot of the login screen: all 14 species render whole.
  - **Idle-decoy roster drift (HIGH, dedup finding):** `server/game/world.js` hardcoded the
    14-species list (with a "MUST stay in sync" comment) to skin its idle decoy animals — the exact
    drift the shared roster was meant to kill. It now pulls from the same shared list as the player
    spawner via `socket/species-roster.js` (`getKeys()`), with a single-ape emergency fallback.
  - The stat-field-name enumeration spread across four server files is documented as a deliberate
    low-priority deferral in `FINDINGS_OUTSIDE_SCOPE.md` (fixing it would re-couple the decoupled
    `bumpStat`). Re-verified: shared+client build/tsc clean, server `npm audit` 0 vulns, end-to-end
    socket auth/join/species/stats integration green.

- 0.2.21: **Client — splash → login → game, restyled HUD, tabbed help widget** (phases 3 & 4
  of the accounts plan). Replaces the bare `prompt('Your name?')` and the manual-opens-on-load
  with a designed front end; all UI stays DOM/CSS overlays (renderer-agnostic).
  - **`client/src/auth.ts`** (new): localStorage wrapper (`aiescape.auth` → `{username, token}`),
    defensive load/save/clear — the Parasite-style persisted identity.
  - **`client/src/menu.ts`** (new): `runMenu(net)` drives the pre-game UI and resolves once
    authed. An animated **"AI ESCAPE" splash** ("Press any key to continue"; the first gesture
    also unlocks audio), then a **login panel** — auto-login via stored token ("Welcome back…"),
    else a username field + a **species selector** (a grid of all 14 species with animated atlas
    sprites, defaulting to the user's last species). Handles every `auth:result`: `ok` saves the
    token and joins; `name_taken` shows an inline error; `bad_token` clears storage and falls back
    to manual entry. Caches the latest `UserStats` for the help widget.
  - **`client/src/species-sprite.ts`** (new): a pure-CSS animated sprite from the existing atlas
    (`./sprites/atlas.png`/`.json`, 64px frames) — fetched once and shared; steps the `*_walk_s_*`
    cycle via `@keyframes steps(4)` (no JS timers → no cleanup/leak), with a colored-block fallback
    (mirroring the renderer's `SPECIES_TINT`) when the atlas is absent. Reused by the login selector
    and the help Species tab.
  - **`client/src/help.ts`** (new, replaces `manual.ts`): the manual becomes a **tabbed widget**
    (H/? toggles, Esc/× closes, no longer opens on load). **Controls** (default), **Species** (all
    14 animated cards with ability + blurb), **More** (the lore — premise, verbatim Three Laws, the
    double-edged-order/Sutskever callout, overflow, the "THE CAVES OF STEEL" flavor + U.S. Robots
    footer), and **Stats** (the logged-in user's games/escapes/caught/orders/abilities/play-time/
    last-species, refreshed on each activation).
  - **`net/client.ts`**: `login(username, token?, species?)`, `onAuthResult(cb)`, and `join(...)`
    extended with optional species — all via the shared event constants.
  - **`main.ts`**: gated boot (awaits `runMenu` before `net.join`); the HUD is redesigned from a
    `white-space:pre` debug dump into a styled, condensed panel — title **AI ESCAPE** + rows for
    latency, players, panic bar, lockdown indicator, human-like bar (+freeze hint), and carrying
    (shown only when relevant). Dropped the dead seq/acked debug row and unused `randomName()`.
  - **`style.css`**: splash/login/species-picker/help-tabs/stats styling + animated title
    keyframes, consistent with the dark palette and z-index discipline.
  - Verified: `tsc --noEmit` + `vite build` clean; bundle contains the new flow + "AI ESCAPE".

- 0.2.20: **Server — SQLite accounts, auth tokens, session restore, persistent stats**
  (phase 2 of the accounts plan). The server was fully anonymous (a `prompt()` name → an
  in-memory UUID, nothing persisted); it now has username-only accounts backed by SQLite.
  - **`server/db.js`** (new, `better-sqlite3`, synchronous): a file DB at `DB_PATH`
    (default `./data/aiescape.db`, WAL mode, `data/` created on boot and git-ignored).
    `users(id, username UNIQUE NOCASE, token UNIQUE, created_at, last_seen, last_species)`
    + `stats(user_id, games, escapes, caught, orders_issued, abilities_used, play_seconds)`.
    `loginOrRegister({username, token})` implements **claim-on-first-use with uniqueness**:
    a valid token restores its account (session restore, DB username authoritative); a free
    username is claimed and issued a fresh random-UUID token; a taken username without a
    matching token is rejected `name_taken`; an unknown token is `bad_token`; empty/over-long
    is `invalid`. Plus `incStats`/`setLastSpecies`/`touchLastSeen`/`incGames`/`getStatsForUser`
    (snake_case columns → camelCase `UserStats`). UNIQUE-violation races fold into `name_taken`.
  - **`server/socket/auth.js`** (new): handles `auth:login` → `auth:result`, stashing
    `{userId, username, token, desiredSpecies, joinedAt}` on the socket; bumps `games` and
    `last_species` on success and returns the user's stats.
  - **`server/socket/species-roster.js`** (new): bridges the ESM `shared/dist/species.js`
    into the CJS server via the same dynamic-`import()`-and-cache pattern `stealth.js` uses
    (warmed at boot before the engine starts), so `lobby.js`'s roster is the SINGLE shared
    list (no more hardcoded `SPECIES_ROSTER` literal).
  - **`lobby.js`**: `lobby:join` now uses the authenticated username (ignores `payload.name`
    when authed), honors a valid chosen `species` (else join-index cycling), and tags the
    player with `userId`. Legacy un-authed path preserved.
  - **Stats hooks** (decoupled — no DB import in the game math): `stealth.js` accumulates onto
    a lazy `player.statsDelta` via `bumpStat()` at four edge chokepoints — `caught`
    (`catchPlayer`), `escapes` (`checkEscape` flip), `ordersIssued` (`orderNearestRobot` hit),
    `abilitiesUsed` (`applyAbility` fired). The engine flushes a non-empty delta to the DB and
    zeroes it (edge-driven → no per-tick DB write); `connection.js` flushes `play_seconds` on
    disconnect.
  - `index.js`/`socket/index.js` thread `db` through; `db.close()` on shutdown. `config.js` +
    `.env.example` gain `DB_PATH`. Verified end-to-end over real sockets: fresh login issues a
    token, authed name overrides payload, chosen species honored, `name_taken`/`bad_token`/
    `invalid` all correct, token restore works and re-increments `games`.

- 0.2.19: **"AI Escape" rebrand + shared auth/species foundation** (phase 1 + 2a/4d of
  the accounts plan). The product title is now **AI Escape** (`client/index.html` tab
  title, `client/capacitor.config.ts` `appName`); the in-world story name *The Caves of
  Steel* stays as narrative flavor. Laid the cross-side foundation the login + help work
  builds on:
  - **Net contract** (`shared/src/net.ts`): new `auth:login` (client→server, `AuthLogin
    {username, token?, species?}`) and `auth:result` (server→client, `AuthResult {ok,
    reason?, token?, username?, stats?}`) events, a `UserStats` shape, and an optional
    `species` on `LobbyJoin`. Existing `lobby:join`/`input`/`snapshot`/`ping` shapes are
    unchanged. Both events wired into the typed `ClientToServerEvents`/`ServerToClientEvents`.
  - **Shared species roster** (`shared/src/species.ts`): one source of truth for the 14
    playable species — `{ key, label, ability, fx, blurb }` — consumed by the server
    roster, the client login selector, and the help Species tab, replacing the copy that
    was duplicated across `lobby.js`, `manual.ts`, and the registry comments. Exported
    from the shared barrel.

- 0.2.18: **Fix — walk animation never played.** The renderer decided idle-vs-walk
  from the render→target position gap (`targetX - renderX`), but that gap is ~0 for
  the **local player** (its view snaps render to target every frame, being client-
  predicted) and collapses to ~0 for remote players between the 20Hz snapshots — so
  no one's avatar ever animated walking. Now "moving" is driven by the *authoritative
  target position actually changing* between updates (identical signal for the snapped
  local player and interpolated remotes), with a short ~200ms persistence window so the
  walk cycle stays smooth across the sparse snapshot gaps and cleanly falls to idle
  ~160ms after stopping. Facing also derives from the authoritative move vector now,
  not the interpolation residual. Verified by isolating the decision logic (walk holds
  the whole time while moving; idle resumes shortly after stop) and a headless boot.

- 0.2.17: **Validation remediation** (post `/plan-validation-and-review` of the
  visual-polish plan). The review traced every requirement as implemented + connected
  (14-species roster aligned across all 5 locations, facing + fx fully wired, all 14
  ability handlers + renderer FX cases present) and surfaced a small set of in-scope
  fixes, now applied:
  - **FX glow leak (CRITICAL):** `phaser.ts updateFx` now clears a sustained glow from
    a previous effect before a new activation fires, so a one-shot (e.g. flit) firing
    while a sustained glow (e.g. cloak) is live no longer orphans the old Arc.
  - **Unbounded map growth (CRITICAL):** `main.ts` now drops a disconnected player's
    entry from the `fxSfxSeen` edge-memory map (alongside the existing entity/playerId
    prune), so it can't grow across a session.
  - **Robot pursuit unclamped (MINOR):** a chasing robot's step is now clamped to the
    world bounds (it could previously drift a few units past the edge).
  - **Dead code removed:** the unused `serpent` archetype (authored in Phase A for
    snake/crocodile, which didn't make the final 14-species roster) and the never-called
    `world.removeWorldEntity` export. Added a cross-reference comment tying the three
    species-roster literals (lobby / world / registry) together.
  - The pre-existing client esbuild/Vite dev-only advisory remains tracked in
    `FINDINGS_OUTSIDE_SCOPE.md` (out of scope; needs a breaking Vite major bump).
  - Re-verified: shared + client build/typecheck clean, atlas verify + check-facing
    green, server boots + the 14-client ability wire-test still shows 11 fx kinds +
    hazard/decoy spawn.

- 0.2.16: **Docs + integration validation (Phase F of the visual-polish plan).**
  Updated `README.md` (Assets section → the animated-spritesheet pipeline +
  sharp/clean-clone note + shape fallback; How-to-play → the 14-species ability
  roster) and `docs/PLAYBOOK.md` (GRAPHICS quick-commands → gen-sprites/build-atlas/
  verify-atlas/check-facing). Full-library consistency review (all 15 species × 8
  directions) confirmed correct mirroring, hidden-face back views, and cohesive
  stroke/shading/anchoring. Integration validation: shared + client build/typecheck
  clean, check-facing + verify-atlas green, the client still builds + runs with the
  atlas removed (shape fallback), and a headless-Chrome full-stack load boots Phaser
  with no runtime errors against a live server.

- 0.2.15: **Spectacular ability FX (Phase E of the visual-polish plan).** Abilities
  fired with no visual feedback; now every activation throws a polished, ability-tuned
  effect that any client sees for any player:
  - **Renderer FX layer (`phaser.ts`):** a `DEPTH_FX` layer + a generated soft-dot
    particle texture + a `fireFx` dispatcher driven by the `fx.startTick` rising edge
    (each activation fires once). Per-ability bursts: elephant **shove** shockwave
    ring + particle blast + camera shake; peacock **dazzle** radial burst + screen
    flash; bird **flit** / kangaroo **leap** scale-pop + feather/dust puff; chameleon
    **cloak** / skunk **stink** / tortoise **shell** / ape **carry** sustained glow;
    cheetah **dash** speed-streak; parrot **mimic** green sound-wave rings; owl **hush**
    calming blue wave; mole **burrow** dirt spray; rat **skitter** dust; fox **decoy**
    puff. Sustained glows follow the entity and clear when the effect ends.
  - **Perf guards:** small particle counts (≤16) + short lifespans (≤600ms), emitters
    auto-destroyed, camera shake/flash **coalesced to one per frame** (strongest shake
    wins) so a burst of simultaneous abilities can't stack into nausea.
  - **Remote ability SFX (`main.ts` + `audio.ts`):** four new placeholder sounds
    (whoosh/thud/sparkle2/dazzle via the zero-dep SFX generator); the render loop fires
    an ability's SFX for ANY entity on the same `fx.startTick` edge, volume scaled by
    distance to the local player so a busy room doesn't become a wall of sound.
  - Verified: shared + client build/typecheck clean; a headless-Chrome load confirms
    Phaser boots with no runtime errors (and gracefully uses the Canvas renderer +
    halo fallback when WebGL/preFX is unavailable). Fixed an init bug found by that
    test (resolve on the game READY event, not the not-yet-wired scene emitter).

- 0.2.14: **The whole zoo — 15 species spritesheets (Phase D of the visual-polish
  plan).** With the contract locked and the ape proven, the 14 remaining species +
  the keeper-robot were built in parallel (one focused builder file each), all against
  the same archetypes/template/anim, so they cohere by construction:
  - `scripts/sprites/species/{bird,rat,elephant,chameleon,peacock,skunk,mole,cheetah,
    parrot,tortoise,kangaroo,owl,fox,robot}.js` — each a thin `parts` declaration
    delegating to its archetype (quadruped/biped/bird/serpent/robot), reusing the
    locked palette + frame-key contract. Distinctive silhouettes: elephant trunk +
    tusks + big ears, tortoise dome shell, fox/rat ears + tails, owl big eyes, peacock
    crest + fan, robot hexagonal chassis + optic eye + antenna.
  - **Archetype polish (cross-cutting, benefits every species):** quadruped tail no
    longer juts sideways in the front view (a small tail-tip peeks over the shoulder
    instead; full plume in back; side-on curl in profile); bird body reads side-on in
    profile (horizontal egg + head carried forward over the breast) instead of looking
    front-facing.
  - **Atlas:** all 15 species × 48 frames = **720 frames** packed into a single
    1728×1728 atlas (under the 2048 WebView ceiling), `verify-atlas` green (every key
    present, no orphans). Registry order matches `SPECIES_ROSTER` + the robot NPC.
  - Verified: gen → build-atlas → verify-atlas clean; client builds and the 240 KB
    atlas copies into `client/dist/sprites/`; contact-sheet inspection of all 15 in
    front + profile confirms readable, symmetric, cohesive art.

- 0.2.13: **Full playable zoo — 14 species, one ability each + ability FX state on
  the wire (Phase C of the visual-polish plan).** Only 4 species were playable and
  abilities had zero on-screen state. Now every species in the roster is playable
  with a unique, Three-Laws-tied power, and the activation state is broadcast so any
  client can show FX for any player:
  - **10 new abilities (server):** chameleon **cloak** (humanLikeness→1), peacock
    **dazzle** (AoE robot stand-down, big panic spike), skunk **stink** (a hazard
    zone robots refuse to enter — Third Law), mole **burrow** (teleport + unseen),
    cheetah **dash** (speed burst that crashes humanLikeness), parrot **mimic**
    (order a robot with NO suspicion), tortoise **shell** (immovable + uncatchable +
    likeness held), kangaroo **leap** (long hop, briefly uncatchable), owl **hush**
    (drain the panic meter), fox **decoy** (spawn a human-looking lure robots chase).
    Niches: disguise / evasion / robot-control / panic-meta, so 14-way play stays
    legible. Each reuses the existing timer/standdown/panic machinery; new tunables
    live in `config.ABILITY`, all secs→ticks (deterministic).
  - **fx echo on the wire:** `EntityFx {kind,startTick,untilTick}` set by every
    handler via a shared `setFx` helper; `toEntity` forwards a player's live fx,
    world entities (robots/hazards/decoys) carry it raw on the delta. `startTick` is
    the client's one-shot-FX edge; `untilTick` drives sustained FX. Expired robot fx
    is swept so the wire stays tidy.
  - **Temporary world entities:** `world.addWorldEntity`/`pruneExpired`/`nextTempId`
    back the skunk hazard + fox decoy; the engine sweeps expired ones each tick.
    Robots avoid hazards via a deterministic post-decision nudge in `stepRobots`
    (robotDecision stays pure perception). New `hazard` EntityKind (rendered as a
    translucent zone; FX visuals land in Phase E).
  - **Roster wiring:** `SPECIES_ROSTER` → all 14; decoy species widened to the full
    zoo (decoys wander + animate, no abilities); per-player effect timers + a generic
    cooldown gate added; `catchPlayer` clears all in-flight self-effects.
  - Verified: shared + client build clean; server boots; a 14-client socket test
    confirms all 14 species assign, 11 fx kinds flow over the wire, the chameleon's
    cloak floors humanLikeness to 1, and skunk-hazard + fox-decoy entities spawn.
    (carry/shove/mimic fx are correctly gated on prop/robot proximity.)

- 0.2.12: **Renderer animation + 8-way facing + interpolation (Phase B of the
  visual-polish plan).** The renderer hard-`setPosition`'d static shapes with no
  animation or facing; abilities had no on-screen state at all. This wires the
  animated-sprite runtime end to end:
  - **Facing on the wire (shared, once):** `Dir8` + `EntityFx`/`FxKind` types and
    `Entity.facing`/`Entity.fx` in `@shared/types`; pure deterministic
    `facingFromVec(dx,dy,prev)` + `DIR8` in `@shared/step` (a zero vector holds the
    last facing). Verified by a new `scripts/check-facing.js` (8 mappings, purity,
    zero-holds-prev, full-sweep).
  - **Server facing:** computed for players (engine integrate, from authoritative
    input), robots (pursue dir / patrol delta), and decoys (wander delta), then
    serialized in `toEntity` (which also forwards a live `fx` echo). `loadShared`
    now requires `facingFromVec`. A socket wire-test confirms all 8 facings flow for
    both animals and robots.
  - **Renderer (`phaser.ts`):** added `preload()` (loads `./sprites/atlas.{png,json}`)
    + `create()` that builds idle/walk directional anims from whatever frames the
    atlas actually contains (no hardcoded species list). Mobile entities render as
    animated 8-directional sprites; each frame picks idle vs walk from motion and
    plays the facing anim. The Three-Laws feedback is preserved on sprites
    (humanLikeness → white halo, robot mode → tint, suspicion ring unchanged).
    Positions are interpolated between snapshots (local player snapped via a
    client-only `_local` flag). **Missing atlas / species → graceful fall back to the
    original geometric shapes**, so the kit still boots + plays with zero art.
  - **Client (`main.ts`):** predicts our own facing on key-press (same shared helper)
    and tags the local entity `_local` for the renderer's snap-vs-interpolate split.
  - Verified: shared + client build/typecheck clean (TS strict), atlas copies into
    `client/dist/sprites/`, server boots and validates the new export, facing wire-test
    green.

- 0.2.11: **CLAUDE.md workflow directive** — added two Workflow rules: commit to the
  feature branch between every phase of plan execution (one phase = one checkpointed
  commit with a CHANGELOG entry), and validate all commits are complete (clean working
  tree, every phase landed) when a plan has fully executed.

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
