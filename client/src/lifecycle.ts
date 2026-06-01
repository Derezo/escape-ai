/**
 * App lifecycle (Android): pause the game when backgrounded, resume on return.
 *
 * On a phone, pressing home / taking a call / switching apps backgrounds the WebView
 * but — without this — the rAF render loop, the two setIntervals (connection tick +
 * input send), the audio loops, and the Socket.IO connection all keep running at full
 * tilt. That drains the battery and leaves the socket churning while invisible, then
 * desyncs on return. This wires Capacitor's App `pause`/`resume` events (plus a
 * `document.visibilitychange` fallback for WebViews where the native event is late or
 * absent) to cleanly suspend and restore that machinery.
 *
 * Gated to native by the caller (main.ts only installs this when `isAndroid`); the
 * `visibilitychange` fallback is platform-agnostic but only ever registered here, so
 * desktop is unaffected unless explicitly opted in.
 *
 * The caller owns the actual machinery and passes callbacks; this module only decides
 * WHEN to pause/resume and debounces so a single background doesn't fire twice (the
 * native `pause` and `visibilitychange→hidden` can both arrive).
 */

import { App } from '@capacitor/app';

export interface LifecycleHooks {
  /** Stop the loops, suspend audio, drop the socket. Called once per background. */
  onPause(): void;
  /** Re-arm the loops, resume audio, reconnect. Called once per foreground. */
  onResume(): void;
}

/** Handle for teardown (rarely needed — the app lives for the session). */
export interface Lifecycle {
  destroy(): void;
}

/**
 * Install pause/resume handling. Returns a teardown handle. The hooks are debounced
 * so the native `pause` and the `visibilitychange` fallback can't double-fire.
 */
export function installLifecycle(hooks: LifecycleHooks): Lifecycle {
  let paused = false;

  const pause = (): void => {
    if (paused) return;
    paused = true;
    hooks.onPause();
  };
  const resume = (): void => {
    if (!paused) return;
    paused = false;
    hooks.onResume();
  };

  // Capacitor native lifecycle (Android/iOS). addListener returns a promise of a
  // handle; we keep the promises so destroy() can remove them.
  const pausePromise = App.addListener('pause', pause);
  const resumePromise = App.addListener('resume', resume);

  // Fallback for older Android WebViews where the native pause can be late/absent:
  // the standard Page Visibility API fires reliably on background/foreground.
  const onVisibility = (): void => {
    if (document.visibilityState === 'hidden') pause();
    else resume();
  };
  document.addEventListener('visibilitychange', onVisibility);

  return {
    destroy() {
      void pausePromise.then((h) => h.remove());
      void resumePromise.then((h) => h.remove());
      document.removeEventListener('visibilitychange', onVisibility);
    },
  };
}
