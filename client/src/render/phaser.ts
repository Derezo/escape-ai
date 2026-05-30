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
import type { IRenderer, Entity, WorldMap } from '@shared/renderer';
import type { AuxKind, Building } from '@shared/world';
import type { Dir8 } from '@shared/types';
import { facingFromVec, hash32 } from '@shared/step';
import { locomotionFor } from '@shared/locomotion';
import { TILE_BY_INDEX } from '@shared/tiles';
import { foodByKey } from '@shared/food';

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
/** The committed procedural tileset texture key (Phase 7 art; flat-color fallback
 *  if absent). Packed 16-col / 32px / slot-index === tile-index — see buildWorld. */
const TILESET_ART_KEY = 'tileset';
/** Squared authoritative-position delta (per update) above which an entity reads
 *  as "moving". Small, so even a slow walk between snapshots registers, while
 *  float jitter on a standing entity does not. */
const MOVE_EPS2 = 0.25;
/** How long (ms) a "moving" state persists after the last detected move, so the
 *  walk cycle stays smooth across the gap between 20Hz snapshots (~50ms apart)
 *  and the local player's per-input-frame predicted moves. */
const MOVE_PERSIST_MS = 200;
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

/**
 * Per-auxKind roof tint, so the three SERVICE buildings (which hold the dispersed
 * food sources) READ DISTINCTLY from each other and from the brown species-home /
 * gatehouse roofs (default 0x6b4f3a). Warm/cool/grey keeps them legible at a glance.
 * Buildings with no auxKind (species homes + gatehouse) are NOT in this table and
 * keep the default roof colour — see the roof loop in buildWorld.
 */
const AUX_ROOF_TINT: Record<AuxKind, number> = {
  commissary: 0x9c5a3c, // warm terracotta (the food hall)
  washroom: 0x2f7d8c, // cool teal
  maintenance: 0x5b626b, // utilitarian grey
};

/**
 * Draw depths. With the tilemap world, mobile entities Y-SORT: their depth is
 * their world Y (so an entity lower on screen draws in front), which lets tree
 * canopies (also Y-sorted by their trunk-base Y) occlude an entity "under" them
 * while the solid trunk — pinned BELOW the Y-sort band — always draws behind the
 * entity. The Y-sort band spans the world height (0..~MAP_H*TILE), so the fixed
 * layers below/above it are pushed clear of that range.
 *
 *   ground tiles ........ DEPTH_GROUND        (terrain floor)
 *   solid deco tiles ..... DEPTH_DECO_GROUND   (trunks/walls/fences/rocks; below mobile)
 *   mobile + canopy ...... worldY              (Y-sorted: the band [0, ~4096])
 *   labels/halos/rings ... worldY + small      (track their entity, just above it)
 *   roof ................. DEPTH_ROOF          (occludes everything until it fades)
 *   fx .................. DEPTH_FX            (bursts/flashes, always on top)
 */
const DEPTH_GROUND = -200;
const DEPTH_DECO_GROUND = -100; // solid, non-canopy deco — always under mobile
const DEPTH_ROOF = 1_000_000; // building roofs (fade to reveal the interior)
/** Aux-building name labels + locked-door markers: just above the roof so they
 *  stay legible whether the roof is opaque (outside) or faded (inside), but below
 *  the FX layer. Static signage, not Y-sorted. */
const DEPTH_AUX_OVERLAY = 1_500_000;
const DEPTH_FX = 2_000_000; // ability effects, glows, particles (above everything)
/** Kept for the legacy no-map path (shape views before a map arrives). */
const DEPTH_PEN = -150;
const DEPTH_PROP = 1; // terminals / gates / hazards / quest objects (Y-sorted band base)
const DEPTH_MOBILE = 2; // animals / robots (overridden to worldY once a map is set)

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
  /** Previous target, to detect authoritative movement between updates. */
  prevTargetX: number;
  prevTargetY: number;
  /** Scene time (ms) until which the entity reads as "moving" (walk anim). A move
   *  refreshes this window so the walk cycle persists smoothly between the 20Hz
   *  snapshots that arrive far less often than the ~60fps render. */
  movingUntil: number;
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
  /** Decaying follow-time ring over a followed animal (a partial-sweep Graphics,
   *  redrawn each frame from the client-stamped _followFrac). Lazily created. */
  followRing?: Phaser.GameObjects.Graphics;
  /** Last follow fraction + ownership stamped on the view, so interpolate() can
   *  re-issue the ring draw at the entity's fresh position each frame. */
  followFrac?: number;
  followMine?: boolean;
  /** True for the local player's view (drives camera-follow + roof-fade probe). */
  isLocal?: boolean;
  /** Whether this kind Y-sorts (mobile entities + quest objects in the world band). */
  ysorted?: boolean;
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
  /** True once the committed tileset.png loaded; buildWorld uses the real art when
   *  set, else generates the flat-color fallback texture. */
  private tilesetArtReady = false;
  /** Species that have a full set of atlas frames (so anims exist for them). */
  private animatedSpecies = new Set<string>();
  /** Strongest camera-shake requested this frame (coalesced so shakes don't stack). */
  private pendingShake = 0;
  /** Whether a screen flash was requested this frame (coalesced to one). */
  private pendingFlash = false;

  /** A map handed in (before or after create()); built on the next update tick. */
  private pendingMap: WorldMap | null = null;
  /** True once buildWorld has stamped the tilemap (so we don't rebuild). */
  private worldBuilt = false;
  /** Per-building roof objects + footprint (world units), for the fade-on-enter. */
  private roofs: { rect: Phaser.GameObjects.Rectangle; bx0: number; by0: number; bx1: number; by1: number; inside: boolean }[] = [];
  /** Aux-building signage (name labels + 🔒 markers) created by buildAuxSignage.
   *  Tracked so a buildWorld re-run (new map) destroys the old set first — these are
   *  standalone text objects, not EntityViews, so destroyView never reaches them. */
  private auxSignage: Phaser.GameObjects.GameObject[] = [];
  /** The body the camera is currently following, so we RE-follow when the local
   *  player's view is recreated (kind change: the seeded {id,x,y} → 'animal'
   *  snapshot destroys+rebuilds the body, and a stale follow target freezes the
   *  camera). Null until the first follow. */
  private followTarget: Phaser.GameObjects.GameObject | null = null;

  constructor() {
    super('world');
  }

  /** Receive the world map (from PhaserRenderer.setMap). Built lazily in update()
   *  so it works whether it arrives before or after the scene's create(). */
  setMap(map: WorldMap): void {
    this.pendingMap = map;
  }

  preload(): void {
    // Relative paths (no leading slash) so they resolve under Vite base:'./'
    // and inside the Capacitor Android WebView. Missing files just leave the
    // atlas absent → the shape fallback takes over (handled in create/createView).
    this.load.atlas(ATLAS_KEY, './sprites/atlas.png', './sprites/atlas.json');
    // The committed procedural tileset (Phase 7 art). Packed to match buildWorld's
    // grid exactly (16 cols, 32px, slot-index === tile-index). If it 404s, the
    // loaderror clears the flag and buildWorld falls back to the flat-color
    // texture — the zero-art path stays fully intact.
    this.load.image(TILESET_ART_KEY, './tiles/tileset.png');
    this.load.on('loaderror', (file: Phaser.Loader.File) => {
      if (file.key === ATLAS_KEY) this.atlasReady = false;
      if (file.key === TILESET_ART_KEY) this.tilesetArtReady = false;
    });
  }

  create(): void {
    this.atlasReady = this.textures.exists(ATLAS_KEY);
    if (this.atlasReady) this.buildAnimations();
    this.tilesetArtReady = this.textures.exists(TILESET_ART_KEY);
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
    // Build the tilemap world the first frame a map is available (it may have
    // arrived before or after create()). Done here so the scene is fully booted.
    if (this.pendingMap && !this.worldBuilt) {
      this.buildWorld(this.pendingMap);
      this.pendingMap = null;
    }
    this.upsert(this.pending);
    this.interpolate(delta / 1000);
    this.updateRoofFade();
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

  /**
   * Build the tilemap world from the generated WorldMap: the tileset texture (the
   * committed procedural tileset.png when present, else a flat-color fallback),
   * three Phaser TilemapLayers (ground / deco-solid / canopy) with culling,
   * per-building roof rectangles for the fade-on-enter, and the camera bounds.
   * Mobile entities Y-sort against the canopy (see interpolate). Idempotent: runs
   * once (worldBuilt guards it).
   */
  private buildWorld(map: WorldMap): void {
    if (this.worldBuilt) return;
    this.worldBuilt = true;

    const TS = map.tile; // 32
    const worldPx = { w: map.w * TS, h: map.h * TS };

    // 1. The tileset TEXTURE. PREFER the committed procedural art (tileset.png,
    //    loaded in preload) — it is packed EXACTLY as this renderer lays tiles out:
    //    a 16-col grid of TS×TS cells with slot-index === tile-index (index 0 a
    //    blank/transparent cell). If that PNG is absent (zero-art clone / 404), we
    //    generate the FLAT-COLOR fallback texture with the identical grid math, so
    //    everything downstream (addTilesetImage, the canopy per-index frames) works
    //    unchanged regardless of which texture key is used.
    const cols = 16;
    const maxIndex = this.maxTileIndex();
    const rows = Math.ceil((maxIndex + 1) / cols);
    const FLAT_KEY = '__tileset_flat';
    let TILESET_KEY: string;
    if (this.tilesetArtReady && this.textures.exists(TILESET_ART_KEY)) {
      // Use the real art. Its layout is the spec above by construction (the build
      // pipeline packs by index in a 16-col / 32px grid — see scripts/build-tileset.js).
      TILESET_KEY = TILESET_ART_KEY;
    } else {
      // Zero-art fallback: one TS×TS colored cell per registry index, same grid.
      TILESET_KEY = FLAT_KEY;
      if (!this.textures.exists(FLAT_KEY)) {
        const g = this.add.graphics();
        for (let idx = 0; idx <= maxIndex; idx++) {
          const cx = (idx % cols) * TS;
          const cy = Math.floor(idx / cols) * TS;
          const color = fallbackTileColor(idx);
          if (color === null) continue; // empty / transparent (index 0, deco gaps)
          g.fillStyle(color, 1).fillRect(cx, cy, TS, TS);
          // A subtle inner border so adjacent same-color tiles still read as a grid
          // on solid structures (walls/fences) without art.
          if (idx !== 0 && TILE_BY_INDEX[idx]?.solid) {
            g.lineStyle(1, 0x000000, 0.25).strokeRect(cx + 0.5, cy + 0.5, TS - 1, TS - 1);
          }
        }
        g.generateTexture(FLAT_KEY, cols * TS, rows * TS);
        g.destroy();
      }
    }

    // 2. Build the three layers from the grids. The canopy layer carries only the
    //    'behind' tiles (drawn ABOVE mobile for walk-behind); the deco layer
    //    carries the rest of deco (solid trunks/walls/fences/rocks, below mobile).
    const tilemap = this.make.tilemap({ tileWidth: TS, tileHeight: TS, width: map.w, height: map.h });
    const ts = tilemap.addTilesetImage(TILESET_KEY, TILESET_KEY, TS, TS, 0, 0);
    if (!ts) return;

    const ground = tilemap.createBlankLayer('ground', ts, 0, 0)!;
    ground.setDepth(DEPTH_GROUND).setCullPadding(2, 2);
    this.fillLayer(ground, map.ground.data, map.w, map.h, () => true);

    const decoGround = tilemap.createBlankLayer('decoGround', ts, 0, 0)!;
    decoGround.setDepth(DEPTH_DECO_GROUND).setCullPadding(2, 2);
    this.fillLayer(decoGround, map.deco.data, map.w, map.h, (idx) => TILE_BY_INDEX[idx]?.ysort !== 'behind');

    // Canopy ('behind') tiles can't live on ONE tilemap layer: a layer has a
    // single depth, but each canopy must Y-sort against the player by its OWN
    // tree-base Y (a player south of a north tree should pass in front of that
    // canopy, behind a south one). There are only a few dozen canopy tiles, so we
    // spawn each as an individual image at depth = the tree base's worldY: a
    // mobile entity (depth = its worldY) below the base draws over the canopy, one
    // above draws under it. The base is one tile below the canopy cell (the trunk).
    this.buildCanopies(map, TS, TILESET_KEY, cols);

    // Roof grid tiles bake into per-building rectangles (below) for the fade, so
    // we DON'T draw the roof grid as a static layer — the rects own the roof.

    // 3. Per-building roof rectangles (fade on enter). Footprint in world units.
    //    AUXILIARY service buildings (b.auxKind set) get a distinct roof tint plus
    //    always-visible signage (name label + locked-door marker) so the three food
    //    halls read apart even with the roof faded. Species homes + the gatehouse
    //    (no auxKind) keep the default brown roof and get no signage — unchanged.
    //    Clear any prior roofs + signage first so a rebuild (new map) never leaks the
    //    previous map's standalone objects (they aren't EntityViews → not swept).
    for (const r of this.roofs) r.rect.destroy();
    this.roofs.length = 0;
    for (const s of this.auxSignage) s.destroy();
    this.auxSignage.length = 0;
    for (const b of map.buildings) {
      const bx = b.rx * TS;
      const by = b.ry * TS;
      const bw = b.rw * TS;
      const bh = b.rh * TS;
      const roofColor = b.auxKind !== undefined ? AUX_ROOF_TINT[b.auxKind] : 0x6b4f3a;
      const rect = this.add
        .rectangle(bx + bw / 2, by + bh / 2, bw, bh, roofColor, 1)
        .setStrokeStyle(2, 0x4a3526, 1)
        .setDepth(DEPTH_ROOF);
      this.roofs.push({ rect, bx0: bx, by0: by, bx1: bx + bw, by1: by + bh, inside: false });
      if (b.auxKind !== undefined) this.buildAuxSignage(b, TS);
    }

    // 4. Camera: bound to the world and (later) follow the local player.
    this.cameras.main.setBounds(0, 0, worldPx.w, worldPx.h);
  }

  /**
   * Static signage for one AUXILIARY building (commissary / washroom / maintenance):
   * a title-cased name label centred over the footprint, plus a 🔒 marker pinned at
   * the door. Both sit ABOVE the roof (DEPTH_AUX_OVERLAY) so they stay readable
   * whether the roof is opaque (player outside) or faded (player inside), letting
   * the three food halls be told apart at a glance. Drawn once in buildWorld.
   *
   * LOCK STATE IS STATIC. We render the door as locked iff `b.locked` — the
   * generator's DEFAULT lock state from the seed-derived map. The SERVER owns the
   * LIVE unlocked set (a room unlocks when its door-terminal is ordered), but that
   * state is NOT on the wire today: the snapshot's terminal/food/robot entities
   * carry no per-building unlock flag, so there is no client-observable signal to
   * drive a live indicator. Wiring the marker to clear on unlock requires a
   * server-sent flag (e.g. an `unlocked` field on the door-terminal entity or a
   * map-room state message) — a future net addition, out of scope for this client
   * phase. Until then the marker simply shows the initial locked state.
   */
  private buildAuxSignage(b: Building, TS: number): void {
    const auxKind = b.auxKind;
    if (auxKind === undefined) return; // caller guards, but keep this total + strict-safe
    const bx = b.rx * TS;
    const by = b.ry * TS;
    const bw = b.rw * TS;

    // Name label, centred over the building, just below its top edge.
    const label = this.add
      .text(bx + bw / 2, by + 4, titleCase(auxKind), {
        fontFamily: 'monospace',
        fontSize: '13px',
        color: '#ffffff',
        backgroundColor: 'rgba(0,0,0,0.45)',
        padding: { x: 4, y: 2 },
      })
      .setOrigin(0.5, 0)
      .setDepth(DEPTH_AUX_OVERLAY);
    this.auxSignage.push(label);

    // Locked-door marker at the door tile centre (static — see method doc).
    if (b.locked === true) {
      const dx = b.doorTx * TS + TS / 2;
      const dy = b.doorTy * TS + TS / 2;
      const marker = this.add
        .text(dx, dy, '🔒', { fontFamily: 'sans-serif', fontSize: '16px' })
        .setOrigin(0.5)
        .setDepth(DEPTH_AUX_OVERLAY);
      this.auxSignage.push(marker);
    }
  }

  /**
   * Spawn each 'behind' (canopy) deco tile as an individual Y-sorted image, so a
   * canopy occludes only the entities "under" it. Depth = the tree base's worldY
   * (the trunk one tile south of the canopy cell), so a mobile entity (depth =
   * its own worldY) below the base draws OVER the canopy, above the base draws
   * UNDER it. Uses a per-index frame on the tileset texture (the committed
   * procedural art, or the flat-color fallback). Canopies are few (tens), so
   * individual images are cheap.
   */
  private buildCanopies(map: WorldMap, TS: number, tilesetKey: string, cols: number): void {
    const tex = this.textures.get(tilesetKey);
    const data = map.deco.data;
    for (let ty = 0; ty < map.h; ty++) {
      for (let tx = 0; tx < map.w; tx++) {
        const idx = data[ty * map.w + tx];
        if (idx === 0 || TILE_BY_INDEX[idx]?.ysort !== 'behind') continue;
        // Register a frame for this index once (slot in the packed grid).
        const frameName = `t${idx}`;
        if (!tex.has(frameName)) {
          tex.add(frameName, 0, (idx % cols) * TS, Math.floor(idx / cols) * TS, TS, TS);
        }
        const wx = tx * TS + TS / 2;
        const wy = ty * TS + TS / 2;
        // Tree base = the trunk one tile south (canopy at ty, trunk at ty+1).
        const baseY = (ty + 1) * TS + TS / 2;
        this.add.image(wx, wy, tilesetKey, frameName).setOrigin(0.5).setDepth(baseY);
      }
    }
  }

  /** Stamp a grid's tile indices into a layer, filtered by `keep(index)`. */
  private fillLayer(
    layer: Phaser.Tilemaps.TilemapLayer,
    data: Uint16Array,
    w: number,
    h: number,
    keep: (index: number) => boolean,
  ): void {
    for (let ty = 0; ty < h; ty++) {
      for (let tx = 0; tx < w; tx++) {
        const idx = data[ty * w + tx];
        if (idx === 0 || !keep(idx)) continue;
        layer.putTileAt(idx, tx, ty);
      }
    }
  }

  /** Highest tile index in the registry (for sizing the flat tileset texture). */
  private maxTileIndex(): number {
    let m = 0;
    for (const k of Object.keys(TILE_BY_INDEX)) m = Math.max(m, Number(k));
    return m;
  }

  /**
   * Fade each building roof in/out as the LOCAL player enters/leaves its
   * footprint. Edge-triggered (a tween only on the inside↔outside flip) so it's
   * cheap and smooth. The interior (floor/walls drawn underneath) is revealed
   * when the roof reaches alpha 0.
   */
  private updateRoofFade(): void {
    if (this.roofs.length === 0) return;
    // Find the local player's interpolated position.
    let px: number | undefined;
    let py: number | undefined;
    for (const v of this.views.values()) {
      if (v.isLocal) { px = v.renderX; py = v.renderY; break; }
    }
    if (px === undefined || py === undefined) return;
    for (const r of this.roofs) {
      const inside = px >= r.bx0 && px < r.bx1 && py >= r.by0 && py < r.by1;
      if (inside === r.inside) continue;
      r.inside = inside;
      this.tweens.add({
        targets: r.rect,
        alpha: inside ? 0 : 1,
        duration: 220,
        ease: 'Sine.easeOut',
      });
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
        view.isLocal = e._local === true;
        if (e._local === true) {
          view.renderX = e.x;
          view.renderY = e.y;
          this.startFollow(view);
        }
        this.updateAnimation(view, e);
        this.restyle(view, e);
        this.updateFx(view, e);
        this.updateFollowRing(view, e);
      } else {
        if (view) this.destroyView(view);
        const created = this.createView(e);
        created.isLocal = e._local === true;
        this.updateAnimation(created, e);
        this.restyle(created, e);
        this.updateFx(created, e);
        this.updateFollowRing(created, e);
        this.views.set(e.id, created);
        if (e._local === true) this.startFollow(created);
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
    for (const [id, view] of this.views.entries()) {
      view.renderX += (view.targetX - view.renderX) * k;
      view.renderY += (view.targetY - view.renderY) * k;
      const x = view.renderX;
      const y = view.renderY;
      // AIRBORNE FLUTTER: a 'fly' species (bird) gets a small vertical bob applied
      // to the BODY ONLY — purely cosmetic, off the render clock, so it never
      // touches the authoritative position, the Y-sort depth (still `y` below), or
      // the adornments. Per-bird phase via hash32(id) so a flock desyncs. The gait
      // comes from the shared locomotion registry by species (no wire field needed).
      const bobY = this.flutterBob(id, view);
      view.body.setPosition(x, y + bobY);
      view.label?.setPosition(x, y - SPRITE_SIZE * 0.55);
      view.ring?.setPosition(x, y);
      view.halo?.setPosition(x, y);
      view.fxGlow?.setPosition(x, y);
      // The follow ring is a Graphics drawn at absolute coords + (re)animated for
      // its pulse, so redraw it at the fresh position each frame while active.
      if (view.followRing && view.followFrac !== undefined) this.drawFollowRing(view);
      // Y-SORT: once a tilemap world exists, a mobile entity's depth is its world
      // Y, so it draws in front of things above it (smaller Y) and behind things
      // below it — including the canopy layer at mid-band, giving the walk-behind
      // -trees effect. Labels/rings/halos track just above their body's band.
      if (view.ysorted && this.worldBuilt) {
        // Whole-unit offsets: at large worldY (the southern map, y up to ~4096) a
        // sub-unit offset like 0.1 can collapse under float precision and let the
        // halo/ring z-fight the body. ±1 is imperceptible spatially but keeps the
        // stacking order stable across the whole band. (Adornments sit within the
        // same tile, so a 1-unit depth nudge never crosses another entity's band.)
        view.body.setDepth(y);
        view.label?.setDepth(y + 2);
        view.ring?.setDepth(y + 1);
        view.halo?.setDepth(y - 1);
      }
    }
  }

  /**
   * The cosmetic vertical bob for an airborne ('fly') sprite, in pixels, this
   * frame. Zero for any non-fly species or shape fallback. A sine wave off the
   * render clock (this.time.now), phased per-entity by hash32(id) so a flock
   * desyncs. The gait + bob params come from the shared locomotion registry by
   * species — no wire field. Render-only: it never touches the entity's true
   * position, so collision/Y-sort/parity are unaffected (flight stays cosmetic).
   */
  private flutterBob(id: string, view: EntityView): number {
    if (!view.isSprite || !view.species) return 0;
    const prof = locomotionFor(view.species);
    if (prof.gait !== 'fly' || !prof.bob) return 0;
    // periodTicks → ms at the 20Hz sim rate (the bob is decorative, so an exact
    // tick is unnecessary; the render clock keeps it smooth at any frame rate).
    const periodMs = prof.bob.periodTicks * 50;
    const phase = (hash32(id) % 1000) / 1000; // 0..1 per-entity offset
    const t = this.time.now / periodMs + phase;
    return Math.sin(t * Math.PI * 2) * prof.bob.ampPx;
  }

  /**
   * Make the camera follow the local player's body. Called every frame the local
   * view is seen; it (re)starts the follow whenever the followed body CHANGES —
   * which happens not just on first sight but each time the view is recreated (the
   * seeded {id,x,y} view is destroyed and rebuilt when the first snapshot adds
   * kind:'animal'). Following a destroyed body silently freezes the camera, so we
   * must re-point it at the live body. Requires the map (bounds) to exist first.
   */
  private startFollow(view: EntityView): void {
    if (!this.worldBuilt) return;
    if (this.followTarget === view.body) return; // already following this body
    this.followTarget = view.body;
    const cam = this.cameras.main;
    cam.startFollow(view.body, true, 0.12, 0.12);
    // Snap to the player immediately (within bounds) so the first frame is framed
    // on the avatar instead of easing in from the previous scroll. Near the world
    // edge (e.g. spawning by the gate) the bounds clamp still pins the camera —
    // that's correct: it can't scroll past the edge, so the player rides toward
    // the screen edge until it's more than half a viewport inward.
    cam.centerOn(view.renderX, view.renderY);
  }

  /**
   * For animated sprite views, pick idle vs walk + the facing animation and play
   * it (only when the key changed). "Moving" is driven by the AUTHORITATIVE target
   * position changing (works identically for the local player — which snaps — and
   * remote players — which interpolate); a move opens a short persistence window
   * so the walk cycle stays smooth between the 20Hz snapshots (far sparser than
   * the ~60fps render). Facing prefers the wire `facing`, then the move vector.
   * No-op for shape fallbacks.
   */
  private updateAnimation(view: EntityView, e: Entity): void {
    if (!view.isSprite || !view.species) return;
    const tdx = view.targetX - view.prevTargetX;
    const tdy = view.targetY - view.prevTargetY;
    view.prevTargetX = view.targetX;
    view.prevTargetY = view.targetY;
    if (tdx * tdx + tdy * tdy > MOVE_EPS2) {
      view.movingUntil = this.time.now + MOVE_PERSIST_MS;
    }
    const moving = this.time.now < view.movingUntil;
    const facing: Dir8 = isDir8(e.facing) ? e.facing : facingFromVec(tdx, tdy, view.facing);
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
   * Draw / update the decaying follow-time ring over a followed animal. The
   * remaining FRACTION is stamped client-side in main.ts (the only place holding
   * the server tick) onto `e._followFrac` (0..1), with `e._followMine` flagging
   * the local player's own herd. The ring is a partial sweep that shrinks as the
   * follow lapses (Graphics, not Arc — Arc can't redraw a sweep each frame), with
   * a green→amber→red colour ramp and a subtle pulse near expiry. Drawn at the
   * entity's interpolated position in interpolate(); torn down in destroyView.
   */
  private updateFollowRing(view: EntityView, e: Entity): void {
    const frac = typeof e._followFrac === 'number' ? e._followFrac : undefined;
    if (frac === undefined || frac <= 0) {
      // Not following (or lapsed): drop the ring if one exists.
      if (view.followRing) { view.followRing.destroy(); view.followRing = undefined; }
      view.followFrac = undefined;
      view.followMine = undefined;
      return;
    }
    if (!view.followRing) {
      view.followRing = this.add.graphics().setDepth(DEPTH_FX);
    }
    // Stash the data; the actual draw happens in drawFollowRing() — called here on
    // a data change AND every frame from interpolate() so the ring tracks the
    // entity's moving position (a Graphics arc is drawn at absolute coords).
    view.followFrac = frac;
    view.followMine = e._followMine === true;
    this.drawFollowRing(view);
  }

  /** Redraw the follow ring at the view's current render position from its stashed
   *  fraction/ownership. Cheap; called each frame from interpolate() while active. */
  private drawFollowRing(view: EntityView): void {
    const g = view.followRing;
    const frac = view.followFrac;
    if (!g || frac === undefined) return;
    // Colour ramp: full = green, half = amber, empty = red.
    const color = frac > 0.5
      ? blendColors(0xffd24a, 0x6fcf97, (frac - 0.5) * 2) // amber → green
      : blendColors(0xe05a5a, 0xffd24a, Math.max(0, frac) * 2); // red → amber
    const mine = view.followMine === true;
    // A subtle pulse on alpha + radius once it's nearly out (< 18%).
    const pulse = frac < 0.18 ? 0.75 + 0.25 * Math.sin(this.time.now / 90) : 1;
    const alpha = (mine ? 0.95 : 0.7) * pulse;
    const width = mine ? 4 : 2.5;
    const r = SPRITE_SIZE * 0.62 * pulse;
    // Sweep clockwise from the top (−90°) proportional to the remaining fraction.
    const start = -Math.PI / 2;
    const end = start + Math.PI * 2 * frac;
    g.clear();
    g.lineStyle(width, color, alpha);
    g.beginPath();
    g.arc(view.renderX, view.renderY, r, start, end, false);
    g.strokePath();
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
    // Clear any sustained glow from a PREVIOUS effect before the new activation,
    // so a one-shot (e.g. flit) firing while a sustained glow (e.g. cloak) is
    // still live doesn't orphan the old Arc. fireFx re-creates a glow if the new
    // effect is itself sustained.
    if (view.fxGlow) { view.fxGlow.destroy(); view.fxGlow = undefined; }
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
      case 'collect': // food pickup: a small gold sparkle rising off the player
        this.burst(view, 0xffd24a, { count: 8, speed: 50, life: 320, gravityY: -40 });
        break;
      case 'feed': // recruited a follower: a warm green confirm ring + soft burst
        this.ring(view, 0x6fcf97, { r0: 8, r1: 56, life: 300, width: 3 });
        this.burst(view, 0x9be0b0, { count: 8, speed: 50, life: 320 });
        break;
      case 'steal': // stole a follower: a contested red/gold burst + a quick flash
        this.burst(view, 0xe05a5a, { count: 14, speed: 110, life: 360 });
        this.burst(view, 0xffd24a, { count: 8, speed: 70, life: 300 });
        this.pendingFlash = true;
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
      prevTargetX: e.x,
      prevTargetY: e.y,
      movingUntil: 0,
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
        if (sprite) return base(sprite, { species: 'robot', label: this.makeLabel(e), ysorted: true });
        // Fallback: a steel-gray diamond (rotated square) — clearly not an animal.
        const body = this.add
          .rectangle(e.x, e.y, RECT_SIZE, RECT_SIZE, 0x9aa3ad)
          .setStrokeStyle(2, 0x2b2f36, 0.9)
          .setOrigin(0.5)
          .setAngle(45)
          .setDepth(DEPTH_MOBILE);
        return base(body, { species: 'robot', label: this.makeLabel(e), ysorted: true });
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

      case 'questObject':
        // A per-species objective marker: a small glowing diamond, Y-sorted so it
        // sits naturally among the entities in its enclosure. (Phase 6 reads the
        // species/quest; this is the on-field marker the player fetches/reaches.)
        return base(
          this.add
            .star(e.x, e.y, 4, MARKER_SIZE * 0.3, MARKER_SIZE * 0.6, 0xffe066)
            .setStrokeStyle(2, 0xfff4b0, 0.9)
            .setOrigin(0.5)
            .setDepth(DEPTH_PROP),
          { ysorted: true, label: this.makeLabel(e) },
        );

      case 'food': {
        // A per-species food source: a small rounded pip tinted to its food, with
        // a label naming the food. Y-sorted so it tucks into the enclosure among
        // the entities. Collected food never depletes the source (renewable), so
        // the view just lives until the entity leaves the snapshot. Vector-only.
        const foodKey = typeof e.foodKey === 'string' ? e.foodKey : undefined;
        const tint = (foodKey !== undefined ? foodByKey(foodKey)?.tint : undefined) ?? 0xffcf6a;
        return base(
          this.add
            .star(e.x, e.y, 6, MARKER_SIZE * 0.22, MARKER_SIZE * 0.5, tint)
            .setStrokeStyle(2, 0xfff0c0, 0.9)
            .setOrigin(0.5)
            .setDepth(DEPTH_PROP),
          { ysorted: true, label: this.makeLabel(e) },
        );
      }

      case 'animal':
      default: {
        const species = typeof e.species === 'string' ? e.species : 'ape';
        const sprite = this.makeSprite(species, e);
        if (sprite) return base(sprite, { species, label: this.makeLabel(e), ysorted: true });
        // Fallback: the original per-species geometric shape.
        return base(this.makeAnimalBody(e), { species, label: this.makeLabel(e), ysorted: true });
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
    view.followRing?.destroy();
  }
}

/** Read a 0..1-ish numeric field, returning undefined for absent/NaN values. */
function readNumber(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}

/** Title-case a single-word identifier (e.g. 'commissary' → 'Commissary'). */
function titleCase(s: string): string {
  return s.length === 0 ? s : s[0].toUpperCase() + s.slice(1);
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

/**
 * Flat fallback color for a tile index (used until Phase 7 ships the real tileset
 * PNG). Returns null for tiles that should be transparent (empty, and deco tiles
 * are drawn on a transparent cell so the ground shows through). Grouped by the
 * tile's semantic NAME prefix so the whole zoo reads correctly with zero art:
 * grass green, paths gray, water blue, walls/roofs brown, fences tan, etc.
 */
function fallbackTileColor(idx: number): number | null {
  const def = TILE_BY_INDEX[idx];
  if (!def || idx === 0) return null;
  const name = def.name;
  // Ground tiles fill their whole cell; deco tiles draw on transparent so the
  // ground beneath shows (except solid structures, which get an opaque body).
  if (name.startsWith('GRASS')) return 0x4f7a3a;
  if (name.startsWith('DIRT') || name.startsWith('MUD')) return 0x7a5a38;
  if (name.startsWith('PAVED') || name.startsWith('COBBLE') || name.startsWith('PATH')) return 0x8b8b93;
  if (name.startsWith('SAND')) return 0xd4c483;
  if (name.startsWith('WATER') || name.startsWith('POND')) return name.includes('DEEP') ? 0x2f5d8a : 0x3f86c0;
  if (name.startsWith('FLOOR') || name.startsWith('PEN_FLOOR') || name === 'HEAT_LAMP_FLOOR') return 0xb8a888;
  // Deco / structures (drawn on transparent cells over the ground).
  if (name.startsWith('TREE_CANOPY') || name === 'PINE_CANOPY') return 0x35702f;
  if (name.includes('TRUNK') || name === 'LOG' || name === 'STUMP') return 0x5a3f24;
  if (name.startsWith('BUSH') || name === 'GRASS_TALL' || name === 'REEDS' || name === 'CATTAILS') return 0x3c6b30;
  if (name.startsWith('ROCK') || name === 'BOULDER' || name.startsWith('ROCKY_DEN')) return 0x807a72;
  if (name.startsWith('FLOWER')) return 0xd9627a;
  if (name.startsWith('WALL') || name === 'WINDOW' || name === 'DOOR_CLOSED') return 0x8a6b4a;
  if (name === 'DOOR_OPEN') return 0x3a2a1a;
  if (name.startsWith('ROOF')) return 0x9a4a3a;
  if (name.startsWith('FENCE') || name.startsWith('CAGE')) return 0xb0894f;
  if (name.startsWith('AVIARY') || name.startsWith('ENCLOSURE') || name === 'MOAT_EDGE' || name === 'KEEPER_GATE' || name === 'SHADE_CLOTH') return 0x9aa3ad;
  if (name === 'LILY_PAD' || name === 'LILY_FLOWER' || name === 'NEST' || name === 'BURROW_MOUND' || name === 'MUSHROOM') return 0x4a7a4a;
  // Props.
  return 0xb0b0b8;
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

  setMap(map: WorldMap): void {
    this.scene?.setMap(map);
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
