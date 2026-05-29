/**
 * Renderer abstraction. The genre rule at hour 0 may force 2D (Phaser) or 3D
 * (Babylon), but the client game loop only ever talks to this interface, so the
 * swap is one line (see BABYLON_FALLBACK.md).
 *
 * Interface is reproduced EXACTLY as specified in ARCHITECTURE.md.
 */

import type { Entity } from './types.js';
import type { WorldMap } from './world.js';

export interface IRenderer {
  init(canvas: HTMLElement): Promise<void>;
  /**
   * Hand the renderer the static world map ONCE, when it becomes available (the
   * client regenerates it from the seed the server sends — see net.ts MapMsg).
   * `WorldMap` is a plain shared data type (typed arrays + plain objects, no
   * Phaser/Babylon types), so any renderer can build its terrain from it: the
   * Phaser impl makes TilemapLayers, a Babylon impl would build ground meshes.
   * Called before / independently of the per-frame syncEntities stream.
   */
  setMap(map: WorldMap): void;
  syncEntities(entities: Entity[]): void; // called every frame from net state
  destroy(): void;
}

// Re-export Entity + WorldMap so renderer impls can
// `import { IRenderer, Entity, WorldMap } from '@shared/renderer'`.
export type { Entity, WorldMap };
