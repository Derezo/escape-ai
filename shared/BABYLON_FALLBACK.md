# Babylon.js 3D fallback renderer

The kit ships **PhaserRenderer** (2D) as the default. If the hour-0 genre rule
demands 3D, you swap renderers — you do **not** rewrite the game. Both implement
the same `IRenderer` (`shared/src/renderer.ts`), and the game loop only ever
talks to that interface.

## When to switch to 3D

Switch when the genre rule implies depth/perspective/voxels/physics-in-3D
(e.g. "first-person", "racing", "tower in 3D space"). For top-down, side-scroll,
puzzle, or board-style games, stay on Phaser — it's faster to iterate.

## What a swap requires

1. `npm install @babylonjs/core` in `client/` (NOT pre-installed — we add it only
   if needed, to keep the hour-0 client build lean).
2. Drop the skeleton below into `client/src/render/babylon.ts`.
3. Flip **one line** in the client bootstrap (`client/src/main.ts`):

   ```ts
   // import { PhaserRenderer } from './render/phaser';
   import { BabylonRenderer } from './render/babylon';

   // const renderer: IRenderer = new PhaserRenderer();
   const renderer: IRenderer = new BabylonRenderer();
   ```

That's the whole swap. The net layer, prediction (`applyInput`), input handling,
and snapshot interpolation are all renderer-agnostic and unchanged.

## How `syncEntities` maps entities to meshes

`syncEntities(entities: Entity[])` runs every frame from net state. It is an
**upsert + prune** over a `Map<id, Mesh>`:

- Each `Entity{ x, y }` maps to a mesh at `(x, y, z)`. Babylon is right-handed
  3D, so we use `Entity.x -> mesh.position.x`, `Entity.y -> mesh.position.z`
  (ground plane), and the **optional** `entity.z` (any extra field is allowed by
  the `Entity` index signature) -> `mesh.position.y` (height). If `entity.z` is
  absent, height defaults to `0`.
- New ids create a box; known ids just move; ids that vanished get disposed.

This keeps the same `{x, y}` contract Phaser uses; 3D only adds an optional axis.

## Reference skeleton (~40 lines)

```ts
import { Engine, Scene, ArcRotateCamera, HemisphericLight, Vector3, MeshBuilder, type Mesh } from '@babylonjs/core';
import type { IRenderer, Entity, WorldMap } from '@escape-ai/shared';

export class BabylonRenderer implements IRenderer {
  private engine!: Engine;
  private scene!: Scene;
  private canvas!: HTMLCanvasElement;
  private meshes = new Map<string, Mesh>();

  async init(host: HTMLElement): Promise<void> {
    this.canvas = document.createElement('canvas');
    this.canvas.style.width = '100%';
    this.canvas.style.height = '100%';
    host.appendChild(this.canvas);

    this.engine = new Engine(this.canvas, true);
    this.scene = new Scene(this.engine);
    const camera = new ArcRotateCamera('cam', -Math.PI / 2, Math.PI / 3, 40, Vector3.Zero(), this.scene);
    camera.attachControl(this.canvas, true);
    new HemisphericLight('light', new Vector3(0, 1, 0), this.scene);

    this.engine.runRenderLoop(() => this.scene.render());
    window.addEventListener('resize', this.onResize);
  }

  // Called once when the world map is ready (the client regenerates it from the
  // seed the server sends). A 3D impl builds its ground from the same plain
  // WorldMap arrays — e.g. a tiled ground plane + instanced meshes for solid
  // deco tiles (map.collision) — instead of Phaser TilemapLayers. Renderer-
  // agnostic: WorldMap carries no Phaser/Babylon types.
  setMap(map: WorldMap): void {
    const ground = MeshBuilder.CreateGround('ground', { width: map.w * map.tile, height: map.h * map.tile }, this.scene);
    ground.position.set((map.w * map.tile) / 2, 0, (map.h * map.tile) / 2);
    // (Solid tiles from map.collision would become instanced wall/tree meshes.)
  }

  syncEntities(entities: Entity[]): void {
    const seen = new Set<string>();
    for (const e of entities) {
      seen.add(e.id);
      let mesh = this.meshes.get(e.id);
      if (!mesh) {
        mesh = MeshBuilder.CreateBox(e.id, { size: 1 }, this.scene);
        this.meshes.set(e.id, mesh);
      }
      const z = typeof e.z === 'number' ? e.z : 0; // optional height axis
      mesh.position.set(e.x, z, e.y);
    }
    for (const [id, mesh] of this.meshes) {
      if (!seen.has(id)) { mesh.dispose(); this.meshes.delete(id); }
    }
  }

  private onResize = () => this.engine.resize();

  destroy(): void {
    window.removeEventListener('resize', this.onResize);
    for (const mesh of this.meshes.values()) mesh.dispose();
    this.meshes.clear();
    this.scene?.dispose();
    this.engine?.dispose();
    this.canvas?.remove();
  }
}
```

> Do **not** add `@babylonjs/core` to `package.json` now. This doc + skeleton is
> the spike; install at hour 0 only if the genre forces 3D.
