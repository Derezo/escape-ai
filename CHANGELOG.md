# Changelog

All notable changes to TINS 2026. Update this file in every commit.

## 0.2 — *Escape AI* (jam build)

- 0.2.108: **Capture consistency fix — a captured NPC can no longer be re-fed/re-leashed out of a
  robot's grip.** Plan-validation review found `feedNearbyAnimal` (`server/game/follow.js`) lacked
  the `capturedBy` guard the other two captured-animal consumers already have
  (`stealth.gatherAnimals` + `stepIdleAnimals`). Because `applyAction` runs before `stepNpcs`, a
  player standing next to a robot that just grabbed an animal could feed it the same tick and yank
  it back — clearing `capturedBy` and leaving a 1-tick dual-ownership race (robot-steal defeated for
  free). `feedNearbyAnimal` now skips any animal with `capturedBy` set: a captured NPC is in the
  robot's possession and not feedable until it's released inside its pen.

- 0.2.107: **Robot NPC-capture is now LIVE — capture trigger + return dispatch wired into
  `stepRobots` (Phase 3, the payoff).** The plumbing from 0.2.106 is now reachable: a
  keeper-robot that touches a loose non-player animal GRABS it and hauls it home. Two
  server-only edits in `server/game/stealth.js` `stepRobots`, no shared/client change. (1)
  RETURN DISPATCH at the TOP of the per-robot loop (right after the Second-Law standdown
  `continue`, before `robotDecision`): if `robot.capturedBy` is set and the captive's link
  still points back (`captive.capturedBy === robot.id`), the robot overrides all Three-Laws
  perception — `mode='pursue'` (so the client renders the hauler as active, not idle, reusing
  the existing RobotMode union — no new wire mode), per-robot `idleCtx.penBounds`/`penGoalTile`
  resolved from `homeBoundsForRoom`/`homeGateForRoom` for `captureSpecies` (and
  `idleCtx.guardBounds` cleared so a previous robot's bounds can't bleed in), then
  `behaviors.stepRobotReturn(robot, captive, idleCtx)` and `continue`. If the captive vanished
  or its back-link broke, the stale `capturedBy`/`captureSpecies` are dropped and the robot
  falls through to normal behavior this tick. (2) CAPTURE TRIGGER as a sibling `else if
  (target)` arm of the existing player-catch in the `pursue` branch: on touch
  (`dist2 <= touchR2`) the robot resolves the NPC's pen (`penSpeciesOf(id) || species`); if a
  pen exists, it tears any player leash (`follow.releaseFollower` — a robot "steal", the owner
  loses the follower), clears `returningHome`, stamps `capturedBy`/`captureSpecies` on BOTH
  sides, sets `robot.behavior='return'` + `lastPatrolIndex`, and `clearPath`s the stale chase
  route — next tick the dispatch takes over and hauls. Capturing an NPC does NOT feed panic:
  `pursuingRobots`/`catches` stay strictly inside the `isPlayer` arm (a captured scenery
  animal is not an escape). A penless animal (shouldn't happen for a pen species) is left as a
  normal uncatchable chase target, exactly as before. Determinism preserved (integer-tick
  fields + shared math; no `Math.random`/`Date.now`). shared builds clean; server boots clean
  and reaches "listening"; `scripts/e2e-follow.js` PASSES (food wire intact); `scripts/sim-clients.js
  20 --secs=15` holds 20/20 clients at a locked ~20Hz snapshot rate with no errors in the
  server log (the new per-tick NPC mutation introduces no desync or tick degradation).

- 0.2.106: **Robot NPC-capture PLUMBING (not yet triggerable — Phase 3 wires it).** Lays the
  groundwork for keeper-robots that CAPTURE a loose non-player animal (or a player's
  follower — a robot "steal"), haul it pinned to their body back to that species' pen via
  A* through the gate, release it inside, and resume patrol. THIS change is plumbing only:
  no trigger or per-robot dispatch yet, so the new path is defined + exported but never
  called — the server boots unchanged. (1) `behaviors.speedFor()` gains a `case 'return':`
  at `config.ROBOT_SPEED` — the same panic-charge base as a chaser, keeping the `* lockMult
  * speedBoost` tail so a returning robot also gets the lockdown multiplier + boost. (2) New
  exported `behaviors.stepRobotReturn(robot, npc, ctx)`: each tick it RELEASES (clears both
  sides' `capturedBy`/`captureSpecies`, rejoins patrol at the nearest waypoint) when the
  species has no home (`penBounds`/`penGoalTile` missing) or when the NPC is already inside
  the pen interior (`pathfind.inBounds`); otherwise it `moveTowardPoint`s toward the
  gate-inside goal tile's center and PINS the NPC onto the robot (after the robot moves, so
  the NPC rides along). It reuses stealth's existing `idleCtx` plus two added fields
  (`penBounds`, `penGoalTile`) — documented in the function header so Phase 3 supplies them.
  (3) `stealth.gatherAnimals` now SKIPS any animal with `capturedBy` set (a hauled NPC is
  off the board — no other robot freezes on or re-targets it) and `stealth.stepIdleAnimals`
  skips its idle drift (the hauling robot owns its position). (4) `shared/src/types.ts` adds
  two typed optional `Entity` fields — `capturedBy?: string` and `captureSpecies?: string` —
  documentation/safety only; they ride the existing index signature, so **no `net.ts`
  change** and no `WORLD_GEN_VERSION` bump. Determinism preserved (integer-tick checks +
  shared math only; no `Math.random`/`Date.now`). shared builds clean, 90/90 shared tests
  green, server boots cleanly.

- 0.2.105: **Fix: den species (skunk/mole/fox) spawned STUCK in their pen.** The `den`
  enclosure stamp in `shared/src/world.ts` walled the spawn-center `BURROW_MOUND` on three
  sides with solid `ROCKY_DEN_WALL` tiles (W, E, N), leaving a 1-tile south-only pocket.
  The player spawns on the mound (with ±16px jitter); since the collision radius (12.8px) is
  smaller than a half-tile but a 3-walled 1-tile cell can't be slid out of, the player's AABB
  wedged and could not move. The three rock tiles now form a back-row backdrop on the
  `(ccy-1)` row — `(ccx-1,ccy-1)`, `(ccx,ccy-1)`, `(ccx+1,ccy-1)` — leaving the mound's W/E/S
  open non-solid DIRT so the body can always slide off. Proven in-interior for the smallest
  den (`rw,rh = 8,8`): the back row sits at `ry+3`, cols `rx+3..rx+5`, all within the interior
  `[1,rw-2]×[1,rh-2]`, never on the barrier ring or the spawn center. The rocky-den look and
  the spare mound + water trough are unchanged. This flips per-den collision cells, so
  `WORLD_GEN_VERSION` bumps **16 → 17** (the client regenerates its tilemap from seed+version,
  so a stale version would desync the visual map from the server collision grid). Re-pinned
  `PINNED_COLLISION_HASH`/`PINNED_ENTITYSPEC_HASH` and added a `world.test.mjs` regression
  asserting every den mound has open W/E/S. shared builds clean; 90/90 shared tests green.

- 0.2.104: **Fix: food collection (and feeding) threw — broken by a circular-require trap.**
  The multi-step quest wiring made `server/game/follow.js` and `server/game/quests.js`
  require each other. In the server's real load order (`engine → stealth → quests →
  follow`), `follow.js` loads *while `quests.js` is still mid-load*, so its top-level
  `const quests = require('./quests')` captured quests' **partial (empty) exports** —
  making `quests.onCollect` / `onRecruit` `undefined`. Every food-collect press (and
  every feed) then threw `TypeError: quests.onCollect is not a function` inside
  `collectNearbyFood`, so collecting food silently did nothing. `follow.js` now resolves
  `quests` **lazily at call time** (a tiny `quests()` accessor), when the module has
  finished loading. Added `server/test/quest-wiring.test.js` (3 tests) + a server `test`
  script that load the modules in the **real engine order** and assert food collection /
  feeding don't throw — the guard that would have caught this. (The earlier validation's
  circular-require check passed only because it required the modules in the *opposite*
  order, which masked the partial-export window.)

- 0.2.103: **Validation follow-up for the multi-step quests.** `/plan-validation-and-review`
  surfaced a wire-contract honesty gap: `server/game/quests.js` `makeQuest` serializes a
  per-step `done` on every `steps[]` entry, but `QuestStepProgress` (shared/src/types.ts)
  didn't declare it — so clients reading per-step progress would be reading an
  undeclared field. Added `done: number` to `QuestStepProgress` (forward-compatible: a
  future HUD can show a full step-by-step checklist). Recorded a deferred balance note
  (cheetah's tight `recruit ×2 → escort ×2` has no re-feed buffer step — playable, not a
  hard lock) in `FINDINGS_OUTSIDE_SCOPE.md`. Builds + 89/89 tests green.

- 0.2.102: **Multi-step side-quests (the 10 "reach home" quests become 2–3 step objectives).**
  The trivially-simple "walk back to your cage / reptile house" quests are now ordered multi-step
  objectives that draw on the full gameplay loop — food gathering, recruiting fellow animals to
  follow, ordering keeper robots, using your species ability, and escorting a herd out the gate —
  before the final reach-home / escort step. ape keeps its courier `fetch` (now preceded by an
  `order` step) and elephant/peacock/parrot keep their 3-terminal `activate` (each gains a second
  step). The arrow indicator always points at the **current step's** target, in order, and the HUD
  shows `step N/total · title · done/need`. Every quest still completes exactly once and tracks in
  the leaderboard via `questsCompleted`.
  - **Shared contract** (`shared/src/quests.ts`, `shared/src/types.ts`): `QuestDef` is now an
    ordered `steps[]` list (kinds `reach`/`fetch`/`activate`/`collect`/`recruit`/`order`/`ability`/
    `escort`); `questForSpecies` stays a pure, stable-ref lookup. `QuestProgress` gains `stepIndex`
    + a compact `steps` summary and mirrors the current step at the top level (legacy
    `type`/`title`/`done`/`need` aliases preserved, so old readers still work). No `net.ts` change —
    it rides `Entity.quest` through the index signature. `shared/test/quests.test.mjs` rewritten to
    the multi-step invariants.
  - **Server step engine** (`server/game/quests.js` + wiring in `stealth.js`/`follow.js`/`engine.js`):
    every mechanic funnels completion through one `bumpCurrent`, which rolls `stepIndex` forward and
    fires the single `bumpStat('questsCompleted')` **exactly once** on the final step. New
    observe-only hooks `onCollect`/`onRecruit`/`onOrder`/`onAbility` (they never re-bump the
    underlying foodCollected/animalsStolen/ordersIssued/abilitiesUsed counters), plus `stepEscort`
    (gate + live-herd check) and per-step gating of `stepReach`/`stepFetchAtGate`. **Catch rule:**
    `catchPlayer` calls `resetSteps`, restarting the quest at step 0 **without** changing species.
  - **Client** (`client/src/main.ts`, `client/src/help.ts`): step-aware HUD readout + `quest_progress`
    SFX on a rising step; `questGuideFor` resolves the arrow goal from the current step kind
    (`fetch`/`escort`→gate, `activate`/`order`→nearest terminal, `collect`→nearest food,
    `recruit`→nearest other-species non-follower animal, `ability`→no arrow, `reach`→own home star),
    with `questUsesMarker` derived per-step so the home star only shows on a `reach` step.
  - **World-gen** (`shared/src/world.ts`): the ape's disguise **Clipboard relocates from the
    gate/spawn area into the commissary (aux building) interior**, so the courier must fetch it from
    inside before walking it out. `WORLD_GEN_VERSION` 15 → 16; `shared/test/world.test.mjs`
    entitySpec hash re-pinned (collision hash unchanged — the interior was already walkable).
  Shared + client builds green; 89/89 shared tests pass; server step engine verified end-to-end
  (per-step ordering, single `questsCompleted`, escort herd-gating, catch reset).

- 0.2.101: **Spawn hardening + dead-code cleanup (spawning audit follow-up).** With the river now
  solid, hardened the robot "top-up" spawn anchor in `world.ts`: it offset x by 3 off a junction and
  clamped only to map bounds, so a future seed could have parked it on a now-solid water tile —
  it now falls back to the (always force-paved) junction tile when the offset lands on solid/water.
  Deterministic and byte-stable: a no-op on every tested seed, so the pinned hashes are unchanged. A
  new `world.test.mjs` invariant asserts every `robotSpawn` anchor sits on a non-solid tile across
  seeds (86 tests total). Also deleted the dead `firstSpawn` function in `server/game/stealth.js`
  (zero call sites; the live fallback is `world.spawnForSpecies` → `map.spawns[0]`) and the stale
  comment that referenced it, and removed the matching `FINDINGS_OUTSIDE_SCOPE.md` entry.

- 0.2.100: **Respawn now updates the player sprite to the new species immediately (client bug).** On
  escape→rebirth the server correctly reassigns the player's species (e.g. rat→elephant), but the
  client kept rendering the OLD sprite ("Reborn as an Elephant!" while still a rat) until a full view
  rebuild happened to fire. The Phaser renderer's `upsert()` reused an entity view whenever
  `view.kind === e.kind` and never compared species, so the cached `view.species` (which keys the
  animation in `updateAnimation`) stayed stale. Fixed in `client/src/render/phaser.ts`: an `animal`
  view is now reused only when its species is unchanged (using the same `'ape'` default `createView`
  uses); otherwise it falls through to the existing leak-free destroy+recreate path — which correctly
  rebuilds the body (sprite↔shape can flip per species) and re-targets the camera for the local
  player. Non-animal kinds (robots are `species:'robot'`) never churn. Client build green.

- 0.2.99: **The river is now a SOLID barrier (world-gen, `WORLD_GEN_VERSION` 14→15).** Previously
  only `WATER_DEEP`/`POND_DEEP` were solid, so the river was mostly walkable (~270 walkable water
  cells per map) and robots/players stood in it. Now ALL water-family tiles are solid: `tiles.ts`
  flips `WATER_SHALLOW`, every `WATER_EDGE_*`/`WATER_CORNER_*`/`WATER_ICORNER_*` shore-blend tile,
  and `POND_EDGE` to `solid:true` (`WATER_DEEP`/`POND_DEEP` were already; `BRIDGE_H`/`BRIDGE_V`
  stay walkable — the only crossings). Because `blendGroundEdges` paints the shore ring AFTER
  `buildCollision` (and collision is never re-derived), `world.ts` adds a final collision-
  reconciliation pass that re-solidifies every cell whose GROUND tile is water-family (new
  `isWaterFamilyIndex` helper, kept separate from `isWaterIndex` so the cohesion/margin/blend
  passes are untouched). A follow-up pass force-reopens the two threshold cells directly inside
  each enclosure's south gate so a pond home (whose interior shore can reach its gate row) stays
  enterable — 67 such cells across 50 seeds, all inside a home rect and connected to walkable
  interior, never a hole into the open river. Reachability still converges on every seed.
  BOTH pinned hashes re-pin: collision (`2182634496`→`2912234384`) as the shore ring flips
  solid, and entitySpecs (`3622420766`→`2666229100`) as pen anchors / food slots / quest objects
  / one aux guard that sat on the now-solid shallow shore relocate onto dry interior tiles. New
  `world.test.mjs` invariant test proves every water-family tile is solid + every bridge walkable
  across seeds. Shared build + 85-test suite green; 50-seed probe: 4950 target checks, 0
  spawn/center/quest/food/gate/door/anchor on a solid tile.

- 0.2.98: **Leaderboard validation fix — persist the escape-time JSON maps (real bug).** The
  `/plan-validation-and-review` gate caught (and a clean-DB round-trip confirmed) that the
  committed `server/db.js` `incStats` only merged `escapesBySpecies` — the old single-map
  branch — and silently dropped the two new maps (`ownEscapesBySpecies`, `escapeSecsBySpecies`),
  so escape-time-by-species never persisted (`own={}`/`secs={}` on read). The table-driven
  `JSON_MAP_COLUMNS` merge loop (which handles all three identically and does NOT round the
  fractional `escapeSecsBySpecies` seconds) had been defined but never wired into `incStats`.
  Replaced the hardcoded single-map branch with the loop. Round-trip now ALL PASS (ape=2 own
  escapes, 40.0s float-preserved); the 18-check leaderboard integration test and the e2e socket
  wire check both green. (Corrects the prior 0.2.97 note, which wrongly called this a false
  positive — it was real.)

- 0.2.97: **Leaderboard validation fix — restore the missing datatable CSS.** The
  `/plan-validation-and-review` gate caught that the leaderboard's stylesheet block (the
  `#lb-*` / `.lb-*` rules the L-key overlay in `client/src/leaderboard.ts` depends on) was
  absent from `client/src/style.css` — the panel would have rendered unstyled. Re-added the
  wide centered-modal chrome: sticky click-to-sort headers, right-aligned tabular metric
  columns, the gold own-row highlight + outside-top-N separator, and the expandable
  per-species detail grid (30 selectors). Client build green; the CSS bundle grew to ~14.9 kB.

- 0.2.96: **Leaderboard, polish — export the scorer from the shared barrel.** Add
  `export * from './score.js'` to `shared/src/index.ts` so the composite scorer is reachable
  via the `@shared` barrel like every other shared module (the server already imports
  `shared/dist/score.js` directly; this lets a future client score-preview import `@shared/score`
  too). Pure consistency fix; shared build + client tsc green.

- 0.2.95: **Leaderboard, phase 3 — the L-key datatable overlay.** The client face of the
  leaderboard. New `client/src/leaderboard.ts` (`createLeaderboard`) builds a hidden, pure-DOM
  overlay — the inventory/help modal idiom — toggled with **L** (added to the movement-key
  early-return guard in `main.ts` alongside H/?/I, and documented in the help Controls tab).
  It's a comprehensive, **click-to-sort datatable**: rank · player (with last-species sprite) ·
  score · escapes · quests · stolen · food · caught · orders · abilities · games · play time.
  Clicking a column header re-requests that sort from the server (which re-ranks
  authoritatively); the local player's row is highlighted gold and **pinned at the bottom when
  it falls outside the top-N**, so you always see your standing; clicking any row expands its
  per-species escape breakdown. Data is fetched on open and **polled every 4s while open**
  (stops on close), via the new `leaderboard:request`/`leaderboard:data` round-trip wired into
  `NetClient` (`requestLeaderboard` + `onLeaderboard`). The server owns score + rank; the
  client only displays them (a stale-sort reply is ignored). New CSS in `style.css` mirrors the
  existing modal chrome (wider, sticky sortable headers, sprite cells). Verified: shared 84/84,
  client tsc clean, Vite production build green.

- 0.2.94: **Leaderboard, phase 2 — server query + escape-time-by-species stat.** The
  server side of the L-key leaderboard. New `server/socket/leaderboard.js` handles
  `leaderboard:request` → `leaderboard:data`: it validates the (only) client-supplied
  `sort`/`limit`, rate-limits the query (new `leaderboard:request` token bucket in
  `rate-limit.js`), and replies with the SERVER-COMPUTED top-N rows + the asker's own ranked
  row + the total. `server/db.js` gains `getLeaderboard()` (materialize every account, score
  via the shared scorer dynamic-imported in `loadScore()` — the species-roster idiom, warmed
  at boot in `index.js` — then rank the whole field so the requester's position is always
  known) and a refactor of `incStats` to a table-driven JSON-map merge. Also closes the one
  real stat gap: **escape-time-by-species**. `stealth.respawnPlayer` + `lobby.js` stamp
  `spawnedAtTick`; the escape edge records the spawn→gate duration via a new
  `stats-delta.bumpOwnEscape`, accumulated into two new JSON columns
  (`own_escapes_by_species` count + `escape_secs_by_species` seconds, guarded-migrated) and
  surfaced in `UserStats` (`net.ts`) so an average escape-time per species can be derived.
  Verified: DB round-trip (sum/merge of all maps), leaderboard ranking + own-row + raw-column
  sort, clean full-server boot, syntax-check across every edited file.

- 0.2.93: **Leaderboard, phase 1 — shared score + net contract.** Groundwork for the
  real-time leaderboard (press **L**). New `shared/src/score.ts` defines the ONE composite
  player **score**, derived purely from the persisted stat counters (escapes, quests, steals,
  food, by-species variety, time-efficiency, a capped capture penalty) — Parasite-style
  shaping that rewards efficient, varied, skilled play over raw grind. It's pure +
  deterministic so the SERVER computes the authoritative number and the client imports the
  same function only to preview/explain it (never to inflate its own rank); no score is
  persisted, so every existing account ranks fairly with zero backfill. `shared/src/net.ts`
  gains the `leaderboard:request` / `leaderboard:data` events, a `LeaderboardSort` union, and
  the `LeaderboardRequest` / `LeaderboardRow` / `LeaderboardMsg` payload shapes (top-N rows +
  the asker's own ranked row + total), wired into the typed socket maps. New
  `shared/test/score.test.mjs` covers the floor, per-term weights, the efficiency cap,
  variety + full-roster bonuses, the capped capture penalty, and NaN coercion. Shared 85/85. **Session persistence — rejoin resumes your current species mid-run (no more
  ape-pen reset).** Previously only account-level stats + a menu-pick `last_species` survived a
  disconnect, so a rejoining player always restarted as a fresh menu species at the original
  pen — never as the species they'd been reborn into. Added a full mid-run **session snapshot**
  (species, x/y, quest progress incl. tapped terminals, food bag, running score, room +
  worldVersion) persisted server-side in a new SQLite `sessions` table (`server/db.js`
  `saveSession`/`loadSession`, guarded-migration idiom). A new `server/game/session.js` owns the
  snapshot shape + a version-guarded `restore`. The engine writes a snapshot on the **rebirth
  edge** (species change after `checkEscape`) and `connection.js` writes one on **disconnect** —
  both edge-driven (no per-tick DB churn), reusing the engine's existing `db`/`userId` seam.
  `auth.js` loads the session and flags `resumed`/`resumeSpecies` in `auth:result` (new optional
  `net.ts` fields); `lobby.js` rebuilds the player from the snapshot when its `worldVersion`
  matches the room (restoring position/quest/inventory/score and stamping the existing
  `spawnSafeUntilTick` grace so a mid-field restore can't be instantly re-caught), and falls back
  to a clean pen spawn for the saved species on a version mismatch. Client: a returning player
  (stored token) auto-logs-in, the menu **skips the species picker**, and joins with no species so
  the server's saved session wins. `session.restore` hardens the quest rehydrate against a future
  quest-def change: it only adopts saved progress when the saved quest type still matches, clamps
  `done` to the current `need`, and drops a stale `complete` (so a redefined quest can't resume
  inconsistent). Verified: DB round-trip + UPSERT + unknown-user guards + quest-restore clamp/
  type-mismatch cases; shared 74/74; client tsc/vite green; clean server boot; trust boundary +
  determinism reviewed clean.

- 0.2.91: **Escape actually respawns you now (was a silent crash) + rebirth fanfare.** Escaping
  did nothing — the avatar stayed stranded at the gate, no species switch, no sound. Root cause:
  `respawnPlayer` in `server/game/stealth.js` declared its 2nd param `spawn` but the body calls
  `spawnForSpecies(roomName, …)` while the caller passes `roomName` — so `roomName` was undefined,
  `respawnPlayer` threw `ReferenceError` every tick the celebration window elapsed, the engine
  swallowed it, and `escaped` never cleared. Renamed the param to `roomName` (one-line scope fix);
  now escape → roll to the next species → respawn in THAT species' pen → clear `escaped` works as
  designed (rotation/quest-reset/grace were all already correct, just dead behind the crash).
  Client (`client/src/main.ts`): the escape edge now stacks a celebratory `quest_complete` chime
  on `gate_open` (victory_sting music already swells underneath, and now actually plays since the
  4s window completes), and the respawn edge fires a "Reborn as a Bird!" toast — a new `flashCue`
  `'reborn'` kind (teal, ~2.2s) using the shared species label — when the species changes. (Session
  persistence so a rejoin resumes the new species is a separate follow-up commit.)

- 0.2.90: **Quest arrow: string-pulled path (clean angles, not a staircase).** The shared A*
  is 4-connected (E/W/S/N only), so the arrow's raw route was a tile-by-tile staircase that
  read as jagged axis-aligned hops. Added a client-side line-of-sight smoothing pass
  (`smoothWaypoints` + `losClear` in `client/src/render/phaser.ts`): a greedy string-pull that
  collapses the polyline to the fewest corner waypoints by skipping any point still reachable
  in a straight line (sampling the segment against the same collision grid the integrator uses,
  via shared `boxHitsSolid` with a small clearance radius). The arrow now darts on clean
  diagonals/angles and only bends at real obstacle corners — staying fully collision-safe (no
  segment ever clips a wall). Client-cosmetic only; reuses shared collision, no new pathfinder.

- 0.2.89: **Quest arrow: ~10× faster travel.** The quest-direction arrow crept along its
  path at 60px/s, which felt sluggish. Bumped `QUEST_ARROW.SPEED` to 600px/s (a brisk dart)
  and scaled `RAMP_PX` 40→120 so the opacity fade-in still reads at the higher speed instead
  of popping to full alpha instantly. Client-cosmetic only; one-tunable change in
  `client/src/render/phaser.ts`.

- 0.2.88: **Pine tree: close the trunk↔canopy gap.** The PINE tile (a canopy cell over a
  trunk cell) had a visible band of grass between the lowest bough and the trunk top: the
  canopy's bottom tier stopped at y≈27 (5px short of its cell bottom) and the trunk started
  at y=6 (6px below its cell top), leaving an ~11px seam gap — so it didn't read as one tree.
  Fixed both halves in `scripts/tiles/builders/nature.js`, mirroring the broadleaf TREE fix
  (dc78c79): `pineCanopy`'s bottom tier now reaches the cell bottom (base y≈31, slightly
  wider) and `pineTrunk` now fills from the cell top (y=0, like `treeTrunk`) down to its root
  flare. Regenerated the pine SVGs + repacked `assets/tiles/tileset.png` via `npm run tiles`;
  the verify drift gate passes (art only — no tile index/flag/order change, no
  `WORLD_GEN_VERSION` bump). The conifer now renders as a connected whole.

- 0.2.87: **Quest clarity — a pathfinding direction arrow + hiding the misleading "quest
  point" marker.** Players couldn't tell what their quest wanted: the ape's "Courier the
  Clipboard" quest (`type: 'fetch'`) completes by carrying the prop to the *gate*, but the
  world spawns a glowing per-species quest-object star in *every* pen — including the ape's —
  and that star does nothing for a fetch/activate quest (only the 10 'reach' species use it).
  So the ape walked to the do-nothing star in its own pen and nothing happened. The quest logic
  was correct; the guidance was missing/misleading. Two client-only fixes (no server, no
  worldgen, no `WORLD_GEN_VERSION` change): **(1)** A render filter in `client/src/render/phaser.ts`
  hides the local player's own quest star when it isn't their real target (fetch/activate);
  other species' stars still draw. **(2)** A cosmetic, owner-only **pulsing translucent red
  arrow** that pathfinds from the player to the real goal using the *same shared A** the NPCs
  use (`@shared/pathfind` — it threads doors/gates, since door tiles are non-solid). The goal is
  per quest type: `fetch`→the gate, `activate`→the nearest keeper terminal, `reach`→the player's
  own home quest-object; the arrow vanishes once the quest completes. Each arrow spawns
  transparent at the player, eases to 25% opacity over its first 40px, travels the route at
  ~60px/s with a soft breathing glow (additive underlay), fades within 100px of the goal, and a
  fresh one spawns from the player's current position after a 0.8s beat. Wiring: a new OPTIONAL
  `setQuestGuide(QuestGuide | null)` on the `IRenderer` contract (`shared/src/renderer.ts`),
  derived per-frame in `client/src/main.ts` (`questGuideFor`, allocation-free) and guarded with
  `?.` so the Babylon fallback is unaffected. The arrow runs A* purely client-side on the map the
  client already regenerates from the seed — nothing crosses the wire; the server still owns
  completion. `pathfind.ts`'s header updated to note the new client-cosmetic consumer. Client
  `tsc --noEmit` clean; shared build + 74/74 tests green (worldgen/entitySpecs untouched).

- 0.2.86: **Spatialized NPC audio — a 10-tile hearing radius, and the always-on ambient bed
  removed.** Looping/ambient sounds played constantly and at full volume regardless of where
  the source was, making the soundscape noisy the moment you joined. Now every world-emitted
  SFX fades with distance to the local player and goes truly silent past ~10 tiles. New single
  source of truth in `client/src/audio.ts`: `spatialGain(dist, base, radius = HEAR_RADIUS)` —
  a hard cutoff (returns exactly 0 at/beyond `HEAR_RADIUS` = 320 u = 10 × `TILE_SIZE`) with a
  quadratic ease inside (`base · t²`, `t = 1 − dist/radius`) so a far emitter is quiet and
  swells gradually as it nears. Applied in `client/src/main.ts`: **robot footsteps** reduced
  (base 0.45 → 0.28) and spatialized — the step is skipped entirely when out of earshot (the
  stride accumulator still advances, so cadence never drifts); **robot_alert** gated + scaled by
  distance; the **robot_pursuit** loop's gain now tracks the *nearest* pursuing robot (a far
  chase is silent and swells as the closest chaser closes in, via `startLoop`'s in-place,
  no-restart gain update); **ability FX** moved onto the same helper (keeping the play-at-base
  fallback when the listener's position isn't known yet). The **ambient room-tone bed**
  (`ambient_bed`) is no longer started — the soundscape is now music + distance-gated NPC
  sounds only (the asset stays in the catalogue/manifest, just unused). Client-only; `tsc
  --noEmit` clean. (Pairs with the 0.2.85 facing fix for a quieter, calmer zoo.)

- 0.2.85: **Pen animals no longer vibrate against their fences (facing deadband).** Idle
  penned animals flipped facing rapidly — appearing to vibrate — whenever they were pinned
  against a pen wall or corner. Root cause: `wanderAvoid` holds one desired heading for ~40
  ticks, but when the body is boxed in, `steerAround`'s probe fan finds a *different* clear
  micro-slide every tick, so deriving facing from each sub-pixel displacement snapped the
  sprite to wildly different directions tick-to-tick (net motion ≈ 0, but the facing churned).
  Fix: a new pure, deterministic `facingFromVecDeadband(dx, dy, prev, minDelta)` in
  `shared/src/step.ts` that HOLDS the previous facing when the actual per-tick move is below
  `WANDER.FACING_DEADBAND` (0.75 units — well under a normal ~2 u/tick step, above corner
  jitter), only turning on a real step. Wired into the containment/idle-wander facing commit in
  `server/game/stealth.js` (the return-home commits are deliberately left untouched). `loadShared`
  now boot-validates `facingFromVecDeadband` + `WANDER` so a stale `shared/dist` fails loud, not
  mid-tick. No change to `wanderVec`/`steerAround`/`wanderAvoid`/`moveWithCollision` — facing-only,
  fully deterministic. 74/74 shared tests green (4 new deadband tests, incl. a corner-grind
  no-flip case); `check-facing.js` still passes.

- 0.2.84: **Map-readability overhaul (WORLD_GEN_VERSION 14): sparse straight paths, a
  connected river, water that only touches grass.** Three fixes to `shared/src/world.ts`,
  all deterministic. (1) **Paths are now sparse + straight.** The winding per-zone spaghetti
  (a 2-wide wobbling corridor to every zone center *and back*, plus 14 forecourt spurs) is
  replaced by a sparse network of mostly-straight trunk avenues: one main horizontal **spine**
  + one short vertical **branch** per zone + a short straight **stub** from each pen gate to the
  nearest spine tile. `carveWindingPath` → axis-aligned `carveStraightPath` (no per-tile wobble,
  no rng in path carving). PAVED drops from ~20% to ~7%; PAVED + path-edge drops from ~35% to
  ~13% of the map. (2) **The river is a connected channel.** `carveRiver` now lays a 2-wide
  `WATER_DEEP` core wrapped in a 2-tile `WATER_SHALLOW` margin, meandering at most ±1 every 3
  rows so consecutive deep rows overlap — the deep core is one continuous body (broken only
  where the spine bridge crosses it), never a staircase of isolated single tiles. The river
  footprint is reserved so no enclosure stamps over it. (3) **Water touches only grass.** A
  water-margin set keeps paths ≥1 tile from any water during carving; paths and reachability
  corridors never pave over water; `enforceWaterGrassMargin` demotes any path the fallback carve
  left adjacent to water back to grass; bridges (`BRIDGE_H`) are the sole place a walkway meets
  water. The water-edge blend now reads the real water boundary so every shoreline gets the
  matching `WATER_EDGE`/`CORNER` tile, and `pickBlendTile` drops the inner-corner (ICORNER)
  branch so isolated 1-tile jogs stay grass instead of becoming busy corner tiles (the
  "grass holes" / diagonal banding). `WORLD_GEN_VERSION` 13→14; both parity hashes re-pinned
  (collision + entitySpecs both drift — path junctions now relocate out of water). All 70 shared
  tests green (reachability, coverage, water-adjacency, blend idempotency). No tile art touched.

- 0.2.83: **Water tiles retonation: single blue hue family, depth by value only.** `WATER_DEEP` and
  `WATER_SHALLOW` previously used different hues — deep a muted dark blue (#2f5d8a), shallow a
  bright cyan (#4f96c8) — so adjacent cells looked like two disjoint materials. Both now share one
  blue hue (203°) with identical saturation, differing only in lightness: shallow is bright
  (accessible), deep is darker (shows depth), abyss is subtle (10% darker, not a hole). Both
  builders use the same wave vocabulary (band positions, ripple frequency) so the surface reads as
  continuous. Result: water reads as one cohesive body in two depths, no hard seams or colour
  discontinuities. Deterministic + seamlessly tiled (verified 4×4 comparison grid).

- 0.2.82: **Full audio set generated — all 8 music tracks + all 18 SFX.** The remaining
  ungenerated assets were produced with the sound-describing prompts (0.2.74) and the livelier
  music palette: music `tension_loop`, `lockdown_loop`, `victory_sting`, `caught_sting`,
  `ambient_bed_music` (plus regenerated `title_theme`/`explore_loop`/`panic_loop`); SFX
  `ambient_bed`, `feed_follow`, `follower_lost`, `food_pickup`, `quest_blocked` (plus regenerated
  `confirm`/`error`/`hit`). Every manifest key now has its real `.mp3` — the placeholder-WAV
  fallbacks are fully retired. Drift gate green (26 SFX keys, 8 music tracks).

- 0.2.81: **Zoo tilemap overhaul (WORLD_GEN_VERSION 13).** A broad pass over the generator
  and tile art so the map reads like a zoo. World-gen (`shared/src/world.ts`): paths no longer
  carve over pen/building interiors (path routing skips claimed rects); pen fences use the right
  orientation — `FENCE_V`/`CAGE_BARS_V` on vertical walls, `FENCE_H` on horizontal, corners join —
  and the entrance now shows a real `FENCE_GATE`/`CAGE_GATE`/`KEEPER_GATE` (re-stamped after the
  reachability carve so it isn't erased). The tortoise/animal pond is bigger and rounded with a
  `WATER_SHALLOW` margin + edge tiles, and a new invariant guarantees `WATER_DEEP` only ever
  touches shallow/deep (never grass/path) — applied to the river too. River crossings now lay
  the new **`BRIDGE_H`/`BRIDGE_V`** wooden-deck tiles (indices 145–146) instead of plain `PAVED`.
  Buildings use the full directional roof/wall sets (`ROOF_RED_EDGE/_CORNER/_RIDGE/_PEAK`,
  `WALL_EXT_CORNER/_END`, `WINDOW`, `DOOR`) instead of a flat `ROOF_RED_MID` fill. ~40 previously
  unused tiles are now placed for richness (pines, stumps, logs, mushrooms, tall grass, cattails,
  lily flowers, benches, lamp posts, signs, troughs, hay bales, nests, burrow mounds, trimmed
  bushes, flower beds). Tile art: roofs are overlapping terracotta shingle courses; walls are
  coursed brick/stone with directional quoins; fences are connecting wooden posts+rails with a
  distinct gate; nature/props gained facets, grain, layered petals, and material texture. New
  `bridges.js` builder + palette sub-tones (append-only). `WORLD_GEN_VERSION` 12→13; both parity
  hashes re-pinned. 70/70 shared tests; 147-tile drift gate green; client + shared build.
  **Known follow-ups:** path layout still reads as diagonal striations (routing, not edges), and
  river bridges span wider than ideal.

- 0.2.80: **Water + shoreline glow-up.** `WATER_DEEP` / `WATER_SHALLOW` were flat blue with a
  few faint ripples; they now read as real water. Both get a seamless depth gradient (faked with
  stacked full-width wave bands — no SVG gradients, which librsvg rasterises inconsistently) plus
  crisp ripple lines; every band is a quadratic wave that returns to its start-y at x=0 and x=32,
  so it wraps horizontally, and identical neighbours keep the rows continuous vertically (verified
  on a 3×3 tiling — no seams). Deep stays dark/abyssal (un-wadeable); shallow lightens toward a
  pale green-blue so the two depths read distinct. `MUD_PUDDLE` became a small basined pool with a
  muddy rim, depth shading, a ripple and a surf glint. The `WATER_*` shoreline edges/corners now
  draw a **foam line** — a paler shallow band + a soft wet-sand fringe + a bright foam ridge + surf
  specks biased to the water side — and the corner/inner-corner variants **round the shoreline**
  (convex grass headlands, concave foam coves) instead of stepping. `PATH_*` edges gained a soft
  trodden dirt margin straddling the grass↔path line (no hard gray rectangle / striation). New
  append-only palette tones: `waterAbyss`, `waterWade`, and `ACCENT.foam` / `foamSoft` / `pathWorn`
  (LOCKED `waterDeep`/`waterShallow` base hues unchanged). Deterministic + byte-stable; `npm run
  tiles` verify-tileset green.

- 0.2.79: **Regenerated SFX with the sound-describing prompts + new wired keys.** Re-ran
  Suno generation for several SFX now that the descriptors describe the *sound* rather than
  the game event (0.2.74): `robot_alert`, `panic_warning`, `lockdown_alarm`, `lockdown_clear`,
  `door_lock`, `gate_open`, plus the newly-wired `quest_progress`, `robot_footstep`, and the
  looping `robot_pursuit`. These replace the old generations / placeholder-WAV fallbacks; the
  loader now plays the themed `.mp3` for each. Drift gate green.

- 0.2.78: **Seamless terrain + a tree that actually reads as a tree (WORLD_GEN_VERSION 12).**
  Ground tiles drew a per-cell top/bottom light/shade band, so identical tiles stacked into
  a visible light/dark stripe at every 32px seam — the "grid" effect on grass/dirt/paved.
  Removed the per-cell banding from every ground material; `paved()` dropped its decorative
  centre-cross seam grid; `cobble()` switched to a wrap-safe scattered stone field; plank/tile
  floor seams were nudged off the cell edge. Trees were rebuilt: each `TREE_CANOPY` tile is now
  a single full, layered round crown that reaches its cell bottom (so the trunk below meets it
  with **no grass gap**) and stays within its width (so neighbouring trees **don't overlap**);
  the trunk is centred with a root flare and its top is covered by the canopy. World-gen places
  the simple canopy-over-trunk pair (the earlier 2×2-crown experiment read as four disconnected
  blobs in-game and was reverted). `WORLD_GEN_VERSION` 11→12 (canopy art changed); collision
  hash re-pinned (trunk placement matches v11, so the grid is unchanged). shared 70/70 tests
  green; atlas drift gate green; client + shared build.

- 0.2.77: **Robot footstep foley.** Robots now make a `robot_footstep` sound as they
  walk, with the cadence gait-locked to their movement (quickening into a chase). Rather
  than a new server event + net-contract field (which would touch the deterministic core
  and risk parity), this is derived client-side in `main.ts` from each robot's own position
  delta — the same motion the renderer already animates the walk cycle on — so it needs no
  shared/server change and stays purely cosmetic local audio, distance-attenuated like the
  other spatial SFX. A step ticks every ~26 world-units travelled (≈ half a tile), with a
  sub-pixel jitter gate so a parked robot is silent, and per-robot accumulators are pruned
  when a robot leaves the snapshot. Plays its `thud.wav` placeholder until the `.mp3` is
  generated. Client typechecks + builds.

- 0.2.76: **Looping SFX subsystem — ambient room-tone + robot pursuit motif.**
  `playSfx()` is one-shot; two manifest SFX are marked `soundLoop` and need to run
  continuously. Added a small loop API to `client/src/audio.ts` (`startLoop`/`stopLoop`)
  that models a loop as desired-state: at most one `BufferSource` per key,
  idempotent start (re-calling just syncs gain), and deferred start — if the buffer is
  still decoding or the context still suspended pre-gesture, the loop begins itself the
  moment it can (the `load()` tail and `unlockAudio()`'s resume both re-drive pending
  loops). Wired in `main.ts`: `ambient_bed` starts at join as a near-subliminal constant
  steel hum (0.3, layered under the music), and `robot_pursuit` loops for as long as at
  least one robot is in `pursue` mode (stops when the last pursuer breaks off). Both use
  their placeholder-WAV fallback until the `.mp3`s are generated. Client typechecks + builds.

- 0.2.75: **Wire 5 themed SFX that were authored but never played.** The manifest
  defined `food_pickup`, `feed_follow`, `follower_lost`, `quest_progress`, and
  `quest_blocked`, but the game still played generic placeholder synth WAVs (or nothing)
  at those moments. Now in `client/src/main.ts`: `sfxForFx()` maps the `collect` fx →
  `food_pickup` and the `feed` fx → `feed_follow` (themed, not the bare `pickup`/`confirm`
  WAVs); the herd-shrank cue plays `follower_lost` instead of `error`; a new edge fires
  `quest_progress` each time an `activate` quest's done-count climbs (short of complete);
  and a new rising-edge fires `quest_blocked` once per gate-brush without a finished quest.
  Until each `.mp3` is generated, the loader's placeholder-WAV fallback keeps them audible
  and auto-upgrades on reload. Client typechecks + builds.

- 0.2.74: **Audio prompts — describe the sound, not the game moment.** Several SFX
  descriptors in `asset-pipeline/manifest.json` narrated the *event* instead of the
  *sound* — Suno was being told to sonify clauses like "an animal now follows you" (feed_follow),
  "you cannot escape yet" (quest_blocked), "the panic meter is filling" (panic_warning),
  "a robot is paying attention" (tension_loop), "the room has sealed" (lockdown_loop),
  "objective met" (quest_complete), "the herd shrinks" (follower_lost). Every descriptor is
  now a pure acoustic description (timbre, attack, pitch motion, texture); the game-event
  mapping stays where it belongs — the manifest `trigger` field. Also retuned the
  `theme.json` **music** palette for more liveliness while keeping the cold/eerie identity:
  dropped the energy-draining "sparse/restrained/light and spooky" stack for "a steady
  underlying pulse / controlled momentum / atmospheric but moving", added a pulsing
  sequencer + propulsive sub-bass + muted mechanical percussion, raised the tempo floor
  50→70 BPM, and pushed the negative tags away from "beatless/sleepy/new age". Drift gate
  green; `audio.generated.ts` unchanged (descriptors don't affect key→file bindings).

- 0.2.73: **Generated audio assets committed (`assets/sfx/*.mp3`, `assets/music/*.mp3`).** The
  first real Suno generations: 9 SFX (robot_alert, panic_warning, lockdown_alarm, lockdown_clear,
  door_lock, quest_complete, hit, error, confirm) and 2 music tracks (title_theme, explore_loop).
  Committed directly to git — matching the repo's "a clean clone boots with all assets present"
  philosophy (like the committed sprite atlas + tileset + placeholder WAVs): the APK bundles them at
  build time, and judges get a fully working clone with no VPS dependency. The drift gate now reports
  these as present (the placeholder-WAV fallbacks deactivate for the generated keys). The gitignored
  raw samples + provenance stay in `asset-pipeline/output/`. Remaining manifest keys are ungenerated
  (WARN, fallbacks active) until generated.

- 0.2.72: **Docs — README + in-game controls accuracy.** The README's controls list was
  missing **E** (interact/collect food), **F** (feed → herd), and **I** (inventory), and didn't
  mention the food-collection/herding loop or the quest-gated gate — now a full controls table +
  a "Herd & escape" note. The Audio section now documents `SUNOAPI_KEY` setup (system env), the
  free `--dry-run`/`--list`/`--credits` path, the sample-swap command, provenance output, and the
  Cloudflare-`1010`-is-not-a-bad-key caveat. The in-game help (`client/src/help.ts`) Controls tab
  was likewise out of sync — it now lists **F** and **I** (and a richer **E** description) to match
  the authoritative `ACTION_KEYS` map in `main.ts`. Client still typechecks/builds.

- 0.2.71: **Audio pipeline — fix Cloudflare 403 (error 1010) on every Suno request.**
  `api.sunoapi.org` sits behind Cloudflare bot protection, which bans the default
  `Python-urllib` User-Agent before the request reaches Suno's auth layer (the symptom is a
  403 with body `error code: 1010`, NOT an API-key failure). `scripts/sunoapi/client.py` now
  sends a browser-like header set (`User-Agent`/`Accept`/`Accept-Language`/`Origin`/`Referer`,
  matching the captured Firefox playground request) on `_post`, `_get`, and the audio
  `download()` (rewritten from `urlretrieve` to a streamed `urlopen` so it can carry headers
  and clean up its `.tmp` on failure). A dedicated 403/1010 error message now explains it is a
  signature/header block, not a bad key. Verified: the actual `Request` objects carry the
  headers; imports and both zero-spend dry-runs stay green.

- 0.2.70: **Audio pipeline Phase 5 — validation remediation.** Two fixes from the
  `/plan-validation-and-review` gate: (1) `scripts/sunoapi/core.py` now catches `SunoShapeError`
  explicitly (it was imported but only hit the generic handler) and prints an actionable message
  pointing at the dumped provenance JSON + `extract.py` to patch if the Suno response shape ever
  changes. (2) `quest_complete` (a `must`-priority SFX that was defined in the manifest but not yet
  played) now fires on the quest-row false→true completion edge in `main.ts`. The remaining unwired
  SFX/music keys are all `nice`-priority and intentionally deferred. Full green: shared + client build,
  `tsc --noEmit`, the drift gate, Python imports, and both zero-spend dry-runs.

- 0.2.69: **Audio pipeline Phase 4 — docs (`docs/AUDIO_PIPELINE.md`, new).** The best-practices
  deliverable: data-flow overview, **cost-consciousness** (user-run generation, free `--dry-run`/`--list`,
  skip-unless-`--force`, raw-reuse, `--credits`, rate/latency/retention), the theme system, **Suno prompt
  best practices** (customMode instrumental music with no `prompt`; SFX `/generate/sounds` V5 with
  `soundLoop`/`soundTempo`/`soundKey` and no `negativeTags` param), the eerie/creepy aesthetic vocabulary,
  the poll-not-callback model (`callBackUrl` is a placeholder), how to add an asset, the full CLI
  reference, sample-swapping, the drift gate, raw provenance layout, and deps/env. `CLAUDE.md` gains the
  audio commands + an architecture rule ("`manifest.json` is the source of truth; `audio.generated.ts` is
  generated — never hand-edit; run `npm run audio`"); `README.md` gains an Audio subsection and updated
  layout. Docs land; `npm run audio` and the client build stay green.

- 0.2.68: **Audio pipeline Phase 3 — client music layer + state machine (`client/src/music.ts`, new).**
  Background music, wired to gameplay. `music.ts` is a renderer-agnostic Web Audio crossfade manager
  sharing the one `AudioContext` from `audio.ts` (so the menu's first-gesture `unlockAudio()` unblocks
  music too): `initMusic()`, `playMusicState(track|null, {fadeMs?,volume?})` (the single per-frame
  entry-point — idempotent, ≤2 voices during a 1.2s linear crossfade, one-shot stings auto-return to the
  loop), `setMusicVolume`/`duckMusic`/`unduckMusic`. Missing `.mp3` (the state until the user generates
  audio) → silent 404, never throws into the frame loop. `main.ts` calls `initMusic()` at boot and
  `playMusicState(selectMusic())` every frame; `selectMusic()` derives the track from wire-guaranteed
  state — menu (`!myId`) → title; `escaped` → victory sting; `world.lockdown` → lockdown loop; panic
  ≥85% → panic loop; a robot in `mode === 'pursue'` or panic ≥66% → tension loop; else explore loop.
  (Robot `mode` is confirmed on the wire — the engine serializes the full entity and the renderer already
  reads it.) New themed SFX replace the old generic blips at their edges: lockdown engage now plays
  `lockdown_alarm` + `door_lock` (was `error`), lift plays `lockdown_clear` (was `confirm`), escape plays
  `gate_open` (was `confirm`); `panic_warning` fires on the 66% up-edge; `robot_alert` fires when any
  robot enters `pursue`. All new SFX play their committed placeholder WAV until the real `.mp3` lands.
  Client typechecks strict and builds; the drift gate stays green.

- 0.2.67: **Audio pipeline Phase 2 — Python generation CLIs (`scripts/sunoapi/` + wrappers, new).**
  The credit-spending half of the pipeline, **stdlib-only** (urllib/json/argparse/os/shutil/pathlib/time —
  zero pip installs; Python 3.8+). A shared `scripts/sunoapi/` package (`client.py` urllib HTTP +
  bearer-auth from `SUNOAPI_KEY` system env; `compose.py` theme+manifest → exact Suno request body;
  `extract.py` HAR-verified `data.response.sunoData[].audioUrl` for **both** kinds; `manifest.py`,
  `paths.py`, `core.py` engine) behind four thin wrappers: `generate-music.py`, `generate-sfx.py`,
  `change-music-track.py`, `change-sfx-track.py`. Music posts `/api/v1/generate` (instrumental, no
  `prompt`, style ≤1000 chars); SFX posts `/api/v1/generate/sounds` (`model:V5`, descriptor-led prompt
  ≤500 chars). Both poll the same `/api/v1/generate/record-info`. **Cost-safe by construction:**
  `--dry-run`/`--list` make zero network calls (work with the key unset); already-generated assets skip
  unless `--force`; both samples are saved to `asset-pipeline/output/<key>/` with a provenance `.json`
  and sample #1 auto-placed; `change-*-track.py` swaps to sample #2 (or an explicit `--input`). Exit
  codes 0/1/2/3/4 (ok/usage/auth/api/integrity). No real generation runs in this phase — the user runs
  it (see Phase 5). `scripts/requirements.txt` documents the intentional stdlib-only choice.

- 0.2.66: **Audio pipeline Phase 1 — manifest→client codegen + drift gate (`scripts/audio/`, new).**
  Makes `asset-pipeline/manifest.json` the single source of truth for the client. `scripts/audio/
  gen-bindings.js` renders the committed `client/src/audio.generated.ts` (deterministic; `SFX_FILES`
  for all 26 sfx keys — 18 manifest `.mp3` + 8 keep-synth `.wav` — plus `SFX_FALLBACK`, `SFX_VOLUME`,
  `MUSIC_FILES`, `MUSIC_META` and the `SfxName`/`MusicName` types). `client/src/audio.ts` now imports
  those maps instead of hand-listing them and, in `load()`, falls back to a committed synth WAV when an
  SFX's `.mp3` isn't generated yet (so e.g. `robot_alert` plays `error.wav` until its MP3 lands, then
  auto-upgrades on reload); it also exports `getAudioCtx()` for the Phase-3 music layer to share the one
  AudioContext. `scripts/audio/verify-audio.js` is the **drift gate** (mirroring `verify-tileset.js`):
  manifest↔generated key coverage, URL-formula correctness, a regenerate-and-diff staleness check,
  asset-existence with placeholder tolerance (missing `.mp3` → WARN, never FAIL while a placeholder WAV
  exists), and fallback-target existence. New `npm run audio` / `audio:codegen` / `audio:verify` scripts.
  Client typechecks strict and the gate exits 0.

- 0.2.65: **Audio pipeline Phase 0 — contracts (`asset-pipeline/`, new).** The foundation
  for Suno-generated music + SFX. `asset-pipeline/theme.json` is the single editable global
  audio identity (eerie/creepy *Caves of Steel* palette, with separate `music` "light and
  spooky" and `sfx` "punchy and engaging" sub-palettes + a `shared` block). `asset-pipeline/
  manifest.json` is the **single source of truth** for every audio asset — 8 music tracks
  (title/explore/tension/panic/lockdown/victory/caught/ambient) and 18 SFX (each with a
  `placeholder` mapping to an existing synth WAV so the game has sound before generation),
  each tagged `must`|`nice` for cost-conscious batching. Both files parse in Python and Node
  (the cross-language seam) and pass an integrity check (unique keys, `assets/`-prefixed
  outputs, every SFX has a placeholder). `.gitignore` now ignores the regenerable raw-output
  staging `asset-pipeline/output/` (two samples + provenance JSON per asset, kept outside Vite
  `publicDir` so it never ships in the bundle/APK) and `assets/{music,sfx}/*.bak` swap backups.
  Later phases add the Node codegen + drift gate, the Python generation/swap CLIs, and the
  client music-playback layer.

- 0.2.64: **Project-level Claude Code subagents (`.claude/agents/`, new).** Added a
  focused roster of 7 tech-stack-aware subagents, authored from a parallel survey of
  the real codebase and adversarially reviewed for accuracy against it. They partition
  the project along its actual trust/ownership boundaries with minimal overlap, and
  each encodes the project's non-negotiables (server-authoritative; `shared/` is the
  single source of truth, never duplicated into `client/`/`server/`; net events are a
  contract in `shared/src/net.ts` changed on both sides in one commit; renderer swappable
  via `IRenderer`; Capacitor-safe `base:'./'`; TS strict; build `shared` before consumers;
  per-phase feature-branch commits, never `main`; CHANGELOG every commit; the
  `/plan-validation-and-review` gate):
  - **`shared-contract-architect`** (opus) — owns `shared/`: net contract, serializable
    types, deterministic core (`step.ts`/`movement.ts`/`locomotion.ts`/`pathfind.ts`/
    `rng.ts`), seed-deterministic world gen + `WORLD_GEN_VERSION`.
  - **`authoritative-server-engineer`** (opus) — the fixed-tick engine, Socket.IO
    orchestration, and all server-owned gameplay (stealth/Three-Laws, behaviors, follow,
    quests, spawn, panic/lockdown).
  - **`client-netcode-engineer`** (sonnet) — Phaser/Vite/TS client: prediction +
    reconciliation, input, `NetClient`, HUD, rendering behind `IRenderer`, Capacitor build.
  - **`asset-pipeline-engineer`** (haiku) — the zero-dep sprite/tile/atlas/tileset/SFX
    generators and their `verify-*` drift gates.
  - **`multiplayer-debug-tester`** (sonnet, read+run only) — reproduces desync via the
    e2e/sim harnesses and the determinism/parity tests; hands root causes to the implementers.
  - **`multiplayer-security-auditor`** (opus) — the authoritative trust boundary: input
    validation, the per-socket rate limiter, anti-cheat, auth/token flows, secret hygiene,
    `npm audit` triage.
  - **`release-and-deploy-engineer`** (sonnet) — build order, clean-clone judge-readiness,
    Android/Capacitor APK, VPS deploy, git/CHANGELOG/commit-hook discipline, validation gate.

  `.gitignore` now keeps `.claude/` session scratch ignored but tracks `.claude/agents/`
  via a `!.claude/agents/**` negation, so the roster ships to every contributor on clone.

- 0.2.63: **Rejuvenation Phase 3 — robustness + hardening.** Three audit-agreed fixes:
  - **`server/index.js` — `unhandledRejection` now shuts down cleanly.** It previously
    only logged, unlike `uncaughtException` (which stops the engine, closes the db + http
    server, and arms a forced-exit timer) — an unhandled rejection could leave a zombie
    server in an inconsistent state. Extracted a shared `shutdownFatal(label, err)` helper
    so both handlers perform the identical clean shutdown.
  - **`shared/src/world.ts` — spawn fallback can no longer seat a spawn on a solid tile.**
    The last-resort `if (!found)` fallback (rare all-occupied seed) pushed a spawn tile
    without re-checking walkability, relying on the later reachability carve. It now carves
    the tile walkable by construction (the generator's own `deco`/`setTile`+`PAVED` idiom),
    so the "every spawn is non-solid" invariant holds independent of the carve. World-gen
    parity hash unchanged (happy path byte-identical); `validity` test still green. **Closes
    and removes the "Spawn fallback can add a still-solid tile" `FINDINGS_OUTSIDE_SCOPE.md`
    entry.**
  - **Per-socket rate-limiting (`server/socket/rate-limit.js`, new).** A dependency-free
    in-memory token bucket guards the three client→server handlers: a coarse budget on
    `auth:login`/`lobby:join` (rare; floods are abuse) and a generous tight budget on
    `input` (sustains 40/sec with a 60-burst — 2× the legitimate 20 Hz stream, so normal
    play is never throttled while a pathological flood is shed). Over-budget packets are
    silently dropped (no state change); buckets are freed on disconnect so memory can't grow
    across reconnects. Wired into `auth.js`, `lobby.js`, and `connection.js`; tunables are
    env-overridable. Rebuilt `shared/dist`; 70/70 shared tests pass; server boots + `/health`
    OK.

- 0.2.62: **Rejuvenation Phase 2 — documentation accuracy.** Fixed the two genuinely
  stale doc claims (the rest of the docs audited clean): (1) `ARCHITECTURE.md` stated
  `BabylonRenderer (client/src/render/babylon.ts) is the 3D fallback impl.` as fact, but
  that file does not exist — reworded to "documented-but-unimplemented" with the skeleton
  in `shared/BABYLON_FALLBACK.md` and the swap path in `client/src/main.ts`. (2) The
  network-contract event lists had drifted: both `ARCHITECTURE.md` and the
  `shared/src/net.ts` header comment (which claims to mirror it) listed only the old
  `lobby:join`/`input`/`ping` ↔ `lobby:state`/`snapshot`/`pong` events — added
  `auth:login`/`auth:result` and `map`, and corrected the payload shapes to match
  `shared/src/net.ts`. Rebuilt `shared/dist`. No behavior change.

- 0.2.61: **Rejuvenation Phase 1 — finish the *Escape AI* title relabel.** Landed the
  in-flight rename of the game title "The Caves of Steel" → "Escape AI" across docs,
  shared, server, client and the asset-pipeline script headers (relabels only — no logic
  touched). Caught the five script headers the rename missed (bare "Caves of Steel" as a
  project label, not the novel): `scripts/check-facing.js`, `scripts/sprites/template.js`,
  `scripts/sprites/anim.js`, `scripts/tiles/builders/edges.js`,
  `scripts/tiles/builders/fences.js`. The Asimov *Caves of Steel* novel / in-world-lore
  references (`client/src/help.ts`, `docs/ASIMOV_REFERENCE.md`, `shared/src/world.ts`,
  `scripts/sprites/species/robot.js`, and historical CHANGELOG entries) are deliberately
  left intact, as is the `game/caves-of-steel` branch name. Verified: `shared` builds
  green; `grep -rni "caves of steel" scripts/` leaves only the keeper-robot flavor line.

- 0.2.60: **NPC pathfinding — Phase 5 (`/plan-validation-and-review`).**
  Validation pass: requirements trace (6/6 implemented + connected), connectivity audit (zero dead code),
  dedup scan, code-comprehension review of the determinism-critical pathfinder + the server integration,
  full build/test. The pathfinder core was reviewed as ship-ready (total-order open set, correct heap +
  generation-stamp scratch, deterministic clearance, guaranteed termination). Three items fixed:
  - **Server (`server/game/stealth.js`):** `loadShared` now also fail-loud-validates the step.js
    primitives the new hot-loop code calls directly — `boxHitsSolid` (near-wall test), `wanderVec`
    (open-field saunter blend), `hash32` (per-entity repath phasing) — so a stale `shared/dist` trips at
    boot, not mid-tick.
  - **Server (`server/game/stealth.js`):** dropped `gateInsideTile` from the pathfind export-validation
    list — it's a shared/test helper (`world.js` computes the gate-inside goal tile inline), so validating
    it as a server dependency was misleading.
  - **`FINDINGS_OUTSIDE_SCOPE.md`:** filed the deliberately-deferred robot **pursue** pathing (a moving
    quarry has no fixed goal tile; both design critiques + the user opted to defer it) with a reproducer
    pointer and a suggested approach.
  - Verified: shared **69/69**, client `tsc && vite build` green, server boots clean (validates the added
    exports), a 2500-tick full real-map loop (idle + followers + robots) returned all animals home with no
    throw. Working tree clean. **Result: Pass with Caveats** (one documented deferral: pursue pathing).

- 0.2.59: **NPC pathfinding — Phase 4 (robot investigate routing around walls + path-follow hardening).**
  Robots now route AROUND walls and THROUGH gates to reach an off-route investigate goal (a noise
  behind a fence) instead of pressing one-tile-ahead into the barrier. Patrol-loop, guard-wander, and
  pursue are unchanged (pursue stays reactive — a moving quarry can't use a cached path; deferred to a
  measured follow-up).
  - **Server (`server/game/behaviors.js`):** `setShared` takes the pathfind module; `moveTowardPoint`
    (the investigate + linger-to-last-known mover) routes via `ctx.followPathToGoal` to the target tile
    (radius-aware, with a point-based retry so a wedged robot is never stranded), then commits. `stepRobotIdle`
    resets the cached path on every FSM transition (investigate↔resume↔guard) so a stale route can't bleed
    across modes. Falls back to raw `steerAround` toward the point when no route exists.
  - **Server (`server/game/stealth.js`):** `stepRobots` hands the per-room A* scratch + the
    `followPathToGoal`/`clearPath` helpers into the robot idle ctx.
  - **Path-follow hardening (fixes wall-corner oscillation for BOTH robots and animals):** the dense tile
    path is followed verbatim (no collinear simplification — a simplified waypoint past a wall corner made
    the body cut the corner and oscillate); `ARRIVE_TILES` lowered to 0.6 so each step targets the
    immediate next tile center (axis-aligned); and within the gate band of a wall the heading is fed
    STRAIGHT to the axis-separated integrator (NOT through `steerAround`, whose probe fan re-aimed the
    clean heading into the fence). `findPath` gained an optional radius-aware `Clearance` (memoized,
    deterministic) so a robot rounding an OPEN-ended barrier never hugs a corner; animals omit it (the
    2-tile gates thread point-based and clearance can strand a body wedged in a sub-radius nook mid-walk).
  - **Dead-code sweep:** `simplifyPath` + `tileClearsRadius` (obsoleted by the dense-path / inline-clearance
    decisions) removed from `pathfind.ts` and their tests; the server's pathfind export-validation list
    trimmed to what it actually calls.
  - Verified: robots route through the gate into a closed enclosure to investigate (38 ticks); all 14
    species re-enter their pens across **15 map seeds (210/210)**; a 3000-tick full real-map loop (idle +
    followers + robots) ran clean with all 9 robots traveling; 42 simultaneous returns over a 600-tick loop
    ran **0.184ms avg / 15.52ms worst** (50ms budget). shared **69/69**, client `tsc && vite build` green.

- 0.2.58: **NPC pathfinding — Phase 3 (return home THROUGH the gate; slow cadence preserved).**
  Fixes the bug where an animal whose follow-leash lapsed drifted toward its enclosure center, jammed
  on the OUTSIDE of the fence, and never found the 2-tile gate — the old code papered over it by
  declaring the animal "home" while merely pressed against the outer wall. It now PATHS back in.
  - **Server (`server/game/world.js`):** new `getHomeGateInsideBySpecies(roomName)` — the per-species
    gate-INSIDE goal tile (one row inside the enclosure gate / building door, always non-solid and
    inside the inset bounds, so a solid pond/den core can never make the goal unreachable), exported.
  - **Server (`server/config.js`):** new `PATHFIND` block — `REPATH_TICKS` (recompute cadence, ~1.5s),
    `GATE_BAND_TILES` (chokepoint band width), `ARRIVE_TILES` (waypoint advance radius).
  - **Server (`server/game/stealth.js`):** `followPathToGoal` (ensure + follow a cached A* route to a
    goal tile — recomputed only on goal-change / exhaustion / the slow phased cadence; route simplified
    to turning points with the gate goal kept mandatory) + `clearPath` + per-room gate-tile & A*-scratch
    caches. `stepIdleAnimals` returningHome branch rewritten: A* to the gate-inside tile, an open-field
    ambient-wander blend (`RETURN_WANDER_BLEND`) so the long walk still reads as a saunter, switching to
    PURE path-following inside the gate band so the 2-tile gap threads deterministically (no fence-post
    clip). Commit is via the EXISTING `steerAround` + `locomotionStep` at the UNCHANGED
    `WANDER_ANIMAL_SPEED` + species gait — so the slow cadence is preserved (a returning tortoise still
    crawls, a kangaroo hops). Arrival is now a TRUE re-entry test (`pathfind.inBounds` of the interior
    bounds), not a proximity guess. The `homeArrivalRadius` hack is DELETED; `homeBiasedWanderStep` is
    KEPT as the documented fallback for the rare unreachable-goal / degenerate-seed case.
  - Verified live: ALL 14 species path from the far spawn corner across the map, through their gate, and
    re-enter their pen (`returningHome` clears only when genuinely inside the inset bounds); gait cadence
    preserved per species; 42 animals returning simultaneously over a 600-tick full loop (idle +
    followers + robots) ran in **0.167ms avg / 14.97ms worst tick** (50ms budget). Paths are per-entity
    server-only scratch, never serialized. shared **68/68**, client `tsc && vite build` green.

- 0.2.57: **NPC pathfinding — Phase 2 (situational awareness: contained animals invisible to robots).**
  Fixes the bug where robots froze/investigated/pursued idle animals sitting INSIDE their own
  enclosures — peeling patrols pointlessly into pens. An animal that is "where it belongs" is no longer
  a stealth target.
  - **Server (`server/game/world.js`):** new `getAuxInteriorRects(roomName)` — the aux-building interior
    rects in world units (same inset wall-ring math as `getGuardBoundsByRobotId`, unkeyed), exported.
  - **Server (`server/game/stealth.js`):** `loadShared` now also imports + fail-loud-validates
    `shared/dist/pathfind.js` and caches it (handed to `behaviors`/`follow` for later phases). New
    `auxInteriorRectsForRoom` per-room cache + `isAtHomeAnimal(e, homeBounds, auxRects)` predicate (an
    O(1) `pathfind.inBounds` point-in-rect against the already-cached enclosure bounds + aux interiors).
    `gatherAnimals` — the SINGLE chokepoint feeding both `robotDecision` (perception/freeze/pursue) AND
    `behaviors.pickInvestigateTarget` — now skips an idle animal when `!isLeashed && !returningHome &&
    isAtHomeAnimal`. So a contained pen/aux animal is invisible to robots, while a leashed follower, a
    returning-home animal still outside its pen, an animal wandered out of bounds, a fox decoy, and
    every player stay visible.
  - Verified live (boot `loadShared`, then exercise `gatherAnimals`): pathfind exports validate; a
    contained pen animal is hidden; leashed / returning-home / out-of-bounds / fox-decoy animals stay
    visible; 30 NPC ticks run clean with the filter active. shared **68/68**, client `tsc && vite build`
    green. No `net.ts` / world-gen change — the filter is server-side, derived from cached map bounds.

- 0.2.56: **NPC pathfinding — Phase 1 (deterministic A* substrate, no consumers yet).**
  Adds the missing GLOBAL route layer the reactive `steerAround` (one-tile-ahead probe) structurally
  lacks: it can round a corner but cannot FIND a two-tile door gap from outside a walled enclosure.
  This is the foundation for fixing return-home-through-the-gate and robot routing around walls.
  - **Shared (`shared/src/pathfind.ts`, new):** a pure, deterministic 4-connected tile-grid A* over
    the existing `collision` Uint8Array. The open set pops by an EXPLICIT TOTAL ORDER (f, then g,
    then flat tile index) so equal-cost frontiers resolve bit-identically across V8 builds; neighbour
    expansion is E,W,S,N — IDENTICAL to `world.ts` `floodReachable`, so "reachable" and "pathable"
    can never disagree. Integer step-count g-scores + integer Manhattan heuristic (no float fragility).
    Reusable `PathScratch` (generation-stamped, so a search resets in O(1) and costs O(cells expanded),
    allocating nothing per call). `maxExpand` defaults to one full grid sweep (`w*h`) so a genuinely
    reachable cross-map goal is never abandoned, yet the search always terminates; on overflow /
    unreachable / solid-or-OOB endpoint it returns `[]` and the caller falls back to reactive steering
    — never a hang. Doors/gates are already non-solid tiles, so A* threads them with zero special-casing.
    Helpers: `simplifyPath` (collinear collapse with a `keepTiles` allow-list so gate waypoints stay
    mandatory + axis-aligned), `toWorldWaypoints`, `nextWaypoint` (arrive-radius advance like
    `patrolStep`), `inBounds` (O(1) point-in-rect, for the awareness filter + the true return-home
    arrival test), `gateInsideTile` (the interior threshold tile = the return-home A* goal), and
    `tileClearsRadius`. A LEAF peer of `step.ts` — imports only `boxHitsSolid`, no `world.ts` import
    (no cycle). Server-only consumption; paths are per-entity scratch, NEVER serialized (no net change).
  - **Shared (`shared/src/index.ts`):** export the new module.
  - **Test (`shared/test/pathfind.test.mjs`, new):** 15 cases — determinism (byte-identical path twice
    AND across a fresh `generateWorld` of the same seed; reused-scratch == fresh-scratch),
    thread-the-door (routes from outside a walled enclosure through the 2-tile gate; the contrast test
    proves pure `steerAround` does NOT), real-map walkability (every species home + every building door
    reachable, every step a non-solid 4-neighbour move), mandatory gate waypoints, graceful degrade
    (solid/OOB/sealed/over-budget → `[]`), `inBounds` truth table, `gateInsideTile`.
  - Verified: shared **68/68** (`node --test test/*.test.mjs`, world parity hashes intact),
    client `tsc && vite build` green. No behavior change to the running game — the substrate ships
    behind a green test gate before any caller touches it.

- 0.2.55: **Drop the locked-door mechanic + fix food distribution (two in-game food bugs).**
  - **Can't collect food (lock removed):** the locked-door gate played badly — the door tile is
    non-solid (you walk straight in), the terminal-unlock wasn't usable, and the lock SILENTLY
    blocked `collectNearbyFood`, so pressing E near food did nothing. Per the design call the lock is
    removed entirely: food in the aux buildings is now freely collectable and the **guard robot is
    the challenge**. Removed: the `foodSource` lock-skip in `server/game/follow.js`; the
    door-terminal interact branch + `nearestDoorTerminal` helper in `server/game/stealth.js`; the
    per-room `unlockedDoors` set + `isDoorLocked`/`unlockDoor`/`auxBuildingById` + their exports + the
    terminal door-meta in `spawnFromMap` (`server/game/world.js`); the `terminal-door-*` entitySpecs
    + `terminalTx/Ty` + `Building.locked` (`shared/src/world.ts`); the 🔒 door marker in
    `client/src/render/phaser.ts`.
  - **All food in the Commissary (distribution fixed):** the species→wall-slot assignment concatenated
    all 3 buildings' wall slots into one list and filled it in order, so the commissary (≈26 slots)
    swallowed all 14 foods. Now ROUND-ROBINS species across the 3 buildings → **5 / 5 / 4** spread,
    each food still strictly inside an aux interior. Deterministic, unshuffled `SPECIES_KEYS` order.
  - **Shared:** `WORLD_GEN_VERSION` 10 → 11; both pinned hashes re-pinned (collision 915161051,
    entitySpec 530761931 — collision moved because the dropped door-terminals no longer pull the
    reachability carve toward them). Tests: dropped the door-terminal invariant + the `locked`
    assertion (kept the 3-guard-robots check), added a food-spread invariant.
  - Verified: shared **19/19**; client `tsc && vite build` green; server boots clean; live-module
    test collects food in two different buildings with NO unlock (`banana` + `seeds`); spread probe →
    `{commissary:5, washroom:5, maintenance:4}`; no lock remnants remain in shared or the server modules.

- 0.2.54: **Spawn players in their own species pen + post-catch grace (fixes the spawn-on-robot
  catch loop).** Players spawned in the gate-side block where robots patrol, so landing on a robot
  caused an instant re-catch every tick — an infinite loop.
  - **Server (`server/game/world.js`):** new `spawnForSpecies(roomName, species, jitterSeed)` —
    resolves the spawn to the player's OWN pen center (`getHomeCentersBySpecies`) with a
    bounds-clamped deterministic jitter (local FNV `hashStr`, no rng) so same-species players don't
    stack. Falls back to the gate spawn only if a species somehow has no home. Exported.
  - **Server (`server/game/stealth.js`):** `catchPlayer` + `respawnPlayer` now take `currentTick`
    and stamp a `spawnSafeUntilTick` GRACE window; the catch hook's `uncatchable` test skips a
    player still within grace, so a robot at the respawn point can't chain-catch. All three spawn
    paths (catch, escape-respawn, initial join) route through `spawnForSpecies`; `respawnPlayer`
    resolves the pen AFTER its species roll (lands in the new animal's pen).
  - **Server (`server/socket/lobby.js`):** initial join spawns via `world.spawnForSpecies`
    (resolved after the species pick; the player id is generated up front so the jitter keys to it).
  - **Config:** `SPAWN_GRACE_SECS` (2s).
  - Verified: server modules `node --check` + boot clean (`listening on :3000`, 0 errors); client
    `tsc && vite build` green; shared **53/53**. Live-module tests: a caught player respawns at its
    own pen center (mole → (274,2966) vs center) with grace stamped exactly (`1000 → 1040 =
    +secsToTicks(2)`); the catch hook's `uncatchable` predicate skips a graced player and re-arms
    after it expires; `spawnForSpecies` lands on a non-solid interior tile (12/12 distinct positions
    from real UUIDs); a 200-seed sweep confirms NO robot ever spawns inside a species pen.

- 0.2.53: **Auxiliary buildings — Phase 5 validation remediation (`/plan-validation-and-review`).**
  The validation pass (requirements trace, connectivity audit, dedup scan, code comprehension,
  build/test) found all 9 requirements implemented + connected, zero dead code, the net contract
  untouched, and no non-deterministic math in world-gen. It cleared three flagged "blockers" as
  false positives (verified by running the code: the door-terminal `break` is present so a press
  never both opens a door and orders a robot; door-terminal anchors are non-solid + reachable
  across 400 seeds with zero generator throws; the guard branch's `wanderAvoid` already tolerates
  undefined bounds). Three real items fixed:
  - **Server (`server/game/follow.js`):** `collectNearbyFood` now SKIPS a locked-building food
    during the nearest-food search instead of bailing when the nearest happens to be locked — so a
    reachable unlocked source is never shadowed by a nearer locked one (two buildings' walls can sit
    within one `RECT_SIZE`). Verified live: locked food refused; unlocked collected; a locked food
    sitting nearer than an unlocked one no longer blocks collecting the unlocked source.
  - **Client (`client/src/render/phaser.ts`):** fixed a real object leak — the aux signage (name
    labels + 🔒 markers) was created with `this.add.text(...)` but never tracked, so a `buildWorld`
    re-run (new map) would orphan the previous map's labels/markers (they aren't `EntityView`s, so
    `destroyView` never sweeps them). Now tracked in `this.auxSignage` and destroyed + reset (with
    the roof rects) at the top of the per-building loop.
  - **Shared (`shared/src/world.ts`):** corrected the `stampAuxBuilding` wall-slot traversal comment
    (south row is R→L, west column bottom→top) — comment-only, no byte/hash change.
  - Verified: shared **53/53** (`node test/world.test.mjs`), client `tsc && vite build` green, server
    modules boot clean; the follow-gating fix + door-terminal unlock/panic + guard containment all
    pass live-module tests. Working tree clean. **Result: Clean Pass (7/7 phases).**

- 0.2.52: **Auxiliary buildings — Phase 3/4 (server gating + guards + client render).** Wires the
  locked-door food economy and the guard robots to the relocated food, and renders the new
  buildings distinctly. No `net.ts` change — everything rides the seed-derived map + existing
  entity snapshots (tech rule "catastrophic overflow": opening a door feeds the panic meter).
  - **Server (`server/game/world.js`):** per-room `unlockedDoors` set; `isDoorLocked` /
    `unlockDoor` / `auxBuildingById` / `getGuardBoundsByRobotId` helpers (the last keyed by
    robot id, not species, since aux buildings are species-less). `spawnFromMap` now carries
    `buildingId`/`auxKind` onto food entities, `door:true`/`buildingId`/`auxKind` onto
    door-terminals, and `behavior:'guard'`/`guard:true`/`buildingId` onto guard robots.
  - **Server (`server/game/follow.js`):** `collectNearbyFood` refuses food whose owning aux
    building is still locked (the door tile stays non-solid — "locked" is pure runtime state).
  - **Server (`server/game/stealth.js`):** the `applyAction` interact branch (after the food-first
    early-return) handles a door-terminal — `unlockDoor` + bump `pendingOrders` (the existing
    Second-Law panic latch), so opening the commissary/washroom/maintenance is the double-edged
    "helpful but raises panic" mechanic (Act-of-Sutskever flavor). New `nearestDoorTerminal`
    helper. `stepRobots` threads per-room guard bounds onto each guard robot.
  - **Server (`server/game/behaviors.js`):** new `guard` behavior — a guard robot contained to its
    building interior via `movement.wanderAvoid(bounds)` (the same containment idle pen animals
    use) instead of leaving on the patrol loop; it still breaks off to investigate/pursue intruders
    (First/Second-Law detection unchanged).
  - **Client (`client/src/render/phaser.ts`):** aux roofs tinted per kind (commissary terracotta /
    washroom teal / maintenance grey) with a floating title label + a 🔒 door marker, so the three
    service buildings read distinctly at a glance. Species homes + the gatehouse are unchanged. The
    lock marker shows the generator's initial `locked` state; a live unlock indicator would need a
    server-sent flag (a documented future net addition, out of scope here). Food + inventory render
    unchanged (food is position-driven).
  - Verified: all 4 server modules `node --check` clean + boot clean (`listening on :3000`, 0
    errors); client `tsc && vite build` green (53 modules, zero TS errors). End-to-end against the
    live modules: food collect refused while locked (`{}`) and succeeds after unlock (`{steak:1}`);
    interacting at a door-terminal unlocks the building (`locked true→false`) AND raises panic
    (`pendingOrders 0→1`); all 3 guards spawn inside their bounds with `behavior:'guard'`.

- 0.2.51: **Auxiliary buildings + dispersed food — Phase 1/2 (shared world-gen).** Food no longer
  sits inside the animals' own housing; it is dispersed into closed-out service buildings, on-theme
  with the domed-megacity (Caves of Steel) setting. `WORLD_GEN_VERSION` 9 → 10.
  - **Shared (`shared/src/world.ts`):**
    - **Aux buildings:** new `AuxKind` type + `auxKind?`/`locked?` fields on `Building`; a stable
      `AUX_BUILDINGS` table (`commissary` / `washroom` / `maintenance`) and a `stampAuxBuilding`
      helper (wall ring + per-kind floor + fade-on-enter roof + 2-wide `DOOR_OPEN` south door +
      light dressing). Placed AFTER the per-species home loop, in a non-`wetland` zone (so the door
      never lands on/adjacent to the river), positions/sizes jittered per seed. Species-less, so the
      one-home-per-species invariant is untouched (the gatehouse precedent).
    - **Food relocation:** all 14 `foodSource` specs move out of animal housing onto the aux
      buildings' interior walls. A deterministic `foodPos` map assigns each species (unshuffled
      `SPECIES_KEYS` order) the next interior wall slot across the 3 buildings (fixed traversal), so
      `JSON.stringify(entitySpecs)` stays byte-stable. The `TROUGH_FOOD` marker stamp (with its
      `collision = 0` override) follows the food to the new tiles. The `questObject` stays on the
      home tile. Each food's `meta` now carries `buildingId` + `auxKind` so the server can gate it.
    - **Guard + door-terminal specs (Phase 2):** each aux building emits one `robot-guard-${kind}`
      (`meta.guard`) at its interior center and one `terminal-door-${kind}` (`meta.door`) just
      outside its door (clear of the interior food's interact reach). Appended after the existing
      robots/terminals so those stay byte-identical.
    - Aux doors + door-terminals + food tiles are all added to `reachTargets`, so the reachability
      carve guarantees them on every seed.
  - **Tests (`shared/test/world.test.mjs`):** re-pinned `PINNED_COLLISION_HASH` (4250159112) +
    `PINNED_ENTITYSPEC_HASH` (58088005), version assertion → 10, gatehouse check re-keyed to
    `species == null && !auxKind`, food added to the deep-water reach-target check, and 3 new
    invariants (exactly 3 reachable aux buildings ≥ 8×6 interior; every food strictly inside an aux
    interior and NOT in any animal home; one door-terminal + one guard per aux building).
  - Verified: `npm run build` clean; shared **53/53** green; a multi-seed probe (0,1,2,7,123,777,
    9999,424242) confirms 3 aux buildings, 14 foods all inside aux interiors with `foodInAnimalHome=0`,
    full reachability, no aux door near deep water, and byte-identical re-runs.

- 0.2.50: **NPC movement refactor — validation remediation (`/plan-validation-and-review`).** The
  validation pass (requirements trace, connectivity audit, dedup scan, determinism audit,
  build/test) found all 6 requirements implemented + connected, every new shared export wired,
  determinism clean (zero RNG/clock in `shared/`), no `net.ts` change, no require cycles, no
  duplicate-of-shared violations, no orphan config. It surfaced one real cleanup, fixed here:
  - **Dead code removed:** `shared/src/step.ts`'s `wanderStep` had zero code callers after the
    refactor replaced both its call sites with `movement.wanderAvoid` (which steers around walls
    instead of stalling). Removed the function, its stale entry in `stealth.loadShared`'s `required`
    export-guard list, and updated the doc comments in `stealth.js`/`world.js`/`step.ts`/`movement.ts`
    that still referenced it (its deterministic heading + edge-bias live on in `wanderVec` +
    `wanderAvoid`). Per CLAUDE.md's no-dead-code rule.
  - The 3× "steerAround → move → hazard-veto → facing" sequence (behaviors/stealth/follow) was
    assessed and kept — the variations are intentional (robot raw move vs animal gait), each is
    small and in a different orchestrator, and the shared math is correctly centralized.
  - Verified: shared **50/50**, client `tsc && vite build` clean, server boots, and a full behavior
    regression sim (robot fleet patrol coverage, idle no-stall, 3-link chain line, fox return-home)
    all green after the removal.

- 0.2.49: **NPC movement refactor — Phase 6: species locomotion (client bob + wiring complete).**
  Completes the per-species gait system. The server-side gait (tortoise ½-speed, kangaroo
  hop-pause) was wired into follower + idle-wander movement in Phase 5; this phase finishes it:
  - **Client airborne flutter** (`client/src/render/phaser.ts`): a `fly` species (bird) now bobs
    vertically — a sine wave off the render clock, phased per-entity by `hash32(id)` so a flock
    desyncs, applied to the sprite BODY ONLY (not the Y-sort depth, the label, or the authoritative
    position). Purely cosmetic, so collision/containment/parity are untouched (flight stays
    grounded for gameplay, per the design decision). The gait + bob params come from the shared
    `LOCOMOTION` registry looked up by `e.species` — **no wire field added**; the client already
    imports `@shared/*`.
  - **`updateAnimation` is already gait-aware** with the current idle/walk art: the kangaroo's
    server-side hop cadence start/stops the walk cycle (the "moving" flag tracks the position
    delta), and the tortoise simply moves at half speed — so hop/crawl read correctly with **no new
    frames** (future `_hop_`/`_fly_` atlas states would slot into the existing discovery).
  - **Robots are exempt** (mechanical) — they move via `behaviors.speedFor`, never `locomotionStep`.
  - Verified by an active-chase sim: tortoise covers exactly **0.50×** a normal walker's distance;
    kangaroo conserves mean distance (1520 vs 1500) with **124/200 hop-pause ticks** (a real
    lurch); fox steady with 0 pauses. Client `tsc && vite build` clean; shared 50/50; server boots.

- 0.2.48: **NPC movement refactor — Phase 5: follower chain + grace + drift-home.** Followers now
  form a trailing LINE and, when their feed timer lapses, drift back to their enclosure instead of
  snapping to a generic wander.
  - **Chain/line formation** (`follow.stepFollowers`): each owner's followers are ordered
    deterministically (oldest fed = front, tie-broken by id hash) and stepped front-to-back —
    link 0 trails the player, link *i* trails link *i-1*'s already-updated position (player → f1 →
    f2 → …), spaced by `FOLLOW.GAP`. Movement routes through `chainFollowStep` + `steerAround` +
    `locomotionStep` (so a tortoise link crawls, a kangaroo lurches). Deterministic anti-stuck
    ladder: if a link makes ~no progress while beyond the gap → retry toward the owner (proven
    reachable), then a per-(id,tick) jitter, else hold — no permanent conga-line deadlock.
  - **Grace window** (user decision): on a lapsed timer the animal keeps lagging in the chain for
    `FOLLOW.GRACE_SECS`; a re-feed snaps it back (clears grace + return-home); only once grace
    elapses with no re-feed does it detach.
  - **Drift home** (`releaseToHome` + `stepIdleAnimals` return-home branch): a detached follower
    wanders biased toward its enclosure center (`homeBiasedWanderStep`), gait-applied, and is
    considered "home" once within a proximity radius of the pen (the gate is too small to thread
    with local steering — the home center can even sit in a corner of the bounds, so the radius is
    measured center-to-farthest-corner + slack); then it resumes a normal contained wander. A
    species with no home (transient fox decoy) falls back to a plain release.
  - **Idle wander now gait-aware** (`stepIdleAnimals`): ambient drift runs at the per-species gait
    speed (`gaitSpeed`), so wandering tortoises crawl and kangaroos lurch (bringing forward part of
    Phase 6's wiring; the client-side bird bob remains for Phase 6).
  - New: `world.getHomeCentersBySpecies`; config `FOLLOW.GAP` / `FOLLOW.GRACE_SECS`. The existing
    feed/steal/score path is unchanged (verified). Verified by sims: a 3-link chain trails in order
    (maxGap 56u), grace enters + re-feed snaps back + lapse detaches, and fox/tortoise/bird/
    kangaroo/elephant all drift home and clear the flag (38–72s) — all deterministic. Server boots
    clean; shared 50/50.

- 0.2.47: **NPC movement refactor — Phase 4: robot patrol + investigate FSM.** Idle robots no
  longer drift aimlessly — they now patrol the generated path loop and break off to investigate.
  - `server/game/behaviors.js` (new): the robot behavior FSM (`patrol` ↔ `investigate` ↔ resume),
    mirroring the follow.js orchestrator pattern (`setShared` hand-off, never re-implements math).
    `stepRobotIdle` walks the room's `patrolRoute` via the shared `patrolStep` (looping waypoints,
    rejoining at the nearest waypoint after a detour); `pickInvestigateTarget` finds a suspicious,
    non-human-looking animal in a WIDER ring (`INVESTIGATE.RADIUS_MULT`×perception) than the close
    pursue range, so a robot detours to a last-known spot and lingers (`INVESTIGATE.LINGER_SECS`)
    before resuming. `speedFor` is the single source of truth for robot speed (patrol < investigate
    < pursue) folding in the lockdown multiplier and the deterministic `speedBoost` (spontaneous
    bursts). The Three-Laws perception (`robotDecision`) is **unchanged** — this is purely what the
    body does once perception is idle.
  - `server/game/stealth.js`: `stepRobots` delegates the idle branch to `behaviors.stepRobotIdle`,
    routes the pursue chase heading through `steerAround` (rounds corners toward the target), pulls
    its speed from `behaviors.speedFor`, and marks `behavior='pursue'` (capturing the resume index).
  - `server/game/world.js`: robots spawn with `behavior='patrol'` (patrolIndex assigned lazily from
    the id hash so the fleet phases around the loop, not clumps).
  - `server/config.js`: `INVESTIGATE` block (radius mult / speed 110 / linger); `PATROL_SPEED`
    60→90 (a real waypoint lap reads in reasonable time, still slower than the 120 chase).
  - Verified by sims: a robot patrols (advances waypoints along the loop), detours to a planted
    low-likeness lure (closest approach 0u), resumes patrol when it's removed, and the 6-robot fleet
    collectively covers all 6 waypoints (phased starts 5,2,1,4,3,0) — all bit-deterministic on
    rerun. Server boots clean; shared 50/50.

- 0.2.46: **NPC movement refactor — Phase 3: un-stick idle wander.** Idle decoy/pen animals no
  longer pin flush against a wall until their wander heading re-rolls (up to 2s of looking
  "stuck"). `stepIdleAnimals` now drives movement through `movement.wanderAvoid` — the same
  deterministic wander heading + soft inward edge-bias as before, but it probe-and-rotates around
  the obstacle and commits via the sliding `moveWithCollision`, so the animal rounds its enclosure
  fence instead of stalling on it. Containment is preserved (soft bias + the collision grid as the
  hard backstop). `stealth.loadShared` now also imports + validates `shared/dist/movement.js` and
  `shared/dist/locomotion.js` (fail-loud missing-export guards, like the step module) and added the
  `homeBiasedWanderStep` export to the step `required` list; `follow.setShared` extended to receive
  the extra modules. Verified by a 600-tick sim: a pen animal made 1200 units of cumulative
  progress with **0/600 fully-stalled ticks**, stayed contained, and reproduced bit-identically on
  rerun (determinism). Server boots clean; shared 50/50.

- 0.2.45: **NPC movement refactor — Phase 2: expose `patrolRoute` on `WorldMap`.** Surface the
  path-network junctions (which `carveOrganicPaths` already computes, in carve order) as a new
  `WorldMap.patrolRoute: {x,y}[]` (world units) so robots can patrol the carved spine instead of
  drifting aimlessly. Additive + seed-derived → **zero wire bytes** (the client regenerates it).
  `WORLD_GEN_VERSION` bumped 8→9 as a deliberate cache-bust (old clients fail loud on the version
  assert rather than silently lacking the field); the two pinned parity hashes are **unchanged**
  (patrolRoute touches neither `collision` nor `entitySpecs` — verified). Added
  `server/game/world.js#getPatrolRoute(roomName)` (reads the cached map) and world-test assertions
  for the version + a non-empty, in-bounds, walkable, deterministic patrol loop. Verified: shared
  **50/50** (+2), client build clean.

- 0.2.44: **NPC movement refactor — Phase 1: shared movement base + locomotion registry.**
  First phase of the layered NPC-movement overhaul (shared pure primitives → server behavior
  strategies → per-species modifiers). No behavior change yet — this lays the deterministic core:
  - `shared/src/movement.ts` (new): `steerAround` (deterministic probe-and-rotate obstacle
    avoidance — the fix for NPCs stalling flush against walls), `patrolStep` (looping waypoint
    follower), `chainFollowStep` (trail-a-leader targeting), `speedBoost` (deterministic occasional
    speed burst), and `wanderAvoid` (ambient wander that rounds walls instead of pinning). All pure
    (`dt`/`tick` in, no RNG/clock) — server authority + client prediction agree bit-for-bit.
  - `shared/src/locomotion.ts` (new): a data-driven `LOCOMOTION` registry keyed by species
    (tortoise=½-speed crawl, kangaroo=hop cadence, bird=fast glide + flutter), `locomotionFor`,
    `gaitSpeed` (per-tick gait speed; kangaroo burst conserves mean distance, phased per entity),
    and `locomotionStep` (the single entry point every animal move routes through). Extensible: a
    new species/gait is one table row, no code branch.
  - `shared/src/step.ts`: exported `boxHitsSolid` (so the steering layer probes with the EXACT
    integrator test — no edge-case stutter); added `WANDER.HOME_BIAS` + `homeBiasedWanderStep`
    (wander blended toward a home target for the post-follow drift-home behavior).
  - `shared/src/types.ts`: typed the new optional `Entity` behavior-state fields (`behavior`,
    `patrolIndex`, `chainIndex`, `returningHome`, `homeX/Y`, investigate/grace timers) — all ride
    the snapshot delta via the index signature, **no `net.ts` change**.
  - Verified: shared **48/48** (+28 new determinism/behavior tests covering steering un-stick,
    patrol looping, chain trailing, boost bounds, the three gaits, and home-drift convergence),
    `tsc` clean.

- 0.2.43: **Merge: organic map overhaul × animal-collection feature.** The `game/map-overhaul`
  branch (organic biome layout, gatehouse plaza, per-pen NPC animals + containment — 0.2.39–0.2.42
  below) merged into `game/caves-of-steel` (which had independently grown the animal-collection
  feature — food sources, feed/follow/score — 0.2.33–0.2.38 below). The two are orthogonal and
  compose: the per-species `foodSource` spec is now emitted inside the overhaul's restructured
  `penAnchor → foodSource → questObject` loop (co-located with the quest tile, with its
  TROUGH_FOOD marker stamped after the reachability carve and before the new edge-blend pass), and
  `stepIdleAnimals` both skips a following animal (collection) AND contains a non-following pen
  animal to its enclosure (overhaul). The merged generator output differs from both parents, so
  `WORLD_GEN_VERSION` was bumped to **8** and both parity hashes re-pinned from the combined
  `generateWorld(123)`. Verified: shared **26/26** (the full union of both branches' tests), server
  boot, client build, and a 42-animal containment sim (0 escaped, 0 frozen) all green.

- 0.2.38: **Animal collection — Phase 6 validation remediation (`/plan-validation-and-review`).**
  The validation pass (requirements trace, connectivity audit, dedup scan, build/test) found
  all 17 requirements implemented + connected, `engine.toEntity` forwarding every new field,
  the `feed` verb wired end-to-end, and the old 4-key stat literals fully migrated. It
  surfaced three fixable items, all fixed here:
  - **Duplicate helpers removed:** `secsToTicks` and `findPlayerById` were byte-identical in
    both `server/game/stealth.js` and `server/game/follow.js` (a config-drift / sync hazard).
    Extracted to a new leaf module `server/game/room-utils.js` (depends only on `config`, so no
    require cycle — `stealth` requires `follow`, so `follow` can't require `stealth`, but both
    require `room-utils`). `findPlayerById` now takes the maps as args (stateless).
  - **Unused shared exports wired:** `FOOD_COUNT` and `isFoodKey` in `shared/src/food.ts` had no
    callers. Rather than drop them (they mirror `quests.ts`'s `QUEST_COUNT` and `species.ts`'s
    `isPlayableSpecies` — the parity-invariant + validation surface of a shared lookup table),
    added `shared/test/food.test.mjs` (mirrors `quests.test.mjs`) that exercises them: 1:1
    species↔food coverage, unique keys (skunk ≠ mole), total/deterministic `foodForSpecies`,
    round-trip `foodByKey`, and `isFoodKey` membership. This also gives the new module the same
    test coverage as its siblings.
  - **False positive dismissed:** a dedup agent flagged `foodByKey` as an unused import in
    `phaser.ts`; it is used at the food `createView` tint lookup — no change.
  - Verified: shared 20/20 (was 15; +5 food tests), client build clean, server boots, the
    collect/feed/steal/score integration harness green, e2e wire check 4/4.

- 0.2.37: **Animal collection — Phase 5: client rendering + UI.** The feature becomes
  visible + playable. No `IRenderer`/shared signature change — new server fields ride the
  `Entity` index signature into `syncEntities`, and client-only derivations ride underscore
  fields stamped in `main.ts` (like `_local`).
  - **`client/src/render/phaser.ts`:** a `kind:'food'` `createView` case (a food-tinted
    6-point pip + label, Y-sorted, tint from the shared `foodByKey`). A **decaying follow
    ring** over a followed animal: a partial-sweep `Graphics` (new `EntityView.followRing`),
    redrawn each frame at the entity's interpolated position, with a green→amber→red colour
    ramp, a subtle pulse under 18%, and the local player's herd drawn brighter/thicker than
    rivals'. New `fireFx` cases for `collect`/`feed`/`steal` (gold sparkle / green confirm
    ring / contested burst+flash).
  - **`client/src/inventory.ts` (new):** a standalone toggle-`I` overlay listing collected
    food (`×count`) and which species each feeds, read from the local player's
    server-authoritative `inventory`; a cached signature so it rebuilds only on change.
  - **`client/src/main.ts`:** `f` → `feed` action key; `i` kept out of the movement key set;
    per-frame stamping of `_followFrac = (followUntilTick − latestTick)/(followUntilTick −
    followSince)` and `_followMine` (main owns `latestTick`; the renderer stays tick-blind);
    inventory refresh; press-confirmation + `fx`-edge SFX for collect/feed/steal; a `#cue`
    toast (`+1 food` / `following you!` / `stolen — following you!`) plus a herd-count-drop
    "a follower was stolen!" cue for the victim; and a `#win-sub` score subtitle ("+N pts ·
    herd of K (J stolen)") populated from `lastScore` on the escape edge.
  - **`client/src/help.ts`:** Stats tab gains Food collected / Animals stolen / Quests
    completed rows, plus an **escapes-by-species** breakdown (animated sprite + count per
    species, from the parsed JSON stat).
  - **`client/src/style.css`:** chrome for the inventory panel, the cue toast, the win
    subtitle, and the species breakdown.
  - **`scripts/e2e-follow.js` (new):** a wire regression check — all 14 food sources ride the
    snapshot with `foodKey`/`name`, and the server accepts the `feed` verb. PASS.
  - Verified: shared 15/15, client build clean; e2e wire check green; the collect/feed/
    accumulate/steal/score MECHANICS were proven by the Phase-3 server integration harness.

- 0.2.36: **Animal collection — Phase 4: stat persistence + DB migration.** The new
  counters now survive across sessions (`server/db.js`).
  - **Guarded in-place migration:** `init()` runs `ALTER TABLE stats ADD COLUMN` for
    `food_collected` / `animals_stolen` / `quests_completed` (INTEGER) and
    `escapes_by_species` (TEXT `'{}'`), swallowing the "duplicate column name" error so it
    is idempotent — an existing `escapeai.db` upgrades in place, a fresh one is unaffected.
  - **`DELTA_COLUMNS`** gains the three flat counters (the `col = col + @key` path).
    `escapesBySpecies` is deliberately NOT in it — a `+=` against a TEXT column is invalid
    SQL.
  - **`incStats`** splits into two: the flat additive UPDATE, plus a dedicated read-modify-write
    that MERGES the `{species:count}` delta into the JSON `escapes_by_species` column (so the
    by-species totals accumulate across escapes). The species merge runs even when no flat
    counter changed, and the common empty case touches nothing.
  - **`getStatsForUser`** returns the three new counters + the parsed `escapesBySpecies` map
    (corrupt/legacy JSON degrades to `{}` rather than throwing).
  - Verified on the live `escapeai.db`: the 7-column table migrates to 11 columns in place;
    a roundtrip persists food/stolen/quests, merges per-species escapes (ape 2+1=3, fox 1)
    while the flat `escapes` path still works; a second `init()` does not crash (idempotent);
    server boots clean.

- 0.2.35: **Animal collection — Phase 3: server mechanics (collect/feed/follow/steal/score).**
  The authoritative simulation for the whole loop.
  - **`server/game/follow.js` (new):** owns the rules (mirrors `quests.js`/`stealth.js`);
    engine + stealth call in. `collectNearbyFood` (interact-collect from a renewable food
    source → inventory + `foodCollected`), `feedNearbyAnimal` (consume liked food →
    `followerOf`/`followUntilTick`/`followSince`; accumulative + capped on a wild feed/top-up;
    a fresh-timer ownership transfer + `animalsStolen` on a steal), `stepFollowers` (per-tick
    collision-aware chase toward the owner via the shared integrator; release on expiry /
    owner-gone / owner-escaped), `scoreEscape` (SCORE_OWN + per-follower, stolen worth more;
    escaped-by-species for player + each follower; stamps `lastScore` + `scoreTotal`; releases
    the herd), `releaseFollower(sOf)`, `initPlayer`/`resetPlayer`. Gets the cached shared math
    via `setShared` (from `stealth.loadShared`) and the live maps via `setRefs` (from
    `engine.init`) — no second ESM import, no require cycle.
  - **`server/config.js`:** new `FOLLOW` block — `GRANT_SECS=15`, `CAP_SECS=60`, `SPEED=150`
    (above walk so a follower keeps up, below sprint so sprinting sheds it), `STOP_DIST=40`,
    `SCORE_OWN/FOLLOWER/STOLEN`.
  - **`server/game/stealth.js`:** `applyAction` 'interact' does a food-first early-return
    (collect), then the unchanged terminal/order/`activate`-quest path; new dedicated 'feed'
    case. `checkEscape` calls `follow.scoreEscape` on the escape edge. `stepIdleAnimals` skips
    active followers (no double-move). `catchPlayer`/`respawnPlayer` clear inventory + release
    the herd (a catch is the sting; `scoreTotal` survives respawn).
  - **`server/game/engine.js`:** `init` wires `follow.setRefs`; `stepNpcs` run-order is now
    pruneExpired → stepIdleAnimals (skips followers) → **stepFollowers** → stepRobots →
    stepPanic (a hard requirement so followers move once and robots perceive them in-position).
  - **`server/socket/lobby.js`:** `ACTIONS += 'feed'`; join object seeds `inventory:{}` /
    `scoreTotal:0` / `lastScore:null` + `follow.initPlayer`.
  - **`server/socket/connection.js`:** disconnect releases the player's followers (no ghost
    chase) before the room teardown.
  - Verified: an integration harness drives collect → feed → accumulate(+capped) → steal
    (ownership + fresh timer + theft stat) → gate score (220 = own 100 + stolen 120;
    escapes-by-species credits both species; herd released) → isFollower/release — all green.
    A 10-client live sim holds 20 Hz, max-entity 64 (the 14 food entities included), ~1 ms RTT,
    no server errors.

- 0.2.34: **Animal collection — Phase 2: deterministic food placement.** The world now
  contains one collectable food source per species, so every food is findable and
  reachable.
  - **`shared/src/world.ts`:** `WORLD_GEN_VERSION` 4 → 5. A new `WorldEntitySpec` kind
    `'foodSource'` (id `food-<species>`, `meta.foodKey` from the shared food table) is
    emitted per species at a FIXED position in the per-species loop (penAnchor → foodSource
    → questObject), co-located with the quest object on its already-proven-reachable home
    tile — so **no new reachability target** is needed. The on-map `TROUGH_FOOD` marker is
    stamped in a separate pass AFTER the reachability carve (so a corridor carve can't erase
    it) and the cell is forced non-solid (a feeder must be able to stand on it).
  - **`shared/test/world.test.mjs`:** re-pinned `PINNED_ENTITYSPEC_HASH` (901741202 →
    198123412) for the 14 new specs; the **collision hash is unchanged** (food tiles
    co-locate with the already-non-solid quest tiles). Added a `foodSource` coverage test
    (exactly one per species, each with a `foodKey`) and extended both reachability tests to
    assert every food source is reachable across all seeds. 15/15 green.
  - **`server/game/world.js`:** loads `foodForSpecies` from `shared/dist/food.js` in
    `loadSharedWorld` (alongside the quest model); `spawnFromMap` learns the `'foodSource'`
    kind → a `{kind:'food', species, foodKey, name}` entity; exposes a `foodForSpecies`
    accessor for the follow module. Verified: 14 food entities spawn, all with a foodKey,
    all on walkable tiles.

- 0.2.33: **Animal collection — Phase 1: contract foundation.** First commit of the
  food / inventory / follow / steal / score feature: the frozen cross-side contract,
  before any behavior. Four parallel subsystem designs were reconciled by an adversarial
  integration critic; this lands the names everything downstream is built against.
  - **`shared/src/food.ts` (new):** the ONE source of truth for per-species liked food —
    14 foods, one per species, each liked by exactly one species, species-appropriate by
    common knowledge (ape→banana, elephant→peanuts, tortoise→lettuce, fox→grapes, …).
    Mirrors `quests.ts`/`species.ts` purity: a fixed literal table + `foodForSpecies`
    (TOTAL, never undefined), `foodByKey`, `isFoodKey`, `FOODS`/`FOOD_KEYS`/`FOOD_COUNT`.
    Exported from the shared barrel.
  - **`shared/src/types.ts`:** `EntityKind += 'food'`; `FxKind += 'collect'|'feed'|'steal'`;
    new optional `Entity` fields — `foodKey`, `followerOf`, `followUntilTick`, `followSince`,
    `stolen`, `inventory`, `lastScore{points,herd,stolen,tick}`, `scoreTotal`.
  - **`shared/src/net.ts`:** `PlayerAction += 'feed'` (a dedicated verb, not overloaded on
    `interact`, so it never collides with the terminal/`activate`-quest path); `UserStats +=
    foodCollected, animalsStolen, questsCompleted, escapesBySpecies?`.
  - **`server/game/stats-delta.js` (new):** the single owner of the per-player stat-delta
    shape + `bumpStat`/`bumpEscapedSpecies`/`hasAny`/`reset`. The zero-shape was previously
    hardcoded in three places (stealth `bumpStat`, engine `anyNonZero`/`flushStatsDelta`);
    centralizing it means a new counter is added once and never silently fails to persist.
    `stealth.js`, `quests.js` and `engine.js` migrated onto it (no require cycle — the module
    depends on nothing).
  - **`server/game/engine.js`:** `toEntity` now forwards `inventory` (unconditionally, even
    when empty, so a cleared bag clears the client overlay), `lastScore` (while escaped) and
    `scoreTotal` — without this, none of the later client UI could ever receive data. The
    flush path uses `stats-delta.hasAny`/`reset`.
  - **`server/game/quests.js`:** bumps `questsCompleted` at each of the three `markComplete`
    callers (reach/activate/fetch), on the completion edge.
  - **`server/socket/connection.js`:** the disconnect flush spreads the full accumulator (all
    new counters + the by-species map) instead of hand-listing four keys.
  - No behavior yet — food sources, feeding, following, stealing, scoring, the inventory UI
    and DB columns land in later phases. Verified: shared builds + 14/14 tests green; server
    boots, ticks at 20Hz, `/health` ok.
- 0.2.42: **Map overhaul validation remediation (post-`/plan-validation-and-review`).** The
  validation pass (requirements trace, connectivity audit, dedup scan, three-group code review,
  build/test) found the overhaul complete and connected — every requirement implemented, zero
  dead/duplicate code, determinism clean. It surfaced two defensive gaps, both fixed here (neither
  changes generator output, so the pinned hashes / `WORLD_GEN_VERSION` are untouched):
  - **Fail loud on home-placement failure (`shared/src/world.ts`):** if `findFreeRect` ever
    exhausted all fallbacks, the loop `continue`d and silently dropped a species — breaking the
    one-home-per-species invariant the parity test relies on. It now throws (mirroring the
    reachability-non-convergence throw), so the invariant is enforced, not assumed. Unreachable at
    128² with 14 homes ≤ 11×10, but no longer silent.
  - **Clamp containment bounds (`server/game/world.js`):** `getHomeBoundsBySpecies` now clamps
    `maxX/maxY ≥ minX/minY` so a degenerate home rect could never hand `wanderStep` an inverted
    bound (which would freeze an animal). World-gen already guarantees rw/rh ≥ 8, so this is
    belt-and-suspenders.
  - One out-of-scope, pre-existing finding (the spawn fallback can add a still-solid tile that the
    reachability carve then rescues) logged to `FINDINGS_OUTSIDE_SCOPE.md` — not fixed here.
  - Verified: shared 20/20, client build, server boot, and a 2000-tick 42-animal containment sim
    (0 escaped, 0 frozen, 0 inverted bounds) all green.

- 0.2.41: **Map overhaul Phase C — per-enclosure NPC animals + containment.** Every enclosure is
  now inhabited by 2–3 wandering NPC animals of its species, kept inside their pen.
  `WORLD_GEN_VERSION` 6 → 7; hashes re-pinned. The wire shape of an animal is byte-identical to
  before (verified) — containment data lives server-side, never on the entity.
  - **`shared/src/world.ts` — `populateEnclosure`/`animalCountFor`:** each home gets
    `animalCountFor = clampInt(2 + floor(interiorArea/24), 2, 3)` animals. The canonical
    `pen-${species}` anchor (home center) is animal 1; `populateEnclosure` shuffles the home's
    non-solid interior tiles ONCE (one rng draw-set per home, in roster order → stream stays
    fixed) and emits the remaining animals as extra `pen-${species}-2..N` penAnchors. They
    reuse the existing `penAnchor` kind, so `spawnFromMap` materializes them with **no new spec
    kind or server case**, and the coverage test (which counts homes/quests, never penAnchors)
    stays green at exactly one home + one quest per species.
  - **`server/game/world.js` — `getHomeBoundsBySpecies`:** derives each species' enclosure
    interior rect (world units, inset one tile inside the barrier ring) from the map's
    housing/buildings. The gatehouse (species == null) is skipped.
  - **`server/game/stealth.js` — containment in `stepIdleAnimals`:** a pen animal
    (`pen-${species}` / `pen-${species}-n`) now wanders ONLY within its enclosure interior rect
    (passed as the `shared.wanderStep` bounds), so the clamp turns it inward at the pen edge and
    it can never drift out the 2-tile non-solid gate. Bounds live in a per-room server-side cache
    keyed by id — **NOT a field on the entity** (the engine `JSON.stringify`s the whole world
    entity onto the wire, so a `homeRect` field would leak). The fox lure (`decoy-N`, no `pen-`
    id) and any future free animal fall back to whole-map bounds and roam, unchanged.
  - **Verified:** a 2000-tick (~100s) simulation — 42 animals, **0 escaped their pen, 0 frozen**,
    and the animal wire payload is byte-identical to a v4 animal (no containment field leaked).
  - **Tests:** new `world.test.mjs` invariants — 2–3 animals per species; every penAnchor on a
    non-solid tile strictly inside its home interior (off the gate ring → no leak); every home
    interior ≥6×6 (so the wander bias can't collapse and freeze an animal). 20/20 green; shared
    build, server boot, client build all green.

- 0.2.40: **Map overhaul Phase B — entrance gatehouse plaza + tile-style accuracy
  (`shared/src/world.ts`).** The bare 1-tile east gate becomes a believable main entrance, and
  the long-unused blend tiles feather every grass↔path / grass↔water seam. `WORLD_GEN_VERSION`
  5 → 6; hashes re-pinned. Reuse-only — no new tiles, no renderer change.
  - **Gatehouse plaza (`stampEntrancePlaza`, replaces `stampPerimeter`):** a roofed gatehouse
    hall (a species-less `Building`, so the renderer's fade-on-enter roof reads as walking
    through the entrance and the coverage test still counts exactly one home per species) over a
    cobble forecourt, framed with a sign arrow, banner, lamp posts, a bench, a bin and planting.
    The perimeter wall is opened at **exactly one tile** — the single escape gate
    (`gate = tileCenter(w-1, gateTy)`, byte-stable for `checkEscape`) — so the chokepoint the
    game relies on is preserved. The plaza owns the east band and hands the layout its forecourt
    spine anchor + a reserved rect, so the organic zones stay clear of the entrance.
  - **Autotiled edges (`blendGroundEdges`/`classOf`/`pickBlendTile`):** a pure, row-major,
    8-neighbour pass that rewrites a grass cell bordering a path/water region into the matching
    `PATH_EDGE_*`/`WATER_EDGE_*` blend tile (25–48) — feathering the seams that used to be hard
    edges. Path wins over water on a shoreline-path cell; ambiguous slivers (region on opposite
    sides) stay base grass. All blend tiles are non-solid and solid water/walls are never
    rewritten, so **collision is unchanged** (no rebuild). Runs after the reachability carve so
    fallback corridors blend too.
  - **Tests:** new `world.test.mjs` invariants — the gatehouse exists, is species-less, and has a
    reachable non-solid door; and every single-edge/outer-corner grass border was blended (proving
    the pass total over its claimed cases + idempotent). 17/17 green.

- 0.2.39: **Map overhaul Phase A — organic layout + biome zones + water feature
  (`shared/src/world.ts`).** The rigid 3×3 PAVED avenue grid and uniform rectangular plots
  are replaced by an organic, real-zoo layout while keeping the generator pure + deterministic
  and every reach target reachable. `WORLD_GEN_VERSION` 4 → 5; hashes re-pinned.
  - **Biome zones (`partitionZones`):** the interior west of a reserved entrance band is split
    into five themed zones (savanna / aviary / forest / wetland / rockyDen) via a fixed-topology,
    jittered BSP — stable themes, per-seed shapes. `SPECIES_ZONE` assigns each species to a
    sensible zone (pond→wetland, dens→forest/rocky, fliers→aviary, grazers/runners→savanna),
    consistent with `SPECIES_HOUSING`, so homes cluster by biome.
  - **Organic enclosures (`findFreeRect`/`claimPlot`):** one irregular home per species placed by
    a deterministic free-rect scan inside its zone, with jittered footprints. Minimum interior is
    pinned to ≥6×6 tiles so Phase C's animal-containment wander bias can't collapse and freeze
    animals in a tiny box.
  - **Water feature (`carveRiver`/`bridgeRiverCrossings`):** a meandering river runs down the
    wetland zone (integer Bresenham + ±1 jitter — **no trig**, which isn't bit-stable across the
    browser and server V8s) with a shallow walkable shore and a solid deep core. Paths route
    around the bed and bridge it only where they meet both banks; an invariant + test keep every
    reach target off/away from deep water so the reachability backstop never paves across the river.
  - **Winding paths (`carveOrganicPaths`/`carveWindingPath`):** a jittered spine loop visits the
    forecourt + every zone center, with a spur from each home to the spine, so the zoo reads as
    curving avenues instead of a grid. The pass returns path **junctions** that now anchor the
    terminals + robot spawns (the old placement read the deleted avenue lines — rewritten in the
    same change so the build never breaks between phases).
  - **Determinism discipline:** every branching helper draws its rng unconditionally per iteration
    and all iteration order is fixed, so `generateWorld(seed)` stays byte-identical client↔server.
  - **Tests:** new `world.test.mjs` invariant "no reach target on/adjacent to deep water" across
    8 seeds; reachability + determinism + one-home/one-quest-per-species all still green (15/15).
    No new tiles, no renderer change (blend tiles 25–48 already render via `TILE_BY_INDEX`).

- 0.2.32: **Plan-validation remediation (post-`/plan-validation-and-review`).** The validation
  pass (requirements trace, connectivity audit, dedup scan, three-group code review, build/test)
  found the tilemap work complete and connected; it surfaced three fixable items, all fixed here:
  - **Dead code removed:** `applyInput` in `shared/src/step.ts` was superseded by
    `moveWithCollision` everywhere (the connectivity audit confirmed zero callers). Removed it
    and the now-unused `Input` import; refreshed the stale `applyInput` references in the
    `main.ts` data-flow comment and the `WORLD`/`moveWithCollision` doc comments. `WORLD`/`Bounds`
    stay — still the default clamp for the ambient `wanderStep`.
  - **Y-sort depth precision:** the per-frame adornment depths (`label`/`ring`/`halo`) used
    sub-unit offsets (±0.1/0.3) against a body depth that ranges up to ~4096 (world Y); at large
    Y those collapse under float precision and z-fight. Bumped to whole-unit offsets (±1/2).
  - **Ambient wander bounds:** patrolling robots + drifting decoys called `wanderStep` with the
    shared default `WORLD` (1000²) instead of the real map (4096²), so their inward-edge bias
    fired at a phantom line (the collision grid still stopped them at the true wall, so this was
    correctness-tidiness, not a break). They now pass the room's real bounds via a `mapBounds(rm)`
    helper.
  - No new out-of-scope findings. Verified: shared 14/14, client build, server boot, and a
    10-client `sim-clients` run all green.

- 0.2.31: **Procedural tile-sheet art + camera-follow fix (Phase 7).** The flat-color
  placeholder tiles are replaced by real generated art, and a camera bug is fixed.
  - **`scripts/tiles/` (new) — the tile-art pipeline, mirroring `scripts/sprites/`:** a
    `contract.js` that mirrors the canonical `shared/src/tiles.ts` registry, a `tilepalette.js`
    (3-tone material families), `template-tile.js` (full-bleed `fillCell`, top-lit bands,
    name-seeded LCG scatter for byte-stable variety), and seven builder modules drawing all
    144 tiles (terrain, grass↔path / land↔water edge sets, nature incl. tree trunk/canopy,
    walls/roofs/doors, fences/cages, zoo housing, props). New scripts `gen-tiles.js` (zero-dep
    SVG), `build-tileset.js` (sharp → packed PNG), `verify-tileset.js` (zero-dep gate). Packed
    **16-col / 32px / slot-index === tile-index** so it's a DROP-IN for the renderer's existing
    flat-color layout. `verify-tileset` is the cross-language drift gate: it asserts
    `contract.js` matches `shared/src/tiles.ts` (names+indices+flags+order) and the PNG packing.
  - **Committed `assets/tiles/tileset.{png,json}`** (512×320, 33 KB) so a clean clone boots on
    the art with no codegen and no sharp; `assets/tiles/svg/` (the intermediate) is gitignored,
    mirroring `assets/sprites/frames/`. `scripts/package.json` gains `gen-tiles`/`build-tileset`/
    `verify-tileset`/`tiles`.
  - **Renderer (`client/src/render/phaser.ts`):** `preload()` loads `./tiles/tileset.png`;
    `buildWorld()` uses the real art when present, else the unchanged flat-color fallback
    (identical 16-col/32px/index-slot math, so canopy frames + `addTilesetImage` work either
    way). Zero-art boot preserved.
  - **Camera-follow fix:** the camera latched onto the local player's body ONCE, but that body is
    destroyed and rebuilt when the seeded `{id,x,y}` view gains `kind:'animal'` on the first
    snapshot — so the camera kept following a dead object and froze. It now re-points at the live
    body whenever it changes (`followTarget`), and `centerOn`s the player when follow (re)starts.
  - **Spawn set back from the gate (`shared/src/world.ts`):** players spawned ~80px from the east
    wall, inside the camera's edge-clamp zone, so the view looked pinned at spawn. Spawns now sit
    ~20 tiles (≈640px, half a viewport) west of the gate via a robust block scan (≥1 guaranteed),
    so the camera frames the avatar on join. `WORLD_GEN_VERSION` 3→4; entitySpec hash re-pinned
    (collision hash unchanged).
  - Verified by headless Chrome: real tile art renders (textured grass/paths/water/roofs), the
    player is centered at spawn AND the world scrolls as it moves (camera follows). `verify-tileset`
    + shared 14/14 + client build all green.

- 0.2.30: **Per-species side-quests: the gate now gates (Phase 6).** Each of the 14
  playable species must finish a short side-quest before the perimeter gate will let it
  out. Three mechanics, themed per species so the flavor varies while the server logic
  stays small.
  - **`shared/src/quests.ts` (new, pure + deterministic):** `QuestDef`, `QuestType`
    (`reach`/`fetch`/`activate`), `questForSpecies(species)` (a pure lookup), and the
    `QUEST_BY_SPECIES` table with an ability-themed title+blurb for all 14. Assignment:
    **ape = fetch** (courier the Clipboard to the gate, need 1); **elephant/peacock/parrot
    = activate** (tap 3 distinct keeper terminals); the other **ten = reach** (return to
    your own enclosure/home, need 1). Added to the `shared` barrel; `Entity` gains a typed
    optional `quest: QuestProgress` + `questBlocked` in `shared/src/types.ts` so the
    progress rides the snapshot.
  - **`server/game/quests.js` (new):** per-player progress (`player.quest =
    {type,title,blurb,done,need,complete}`) consuming the shared defs via
    `world.questForSpecies`. `initPlayer` (join + respawn), `stepReach` (per-tick distance
    to the species' own questObject), `onInteract` (counts distinct terminals for
    `activate`), `stepFetchAtGate` (ape completes at the gate while carrying). The shared
    quest model is loaded once in `server/game/world.js`'s `loadSharedWorld` and exposed as
    `world.questForSpecies`.
  - **Gate gating (`server/game/stealth.js`):** `checkEscape` now refuses the escape unless
    `player.quest.complete` — it stamps a transient `player.questBlocked` tick instead, so
    the client can hint. The ape's fetch completes the same tick it reaches the gate, so the
    courier escapes immediately. `respawnPlayer` re-initializes the quest for the NEW
    species. `applyAction`'s interact branch advances `activate` quests.
  - **Wiring (`server/game/engine.js`, `server/socket/lobby.js`):** the engine runs the
    per-tick `reach` advance before `checkEscape` and forwards `player.quest`/`questBlocked`
    in `toEntity`; lobby initializes the quest on join.
  - **Client (`client/src/main.ts`, `help.ts`, `style.css`):** a new HUD **quest** row shows
    the title + `done/need` + a ✓ when complete, flashes "finish your quest to escape!" when
    you brush the gate without finishing (tracked via the snapshot tick), and tints
    green/amber. The help widget's Goal blurb now explains the per-species quest gate.
  - **Tests:** `shared/test/quests.test.mjs` (new, zero-dep) pins the model — coverage,
    mechanic distribution, short titles, and `questForSpecies` purity. `npm test` is green
    (14 tests: 10 existing + 4 new).

- 0.2.29: **The world is on screen: tilemap rendering, camera-follow, Y-sort, roof-fade
  (Phase 5).** The client now draws the generated zoo instead of a dark void — verified with
  headless-Chrome screenshots end-to-end.
  - **`IRenderer` gains `setMap(map: WorldMap)`** (`shared/src/renderer.ts`) — a plain shared
    data type, no Phaser types, so a Babylon impl can build ground meshes from the same arrays.
    Docs updated in lockstep (`ARCHITECTURE.md`, `shared/BABYLON_FALLBACK.md`).
  - **`client/src/render/phaser.ts`:** `setMap` builds the tilemap from the `WorldMap` grids —
    a flat-color tileset TEXTURE generated at runtime (Phase 7 swaps in the real art PNG with
    no logic change), three culled `TilemapLayer`s (ground / solid-deco / —), per-building
    **roof rectangles**, and **camera bounds + follow** on the local player. **Y-sort**: mobile
    entities + quest objects take depth = their world Y; tree canopies spawn as individual
    images at depth = the trunk-base Y, so you walk *behind* a canopy and *in front of* its
    trunk. **Roof fade**: each frame, if the local player's position is inside a building
    footprint, that roof tweens to alpha 0 (revealing floor/walls/windows/quest marker) and
    back on exit — keyed purely on player-in-bounds. New `questObject` view (a Y-sorted star).
  - **`client/src/net/client.ts`:** `onMap` handler for the `map` event.
    **`client/src/main.ts`:** regenerates the `WorldMap` from the seed (asserting
    `WORLD_GEN_VERSION`), hands it to the renderer, and switches client prediction to the shared
    **`moveWithCollision`** against the same grid — so prediction stops at walls exactly where
    the server does (no rubber-band). `PREDICTION_BOUNDS`/`applyInput` prediction retired.
  - **Door/gate width fix (`shared/src/world.ts`):** 1-tile (32px) openings left only ~6px
    clearance for the player's collision AABB — effectively impassable. Doors and enclosure
    gates are now **2 tiles (64px)** wide so buildings/enclosures are genuinely enterable.
    `WORLD_GEN_VERSION` 2→3; the parity test's collision hash re-pinned (entitySpecs unchanged).
  - Verified by headless Chrome: tilemap (grass/paths/gate) renders, camera follows across the
    4096² world, collision blocks walls, **entering a building fades its roof to reveal the
    interior + quest marker**, trees render as canopy/trunk pairs that Y-sort. No console errors;
    shared 10/10; client build green.

- 0.2.28: **Server runs on the generated world: map-derived entities, real collision,
  seed-on-join (Phase 4).** The hardcoded starter layout is gone — the authoritative server
  now generates each room's world from a per-room seed and plays on it.
  - **`server/game/world.js`:** dynamic-loads `shared/dist/world.js`+`rng.js` (mirrors the
    stealth loader, awaited in `engine.init`), seeds each room with `seedFromString(roomName)`,
    and **`spawnFromMap(map)`** replaces `spawnStarterLayout` — it materializes `entitySpecs`
    into entities (gate, terminals, the Clipboard prop, 6 robots, 14 per-species decoy animals
    in their enclosures, 14 quest objects with `meta`). New accessors `getRoomMap`
    (collision+dims+tile+spawns), `getMapMeta` (the map-event payload), `isSolidAtRoom`.
  - **Collision is enforced authoritatively.** `engine.integratePlayers` moves players via a new
    `stealth.movePlayerWithCollision` (the shared axis-separated `moveWithCollision` against the
    room's grid, radius `RECT_SIZE*0.4`). Robots pursue/patrol and idle decoys are collision-aware
    too — they hold at walls/fences instead of tunnelling (still honoring the Third-Law hazard
    check). Mole/kangaroo teleports cancel if the destination tile is solid. Catch/respawn now
    return players to the map's spawn point, not the old (50,50).
  - **`server/socket/lobby.js`:** spawns players from `map.spawns[...]` and `emit('map', …)` to the
    joining socket (seed-only). **`server/config.js`:** `WORLD_MAX` default 1000→4096 (= MAP_W·TILE).
    **`shared/src/types.ts`:** `EntityKind += 'questObject'`.
  - Verified independently: server boots clean; a headless socket client gets `map
    {seed, version:2, tile:32, w:128, h:128}` + a steady snapshot stream; a player driven hard
    into a corner is blocked by collision (ends mid-map, never at the origin); `sim-clients` runs
    clean; shared 10/10 tests still pass. No dead code (old spawn constants removed).

- 0.2.27: **Collision-aware movement + the `map` net event (Phases 2 & 3).** The two pieces
  that let the tilemap world actually block movement and reach the client.
  - **`shared/src/step.ts` — `moveWithCollision(entity, dx, dy, dt, speed, collision, w, h,
    tile, radius)`.** Axis-separated sliding collision against a solidity grid: try X (reject if
    the entity's AABB hits a solid tile, else commit), then Y independently — so pushing into a
    wall diagonally keeps the clear axis (you slide). Out-of-bounds is solid, so the world edge
    is a wall and positions are implicitly clamped (you leave only via the gate). Pure +
    deterministic, kept dependency-free (no world.ts import → no cycle), so server authority and
    client prediction integrate identically. `applyInput` stays for now (removed in cleanup once
    nothing imports it).
  - **`shared/src/net.ts` — `SERVER_EVENTS.MAP='map'` + `MapMsg {seed, version, tile, w, h}`.**
    Seed-only map transfer: the server sends just the seed (a few bytes); the client regenerates
    the identical `WorldMap` via `generateWorld`. The 16k-tile map never rides the per-tick
    snapshot. Added to `ServerToClientEvents`.
  - **New `shared/test/collision.test.mjs`**: stops-at-wall-face, slides-along-wall,
    can't-leave-the-world (against a real `generateWorld` map), and free-movement-equals-speed*dt.
    `shared` test script now globs `test/*.test.mjs` (10/10 pass). `client` build green.

- 0.2.26: **Full deterministic zoo generator (Phase 1).** `generateWorld(seed)` in
  `shared/src/world.ts` is now the real plot/zone layout (was a placeholder grass field):
  a grass field inside a walled perimeter with one escape gate, a PAVED avenue skeleton that
  partitions the interior into plots, **one home per species** drawn from a fixed
  species→housing table (3 enterable buildings: ape/chameleon/owl; 11 open enclosures —
  aviary/cage/paddock/den/pond/pen), enterable buildings (wall ring + floor + door + fading
  roof + interior props), per-kind housing (pond = solid deep-water core ringed by walkable
  shore; den = rocky cluster with a walkable mound; cage/aviary/paddock/pen = barrier ring +
  walkable gate), scattered nature (trees as canopy+solid-trunk pairs, bushes, rocks, flowers
  with min-spacing, never on roads/homes/spawns), and the gameplay `entitySpecs` (gate, the
  Clipboard prop, terminals, robot spawns, and a decoy anchor + quest object per species).
  - **Reachability is guaranteed:** after stamping, a deterministic flood-fill from spawn
    carves L-shaped corridors until the gate, every door, every enclosure center, every spawn,
    and every quest object are walkable — or throws (loud failure beats a silent unwinnable map).
  - **Pure + seeded** (single `mulberry32` stream, fixed iteration order) → byte-identical on
    server and client. `WORLD_GEN_VERSION` bumped 1→2 (output changed).
  - **New `shared/test/world.test.mjs`** (zero deps, Node's runner over `dist`) is the
    client/server PARITY tripwire: pins a `hash32` of the collision grid + entitySpecs (drift
    trips the test), asserts every species has exactly one home + one quest with no strays,
    that gate/spawns are non-solid, and re-runs an INDEPENDENT flood-fill to prove
    reachability for the pinned seed and across 7 seeds. `shared` gains a `test` script
    (`npm run build && node --test`). Counts (any seed): 3 buildings, 11 housing, 14 quests,
    14 pen anchors, ~6.5% solid. Verified: `shared` build + `npm test` (6/6) + `client` build green.

- 0.2.25: **Tile-map world foundations (Phase 0 of the big-world plan).** Lays the shared,
  deterministic groundwork for a large procedurally-generated zoo — no behavior change yet,
  nothing consumes it on the hot path. Three new shared modules, all pure + seeded (same
  determinism rules as `step.ts`, so client and server will generate bit-identical maps):
  - **`shared/src/rng.ts`** — a `mulberry32` PRNG built on the existing FNV-1a `hash32`, plus
    `seedFromString`, `randInt`, `pick`, `shuffle`. The random source for world-gen.
  - **`shared/src/tiles.ts`** — the canonical TILE-IDENTITY CONTRACT: a 144-tile registry
    (terrain, grass↔path / land↔water edge sets, nature incl. tree trunk/canopy, walls/roofs/
    doors, fences, zoo housing, props) mapping each semantic name → stable index + `{layer,
    solid, ysort}`. Index 0 = empty; indices contiguous + append-only. The one source the
    world-gen, the renderer, and the (Phase 7) tile-art generator agree on.
  - **`shared/src/world.ts`** — the `WorldMap` types (ground/deco/roof `TileGrid`s, `collision`
    `Uint8Array`, `Building`/`Housing`/`WorldEntitySpec`), helpers (`tileSolid` with
    out-of-bounds-is-solid, `isSolidAt`, `worldToTile`, `buildCollision`), `WORLD_GEN_VERSION=1`,
    `MAP_W=MAP_H=128` (4096×4096 units, 16× the old 1000²), and a SIMPLE seeded `generateWorld`
    (grass field + solid border wall + an east-edge gate gap + spawns). Phase 1 expands the
    generator body into the full plot/zone layout without changing these types.
  - Wired into `shared/src/index.ts`. Verified: `shared` + `client` build clean; server boots;
    `generateWorld` is deterministic (seed 123 twice → identical collision grid).

- 0.2.24: **Rebrand "AI Escape" → "Escape AI" + new choreographed splash.** The premise
  reads better as *Escape AI*: an AI-run zoo, and the animals trick the AI to escape it. The
  title now appears everywhere as **Escape AI** — browser tab (`client/index.html`), Android
  app name (`capacitor.config.ts`), and the in-game HUD (`main.ts`, "ESCAPE AI").
  - **Splash reveal is now a timed, eerie sequence** (`menu.ts` + `style.css`). The screen opens
    *empty*. "ESCAPE" fades in slowly (cold cyan, serene); ~1.5s later "AI" pops in — flickering
    and shaking with a red/cyan chromatic-aberration glitch, then snaps solid (the menace). The
    tagline fades in next, then "PRESS ANY KEY TO CONTINUE" fades in and hums as before. The
    title splits into two independently-animated `<span>`s; all timing lives in CSS
    `animation-delay`s, so `menu.ts` stays choreography-free.
  - **New tagline:** "The zoo is under new management." (was "The zoo is run by robots…").
  - **Storage/DB keys renamed for brand consistency.** Client localStorage key
    `aiescape.auth` → `escapeai.auth` (existing saved sessions are dropped — players re-enter
    their name once). Default server DB path `./data/aiescape.db` → `./data/escapeai.db`
    (`config.js`, `db.js`, `server/.env.example`). **Deployers with an existing
    `data/aiescape.db` must rename it (or set `DB_PATH`) to keep accounts/stats.**
  - Verified: `tsc` + `vite build` clean; dist contains "Escape AI", the two-word title, and
    the new tagline; no `aiescape`/"AI Escape" references remain in source.

- 0.2.23: **Fix — escaping was a dead end: "ESCAPED!" banner never cleared and the player
  never respawned.** The `escaped` flag was permanently sticky server-side — once you reached
  the gate the avatar left the field for good (robots ignore it, it can't be caught), the client
  showed the win banner once and never removed it, and there was no respawn. Escape is now a
  round-based loop:
  - **Server** (`game/stealth.js` `checkEscape`, now passed `currentTick`): reaching the gate sets
    `escaped` and stamps an `escapeUntilTick` deadline (`ESCAPE_CELEBRATION_SECS`, default 4s).
    Once the window elapses, `respawnPlayer()` puts the player back at the spawn origin as a NEW
    species (next in the shared roster), with disguise + ability timers wiped and `escaped` cleared.
    The escape stat still counts exactly once per run.
  - **Client** (`main.ts`): the win banner now tracks both edges of `escaped` — shown on
    false→true (with the win SFX), and **cleared** on true→false (respawn), then re-armed for the
    next escape, instead of latching forever.
  - `config.js` + `.env.example` gain `ESCAPE_CELEBRATION_SECS`. Verified end-to-end: a client
    driven to the gate flips escaped=true, then after the window respawns (escaped=false, species
    ape→bird, position back to 50,50).

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

- 0.2.0: Rules dropped; committed to the game design. **Escape AI** — a
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
