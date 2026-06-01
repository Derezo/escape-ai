/**
 * Platform detection — the single Android gate everything Android-only hangs on.
 *
 * The web client is the product; the Android app is a Capacitor WebView wrapper of
 * the same bundle. `Capacitor.getPlatform()` returns 'android' | 'ios' | 'web', so
 * `isAndroid` is the precise flag for surfacing touch controls, lifecycle handling,
 * and soft-keyboard management ONLY on Android — desktop and the browser build stay
 * byte-for-byte identical.
 *
 * `applyPlatformClass()` mirrors the flag onto <body> as a class so CSS can gate
 * presentation (safe-area insets, larger touch targets) the same way the JS gates
 * behaviour. Call it once at startup.
 */

import { Capacitor } from '@capacitor/core';

/** True only inside the Android Capacitor WebView. The gate for all touch/native UI. */
export const isAndroid: boolean = Capacitor.getPlatform() === 'android';

/** True on any native Capacitor platform (android or ios), false in a browser. */
export const isNative: boolean = Capacitor.isNativePlatform();

/**
 * Add a `platform-android` / `platform-native` class to <body> so CSS can branch on
 * the platform without duplicating the detection. Idempotent. Call once at init.
 */
export function applyPlatformClass(): void {
  document.body.classList.toggle('platform-android', isAndroid);
  document.body.classList.toggle('platform-native', isNative);
}
