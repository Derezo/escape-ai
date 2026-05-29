/**
 * PhaserRenderer — the default 2D implementation of the shared IRenderer.
 *
 * It knows nothing about netcode or input; the game loop hands it a flat list of
 * entities every frame and it makes the screen match. Each entity is drawn by
 * its `kind` (The Caves of Steel populates the room with pens, robots, animals,
 * terminals and a gate). An entity with no `kind` (the bare starter-kit point)
 * is treated as an `animal`.
 *
 * Mobile entities (animals/robots) render as ANIMATED, 8-directional SPRITES from
 * a packed atlas (assets/sprites/atlas.{png,json}) when it is present — idle and
 * walk cycles, facing the movement direction. If the atlas (or a given species'
 * frames) is missing, that entity FALLS BACK to the original geometric shape, so
 * the kit still boots and plays with zero art. Positions are interpolated between
 * snapshots for smoothness (the local player is snapped to its predicted pos).
 *
 * The 3D swap (BabylonRenderer) implements this same interface; see
 * shared/BABYLON_FALLBACK.md.
 */

import Phaser from 'phaser';
import type { IRenderer, Entity } from '@shared/renderer';
import type { Dir8 } from '@shared/types';
import { facingFromVec } from '@shared/step';

/** Visual size of a mobile entity (animal/robot), in pixels. */
const RECT_SIZE = 28;
/** Display size of a sprite (the 64px atlas frame scaled down). */
const SPRITE_SIZE = 40;
/** Side length of a pen enclosure square, in pixels. */
const PEN_SIZE = 120;
/** Visual size of a static marker (terminal/gate), in pixels. */
const MARKER_SIZE = 20;
/** Size of the carryable Clipboard prop, in pixels (smaller than a creature). */
const PROP_SIZE = 16;
/** The atlas texture key. */
const ATLAS_KEY = 'creatures';
/** Squared per-frame position delta above which an entity reads as "moving". */
const MOVE_EPS2 = 0.6;
/** Interpolation rate for remote entities (higher = snappier). */
const LERP_RATE = 16;

/**
 * Per-species base tint for animals — also used to tint the shape FALLBACK so the
 * fallback matches the atlas family colour. (Kept for the no-atlas path.)
 */
const SPECIES_TINT: Record<string, number> = {
  ape: 0x8d6e4f, // warm brown
  bird: 0x4cc9f0, // cyan
  rat: 0x9aa3ad, // gray
  elephant: 0x5a6b7a, // slate
};

/** Draw depths. Pens floor; props/markers; mobile; fx on top. */
const DEPTH_PEN = 0;
const DEPTH_PROP = 1; // terminals / gates / hazards
const DEPTH_MOBILE = 2; // animals / robots
const DEPTH_FX = 3; // ability effects, glows, particles (above everything)

/** A soft round particle texture key, generated once in create(). */
const DOT_KEY = '__fxdot';

/** A robot's behavioural mode, mirrored from the snapshot for visual feedback. */
type RobotMode = 'idle' | 'frozen' | 'pursue' | 'ordered';

/**
 * One entity's on-screen representation: a body (sprite OR shape) + optional
 * name label, suspicion ring, and humanLikeness halo. We cache the last-rendered
 * Three-Laws + animation state so we only restyle / re-play when something
 * actually changed (a static room of entities costs nothing per frame).
 */
interface EntityView {
  body: Phaser.GameObjects.Shape | Phaser.GameObjects.Sprite;
  isSprite: boolean;
  species?: string;
  label?: Phaser.GameObjects.Text;
  kind: Entity['kind'];
  /** Suspicion ring for robots; created lazily the first time suspicion > 0. */
  ring?: Phaser.GameObjects.Arc;
  /** humanLikeness halo for sprite animals (the shape path uses a stroke instead). */
  halo?: Phaser.GameObjects.Arc;
  /** Interpolated (displayed) position + the latest target from the snapshot. */
  renderX: number;
  renderY: number;
  targetX: number;
  targetY: number;
  /** Last-rendered animation key + facing, so we only re-play on change. */
  anim?: string;
  facing: Dir8;
  /** Last-rendered Three-Laws state, so we restyle only on change. */
  humanLikeness?: number;
  mode?: RobotMode;
  suspicion?: number;
  /** The fx.startTick we last fired a burst for, so each activation fires once. */
  fxStartTick?: number;
  /** A sustained glow/overlay (cloak/carry/shell/stink), cleared when fx ends. */
  fxGlow?: Phaser.GameObjects.Arc;
}

/** humanLikeness at/above this reads as "human" — mirrors the server freeze threshold. */
const HUMAN_THRESHOLD = 0.6;

/**
 * The single Scene. Owns the per-entity views, loads the atlas in preload(),
 * builds directional animations in create(), and reconciles views to the latest
 * entity list in update().
 */
class WorldScene extends Phaser.Scene {
  private views = new Map<string, EntityView>();
  /** Latest entity list to draw; updated by the renderer, consumed in update(). */
  private pending: Entity[] = [];
  /** True once the atlas texture loaded; gates the sprite path (else shapes). */
  private atlasReady = false;
  /** Species that have a full set of atlas frames (so anims exist for them). */
  private animatedSpecies = new Set<string>();
  /** Strongest camera-shake requested this frame (coalesced so shakes don't stack). */
  private pendingShake = 0;
  /** Whether a screen flash was requested this frame (coalesced to one). */
  private pendingFlash = false;

  constructor() {
    super('world');
  }

  preload(): void {
    // Relative paths (no leading slash) so they resolve under Vite base:'./'
    // and inside the Capacitor Android WebView. Missing files just leave the
    // atlas absent → the shape fallback takes over (handled in create/createView).
    this.load.atlas(ATLAS_KEY, './sprites/atlas.png', './sprites/atlas.json');
    this.load.on('loaderror', (file: Phaser.Loader.File) => {
      if (file.key === ATLAS_KEY) this.atlasReady = false;
    });
  }

  create(): void {
    this.atlasReady = this.textures.exists(ATLAS_KEY);
    if (this.atlasReady) this.buildAnimations();
    this.makeDotTexture();
  }

  /** Generate a soft round particle texture once (a radial-ish white dot). */
  private makeDotTexture(): void {
    if (this.textures.exists(DOT_KEY)) return;
    const g = this.add.graphics();
    g.fillStyle(0xffffff, 1).fillCircle(8, 8, 8);
    g.fillStyle(0xffffff, 0.5).fillCircle(8, 8, 5);
    g.generateTexture(DOT_KEY, 16, 16);
    g.destroy();
  }

  /**
   * Build idle/walk directional animations from whatever frames the atlas
   * actually contains. We scan the atlas frame names (`species_state_dir_n`) and
   * create one anim per (species,state,dir) that has frame 0 present — so the
   * renderer supports exactly the species shipped in the atlas, no hardcoded list
   * (a partially-populated atlas during fan-out still works).
   */
  private buildAnimations(): void {
    const tex = this.textures.get(ATLAS_KEY);
    const frameNames = tex.getFrameNames(); // e.g. ['ape_walk_s_0', ...]
    const states: Record<string, number> = { idle: 2, walk: 4 };
    const dirs: Dir8[] = ['s', 'se', 'e', 'ne', 'n', 'nw', 'w', 'sw'];
    const present = new Set(frameNames);

    // Discover species from frame names.
    const species = new Set<string>();
    for (const name of frameNames) {
      const sp = name.split('_')[0];
      if (sp) species.add(sp);
    }

    for (const sp of species) {
      let complete = true;
      for (const [state, count] of Object.entries(states)) {
        for (const dir of dirs) {
          const key = `${sp}_${state}_${dir}`;
          // Require frame 0 to exist; collect the run of frames that do.
          const frames: Phaser.Types.Animations.AnimationFrame[] = [];
          for (let i = 0; i < count; i++) {
            const frameName = `${sp}_${state}_${dir}_${i}`;
            if (present.has(frameName)) frames.push({ key: ATLAS_KEY, frame: frameName });
          }
          if (frames.length === 0) {
            complete = false;
            continue;
          }
          if (!this.anims.exists(key)) {
            this.anims.create({
              key,
              frames,
              frameRate: state === 'walk' ? 10 : 3,
              repeat: -1,
            });
          }
        }
      }
      if (complete) this.animatedSpecies.add(sp);
    }
  }

  /** Called by PhaserRenderer.syncEntities — just stash the latest list. */
  setEntities(entities: Entity[]): void {
    this.pending = entities;
  }

  // Phaser drives update() every frame; we reconcile views to `pending` here so
  // creation/movement happens on the render thread, then interpolate positions.
  update(_time: number, delta: number): void {
    this.upsert(this.pending);
    this.interpolate(delta / 1000);
    // Apply the coalesced camera FX once per frame (strongest shake wins; one
    // flash) so a burst of simultaneous abilities can't stack into nausea.
    if (this.pendingShake > 0) {
      this.cameras.main.shake(180, this.pendingShake);
      this.pendingShake = 0;
    }
    if (this.pendingFlash) {
      this.cameras.main.flash(150, 255, 255, 255, false);
      this.pendingFlash = false;
    }
  }

  /** Upsert (create/move) present entities, destroy vanished ones. */
  private upsert(entities: Entity[]): void {
    const seen = new Set<string>();

    for (const e of entities) {
      seen.add(e.id);
      const view = this.views.get(e.id);
      if (view && view.kind === e.kind) {
        // New target position from the snapshot; the local entity snaps (it is
        // already client-predicted), remote entities interpolate (see interpolate()).
        view.targetX = e.x;
        view.targetY = e.y;
        if (e._local === true) {
          view.renderX = e.x;
          view.renderY = e.y;
        }
        this.updateAnimation(view, e);
        this.restyle(view, e);
        this.updateFx(view, e);
      } else {
        if (view) this.destroyView(view);
        const created = this.createView(e);
        this.updateAnimation(created, e);
        this.restyle(created, e);
        this.updateFx(created, e);
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

  /** Exponentially smooth each view's render position toward its target. */
  private interpolate(dt: number): void {
    const k = 1 - Math.exp(-LERP_RATE * dt);
    for (const view of this.views.values()) {
      view.renderX += (view.targetX - view.renderX) * k;
      view.renderY += (view.targetY - view.renderY) * k;
      const x = view.renderX;
      const y = view.renderY;
      view.body.setPosition(x, y);
      view.label?.setPosition(x, y - SPRITE_SIZE * 0.55);
      view.ring?.setPosition(x, y);
      view.halo?.setPosition(x, y);
      view.fxGlow?.setPosition(x, y);
    }
  }

  /**
   * For animated sprite views, pick idle vs walk + the facing animation and play
   * it (only when the key changed). Uses the smoothed render→target delta to
   * decide "moving", and prefers the wire `facing`, falling back to the motion
   * vector. No-op for shape fallbacks.
   */
  private updateAnimation(view: EntityView, e: Entity): void {
    if (!view.isSprite || !view.species) return;
    const dx = view.targetX - view.renderX;
    const dy = view.targetY - view.renderY;
    const moving = dx * dx + dy * dy > MOVE_EPS2;
    const facing: Dir8 = isDir8(e.facing) ? e.facing : facingFromVec(dx, dy, view.facing);
    view.facing = facing;
    const state = moving ? 'walk' : 'idle';
    const key = `${view.species}_${state}_${facing}`;
    if (view.anim !== key && this.anims.exists(key)) {
      (view.body as Phaser.GameObjects.Sprite).play(key, true);
      view.anim = key;
    }
  }

  /**
   * Re-apply the Three-Laws visual feedback for an entity, restyling only fields
   * that changed since the last frame. Sprites and shapes take different paths
   * (sprites can't setStrokeStyle/setFillStyle — they tint + use a halo arc).
   */
  private restyle(view: EntityView, e: Entity): void {
    if (e.kind === 'animal' || e.kind === undefined) {
      const hl = readNumber(e.humanLikeness);
      if (hl === view.humanLikeness) return;
      view.humanLikeness = hl;
      const human = hl !== undefined && hl >= HUMAN_THRESHOLD;
      const alpha = human ? 1 : 0.6 * (hl ?? 0) + 0.4;
      if (view.isSprite) {
        // A human-looking animal gets a white halo whose intensity tracks hl.
        this.styleHumanHalo(view, hl ?? 0, human, alpha);
      } else {
        const width = human ? 3 : 2;
        const color = human ? 0xffffff : 0xdddddd;
        (view.body as Phaser.GameObjects.Shape).setStrokeStyle(width, color, alpha);
      }
      return;
    }

    if (e.kind === 'robot') {
      const mode = readMode(e.mode);
      const suspicion = readNumber(e.suspicion) ?? 0;
      if (mode !== view.mode) {
        view.mode = mode;
        // frozen → cold blue (First-Law freeze), ordered → green (Second-Law
        // standdown), pursue → hostile red, idle → neutral.
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
        if (view.isSprite) {
          const sprite = view.body as Phaser.GameObjects.Sprite;
          // idle reads as the sprite's own colours (clear tint); modes tint it.
          if (mode === 'idle') sprite.clearTint();
          else sprite.setTint(fill);
        } else {
          const rect = view.body as Phaser.GameObjects.Rectangle;
          rect.setFillStyle(fill);
          rect.setStrokeStyle(2, stroke, 0.9);
        }
      }
      this.styleSuspicionRing(view, suspicion);
      return;
    }
  }

  /** Lazily create/update the white humanLikeness halo behind a sprite animal. */
  private styleHumanHalo(view: EntityView, hl: number, human: boolean, alpha: number): void {
    if (hl <= 0.05) {
      view.halo?.setVisible(false);
      return;
    }
    if (!view.halo) {
      view.halo = this.add
        .circle(view.renderX, view.renderY, SPRITE_SIZE * 0.55)
        .setStrokeStyle(2, 0xffffff, 1)
        .setFillStyle(0, 0)
        .setOrigin(0.5)
        .setDepth(DEPTH_MOBILE - 1);
    }
    const color = human ? 0xffffff : 0xdddddd;
    view.halo.setStrokeStyle(human ? 3 : 2, color, alpha).setVisible(true);
  }

  /** Lazily create/update the orange suspicion halo around a robot. */
  private styleSuspicionRing(view: EntityView, suspicion: number): void {
    if (suspicion === view.suspicion) return;
    view.suspicion = suspicion;
    if (suspicion <= 0.05) {
      view.ring?.setVisible(false);
      return;
    }
    if (!view.ring) {
      view.ring = this.add
        .circle(view.renderX, view.renderY, SPRITE_SIZE * 0.6)
        .setStrokeStyle(2, 0xffa500, 1)
        .setFillStyle(0, 0)
        .setOrigin(0.5)
        .setDepth(DEPTH_MOBILE);
    }
    view.ring.setStrokeStyle(2, 0xffa500, 0.3 + 0.7 * Math.min(1, suspicion)).setVisible(true);
  }

  /**
   * Detect a NEW ability activation (the fx.startTick rising edge) and fire a
   * one-shot burst; manage sustained glows (cloak/carry/shell/stink) that last
   * for the effect's duration. Cheap no-op when fx is absent/unchanged.
   */
  private updateFx(view: EntityView, e: Entity): void {
    const fx = e.fx;
    if (!fx || typeof fx.startTick !== 'number') {
      // Effect cleared: drop any sustained glow.
      if (view.fxGlow) { view.fxGlow.destroy(); view.fxGlow = undefined; }
      return;
    }
    if (fx.startTick === view.fxStartTick) return; // already handled this activation
    view.fxStartTick = fx.startTick;
    this.fireFx(view, fx.kind);
  }

  /** A short-lived particle burst at a view, using the soft dot texture. */
  private burst(
    view: EntityView,
    color: number,
    opts: { count?: number; speed?: number; life?: number; scale?: number; gravityY?: number } = {},
  ): void {
    const { count = 12, speed = 70, life = 380, scale = 0.6, gravityY = 0 } = opts;
    const emitter = this.add.particles(view.renderX, view.renderY, DOT_KEY, {
      lifespan: life,
      speed: { min: speed * 0.4, max: speed },
      scale: { start: scale, end: 0 },
      alpha: { start: 0.9, end: 0 },
      tint: color,
      gravityY,
      quantity: count,
      emitting: false,
    });
    emitter.setDepth(DEPTH_FX);
    emitter.explode(count);
    // Auto-clean after the longest particle dies.
    this.time.delayedCall(life + 60, () => emitter.destroy());
  }

  /** An expanding ring (shockwave / sound-wave / calm-wave) tween. */
  private ring(view: EntityView, color: number, opts: { r0?: number; r1?: number; life?: number; width?: number } = {}): void {
    const { r0 = 8, r1 = 70, life = 260, width = 3 } = opts;
    const arc = this.add
      .circle(view.renderX, view.renderY, r0)
      .setStrokeStyle(width, color, 1)
      .setFillStyle(0, 0)
      .setDepth(DEPTH_FX);
    this.tweens.add({
      targets: arc,
      radius: r1,
      alpha: 0,
      duration: life,
      ease: 'Cubic.easeOut',
      onComplete: () => arc.destroy(),
    });
  }

  /** A sustained glow ring around a view for the effect's duration (cloak/carry/shell). */
  private sustainGlow(view: EntityView, color: number): void {
    if (!view.fxGlow) {
      view.fxGlow = this.add
        .circle(view.renderX, view.renderY, SPRITE_SIZE * 0.5)
        .setStrokeStyle(3, color, 0.8)
        .setFillStyle(0, 0)
        .setDepth(DEPTH_FX);
    } else {
      view.fxGlow.setStrokeStyle(3, color, 0.8);
    }
  }

  /** A quick scale-pop tween on the body (flit/leap). */
  private pop(view: EntityView): void {
    const target = view.body;
    this.tweens.add({ targets: target, scaleY: 1.3, scaleX: 0.9, duration: 110, yoyo: true, ease: 'Sine.easeOut' });
  }

  /**
   * Fire the spectacular one-shot FX for an ability activation. Each is tuned to
   * its ability's flavour + colour; perf-guarded (small particle counts, short
   * lifespans, coalesced camera shake/flash). Sustained effects also set a glow.
   */
  private fireFx(view: EntityView, kind: string): void {
    switch (kind) {
      case 'carry': // ape: warm gold sustained glow + tiny sparkle
        this.sustainGlow(view, 0xffd700);
        this.burst(view, 0xffd700, { count: 8, speed: 40, life: 300, gravityY: -30 });
        break;
      case 'flit': // bird: cyan scale-pop + upward feather puff
        this.pop(view);
        this.burst(view, 0x4cc9f0, { count: 12, speed: 80, life: 420, gravityY: -60 });
        break;
      case 'skitter': // rat: gray dust puff at the feet
        this.burst(view, 0x9aa3ad, { count: 10, speed: 50, life: 300, gravityY: 40 });
        break;
      case 'shove': // elephant: shockwave ring + particle blast + camera shake
        this.ring(view, 0x5a6b7a, { r0: 10, r1: 85, life: 280, width: 4 });
        this.burst(view, 0xbfc6cf, { count: 16, speed: 110, life: 360 });
        this.pendingShake = Math.max(this.pendingShake, 0.012);
        break;
      case 'cloak': // chameleon: green sustained shimmer + soft burst
        this.sustainGlow(view, 0x6fcf97);
        this.burst(view, 0x6fcf97, { count: 10, speed: 50, life: 400 });
        break;
      case 'dazzle': // peacock: bright radial burst + flash + small shake
        this.ring(view, 0x2e6fd6, { r0: 8, r1: 100, life: 320, width: 3 });
        this.burst(view, 0x1f8a8a, { count: 16, speed: 120, life: 420 });
        this.pendingFlash = true;
        this.pendingShake = Math.max(this.pendingShake, 0.006);
        break;
      case 'stink': // skunk: sustained green/brown gas cloud
        this.sustainGlow(view, 0x9bb04a);
        this.burst(view, 0x6b7d3a, { count: 14, speed: 30, life: 600, gravityY: -20 });
        break;
      case 'burrow': // mole: brown dirt spray (the dig-down)
        this.burst(view, 0x6b4f2a, { count: 14, speed: 90, life: 360, gravityY: 60 });
        break;
      case 'dash': // cheetah: hot-yellow speed streak + small shake
        this.burst(view, 0xffd24a, { count: 12, speed: 130, life: 300 });
        this.pendingShake = Math.max(this.pendingShake, 0.004);
        break;
      case 'mimic': // parrot: green sound-wave rings (no red — distinct from order)
        this.ring(view, 0x3aa84a, { r0: 6, r1: 70, life: 320, width: 2 });
        this.ring(view, 0x3aa84a, { r0: 6, r1: 50, life: 220, width: 2 });
        break;
      case 'shell': // tortoise: stone-gray sustained glow + dust ring
        this.sustainGlow(view, 0x9a8a5a);
        this.ring(view, 0x7a6a3a, { r0: 8, r1: 40, life: 240, width: 3 });
        break;
      case 'leap': // kangaroo: pop + dust + sandy puff
        this.pop(view);
        this.burst(view, 0xc9925b, { count: 10, speed: 70, life: 360, gravityY: 50 });
        break;
      case 'hush': // owl: calming blue wave (the anti-lockdown colour)
        this.ring(view, 0x6aa0e0, { r0: 10, r1: 120, life: 600, width: 4 });
        break;
      case 'decoy': // fox: orange spawn puff
        this.burst(view, 0xd2691e, { count: 12, speed: 80, life: 360 });
        break;
      default:
        break;
    }
  }

  /** Build the per-kind visual for a freshly-seen entity. */
  private createView(e: Entity): EntityView {
    const base = (body: EntityView['body'], extra: Partial<EntityView> = {}): EntityView => ({
      body,
      isSprite: body instanceof Phaser.GameObjects.Sprite,
      kind: e.kind,
      renderX: e.x,
      renderY: e.y,
      targetX: e.x,
      targetY: e.y,
      facing: isDir8(e.facing) ? e.facing : 's',
      ...extra,
    });

    switch (e.kind) {
      case 'pen':
        return base(
          this.add
            .rectangle(e.x, e.y, PEN_SIZE, PEN_SIZE, 0x3a5a78, 0.12)
            .setStrokeStyle(2, 0x6fa8dc, 0.6)
            .setOrigin(0.5)
            .setDepth(DEPTH_PEN),
        );

      case 'hazard':
        // A skunk stink-cloud / fox lure zone: a translucent radius marker robots
        // avoid. Kept as a shape (the FX layer in Phase E animates a gas cloud).
        return base(
          this.add
            .circle(e.x, e.y, RECT_SIZE * 1.4, 0x6b7d3a, 0.18)
            .setStrokeStyle(2, 0x9bb04a, 0.5)
            .setOrigin(0.5)
            .setDepth(DEPTH_PROP),
        );

      case 'robot': {
        const sprite = this.makeSprite('robot', e);
        if (sprite) return base(sprite, { species: 'robot', label: this.makeLabel(e) });
        // Fallback: a steel-gray diamond (rotated square) — clearly not an animal.
        const body = this.add
          .rectangle(e.x, e.y, RECT_SIZE, RECT_SIZE, 0x9aa3ad)
          .setStrokeStyle(2, 0x2b2f36, 0.9)
          .setOrigin(0.5)
          .setAngle(45)
          .setDepth(DEPTH_MOBILE);
        return base(body, { species: 'robot', label: this.makeLabel(e) });
      }

      case 'terminal':
        return base(
          this.add
            .rectangle(e.x, e.y, MARKER_SIZE, MARKER_SIZE, 0x32d296)
            .setStrokeStyle(2, 0xffffff, 0.7)
            .setOrigin(0.5)
            .setDepth(DEPTH_PROP),
        );

      case 'gate':
        return base(
          this.add
            .rectangle(e.x, e.y, MARKER_SIZE * 0.5, MARKER_SIZE * 2, 0xe0a526)
            .setStrokeStyle(2, 0xffffff, 0.7)
            .setOrigin(0.5)
            .setDepth(DEPTH_PROP),
        );

      case 'prop':
        return base(
          this.add
            .rectangle(e.x, e.y, PROP_SIZE * 0.8, PROP_SIZE, 0xeef0f2)
            .setStrokeStyle(2, 0x6b7280, 0.9)
            .setOrigin(0.5)
            .setDepth(DEPTH_PROP),
        );

      case 'animal':
      default: {
        const species = typeof e.species === 'string' ? e.species : 'ape';
        const sprite = this.makeSprite(species, e);
        if (sprite) return base(sprite, { species, label: this.makeLabel(e) });
        // Fallback: the original per-species geometric shape.
        return base(this.makeAnimalBody(e), { species, label: this.makeLabel(e) });
      }
    }
  }

  /**
   * Create an animated sprite for `species` if the atlas has its animations,
   * else return undefined (caller draws the shape fallback). Starts on the
   * idle-south frame; updateAnimation switches it each frame.
   */
  private makeSprite(species: string, e: Entity): Phaser.GameObjects.Sprite | undefined {
    if (!this.atlasReady || !this.animatedSpecies.has(species)) return undefined;
    const startFrame = `${species}_idle_s_0`;
    if (!this.textures.get(ATLAS_KEY).has(startFrame)) return undefined;
    const sprite = this.add
      .sprite(e.x, e.y, ATLAS_KEY, startFrame)
      .setOrigin(0.5)
      .setDepth(DEPTH_MOBILE);
    sprite.setDisplaySize(SPRITE_SIZE, SPRITE_SIZE);
    return sprite;
  }

  /**
   * Build an animal's body SHAPE FALLBACK, varying shape by species and tinting
   * the id colour toward the species' family colour. Used only when the atlas (or
   * this species' frames) is unavailable.
   */
  private makeAnimalBody(e: Entity): Phaser.GameObjects.Shape {
    const species = typeof e.species === 'string' ? e.species : undefined;
    const tint = species !== undefined ? SPECIES_TINT[species] : undefined;
    const fill = tint !== undefined ? blendColors(colorFor(e.id), tint, 0.55) : colorFor(e.id);
    const stroke = 0xffffff;
    const alpha = 0.6;

    switch (species) {
      case 'bird': {
        const r = RECT_SIZE * 0.62;
        return this.add
          .triangle(e.x, e.y, 0, r, r, -r, -r, -r, fill)
          .setStrokeStyle(2, stroke, alpha)
          .setOrigin(0.5)
          .setDepth(DEPTH_MOBILE);
      }
      case 'rat': {
        const d = RECT_SIZE * 0.7;
        return this.add
          .rectangle(e.x, e.y, d, d, fill)
          .setStrokeStyle(2, stroke, alpha)
          .setOrigin(0.5)
          .setAngle(45)
          .setDepth(DEPTH_MOBILE);
      }
      case 'elephant': {
        const big = RECT_SIZE * 1.25;
        return this.add
          .rectangle(e.x, e.y, big, big, fill)
          .setStrokeStyle(2, stroke, alpha)
          .setOrigin(0.5)
          .setDepth(DEPTH_MOBILE);
      }
      case 'ape':
      default:
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
      .text(e.x, e.y - SPRITE_SIZE * 0.55, e.name ?? e.id.slice(0, 6), {
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
    view.halo?.destroy();
    view.fxGlow?.destroy();
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

/** Type guard: is `v` a valid Dir8 string? */
function isDir8(v: unknown): v is Dir8 {
  return (
    v === 's' || v === 'se' || v === 'e' || v === 'ne' ||
    v === 'n' || v === 'nw' || v === 'w' || v === 'sw'
  );
}

/** Deterministic pastel color from an entity id so each shape fallback is distinct. */
function colorFor(id: string): number {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0;
  const hue = h % 360;
  return hsvToInt(hue, 0.55, 0.95);
}

/** Linearly blend two 0xRRGGBB colours: `t` of `b` mixed into `a` (t in 0..1). */
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

    // Resolve once Phaser has booted. The boot sequence runs the scene's
    // preload (atlas load) → create (anims + dot texture) BEFORE firing the
    // game READY event, so by the time this resolves the atlas + animations are
    // ready and the first syncEntities is safe.
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
