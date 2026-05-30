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

import { SFX_FILES, SFX_FALLBACK, type SfxName } from './audio.generated';
export type { SfxName } from './audio.generated';

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

/**
 * Track which names we've already attempted a fallback for, so we never loop:
 * primary fails → try fallback once → give up silently.
 */
const triedFallback = new Set<SfxName>();

/** Fetch + decode one sound into the cache. Safe to call repeatedly. */
async function load(name: SfxName): Promise<void> {
  if (buffers.has(name) || loading.has(name)) return;
  const context = audioCtx();
  if (!context) return;
  loading.add(name);
  try {
    const res = await fetch(SFX_FILES[name]);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const bytes = await res.arrayBuffer();
    const buf = await context.decodeAudioData(bytes);
    buffers.set(name, buf);
    ensureLoop(name); // a loop deferred on this buffer can start now
  } catch (err) {
    // Primary URL failed. If a fallback WAV is configured (and we haven't tried
    // it yet), load THAT under the same name so gameplay has sound until the
    // real MP3 is generated. Auto-upgrades: once the MP3 lands, a page reload
    // fetches it fresh (the buffer isn't cached across reloads).
    const fallbackUrl = SFX_FALLBACK[name];
    if (fallbackUrl && !triedFallback.has(name)) {
      triedFallback.add(name);
      loading.delete(name); // allow the fallback load() call below to proceed
      try {
        loading.add(name);
        const res2 = await fetch(fallbackUrl);
        if (!res2.ok) throw new Error(`HTTP ${res2.status}`);
        const bytes2 = await res2.arrayBuffer();
        const buf2 = await context.decodeAudioData(bytes2);
        buffers.set(name, buf2);
        ensureLoop(name); // fallback decoded — start a deferred loop on it too
        return; // fallback succeeded; skip the outer warn
      } catch {
        // Fallback also failed — fall through to the silent warn below.
      }
    }
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
  if (context && context.state === 'suspended') {
    void context.resume().then(resumeLoops);
  } else if (context) {
    // Already running (e.g. a later gesture) — still re-drive any pending loops.
    resumeLoops();
  }
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

// ---------------------------------------------------------------------------
// Looping SFX (ambient room-tone, robot pursuit motif, …)
// ---------------------------------------------------------------------------
//
// playSfx() is one-shot; some manifest SFX are marked soundLoop and need to run
// continuously while a game state holds (ambient_bed always-on, robot_pursuit
// while a robot is chasing). A loop is desired-state, not a fire event: we record
// the wish per key and (re)create the BufferSource whenever it can actually run —
// the buffer might still be decoding, or the context still suspended pre-gesture.

interface Loop {
  /** Whether the caller wants this loop playing. */
  want: boolean;
  /** Target gain 0..1. */
  volume: number;
  /** Live nodes while sounding; undefined when idle/desired-but-not-yet-started. */
  src?: AudioBufferSourceNode;
  gain?: GainNode;
}
const loops = new Map<SfxName, Loop>();

/**
 * Reconcile one loop's live nodes with its desired state. Idempotent: safe to
 * call repeatedly (on start/stop, after a buffer decodes, after a resume). Starts
 * a source only when wanted AND the buffer is decoded AND the context runs; stops
 * and tears down the source when no longer wanted.
 */
function ensureLoop(name: SfxName): void {
  const loop = loops.get(name);
  if (!loop) return;
  const context = audioCtx();
  if (!context) return;

  if (!loop.want) {
    if (loop.src) {
      try {
        loop.src.stop();
      } catch {
        // already stopped — ignore
      }
      loop.src.disconnect();
      loop.gain?.disconnect();
      loop.src = undefined;
      loop.gain = undefined;
    }
    return;
  }

  // Wanted. Already sounding → just keep the gain in sync and return.
  if (loop.src) {
    if (loop.gain) loop.gain.gain.value = loop.volume;
    return;
  }

  // Wanted but silent. We can only start once the buffer is decoded; kick off the
  // load if needed and start now if it's already cached. The load() tail calls
  // ensureLoop() again, so a deferred start fires the moment decode completes.
  const buf = buffers.get(name);
  if (!buf) {
    void load(name);
    return;
  }
  const src = context.createBufferSource();
  src.buffer = buf;
  src.loop = true;
  const gain = context.createGain();
  gain.gain.value = loop.volume;
  src.connect(gain).connect(context.destination);
  src.start();
  loop.src = src;
  loop.gain = gain;
}

/**
 * Start (or update the volume of) a looping SFX. Idempotent — calling it while the
 * loop already plays just adjusts the gain, it does not stack a second source. If
 * audio is still locked or the buffer is still decoding, the loop starts itself
 * automatically as soon as it can.
 */
export function startLoop(name: SfxName, volume = 0.3): void {
  const loop = loops.get(name) ?? { want: true, volume };
  loop.want = true;
  loop.volume = volume;
  loops.set(name, loop);
  ensureLoop(name);
}

/** Stop a looping SFX and release its nodes. No-op if it isn't running. */
export function stopLoop(name: SfxName): void {
  const loop = loops.get(name);
  if (!loop) return;
  loop.want = false;
  ensureLoop(name);
}

/** Whether a loop is currently desired (started and not yet stopped). */
export function isLooping(name: SfxName): boolean {
  return loops.get(name)?.want === true;
}

/**
 * Re-drive every desired loop. Called after unlockAudio() resumes the context so
 * loops requested while audio was still locked (e.g. ambient_bed at join) begin
 * sounding the moment the first user gesture lands.
 */
function resumeLoops(): void {
  for (const name of loops.keys()) ensureLoop(name);
}

/**
 * Expose the shared AudioContext so music.ts (Phase 3) can share the single
 * context and benefit from unlockAudio() without creating a second context.
 */
export function getAudioCtx(): AudioContext | undefined {
  return audioCtx();
}
