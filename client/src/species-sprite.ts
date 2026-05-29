/**
 * A pure DOM/CSS animated species sprite, driven by the SAME packed atlas the
 * Phaser renderer uses (assets/sprites/atlas.{png,json}). Reused by BOTH the
 * login species selector (menu.ts) and the help widget's Species tab (help.ts).
 *
 * Why DOM and not Phaser? The login + help chrome are renderer-agnostic overlays
 * (see ARCHITECTURE.md) and must work even when the 3D renderer is swapped in —
 * so the sprites here paint via `background-image`, never via the game canvas.
 *
 * Animation strategy: a per-species CSS `@keyframes` that steps the
 * `background-position` through the four south-facing walk frames
 * (`<species>_walk_s_0..3`), driven by `steps(4)`. CSS animation means there are
 * NO JS timers to track or clear — the help widget can rebuild the Species tab
 * freely without leaking intervals. Keyframes are generated once per species and
 * cached in a single shared <style> element.
 *
 * Crispness: the placeholder atlas is pixel-art, so the element renders with
 * `image-rendering: pixelated` and we scale by adjusting `background-size`
 * (atlasW*scale × atlasH*scale) plus a scaled `background-position`.
 *
 * Graceful fallback: if `./sprites/atlas.json` 404s (zero-art boot), every
 * sprite shows a coloured block tinted by a species→colour map (mirroring the
 * renderer's SPECIES_TINT). When the atlas loads later, in-flight blocks are
 * upgraded to the real animated sprite — the load is kicked off the first time a
 * component is created.
 */

/** Where the atlas image is served (relative, so it works under Vite base:'./'). */
const ATLAS_IMG = './sprites/atlas.png';
/** Where the atlas frame map is served. */
const ATLAS_JSON = './sprites/atlas.json';

/** Atlas walk-cycle frame count (matches the renderer's `walk: 4`). */
const WALK_FRAMES = 4;
/** Seconds for one full 4-frame walk cycle (≈ the renderer's 10fps walk feel). */
const WALK_CYCLE_S = 0.45;

/** One packed frame's rect within the atlas image. */
interface FrameRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** The parsed atlas: the frame-name → rect map plus the source image size. */
export interface AtlasFrames {
  frames: Record<string, FrameRect>;
  /** Atlas image width/height (needed to scale background-size). */
  width: number;
  height: number;
}

/**
 * Per-species fallback colour (CSS) for the no-atlas block. The first four
 * mirror the renderer's SPECIES_TINT exactly (values copied, NOT imported — the
 * renderer pulls in Phaser, which this DOM component must not). The rest pick
 * distinct, on-theme hues so every species reads as its own thing.
 */
const SPECIES_COLOR: Record<string, string> = {
  ape: '#8d6e4f', // warm brown   (SPECIES_TINT.ape)
  bird: '#4cc9f0', // cyan         (SPECIES_TINT.bird)
  rat: '#9aa3ad', // gray         (SPECIES_TINT.rat)
  elephant: '#5a6b7a', // slate    (SPECIES_TINT.elephant)
  chameleon: '#6fcf97', // green
  peacock: '#2e6fd6', // royal blue
  skunk: '#9bb04a', // olive
  mole: '#6b4f2a', // dark earth
  cheetah: '#ffd24a', // amber
  parrot: '#3aa84a', // parrot green
  tortoise: '#9a8a5a', // shell tan
  kangaroo: '#c9925b', // sandy
  owl: '#6aa0e0', // dusk blue
  fox: '#d2691e', // chocolate/orange
};

/** Stable fallback for an unknown species key (shouldn't happen with @shared roster). */
const DEFAULT_COLOR = '#6c7888'; // theme `muted`

/**
 * Shared, lazily-created cache of the atlas fetch so repeated `loadAtlas()`
 * calls (login + every help open) share ONE network request. null = not yet
 * fetched; a settled promise resolving to AtlasFrames|null otherwise.
 */
let atlasPromise: Promise<AtlasFrames | null> | undefined;

/** The shared <style> element holding the generated per-species @keyframes. */
let keyframeStyle: HTMLStyleElement | undefined;
/** Species we've already emitted a @keyframes rule for (so we write each once). */
const keyframesWritten = new Set<string>();

/**
 * Fetch + parse the atlas frame map once (cached). Returns null on any failure
 * (missing file, bad JSON) so callers fall back to coloured blocks. The shape is
 * `{ "frames": { name: { frame:{x,y,w,h} } }, "meta": { size:{w,h} } }`.
 */
export function loadAtlas(): Promise<AtlasFrames | null> {
  if (atlasPromise) return atlasPromise;
  atlasPromise = (async (): Promise<AtlasFrames | null> => {
    try {
      const res = await fetch(ATLAS_JSON);
      if (!res.ok) return null;
      const data: unknown = await res.json();
      if (typeof data !== 'object' || data === null) return null;
      const d = data as {
        frames?: Record<string, { frame?: FrameRect }>;
        meta?: { size?: { w?: number; h?: number } };
      };
      if (!d.frames) return null;
      // Flatten the `{ frame:{x,y,w,h} }` wrapper into a name → rect map.
      const frames: Record<string, FrameRect> = {};
      for (const [name, entry] of Object.entries(d.frames)) {
        const f = entry?.frame;
        if (f && typeof f.x === 'number' && typeof f.y === 'number') frames[name] = f;
      }
      // Atlas image size: prefer meta.size; else derive from the frame extents.
      let width = d.meta?.size?.w ?? 0;
      let height = d.meta?.size?.h ?? 0;
      if (!width || !height) {
        for (const f of Object.values(frames)) {
          width = Math.max(width, f.x + f.w);
          height = Math.max(height, f.y + f.h);
        }
      }
      if (!width || !height) return null;
      return { frames, width, height };
    } catch {
      return null; // network error / not served → coloured-block fallback
    }
  })();
  return atlasPromise;
}

/** Look up the colour for a species' fallback block. */
function colorFor(species: string): string {
  return SPECIES_COLOR[species] ?? DEFAULT_COLOR;
}

/** Lazily get the shared <style> element that holds the walk @keyframes. */
function styleSheet(): HTMLStyleElement {
  if (!keyframeStyle) {
    keyframeStyle = document.createElement('style');
    keyframeStyle.id = 'species-sprite-keyframes';
    document.head.appendChild(keyframeStyle);
  }
  return keyframeStyle;
}

/**
 * Emit (once) a `@keyframes` rule that steps `background-position` across this
 * species' four south-walk frames at the requested display scale. Returns the
 * animation name, or undefined if the species has no walk frames in the atlas
 * (caller then leaves the element on its idle/first frame or fallback).
 *
 * The keyframe name encodes the scale (rounded) so two different display sizes
 * for the same species don't collide on one rule.
 */
function ensureWalkKeyframes(species: string, atlas: AtlasFrames, scale: number): string | undefined {
  const scaleTag = Math.round(scale * 1000);
  const animName = `walk_${species}_${scaleTag}`;
  if (keyframesWritten.has(animName)) return animName;

  // Collect the contiguous run of walk-south frames that actually exist.
  const rects: FrameRect[] = [];
  for (let i = 0; i < WALK_FRAMES; i++) {
    const rect = atlas.frames[`${species}_walk_s_${i}`];
    if (rect) rects.push(rect);
  }
  if (rects.length === 0) return undefined;

  // One keyframe stop per frame; `steps()` on the consumer makes it discrete.
  // background-position is the negative scaled top-left of each frame.
  const stopPct = 100 / rects.length;
  const stops: string[] = rects.map((r, i) => {
    const px = -(r.x * scale);
    const py = -(r.y * scale);
    return `${(i * stopPct).toFixed(4)}% { background-position: ${px}px ${py}px; }`;
  });
  // Close the loop back to the first frame so steps() lands cleanly.
  const first = rects[0];
  stops.push(`100% { background-position: ${-(first.x * scale)}px ${-(first.y * scale)}px; }`);

  styleSheet().appendChild(
    document.createTextNode(`@keyframes ${animName} {\n${stops.join('\n')}\n}\n`),
  );
  keyframesWritten.add(animName);
  return animName;
}

/**
 * Paint `el` as the real animated atlas sprite for `species` at `scale`. Sets
 * the atlas as the background, sizes it (atlas px × scale), parks it on the
 * first walk frame, and applies the stepped walk keyframes if present. If the
 * species has no atlas frames, leaves the fallback block in place.
 */
function paintSprite(el: HTMLElement, species: string, atlas: AtlasFrames, displaySize: number): void {
  const first = atlas.frames[`${species}_walk_s_0`] ?? atlas.frames[`${species}_idle_s_0`];
  if (!first) return; // no frames for this species → keep coloured block
  const scale = displaySize / first.w;

  el.classList.add('species-sprite--loaded');
  el.style.backgroundColor = 'transparent';
  el.style.backgroundImage = `url(${ATLAS_IMG})`;
  el.style.backgroundRepeat = 'no-repeat';
  el.style.backgroundSize = `${atlas.width * scale}px ${atlas.height * scale}px`;
  el.style.backgroundPosition = `${-(first.x * scale)}px ${-(first.y * scale)}px`;

  const animName = ensureWalkKeyframes(species, atlas, scale);
  if (animName) {
    // steps(N) makes the position jump between frames rather than smear.
    el.style.animation = `${animName} ${WALK_CYCLE_S}s steps(${WALK_FRAMES}) infinite`;
  }
}

/** Options for {@link createSpeciesSprite}. */
export interface SpeciesSpriteOpts {
  /** Display edge length in px (the 64px atlas frame is scaled to this). Default 64. */
  size?: number;
}

/**
 * Build a self-contained animated species sprite element.
 *
 * Returns a `<div>` immediately. If the atlas is already loaded it paints the
 * real sprite synchronously; otherwise it shows the coloured-block fallback and
 * upgrades itself once `loadAtlas()` resolves (the load is kicked off here). No
 * cleanup is required by callers — the walk animation is pure CSS, so an element
 * removed from the DOM stops animating with no dangling timer.
 */
export function createSpeciesSprite(species: string, opts: SpeciesSpriteOpts = {}): HTMLElement {
  const size = opts.size ?? 64;
  const el = document.createElement('div');
  el.className = 'species-sprite';
  el.style.width = `${size}px`;
  el.style.height = `${size}px`;
  // Fallback first: a tinted block, in case the atlas never loads.
  el.style.backgroundColor = colorFor(species);
  el.setAttribute('role', 'img');
  el.setAttribute('aria-label', `${species} sprite`);

  // Upgrade to the real sprite as soon as the (shared, cached) atlas is ready.
  void loadAtlas().then((atlas) => {
    if (atlas) paintSprite(el, species, atlas, size);
  });

  return el;
}
