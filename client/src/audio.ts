/**
 * SFX — fire-and-forget sound effects for Escape AI.
 *
 * Uses the Web Audio API directly (not Phaser audio): the renderer is swappable
 * behind IRenderer, so sound must not depend on it. WAVs are the zero-dependency
 * placeholders from `scripts/gen-placeholder-sfx.js`, served from the bundled
 * `assets/` dir (Vite `publicDir`) at `./sfx/<name>.wav`.
 *
 * Browsers block audio until a user gesture; `unlock()` (wired to the first
 * key/pointer event) resumes the context. Buffers are decoded lazily on first
 * load and cached, so `play()` is cheap to call from gameplay events.
 */

/** Logical sound names → file under `./sfx/`. Maps game events to the catalogue. */
const SFX_FILES = {
  blip: './sfx/blip.wav',
  select: './sfx/select.wav',
  confirm: './sfx/confirm.wav',
  pickup: './sfx/pickup.wav',
  hit: './sfx/hit.wav',
  error: './sfx/error.wav',
  jump: './sfx/jump.wav',
  // Ability FX sounds (Phase E).
  whoosh: './sfx/whoosh.wav',
  thud: './sfx/thud.wav',
  sparkle2: './sfx/sparkle2.wav',
  dazzle: './sfx/dazzle.wav',
} as const;

export type SfxName = keyof typeof SFX_FILES;

let ctx: AudioContext | undefined;
const buffers = new Map<SfxName, AudioBuffer>();
/** Names we've already started loading, so we decode each file at most once. */
const loading = new Set<SfxName>();

/** Lazily create the shared AudioContext (constructed on first use). */
function audioCtx(): AudioContext | undefined {
  if (ctx) return ctx;
  // Safari still exposes only the webkit-prefixed constructor.
  const Ctor =
    window.AudioContext ??
    (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!Ctor) return undefined; // no Web Audio → silently no sound
  ctx = new Ctor();
  return ctx;
}

/** Fetch + decode one sound into the cache. Safe to call repeatedly. */
async function load(name: SfxName): Promise<void> {
  if (buffers.has(name) || loading.has(name)) return;
  const context = audioCtx();
  if (!context) return;
  loading.add(name);
  try {
    const res = await fetch(SFX_FILES[name]);
    const bytes = await res.arrayBuffer();
    const buf = await context.decodeAudioData(bytes);
    buffers.set(name, buf);
  } catch (err) {
    // A missing/undecodable SFX must never break gameplay — just stay silent.
    console.warn(`[audio] could not load "${name}":`, err);
  } finally {
    loading.delete(name);
  }
}

/** Preload the whole catalogue (call once at boot; failures are non-fatal). */
export function preloadSfx(): void {
  (Object.keys(SFX_FILES) as SfxName[]).forEach((name) => void load(name));
}

/**
 * Resume the AudioContext after the first user gesture. Browsers start it
 * "suspended" until then; calling this from a keydown/pointerdown unblocks audio.
 */
export function unlockAudio(): void {
  const context = audioCtx();
  if (context && context.state === 'suspended') void context.resume();
}

/**
 * Play a sound once. No-op (not an error) if audio is unavailable or the buffer
 * isn't decoded yet — the first play of a not-yet-loaded sound kicks off its load
 * so subsequent plays are audible.
 * @param name   catalogue entry
 * @param volume 0..1 gain (default 0.6 so layered SFX don't clip)
 */
export function playSfx(name: SfxName, volume = 0.6): void {
  const context = audioCtx();
  if (!context) return;
  const buf = buffers.get(name);
  if (!buf) {
    void load(name); // warm it for next time
    return;
  }
  const src = context.createBufferSource();
  src.buffer = buf;
  const gain = context.createGain();
  gain.gain.value = volume;
  src.connect(gain).connect(context.destination);
  src.start();
}
