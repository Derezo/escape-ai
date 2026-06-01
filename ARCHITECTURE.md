# TINS 2026 Starter Kit — Architecture Contract

> This file is the single source of truth that all scaffold work must follow.
> The competition-specific rules drop at hour 0; this kit exists so that when they
> drop we write **gameplay**, not boilerplate.

## Decision summary
- **Client renderer:** Phaser 3 (2D default) + Babylon.js (3D fallback), behind a
  common `IRenderer` interface so the genre rule only forces a renderer swap.
- **Language/build:** TypeScript + Vite (client & shared). Server is Node + Socket.IO.
- **Netcode:** Express + Socket.IO **authoritative server**, fixed-tick engine with
  delta broadcast. Pattern lifted from `Derezo/galaxy-miner` `server/`.
- **Shared:** one TS module of types + deterministic update logic used by client AND server.
- **Android:** Capacitor wraps the Vite web build (browser-first, Android nice-to-have).
- **Deploy:** a VPS (nginx + pm2, env-driven) hosts the Socket.IO server — see `scripts/provision-escape.sh` + `scripts/deploy-server.sh`.

## Directory layout (agreed paths — do not deviate)
```
tins2026/
  client/        Vite + TS + Phaser app. entry: client/src/main.ts, client/index.html
  server/        Node + Socket.IO authoritative server. entry: server/index.js (CommonJS, Node 22)
  shared/        TS package: types, net contracts, deterministic step(). import as "@shared/*"
  scripts/       asset + audio generators (ported from Modia), deploy script
  docs/          PLAYBOOK.md (hour-0 Rule-O-Matic mapping) + notes
  assets/        generated/placeholder art + audio
```

## Network contract (shared/src/net.ts — authoritative)
- Client → server events: `auth:login {username, token?, species?}`,
  `lobby:join {room, name, species?}`, `input {seq, dx, dy, sprint?, action?}`,
  `ping {t}`, `leaderboard:request {sort?, limit?}`, `chat:send {text}`
- Server → client events: `auth:result {ok, reason?, token?, username?, stats?}`,
  `lobby:state {players}`, `snapshot {tick, entities, acks, world?}`, `pong {t}`,
  `map {seed, version, tile, w, h}`, `leaderboard:data {sort, rows, total, you}`,
  `chat:message {senderId, senderName, senderSpecies, text, tick}`
- The runtime event-name surface is guarded by `shared/test/net.test.mjs` (key sets,
  uniqueness, client/server disjointness); payload shapes are enforced by `tsc --strict`.
- Server runs a fixed tick (default 20 Hz). Client interpolates/predicts.
- Entities are plain serializable objects `{id, x, y, ...}`; renderer-agnostic.
- The map is sent once as a seed; the client regenerates the identical tilemap
  deterministically (no per-tile bandwidth).
- A room's world is created lazily on first `lobby:join` and reclaimed when the room
  empties (the pre-warmed `default` room persists); the client-supplied room name is
  validated server-side. See `server/socket/lobby.js` (`sanitizeRoom`) +
  `server/game/world.js` (`removeRoom`/`hasRoom`).

## Renderer interface (shared/src/renderer.ts)
```ts
export interface IRenderer {
  init(canvas: HTMLElement): Promise<void>;
  setMap(map: WorldMap): void;             // once, when the world map is ready
  syncEntities(entities: Entity[]): void;  // called every frame from net state
  destroy(): void;
}
```
PhaserRenderer (client/src/render/phaser.ts) is the default (and currently only) impl.
BabylonRenderer (client/src/render/babylon.ts) is the documented-but-unimplemented 3D
fallback: a pre-written skeleton lives in shared/BABYLON_FALLBACK.md, and the swap path
(install @babylonjs/core, drop in babylon.ts, flip two lines) is wired in
client/src/main.ts. Build it only if an hour-0 genre rule forces 3D.

## Reuse sources (copy patterns, generalize, strip game specifics)
- Server skeleton ← `Derezo/galaxy-miner` `server/{index.js,socket/index.js,socket/connection.js,game/engine.js}`
- Asset/audio generators ← `Derezo/Modia` `scripts/{tiles,audio,generate-icons.js}`

## Non-goals for the scaffold
- No actual game design — that's decided at hour 0.
- Keep everything game-agnostic: a movable synced entity is the only "gameplay".
