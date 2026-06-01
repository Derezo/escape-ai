/**
 * Platform detection — the single Android gate everything Android-only hangs on.
 *
 * The web client is the product; the Android app is a Capacitor WebView wrapper of
 * the same bundle. `Capacitor.getPlatform()` returns 'android' | 'ios' | 'web', so
 * `isAndroid` is the precise flag for surfacing touch controls, lifecycle handling,
 * and soft-keyboard management ONLY on Android — desktop and the browser build stay
 * byte-for-byte identical.
 *
 * `applyPlatformClass()` mirrors the flag onto <body> as `platform-android` so CSS can
 * scope Android-only rules (e.g. the touch-control overlay) the same way the JS gates
 * behaviour. Call it once at startup.
 */

import { Capacitor } from '@capacitor/core';

/** True only inside the Android Capacitor WebView. The gate for all touch/native UI. */
export const isAndroid: boolean = Capacitor.getPlatform() === 'android';

/**
 * Add a `platform-android` class to <body> so CSS can scope Android-only rules without
 * duplicating the detection. Idempotent. Call once at init.
 */
export function applyPlatformClass(): void {
  document.body.classList.toggle('platform-android', isAndroid);
}

/**
 * Belt-and-suspenders landscape lock for Android. The APK's AndroidManifest already
 * pins the activity to `screenOrientation="sensorLandscape"` (the authoritative,
 * native lock), but a stale install or a WebView that doesn't honour it can still let
 * the page rotate to portrait. This re-asserts the lock at runtime via the standard Web
 * Screen Orientation API — exactly what the @capacitor/screen-orientation plugin wraps,
 * but with zero new dependency or native code. No-op off Android, and silently tolerant
 * where lock() is unsupported / rejects (it requires a secure context + can throw on
 * some WebViews) — the manifest remains the primary guarantee. Call once at startup;
 * the manifest keeps it locked across resume, so no re-arm hook is needed.
 */
export function lockLandscape(): void {
  if (!isAndroid) return;
  // `screen.orientation.lock` is not in the default TS lib DOM types (it's behind a
  // permissions-gated API), so reach it through a narrowed shape rather than `any`.
  const orientation = (screen as Screen & {
    orientation?: { lock?: (o: string) => Promise<void> };
  }).orientation;
  // lock() returns a promise that rejects on unsupported / not-allowed; swallow it —
  // the manifest is the real lock and we don't want an unhandled rejection at boot.
  orientation?.lock?.('landscape').catch(() => {
    /* WebView without programmatic lock — manifest sensorLandscape still governs. */
  });
}
