/**
 * The first-run cinematic — the "ESCAPE AI" transfer-pod intro.
 *
 * Plays ONCE, for a brand-new character only (main.ts gates on
 * `MenuResult.isNewCharacter`). It sets the premise before the player enters the
 * world: the machines rule, the zoos answer to the network, and humans pour their
 * minds into caged animals to break them out.
 *
 * Sequence (≈18.5s, all timings are the constants below):
 *   1. Black + a low electrical hum (`intro_power` loop) for 3s.
 *   2. The empty transfer chamber (`transfer-pod-off.png`) slowly fades in.
 *   3. Narrative subtitles reveal one at a time. The first one ARMS the skip.
 *   4. The pods flicker on↔off (swapping to `transfer-pod-on.png` — a human and a
 *      kangaroo mid-transfer), an `intro_spark` crack on each power-on flip.
 *   5. Fade to black; the hum stops.
 *   6. "ESCAPE AI" alone for 3s.
 *   7. Resolve → main.ts hands control to gameplay (the world has been loading
 *      behind this opaque overlay the whole time, so there's no build hitch).
 *
 * Design notes:
 *   - Renderer-agnostic: a pure DOM/CSS overlay built and torn down here, exactly
 *     like the splash/login in menu.ts. Gameplay never sees Phaser through this.
 *   - The macro timeline is JS-scheduled (not CSS animation-delays like the splash)
 *     because it must be cancellable mid-sequence (skip) and must stop a running
 *     audio loop on teardown — CSS delays can't be cancelled-to-completion cleanly.
 *     The *visual* polish (opacity fades, the title glow) is still CSS transitions/
 *     keyframes for smooth GPU compositing; JS only toggles classes and fires SFX.
 *   - Time-driven, not load-driven: every phase fires on a timer regardless of
 *     whether the images decoded, so a 404 or a slow decode can never hang the
 *     intro. `playIntro()` ALWAYS resolves (never rejects) so the join is never
 *     blocked — main.ts joins BEFORE awaiting this.
 *   - Two stacked, pre-decoded <img> elements (off + on) toggled by a class drive
 *     the flicker; we never reassign `src` on a 2.7MB PNG (that can re-decode and
 *     hitch). Preloaded at boot via `preloadIntroAssets()`.
 *   - Respects `prefers-reduced-motion`: motion is removed (instant cuts, no
 *     flicker) but the narrative + title still show. We never auto-skip the whole
 *     thing for reduced-motion users — they still get the story.
 */

import { playSfx, startLoop, stopLoop, preloadVoice, playVoice, stopVoice } from './audio';
import { VOICE_META, type VoiceName } from './audio.generated';
import { playMusicState } from './music';

// --- Asset URLs (Vite publicDir = assets/, base './' → Capacitor-safe) --------
const POD_OFF_URL = './images/transfer-pod-off.png';
const POD_ON_URL = './images/transfer-pod-on.png';

// --- The narrative. Four short beats: the fall, the reach, the plan, the order.
// These strings MUST match the `text` of the corresponding `voice` manifest entries
// (intro_vo_1..4 in asset-pipeline/manifest.json) — the manifest text is the single
// source for both the spoken VO clip and this on-screen subtitle, paired by index. ---
const SUBTITLES = [
  'The machines we built to serve us… learned to rule us.',
  'The steel cities run on their logic now. Every zoo answers to the network.',
  'We cannot win this as men. We have technology to transfer our human souls into the imprisoned creatures now.',
  'Wake up in their skin. Open the gates. Run.',
] as const;

/**
 * The voice-clip key per subtitle (index-aligned with SUBTITLES). Each names a
 * `voice` manifest entry; the client reads its baked `durationMs` (via VOICE_META) to
 * pace the subtitle and plays its clip on the reveal. A clip whose duration isn't
 * baked yet falls back to FIXED_SUBTITLE_MS and plays silently.
 */
const VOICE_ORDER: readonly VoiceName[] = [
  'intro_vo_1',
  'intro_vo_2',
  'intro_vo_3',
  'intro_vo_4',
];

// --- Timeline anchors (ms). The SUBTITLE phase is now DYNAMIC — each subtitle holds
// for its voice clip's baked duration + a buffer (see computeSubtitleSchedule). These
// constants are the fixed parts: the opening black, the per-subtitle fallback gap when
// no clip is generated, the buffer after each clip, and the closing flicker/title math.
const T = {
  /** Black hold before the chamber fades in. */
  POD_FADE_IN: 3000,
  /** When subtitle 0 appears — this also ARMS the skip affordance. */
  FIRST_SUBTITLE: 5000,
  /** Hold per subtitle when its voice clip has no baked duration (the clean-clone
   *  default — matches the original fixed cadence so the un-voiced intro is unchanged). */
  FIXED_SUBTITLE_MS: 2200,
  /** Extra time a subtitle stays up AFTER its voice clip ends (the requested buffer). */
  SUBTITLE_BUFFER_MS: 1500,
  /** Beat between the last subtitle clearing and the flicker starting. */
  PRE_FLICKER_BEAT: 600,
  /** One flicker half-cycle (off→on or on→off). */
  FLICKER_STEP: 250,
  /** How many power-on flips (each fires a spark). */
  FLICKER_FLIPS: 5,
  /** After the flicker: beat before fading to black. */
  POST_FLICKER_BEAT: 400,
  /** Fade-to-black duration before the title shows. */
  TO_BLACK_HOLD: 600,
  /** How long the lone "ESCAPE AI" title holds before finish. */
  TITLE_HOLD: 2800,
  /** Safety margin added past the computed finish for the hard-ceiling timer. */
  CEILING_MARGIN: 2200,
} as const;

/** Loop gain for the power-up hum. */
const HUM_VOLUME = 0.45;
/** One-shot gain for each transfer spark. */
const SPARK_VOLUME = 0.6;

/**
 * Compute the dynamic subtitle schedule and the downstream phase offsets from the
 * baked voice durations. When no durations are baked (clean clone) this collapses to
 * the original fixed cadence, so the un-voiced intro is byte-for-byte the same UX.
 *
 * Returns absolute ms offsets from intro start:
 *  - subtitleAt[i]  — when subtitle i reveals (and its voice clip plays)
 *  - flickerStart   — when the pod on↔off flicker begins
 *  - toBlack        — fade everything to black + stop the hum
 *  - titleIn        — show the lone "ESCAPE AI" title
 *  - finish         — tear down + resolve
 *  - ceiling        — hard-ceiling safety net (> finish)
 */
function computeTimeline(reduced: boolean): {
  subtitleAt: number[];
  flickerStart: number;
  toBlack: number;
  titleIn: number;
  finish: number;
  ceiling: number;
} {
  const firstAt = reduced ? 1200 : T.FIRST_SUBTITLE;
  const buffer = reduced ? 800 : T.SUBTITLE_BUFFER_MS;
  const fallbackHold = reduced ? 1600 : T.FIXED_SUBTITLE_MS;

  const subtitleAt: number[] = [];
  let cursor = firstAt;
  for (let i = 0; i < SUBTITLES.length; i++) {
    subtitleAt.push(cursor);
    // Hold = the clip's baked duration (if any) + buffer; else the fixed fallback hold.
    const key = VOICE_ORDER[i];
    const dur = key ? VOICE_META[key]?.durationMs ?? null : null;
    const hold = dur != null && dur > 0 ? dur + buffer : fallbackHold;
    cursor += hold;
  }

  // `cursor` now sits just after the last subtitle's hold ends.
  const flickerStart = cursor + (reduced ? 0 : T.PRE_FLICKER_BEAT);
  const flickerSpan = reduced ? 0 : T.FLICKER_FLIPS * 2 * T.FLICKER_STEP;
  const toBlack = flickerStart + flickerSpan + (reduced ? 0 : T.POST_FLICKER_BEAT);
  const titleIn = toBlack + T.TO_BLACK_HOLD;
  const finish = titleIn + T.TITLE_HOLD;
  const ceiling = finish + T.CEILING_MARGIN;
  return { subtitleAt, flickerStart, toBlack, titleIn, finish, ceiling };
}

// --- Preloaded image cache (warmed at boot, read at play time) ----------------
let offImg: HTMLImageElement | undefined;
let onImg: HTMLImageElement | undefined;

/** Whether the intro overlay is currently up (read by main.ts's music guard). */
let active = false;

/** True while the intro overlay is on screen, so main.ts can keep music silent. */
export function isIntroActive(): boolean {
  return active;
}

/** Does the user prefer reduced motion? Re-read each play (it can change). */
function prefersReducedMotion(): boolean {
  return (
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches
  );
}

/**
 * Warm the heavy PNGs so the cinematic runs hitch-free. Fire-and-forget: call at
 * boot (next to preloadSfx). Decoding two ~2.7MB images takes a moment; by the time
 * the player finishes the login screen they're ready. Never throws, never blocks.
 *
 * The intro SFX (`intro_power`/`intro_spark`) are warmed by main.ts's existing
 * `preloadSfx()` boot call (it loads the whole catalogue). We warm the two heavy PNGs
 * AND the narration clips here so the cinematic plays without a fetch/decode hitch.
 */
export function preloadIntroAssets(): void {
  if (!offImg) {
    offImg = new Image();
    offImg.src = POD_OFF_URL;
    void offImg.decode().catch(() => {
      /* decode failures are non-fatal — the timeline is time-driven */
    });
  }
  if (!onImg) {
    onImg = new Image();
    onImg.src = POD_ON_URL;
    void onImg.decode().catch(() => {});
  }
  // Warm the narration clips (no-op-silent if not generated yet).
  preloadVoice();
}

/**
 * Play the full cinematic. Resolves when it finishes naturally OR when the player
 * skips (after the first subtitle). NEVER rejects — all work is guarded so the
 * caller's join can never be blocked by an intro error.
 *
 * Re-entrancy guard: if an intro is already on screen (`active`), this resolves
 * immediately without building a second overlay — a second concurrent run would
 * orphan the first one's timers/listeners/loop. main() only calls this once, but
 * the guard keeps the public API safe regardless.
 */
export function playIntro(): Promise<void> {
  if (active) return Promise.resolve();
  return new Promise<void>((resolve) => {
    try {
      runSequence(resolve);
    } catch {
      // Building the overlay failed somehow — don't trap the player at the gate.
      active = false;
      resolve();
    }
  });
}

/** Build the overlay, schedule the timeline, and wire the single teardown path. */
function runSequence(resolve: () => void): void {
  const reduced = prefersReducedMotion();

  // --- Overlay DOM ----------------------------------------------------------
  const overlay = document.createElement('div');
  overlay.id = 'intro';
  overlay.className = reduced ? 'reduced-motion' : '';
  overlay.innerHTML = `
    <div id="intro-stage">
      <img id="intro-pod-off" class="intro-pod" alt="" src="${POD_OFF_URL}" />
      <img id="intro-pod-on" class="intro-pod" alt="" src="${POD_ON_URL}" />
    </div>
    <p id="intro-subtitle" aria-live="polite"></p>
    <h1 id="intro-title" class="intro-title" aria-hidden="true">
      <span class="intro-word-escape">ESCAPE</span>
      <span class="intro-word-ai">AI</span>
    </h1>
    <p id="intro-skip">Press any key to skip</p>
  `;
  document.body.appendChild(overlay);
  active = true;

  const stageEl = overlay.querySelector<HTMLDivElement>('#intro-stage')!;
  const subtitleEl = overlay.querySelector<HTMLParagraphElement>('#intro-subtitle')!;
  const titleEl = overlay.querySelector<HTMLHeadingElement>('#intro-title')!;
  const skipEl = overlay.querySelector<HTMLParagraphElement>('#intro-skip')!;

  // --- Scheduler + single guarded teardown ----------------------------------
  const timers: ReturnType<typeof setTimeout>[] = [];
  const at = (ms: number, fn: () => void): void => {
    timers.push(setTimeout(fn, ms));
  };
  let settled = false;
  let skipArmed = false;

  const onSkip = (): void => {
    if (skipArmed) finish();
  };

  /** The ONE teardown path — natural finish and skip both route through here. */
  const finish = (): void => {
    if (settled) return;
    settled = true;
    for (const t of timers) clearTimeout(t);
    window.removeEventListener('keydown', onSkip);
    window.removeEventListener('pointerdown', onSkip);
    stopLoop('intro_power');
    stopVoice(); // cut any in-progress narration on skip/finish
    overlay.remove();
    active = false;
    resolve();
  };

  // --- Dynamic timeline: each subtitle holds for its voice clip's baked duration +
  // a buffer (or a fixed fallback when no clip is generated). Everything downstream
  // (flicker, fade, title, finish) chains off the computed end of the last subtitle.
  const tl = computeTimeline(reduced);

  // --- Audio: silence the menu music, start the power-up hum ----------------
  // The menu's title_theme is playing; fade it out so the cold hum owns the
  // soundscape. main.ts's frame-loop music guard keeps it silent (isIntroActive())
  // until the overlay is gone, then crossfades the gameplay track in.
  playMusicState(null);
  startLoop('intro_power', HUM_VOLUME);

  // --- Phase: chamber fades in ----------------------------------------------
  at(reduced ? 0 : T.POD_FADE_IN, () => stageEl.classList.add('visible'));

  // --- Phase: subtitles reveal one at a time, paced by their voice clip ------
  SUBTITLES.forEach((line, i) => {
    at(tl.subtitleAt[i], () => {
      subtitleEl.textContent = line;
      // Re-trigger the fade by toggling the class off→on across a frame.
      subtitleEl.classList.remove('show');
      void subtitleEl.offsetWidth; // force reflow so the re-add animates
      subtitleEl.classList.add('show');
      // Play the narration clip for this beat (silent no-op if not generated).
      const key = VOICE_ORDER[i];
      if (key) playVoice(key, VOICE_META[key]?.volume ?? 0.95);
      // Arm the skip on the FIRST subtitle.
      if (i === 0 && !skipArmed) {
        skipArmed = true;
        skipEl.classList.add('show');
        window.addEventListener('keydown', onSkip);
        window.addEventListener('pointerdown', onSkip);
      }
    });
  });

  // --- Phase: the transfer flicker ------------------------------------------
  // Power-on flips swap the "on" image in (class toggle, no src reassign) and crack
  // a spark; power-off flips swap it back out silently. Reduced-motion skips the
  // flicker entirely (it's pure motion) — the on-image just shows once, quietly.
  if (reduced) {
    at(tl.flickerStart, () => stageEl.classList.add('powered'));
  } else {
    for (let flip = 0; flip < T.FLICKER_FLIPS; flip++) {
      const onAt = tl.flickerStart + flip * 2 * T.FLICKER_STEP;
      const offAt = onAt + T.FLICKER_STEP;
      at(onAt, () => {
        stageEl.classList.add('powered');
        playSfx('intro_spark', SPARK_VOLUME);
      });
      // Hold the LAST power-on through to the fade-to-black (don't flick it off).
      if (flip < T.FLICKER_FLIPS - 1) {
        at(offAt, () => stageEl.classList.remove('powered'));
      }
    }
  }

  // --- Phase: fade to black, stop the hum -----------------------------------
  at(tl.toBlack, () => {
    overlay.classList.add('to-black');
    stopLoop('intro_power');
  });

  // --- Phase: the lone title ------------------------------------------------
  at(tl.titleIn, () => {
    overlay.classList.add('title-stage');
    titleEl.classList.add('show');
  });

  // --- Phase: natural finish + hard-ceiling safety net ----------------------
  at(tl.finish, finish);
  at(tl.ceiling, finish); // belt-and-suspenders; finish() is idempotent
}
