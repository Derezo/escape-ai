/**
 * Music playback layer for Escape AI.
 *
 * Thin crossfade manager built on the SHARED AudioContext from audio.ts.
 * No Phaser dependency — renderer-agnostic. Shares the single AudioContext
 * so unlockAudio() (called on first gesture in menu.ts) unblocks music too.
 *
 * Defensive by design: any missing file (404) or decode error stays silent
 * and never throws into the frame loop. All public functions are idempotent.
 *
 * Usage:
 *   initMusic();               // call once at boot (after preloadSfx)
 *   playMusicState('explore_loop');  // call every frame — safe, idempotent
 */

import { getAudioCtx } from './audio';
import { MUSIC_FILES, MUSIC_META, type MusicName } from './audio.generated';

// ---------------------------------------------------------------------------
// Internal voice state
// ---------------------------------------------------------------------------

/** A live AudioBufferSourceNode plus its per-voice GainNode. */
interface Voice {
  source: AudioBufferSourceNode;
  gain: GainNode;
}

/** The master gain node connected to the AudioContext destination. */
let masterGain: GainNode | undefined;
/** Outgoing voice being faded out. */
let outVoice: Voice | undefined;
/** Currently playing (or ramping in) voice. */
let inVoice: Voice | undefined;

/** The track that was requested this frame (used for idempotency check). */
let targetTrack: MusicName | null = null;

/** Decoded buffer cache: name → AudioBuffer. */
const bufferCache = new Map<MusicName, AudioBuffer>();
/** Names currently being fetched, to avoid duplicate in-flight requests. */
const fetchingNow = new Set<MusicName>();

/** Master volume scalar (0..1). Applied on top of per-track MUSIC_META volume. */
let masterMusicVolume = 1;

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Create (or reuse) the master music GainNode connected to the AudioContext.
 * Idempotent — safe to call multiple times.
 */
export function initMusic(): void {
  ensureMasterGain();
}

/**
 * The ONE entry-point for music state changes — call every frame.
 *
 * Idempotent: if `track` equals the current target, nothing happens (no
 * restart, no re-fade). Crossfades over `fadeMs` (default 1200 ms) between
 * the outgoing and incoming voices. `null` fades the current track to silence.
 */
export function playMusicState(
  track: MusicName | null,
  opts?: { fadeMs?: number; volume?: number },
): void {
  // Idempotency: same target → do nothing.
  if (track === targetTrack) return;
  targetTrack = track;

  const fadeMs = opts?.fadeMs ?? 1200;

  if (track === null) {
    // Fade out whatever is playing, then silence.
    fadeOutCurrent(fadeMs);
    return;
  }

  const targetVolume = (opts?.volume ?? MUSIC_META[track].volume) * masterMusicVolume;

  // If the buffer is already cached, start the crossfade immediately.
  const buf = bufferCache.get(track);
  if (buf) {
    startCrossfade(track, buf, fadeMs, targetVolume);
    return;
  }

  // Otherwise kick off a background fetch; the current track keeps playing.
  void fetchAndStart(track, fadeMs, targetVolume);
}

/**
 * Set the master music volume (0..1). Ramps the master gain smoothly.
 */
export function setMusicVolume(v: number): void {
  masterMusicVolume = Math.max(0, Math.min(1, v));
  const ctx = getAudioCtx();
  if (!ctx || !masterGain) return;
  masterGain.gain.linearRampToValueAtTime(masterMusicVolume, ctx.currentTime + 0.1);
}

/**
 * Temporarily duck the master music gain by `factor` (default 0.3) over `ms`
 * milliseconds. Call unduckMusic() to restore.
 */
export function duckMusic(factor = 0.3, ms = 300): void {
  const ctx = getAudioCtx();
  if (!ctx || !masterGain) return;
  masterGain.gain.linearRampToValueAtTime(
    masterMusicVolume * factor,
    ctx.currentTime + ms / 1000,
  );
}

/**
 * Restore the master music gain after a duckMusic() call over `ms` milliseconds.
 */
export function unduckMusic(ms = 300): void {
  const ctx = getAudioCtx();
  if (!ctx || !masterGain) return;
  masterGain.gain.linearRampToValueAtTime(masterMusicVolume, ctx.currentTime + ms / 1000);
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/** Ensure the masterGain node exists and is connected to the destination. */
function ensureMasterGain(): void {
  if (masterGain) return;
  const ctx = getAudioCtx();
  if (!ctx) return; // no AudioContext yet; will be called again next frame
  masterGain = ctx.createGain();
  masterGain.gain.value = masterMusicVolume;
  masterGain.connect(ctx.destination);
}

/**
 * Fade the current inVoice to silence over `fadeMs` and then stop it.
 * Moves it to outVoice so a newly starting voice can coexist during the fade.
 */
function fadeOutCurrent(fadeMs: number): void {
  const ctx = getAudioCtx();
  if (!ctx) return;

  // If there's already an outgoing fade, kill it immediately so it doesn't
  // pile up beyond the two-voice limit.
  if (outVoice) {
    try { outVoice.source.stop(); } catch { /* already stopped */ }
    outVoice = undefined;
  }

  if (inVoice) {
    const v = inVoice;
    inVoice = undefined;
    outVoice = v;
    const endTime = ctx.currentTime + fadeMs / 1000;
    v.gain.gain.cancelScheduledValues(ctx.currentTime);
    v.gain.gain.setValueAtTime(v.gain.gain.value, ctx.currentTime);
    v.gain.gain.linearRampToValueAtTime(0, endTime);
    // Stop after the fade; a small buffer ensures the ramp finishes cleanly.
    try { v.source.stop(endTime + 0.05); } catch { /* already stopped */ }
    // Clear the outVoice ref once the stop fires so GC can reclaim it.
    v.source.addEventListener('ended', () => {
      if (outVoice === v) outVoice = undefined;
    });
  }
}

/**
 * Start the new voice and crossfade in from 0 → targetVolume while the
 * current voice fades out.
 */
function startCrossfade(
  track: MusicName,
  buf: AudioBuffer,
  fadeMs: number,
  targetVolume: number,
): void {
  ensureMasterGain();
  const ctx = getAudioCtx();
  if (!ctx || !masterGain) return;

  // Fade out whatever was playing.
  fadeOutCurrent(fadeMs);

  // Create the new source + gain.
  const src = ctx.createBufferSource();
  src.buffer = buf;
  src.loop = MUSIC_META[track].loop;

  const gainNode = ctx.createGain();
  gainNode.gain.setValueAtTime(0, ctx.currentTime);
  gainNode.gain.linearRampToValueAtTime(targetVolume, ctx.currentTime + fadeMs / 1000);

  src.connect(gainNode).connect(masterGain);
  src.start();

  const newVoice: Voice = { source: src, gain: gainNode };
  inVoice = newVoice;

  // One-shot tracks (victory_sting / caught_sting): when they end, clear
  // inVoice so the next frame's playMusicState call can start the next track.
  // We also reset targetTrack so the idempotency check doesn't block the
  // underlying loop from being restarted the following frame.
  if (!MUSIC_META[track].loop) {
    src.addEventListener('ended', () => {
      if (inVoice === newVoice) {
        inVoice = undefined;
        // Reset target so the next frame's selectMusic() result takes effect.
        targetTrack = null;
      }
    });
  }
}

/**
 * Fetch + decode a track in the background; when ready, start the crossfade
 * (only if this track is still the target — avoids a stale-fetch race).
 */
async function fetchAndStart(
  track: MusicName,
  fadeMs: number,
  targetVolume: number,
): Promise<void> {
  if (fetchingNow.has(track)) return; // already in flight
  fetchingNow.add(track);

  const ctx = getAudioCtx();
  if (!ctx) {
    fetchingNow.delete(track);
    return;
  }

  try {
    const res = await fetch(MUSIC_FILES[track]);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const bytes = await res.arrayBuffer();
    const buf = await ctx.decodeAudioData(bytes);
    bufferCache.set(track, buf);

    // Only start if this track is still the requested one (the user might have
    // changed state while the fetch was in flight).
    if (targetTrack === track) {
      startCrossfade(track, buf, fadeMs, targetVolume);
    }
  } catch (err) {
    // Missing/undecodable music never crashes the frame loop — just stay silent.
    console.warn(`[music] could not load "${track}":`, err);
  } finally {
    fetchingNow.delete(track);
  }
}
