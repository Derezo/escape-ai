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
/** Size of the carryable Clipboard prop, in pixels (smaller than a creature). */
const PROP_SIZE = 16;

/**
 * Per-species base tint for animals. The id still spins the hue (colorFor) so
 * two apes are tellable apart, but a species' tint biases the body toward a
 * recognisable family colour so a player can read ape/bird/rat/elephant at a
 * glance. An unknown/absent species falls back to the pure id colour.
 */
const SPECIES_TINT: Record<string, number> = {
  ape: 0x8d6e4f, // warm brown
  bird: 0x4cc9f0, // cyan
  rat: 0x9aa3ad, // gray
  elephant: 0x5a6b7a, // slate
};

/**
 * Draw depths. Pens are the floor of the room, so they sit UNDER the mobile
 * entities and static markers; everything else shares the default layer.
 */
const DEPTH_PEN = 0;
const DEPTH_PROP = 1; // terminals / gates
const DEPTH_MOBILE = 2; // animals / robots

/** A robot's behavioural mode, mirrored from the snapshot for visual feedback. */
type RobotMode = 'idle' | 'frozen' | 'pursue' | 'ordered';

/**
 * One entity's on-screen representation: a body shape + (optional) name label.
 * `body` is a generic GameObject so the body can be a rectangle, triangle, etc.
 * depending on `kind`; we only ever reposition it, never read its subtype back.
 * `kind` is remembered so a kind change (rare) rebuilds the right visual.
 *
 * The Three-Laws fields below let the player SEE the stealth working. We cache
 * the last-rendered values so we only restyle a body when they actually change
 * (a body is restyled in-place; only a `kind` change rebuilds it):
 *   - `humanLikeness` drives an animal's outline (a human-looking animal glows)
 *   - `mode`/`suspicion` drive a robot's tint + suspicion ring
 */
interface EntityView {
  body: Phaser.GameObjects.Shape;
  label?: Phaser.GameObjects.Text;
  kind: Entity['kind'];
  /** Suspicion ring for robots; created lazily the first time suspicion > 0. */
  ring?: Phaser.GameObjects.Arc;
  /** Last-rendered Three-Laws state, so we restyle only on change. */
  humanLikeness?: number;
  mode?: RobotMode;
  suspicion?: number;
}

/** humanLikeness at/above this reads as "human" — mirrors the server freeze threshold. */
const HUMAN_THRESHOLD = 0.6;

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
        view.ring?.setPosition(e.x, e.y);
        // Reflect the Three-Laws state (humanLikeness / mode / suspicion); cheap
        // and a no-op unless a value actually changed since last frame.
        this.restyle(view, e);
      } else {
        if (view) this.destroyView(view);
        const created = this.createView(e);
        this.restyle(created, e);
        this.views.set(e.id, created);
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

  /**
   * Re-apply the Three-Laws visual feedback for an entity, restyling only the
   * body fields that changed since the last frame (so a static room of entities
   * costs nothing). Display-only: reads server-authoritative fields, mutates
   * nothing on the entity.
   */
  private restyle(view: EntityView, e: Entity): void {
    if (e.kind === 'animal' || e.kind === undefined) {
      // First-Law stealth: a human-looking animal gets a bright white outline so
      // robots' "is that a human?" read is legible to the player too.
      const hl = readNumber(e.humanLikeness);
      if (hl === view.humanLikeness) return;
      view.humanLikeness = hl;
      const human = hl !== undefined && hl >= HUMAN_THRESHOLD;
      // Stroke alpha scales with humanLikeness so the disguise "warms up" toward
      // the threshold; once human-looking it snaps to a solid white outline.
      const alpha = human ? 1 : 0.6 * (hl ?? 0) + 0.4;
      const width = human ? 3 : 2;
      const color = human ? 0xffffff : 0xdddddd;
      view.body.setStrokeStyle(width, color, alpha);
      return;
    }

    if (e.kind === 'robot') {
      const mode = readMode(e.mode);
      const suspicion = readNumber(e.suspicion) ?? 0;
      if (mode !== view.mode) {
        view.mode = mode;
        // Mode drives the body fill: frozen reads cold/blue (First-Law freeze),
        // ordered reads green (Second-Law standdown — now working for you),
        // pursue reads hostile/red, idle stays the neutral steel gray it spawns as.
        const fill =
          mode === 'frozen' ? 0x5aa0e0
          : mode === 'ordered' ? 0x46c46a
          : mode === 'pursue' ? 0xe05a5a
          : 0x9aa3ad;
        const stroke =
          mode === 'frozen' ? 0xbfe0ff
          : mode === 'ordered' ? 0x9bf0b0
          : mode === 'pursue' ? 0xff3030
          : 0x2b2f36;
        // Shapes built via add.rectangle expose fill/stroke setters at runtime;
        // EntityView.body is the generic Shape supertype, so narrow to use them.
        const rect = view.body as Phaser.GameObjects.Rectangle;
        rect.setFillStyle(fill);
        rect.setStrokeStyle(2, stroke, 0.9);
      }
      // Suspicion ring: an orange halo whose opacity tracks how convinced the
      // robot is. Created lazily, hidden when suspicion is negligible.
      this.styleSuspicionRing(view, e, suspicion);
      return;
    }
  }

  /** Lazily create/update the orange suspicion halo around a robot. */
  private styleSuspicionRing(view: EntityView, e: Entity, suspicion: number): void {
    if (suspicion === view.suspicion) return;
    view.suspicion = suspicion;
    if (suspicion <= 0.05) {
      view.ring?.setVisible(false);
      return;
    }
    if (!view.ring) {
      view.ring = this.add
        .circle(e.x, e.y, RECT_SIZE * 0.9)
        .setStrokeStyle(2, 0xffa500, 1)
        .setFillStyle(0, 0)
        .setOrigin(0.5)
        .setDepth(DEPTH_MOBILE);
    }
    // Intensity rises with suspicion (0.05..1 → ~0.3..1 alpha).
    view.ring.setStrokeStyle(2, 0xffa500, 0.3 + 0.7 * Math.min(1, suspicion)).setVisible(true);
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

      case 'prop':
        // The Clipboard: a small pale document — a slim portrait rect, clearly
        // an inert item, not a creature. Sits on the prop layer with terminals.
        return {
          kind,
          body: this.add
            .rectangle(e.x, e.y, PROP_SIZE * 0.8, PROP_SIZE, 0xeef0f2)
            .setStrokeStyle(2, 0x6b7280, 0.9)
            .setOrigin(0.5)
            .setDepth(DEPTH_PROP),
        };

      case 'animal':
      default: {
        // Players + idle animals. The body shape varies by species so the four
        // animals read apart at a glance; the fill blends the id colour (so two
        // of a species still differ) with a species tint. `undefined` kind (the
        // bare starter point) falls through here as a plain id-coloured square.
        const body = this.makeAnimalBody(e);
        return { kind, body, label: this.makeLabel(e) };
      }
    }
  }

  /**
   * Build an animal's body, varying SHAPE by species (ape/bird/rat/elephant)
   * and tinting the id colour toward the species' family colour. The body stays
   * a generic Shape so `restyle()`'s humanLikeness outline applies uniformly,
   * and so per-species shapes never leak into the rest of the lifecycle.
   */
  private makeAnimalBody(e: Entity): Phaser.GameObjects.Shape {
    const species = typeof e.species === 'string' ? e.species : undefined;
    const tint = species !== undefined ? SPECIES_TINT[species] : undefined;
    // Blend toward the species tint when known so the family colour reads while
    // each id still shifts the hue; unknown species keeps the pure id colour.
    const fill = tint !== undefined ? blendColors(colorFor(e.id), tint, 0.55) : colorFor(e.id);
    // restyle() overrides this outline per-frame from humanLikeness; this is the
    // neutral default a freshly-spawned animal shows before any First-Law read.
    const stroke = 0xffffff;
    const alpha = 0.6;

    switch (species) {
      case 'bird': {
        // Light + nimble (flies): an upward triangle.
        const r = RECT_SIZE * 0.62;
        return this.add
          .triangle(e.x, e.y, 0, r, r, -r, -r, -r, fill)
          .setStrokeStyle(2, stroke, alpha)
          .setOrigin(0.5)
          .setDepth(DEPTH_MOBILE);
      }
      case 'rat': {
        // Small + squeezes through gaps: a compact diamond (rotated square).
        const d = RECT_SIZE * 0.7;
        return this.add
          .rectangle(e.x, e.y, d, d, fill)
          .setStrokeStyle(2, stroke, alpha)
          .setOrigin(0.5)
          .setAngle(45)
          .setDepth(DEPTH_MOBILE);
      }
      case 'elephant': {
        // Big + smashes: an oversized square so it reads as the heavy one.
        const big = RECT_SIZE * 1.25;
        return this.add
          .rectangle(e.x, e.y, big, big, fill)
          .setStrokeStyle(2, stroke, alpha)
          .setOrigin(0.5)
          .setDepth(DEPTH_MOBILE);
      }
      case 'ape':
      default:
        // Ape (climber) + the bare starter point: the baseline id-coloured square.
        return this.add
          .rectangle(e.x, e.y, RECT_SIZE, RECT_SIZE, fill)
          .setStrokeStyle(2, stroke, alpha)
          .setOrigin(0.5)
          .setDepth(DEPTH_MOBILE);
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
    view.ring?.destroy();
  }
}

/** Read a 0..1-ish numeric field, returning undefined for absent/NaN values. */
function readNumber(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}

/** Narrow the snapshot's `mode` (index-signature `unknown`) to a RobotMode. */
function readMode(v: unknown): RobotMode {
  return v === 'frozen' || v === 'pursue' || v === 'ordered' ? v : 'idle';
}

/** Deterministic pastel color from an entity id so each rectangle is distinct. */
function colorFor(id: string): number {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0;
  // Spread hue across the wheel; fixed-ish saturation/lightness via HSV->RGB.
  const hue = h % 360;
  return hsvToInt(hue, 0.55, 0.95);
}

/**
 * Linearly blend two 0xRRGGBB colours: `t` of `b` mixed into `a` (t in 0..1).
 * Used to bias an animal's per-id colour toward its species' family tint.
 */
function blendColors(a: number, b: number, t: number): number {
  const lerp = (x: number, y: number) => Math.round(x + (y - x) * t);
  const r = lerp((a >> 16) & 0xff, (b >> 16) & 0xff);
  const g = lerp((a >> 8) & 0xff, (b >> 8) & 0xff);
  const bl = lerp(a & 0xff, b & 0xff);
  return (r << 16) | (g << 8) | bl;
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
