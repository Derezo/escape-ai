/**
 * PhaserRenderer — the default 2D implementation of the shared IRenderer.
 *
 * It knows nothing about netcode or input; the game loop hands it a flat list of
 * entities every frame and it makes the screen match. Each entity is drawn by
 * its `kind` (The Caves of Steel populates the room with pens, robots, animals,
 * terminals and a gate) — no art assets required to boot, so the kit still runs
 * the moment you `npm run dev`. An entity with no `kind` (the bare starter-kit
 * point) is treated as an `animal`.
 *
 * The 3D swap (BabylonRenderer) implements this same interface; see
 * shared/BABYLON_FALLBACK.md.
 */

import Phaser from 'phaser';
import type { IRenderer, Entity } from '@shared/renderer';

/** Visual size of a mobile entity (animal/robot), in pixels. */
const RECT_SIZE = 28;
/** Side length of a pen enclosure square, in pixels. */
const PEN_SIZE = 120;
/** Visual size of a static marker (terminal/gate), in pixels. */
const MARKER_SIZE = 20;

/**
 * Draw depths. Pens are the floor of the room, so they sit UNDER the mobile
 * entities and static markers; everything else shares the default layer.
 */
const DEPTH_PEN = 0;
const DEPTH_PROP = 1; // terminals / gates
const DEPTH_MOBILE = 2; // animals / robots

/**
 * One entity's on-screen representation: a body shape + (optional) name label.
 * `body` is a generic GameObject so the body can be a rectangle, triangle, etc.
 * depending on `kind`; we only ever reposition it, never read its subtype back.
 * `kind` is remembered so a kind change (rare) rebuilds the right visual.
 */
interface EntityView {
  body: Phaser.GameObjects.Shape;
  label?: Phaser.GameObjects.Text;
  kind: Entity['kind'];
}

/**
 * The single Scene. It owns the per-entity views and exposes `setEntities()` so
 * the renderer can push the latest entity list in from outside the Phaser
 * lifecycle.
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
      // Recreate the view if it's missing or its kind changed under it (so a
      // server reclassification swaps the visual instead of leaving the wrong one).
      if (view && view.kind === e.kind) {
        view.body.setPosition(e.x, e.y);
        view.label?.setPosition(e.x, e.y - RECT_SIZE);
      } else {
        if (view) this.destroyView(view);
        this.views.set(e.id, this.createView(e));
      }
    }

    // Destroy views for entities no longer present.
    for (const [id, view] of this.views) {
      if (!seen.has(id)) {
        this.destroyView(view);
        this.views.delete(id);
      }
    }
  }

  /** Build the per-kind visual for a freshly-seen entity. */
  private createView(e: Entity): EntityView {
    const kind = e.kind;
    switch (kind) {
      case 'pen':
        // A large translucent enclosure outline, drawn UNDER the mobile entities.
        return {
          kind,
          body: this.add
            .rectangle(e.x, e.y, PEN_SIZE, PEN_SIZE, 0x3a5a78, 0.12)
            .setStrokeStyle(2, 0x6fa8dc, 0.6)
            .setOrigin(0.5)
            .setDepth(DEPTH_PEN),
        };

      case 'robot': {
        // A steel-gray diamond (rotated square) — clearly NOT an animal blob.
        const body = this.add
          .rectangle(e.x, e.y, RECT_SIZE, RECT_SIZE, 0x9aa3ad)
          .setStrokeStyle(2, 0x2b2f36, 0.9)
          .setOrigin(0.5)
          .setAngle(45)
          .setDepth(DEPTH_MOBILE);
        return { kind, body, label: this.makeLabel(e) };
      }

      case 'terminal':
        // A small bright marker the player will later `interact` with.
        return {
          kind,
          body: this.add
            .rectangle(e.x, e.y, MARKER_SIZE, MARKER_SIZE, 0x32d296)
            .setStrokeStyle(2, 0xffffff, 0.7)
            .setOrigin(0.5)
            .setDepth(DEPTH_PROP),
        };

      case 'gate':
        // A distinct amber marker, drawn as a thin tall bar to read as a door.
        return {
          kind,
          body: this.add
            .rectangle(e.x, e.y, MARKER_SIZE * 0.5, MARKER_SIZE * 2, 0xe0a526)
            .setStrokeStyle(2, 0xffffff, 0.7)
            .setOrigin(0.5)
            .setDepth(DEPTH_PROP),
        };

      case 'animal':
      default: {
        // Players + idle animals: a filled square colored by id, with a name
        // label. `undefined` kind (bare starter point) falls through to here.
        const body = this.add
          .rectangle(e.x, e.y, RECT_SIZE, RECT_SIZE, colorFor(e.id))
          .setStrokeStyle(2, 0xffffff, 0.6)
          .setOrigin(0.5)
          .setDepth(DEPTH_MOBILE);
        return { kind, body, label: this.makeLabel(e) };
      }
    }
  }

  /** A name label floating above a mobile entity. */
  private makeLabel(e: Entity): Phaser.GameObjects.Text {
    return this.add
      .text(e.x, e.y - RECT_SIZE, e.name ?? e.id.slice(0, 6), {
        fontFamily: 'monospace',
        fontSize: '12px',
        color: '#ffffff',
      })
      .setOrigin(0.5, 1)
      .setDepth(DEPTH_MOBILE);
  }

  private destroyView(view: EntityView): void {
    view.body.destroy();
    view.label?.destroy();
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
