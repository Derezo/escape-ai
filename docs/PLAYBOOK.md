# TINS 2026 — Hour-0 Playbook

> The Rule-O-Matic rules drop at the start of the 72h jam. This kit exists so you
> write **gameplay**, not boilerplate. This playbook is the map from each rule
> category to the exact lever in THIS stack, plus a literal first-90-minutes
> checklist. Read the top of `ARCHITECTURE.md` first if you haven't.

Stack recap: Vite + TS + **Phaser 3** client (Babylon 3D fallback behind
`IRenderer`), Node + **Socket.IO** authoritative server (20 Hz tick), a `shared/`
TS module of types + deterministic `step()`, deploy to **mittonvillage.com** VPS.

---

## 1. Rule-O-Matic category → how to satisfy it with this stack

| Category | Lever in this kit | Concrete first move |
|---|---|---|
| **GENRE** | Genre only forces a **renderer choice**, not an architecture change. 2D → keep `PhaserRenderer` (`client/src/render/phaser.ts`). 3D → swap to `BabylonRenderer` (`client/src/render/babylon.ts`) behind the same `IRenderer`. Entities stay plain `{id,x,y,...}`. | Decide 2D vs 3D in the first 10 min. If 3D, jump to §4 immediately (it's the only swap with real install cost). |
| **GAMEPLAY** | Gameplay lives in `shared/src` deterministic `step(world, inputs, dt)` so client prediction and server authority agree. Bolt new fields onto `Entity` via its index signature (`hp`, `team`, `z`, ...) — no type-file surgery. | Add the rule's verbs to `Input` (`shared/src/types.ts`) and the rule's state to the `step()` reducer. Both client and server import it — single source of truth. |
| **GRAPHICS / ART** | `node scripts/gen-placeholder-sprites.js` emits labelled SVG placeholders to `assets/sprites/`. Phaser loads SVG via `this.load.svg(key, url, {width,height})`. Swap art by dropping files with the same names. **Palette constraint** rules: pass every sprite through a fixed palette in a Phaser pipeline/postFX, or just author the SVG `fill`s from the mandated palette in the generator's `SPRITES` table. **"Must include this provided image"**: drop it in `assets/`, `this.load.image('required', ...)`, render it in the help scene + somewhere on the play field. | Edit `SPRITES` in `scripts/gen-placeholder-sprites.js` to the genre's entities, rerun with `--force`. If a rule rewards raster pixel-art, `npm i sharp` and rasterise the SVGs (Modia's `scripts/tiles` is the reference pipeline). |
| **TECHNICAL** | **Multiplayer is already wired** (authoritative server + delta snapshots + ack-based reconciliation — see `shared/src/net.ts`). **Procedural generation** rule → add a **seeded RNG** in `shared/` (mulberry32/xorshift, ~10 lines) and seed both client & server identically so worlds match deterministically. **Physics/pathfinding/etc.** → put the deterministic math in `shared/step()` so it can't desync. | Name which technical feature the rule wants, decide if it belongs in `shared/` (must be deterministic / both-sides) or client-only (visual). Default: `shared/`. |
| **SOUND / MUSIC** | `node scripts/gen-placeholder-sfx.js` synthesises 7 WAV blips (`blip, select, confirm, pickup, hit, error, jump`) to `assets/sfx/` — zero deps, no API key. Covers **"sound on every action"** instantly: load with Phaser audio and `.play()` from each input/entity/UI event. The catalogue keys map to common actions on purpose. | In the Phaser scene, `this.load.audio('hit', 'assets/sfx/hit.wav')` for each, then fire on the matching event. If the rule rewards real music, install ElevenLabs/Suno (Modia's `scripts/audio/*`) at hour 0 — otherwise loop a synthesised pad. |
| **STORY** | Add an **HTML overlay / Phaser scene** as a manual/intro. The cheapest win is an `index.html` overlay `<div>` that doubles as the **in-game help/manual** (a recurring TINS requirement — see §3). | Create a `HelpScene` (or a toggled overlay div) with the premise + controls + the mandated image. Wire a `?`/`H` key to toggle it. |
| **BONUS** | Bonus rules are usually small, weird, additive (a hidden feature, an easter egg, a constraint). They rarely touch architecture. | Reserve the **hidden/secret feature slot** (§3) for any "secret"-flavoured bonus; otherwise satisfy in the relevant category's lever above. |

---

## 2. First 90 minutes — literal checklist

Run top-to-bottom. Don't optimise; get a synced entity on two screens with sound
and the rules' nouns wired, then iterate.

**0–10 min — read rules, decide shape**
- [ ] Write each drawn rule into `docs/` (one line each) so they're not lost.
- [ ] Decide **2D or 3D** → which `IRenderer` impl. (3D = do §4 now.)
- [ ] Decide what the single synced `Entity` represents in this genre.

**10–30 min — dependencies + assets (parallelisable)**
- [ ] `cd server && npm install` ; `cd client && npm install` (clean-clone check, see §3).
- [ ] Only now install rule-driven deps: `npm i sharp` (raster art), Babylon (3D, §4),
      ElevenLabs/Suno (rich audio). Skip anything no rule rewards.
- [ ] `node scripts/gen-placeholder-sprites.js --force` — after editing `SPRITES` to the genre.
- [ ] `node scripts/gen-placeholder-sfx.js` — keep as-is; rename keys later if useful.

**30–55 min — define the data + core loop**
- [ ] Add the rule's fields to `Entity` and the rule's verbs to `Input` (`shared/src/types.ts`).
- [ ] Implement the deterministic `step()` in `shared/` (movement + the one core mechanic).
- [ ] Confirm server imports `step()` and broadcasts `snapshot` each tick; client predicts + reconciles.

**55–75 min — render + sound + manual**
- [ ] Phaser scene: load sprites + sfx, `syncEntities()` draws snapshot, inputs emit `input`.
- [ ] Fire an SFX on every meaningful action (covers a SOUND rule).
- [ ] Add the help/manual scene/overlay (covers STORY + the TINS in-game-help gotcha).

**75–90 min — deploy + 2-browser test**
- [ ] Edit `HOST` and `REMOTE_PATH` at the top of `scripts/deploy-server.sh`.
- [ ] `./scripts/deploy-server.sh` (rsync server+shared → npm install → pm2 restart-or-start).
- [ ] Open the client in **two browser windows**, join the same room, confirm both
      see each other move in real time. This is the demo-critical proof.
- [ ] Commit. From here it's pure gameplay iteration.

---

## 3. TINS gotchas (don't lose points on these)

- **Source must build from a CLEAN CLONE.** You submit source code and it is
  judged/run. Test it: `git clean -xfd` in a scratch copy (or fresh `git clone`),
  then `npm install` in `server/` and `client/`, `npm run build` (client), `npm start`
  (server). If a generator output is needed at runtime, either commit `assets/` or
  document the `node scripts/gen-*.js` step in the README. **Do this before the deadline,
  not at it.**
- **Include a README** at repo root: what the game is, how to install + run
  (client dev server + server), controls, which Rule-O-Matic rules you targeted
  and where each is satisfied (judges look for this). List the asset/sfx generator
  commands.
- **Required image rule.** If a rule mandates a specific provided image, commit it
  to `assets/`, load it in Phaser, and show it in **both** the help/manual scene and
  on the play field so it's unmissable.
- **In-game help / manual** is a recurring requirement — build the help scene/overlay
  even if no rule explicitly demands it (cheap insurance; also covers STORY).
- **Hidden / secret feature slot.** Reserve one. Cheap ideas: a Konami-code input
  sequence that spawns a secret entity or toggles a "dev" overlay; a hidden room you
  reach by walking off-screen; a secret SFX (`assets/sfx/`) on an undocumented key.
  Document its existence (not the trigger) in the README so judges know to hunt.
- **Determinism = no desync.** Anything affecting world state goes through
  `shared/step()` and the seeded RNG, never computed independently on client and
  server.

---

## 4. Swap to 3D — quickref

If the GENRE rule forces 3D, the only change is the renderer impl — the net
contract, `shared/`, server, and entity shapes are unchanged.

- See **`shared/BABYLON_FALLBACK.md`** for the full swap procedure. *(If that file
  isn't present yet, it's the documented fallback task: `npm i @babylonjs/core` in
  `client/`, implement `BabylonRenderer` against the same `IRenderer` interface in
  `client/src/render/babylon.ts`, and select it in `client/src/main.ts` instead of
  `PhaserRenderer`.)*
- `Entity.{x,y}` stays the ground plane; add `z` (or `y`-as-height) via the Entity
  index signature — no type-file change, no server change.
- `IRenderer.syncEntities(entities)` is still called every frame from net state;
  only the drawing backend differs.

---

## Appendix — generator & deploy quick commands

```bash
# Animated 8-dir sprite atlas (the zoo). gen + verify are zero-dep; build needs sharp.
node scripts/gen-sprites.js                       # vector SVG frames -> assets/sprites/frames/
node scripts/build-atlas.js                       # pack -> assets/sprites/atlas.{png,json}
node scripts/verify-atlas.js                      # headless gate (all keys present)
cd scripts && npm run sprites                      # all three (force regen)
node scripts/check-facing.js                      # facingFromVec determinism check (build shared first)

node scripts/gen-placeholder-sprites.js          # legacy static single-shape SVGs (fallback)
node scripts/gen-placeholder-sfx.js              # WAV blips -> assets/sfx/
./scripts/deploy-server.sh                       # rsync+pm2 deploy (EDIT HOST/REMOTE_PATH first)
```
The frame generator + SFX generator + verifiers are **zero-dependency** (pure Node +
`fs`); only `build-atlas.js` needs `sharp` (a `scripts/` dev dep). The committed
`assets/sprites/atlas.{png,json}` means a clean clone runs without sharp. The deploy
script needs `HOST`/`REMOTE_PATH` filled in at its top.
