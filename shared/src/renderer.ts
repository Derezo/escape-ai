/**
 * Renderer abstraction. The genre rule at hour 0 may force 2D (Phaser) or 3D
 * (Babylon), but the client game loop only ever talks to this interface, so the
 * swap is one line (see BABYLON_FALLBACK.md).
 *
 * Interface is reproduced EXACTLY as specified in ARCHITECTURE.md.
 */

import type { Entity } from './types.js';
import type { WorldMap } from './world.js';

/**
 * A cosmetic, owner-only quest-direction hint the game loop hands the renderer so
 * it can draw a path-following arrow from the local player toward their current
 * quest goal. Purely a render cue — the server still owns quest completion; this
 * never crosses the wire. `null` clears it (no quest / complete / no goal found).
 */
export interface QuestGuide {
  /** Entity id of the local player the arrow emits from. */
  fromId: string;
  /** Quest goal position in world units (gate / terminal / home object). */
  goalX: number;
  goalY: number;
  /** The local player's species — used to suppress its own meaningless marker. */
  ownerSpecies: string;
  /**
   * Whether the owner's own per-species questObject marker is its real target
   * ('reach' quests). When false, the renderer hides that species' star (it would
   * be a misleading do-nothing marker, e.g. the ape whose target is the gate).
   */
  questUsesMarker: boolean;
}

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
  /**
   * Update the local player's quest-direction hint (or `null` to clear it).
   * OPTIONAL: a renderer that doesn't draw guidance (e.g. the Babylon fallback)
   * simply omits it; the game loop guards the call with `?.`. Called once per
   * frame from main.ts; the renderer decides how often to re-path.
   */
  setQuestGuide?(guide: QuestGuide | null): void;
  destroy(): void;
}

// Re-export Entity + WorldMap so renderer impls can
// `import { IRenderer, Entity, WorldMap } from '@shared/renderer'`.
export type { Entity, WorldMap };
