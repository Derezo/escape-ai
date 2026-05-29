# TINS 2026 Starter Kit — Architecture Contract

> This file is the single source of truth that all scaffold work must follow.
> The competition-specific rules drop at hour 0; this kit exists so that when they
> drop we write **gameplay**, not boilerplate.

## Decision summary
- **Client renderer:** Phaser 3 (2D default) + Babylon.js (3D fallback), behind a
  common `IRenderer` interface so the genre rule only forces a renderer swap.
- **Language/build:** TypeScript + Vite (client & shared). Server is Node + Socket.IO.
- **Netcode:** Express + Socket.IO **authoritative server**, fixed-tick engine with
  delta broadcast. Pattern lifted from `~/Projects/galaxy-miner/server`.
- **Shared:** one TS module of types + deterministic update logic used by client AND server.
- **Android:** Capacitor wraps the Vite web build (browser-first, Android nice-to-have).
- **Deploy:** mittonvillage.com VPS hosts the Socket.IO server.

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
- Client → server events: `lobby:join {room, name}`, `input {seq, ...}`, `ping {t}`
- Server → client events: `lobby:state {players}`, `snapshot {tick, entities, acks}`, `pong {t}`
- Server runs a fixed tick (default 20 Hz). Client interpolates/predicts.
- Entities are plain serializable objects `{id, x, y, ...}`; renderer-agnostic.

## Renderer interface (shared/src/renderer.ts)
```ts
export interface IRenderer {
  init(canvas: HTMLElement): Promise<void>;
  syncEntities(entities: Entity[]): void;  // called every frame from net state
  destroy(): void;
}
```
PhaserRenderer (client/src/render/phaser.ts) is the default impl.
BabylonRenderer (client/src/render/babylon.ts) is the 3D fallback impl.

## Reuse sources (copy patterns, generalize, strip game specifics)
- Server skeleton ← `~/Projects/galaxy-miner/server/{index.js,socket/index.js,socket/connection.js,game/engine.js}`
- Asset/audio generators ← `~/Projects/Modia/scripts/{tiles,audio,generate-icons.js}`

## Non-goals for the scaffold
- No actual game design — that's decided at hour 0.
- Keep everything game-agnostic: a movable synced entity is the only "gameplay".
