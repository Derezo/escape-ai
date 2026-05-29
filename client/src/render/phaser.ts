/**
 * PhaserRenderer — the default 2D implementation of the shared IRenderer.
 *
 * It knows nothing about netcode or input; the game loop hands it a flat list of
 * entities every frame and it makes the screen match. Each entity is drawn as a
 * colored rectangle with its name above it — no art assets required to boot, so
 * the kit runs the moment you `npm run dev`.
 *
 * The 3D swap (BabylonRenderer) implements this same interface; see
 * shared/BABYLON_FALLBACK.md.
 */

import Phaser from 'phaser';
import type { IRenderer, Entity } from '@shared/renderer';

/** Visual size of an entity rectangle, in pixels. */
const RECT_SIZE = 28;

/** One entity's on-screen representation: a body rectangle + a name label. */
interface EntityView {
  rect: Phaser.GameObjects.Rectangle;
  label: Phaser.GameObjects.Text;
}

/**
 * The single Scene. It owns the per-entity views and exposes `apply()` so the
 * renderer can push the latest entity list in from outside the Phaser lifecycle.
 */
class WorldScene extends Phaser.Scene {
  private views = new Map<string, EntityView>();
  /** Latest entity list to draw; updated by the renderer, consumed in update(). */
  private pending: Entity[] = [];

  constructor() {
    super('world');
  }

  /** Called by PhaserRenderer.syncEntities — just stash the latest list. */
  setEntities(entities: Entity[]): void {
    this.pending = entities;
  }

  // Phaser drives update() every frame; we reconcile views to `pending` here so
  // creation/movement happens on the render thread.
  update(): void {
    this.upsert(this.pending);
  }

  /** Upsert (create/move) present entities, destroy vanished ones. */
  private upsert(entities: Entity[]): void {
    const seen = new Set<string>();

    for (const e of entities) {
      seen.add(e.id);
      // World coords map 1:1 to screen pixels for the skeleton. The camera
      // origin is top-left, matching the server's (0,0) spawn.
      const view = this.views.get(e.id);
      if (view) {
        // Existing entity: just move it.
        view.rect.setPosition(e.x, e.y);
        view.label.setPosition(e.x, e.y - RECT_SIZE);
      } else {
        // New entity: create a rectangle + name label.
        const color = colorFor(e.id);
        const rect = this.add
          .rectangle(e.x, e.y, RECT_SIZE, RECT_SIZE, color)
          .setStrokeStyle(2, 0xffffff, 0.6)
          .setOrigin(0.5);
        const label = this.add
          .text(e.x, e.y - RECT_SIZE, e.name ?? e.id.slice(0, 6), {
            fontFamily: 'monospace',
            fontSize: '12px',
            color: '#ffffff',
          })
          .setOrigin(0.5, 1);
        this.views.set(e.id, { rect, label });
      }
    }

    // Destroy views for entities no longer present.
    for (const [id, view] of this.views) {
      if (!seen.has(id)) {
        view.rect.destroy();
        view.label.destroy();
        this.views.delete(id);
      }
    }
  }
}

/** Deterministic pastel color from an entity id so each rectangle is distinct. */
function colorFor(id: string): number {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0;
  // Spread hue across the wheel; fixed-ish saturation/lightness via HSV->RGB.
  const hue = h % 360;
  return hsvToInt(hue, 0.55, 0.95);
}

function hsvToInt(h: number, s: number, v: number): number {
  const c = v * s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = v - c;
  let r = 0;
  let g = 0;
  let b = 0;
  if (h < 60) [r, g, b] = [c, x, 0];
  else if (h < 120) [r, g, b] = [x, c, 0];
  else if (h < 180) [r, g, b] = [0, c, x];
  else if (h < 240) [r, g, b] = [0, x, c];
  else if (h < 300) [r, g, b] = [x, 0, c];
  else [r, g, b] = [c, 0, x];
  const ri = Math.round((r + m) * 255);
  const gi = Math.round((g + m) * 255);
  const bi = Math.round((b + m) * 255);
  return (ri << 16) | (gi << 8) | bi;
}

export class PhaserRenderer implements IRenderer {
  private game?: Phaser.Game;
  private scene?: WorldScene;

  async init(host: HTMLElement): Promise<void> {
    this.scene = new WorldScene();

    this.game = new Phaser.Game({
      type: Phaser.AUTO,
      parent: host,
      backgroundColor: '#0b0e14',
      scale: {
        mode: Phaser.Scale.RESIZE, // fill the container; track viewport changes
        autoCenter: Phaser.Scale.CENTER_BOTH,
      },
      scene: this.scene,
    });

    // Phaser boots asynchronously; resolve once the scene is live so callers can
    // safely start pushing entities.
    await new Promise<void>((resolve) => {
      this.game!.events.once(Phaser.Core.Events.READY, () => resolve());
    });
  }

  syncEntities(entities: Entity[]): void {
    this.scene?.setEntities(entities);
  }

  destroy(): void {
    this.game?.destroy(true);
    this.game = undefined;
    this.scene = undefined;
  }
}
