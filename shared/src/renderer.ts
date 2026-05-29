/**
 * Renderer abstraction. The genre rule at hour 0 may force 2D (Phaser) or 3D
 * (Babylon), but the client game loop only ever talks to this interface, so the
 * swap is one line (see BABYLON_FALLBACK.md).
 *
 * Interface is reproduced EXACTLY as specified in ARCHITECTURE.md.
 */

import type { Entity } from './types.js';

export interface IRenderer {
  init(canvas: HTMLElement): Promise<void>;
  syncEntities(entities: Entity[]): void; // called every frame from net state
  destroy(): void;
}

// Re-export Entity so renderer impls can `import { IRenderer, Entity } from '@shared/renderer'`.
export type { Entity };
