/**
 * Soft-keyboard helpers for Android.
 *
 * Two problems the WebView has with text input on a phone:
 *
 *  1. Focusing an input programmatically (e.g. ~280ms after a gesture, as the login
 *     and chat flows do) is OUTSIDE Capacitor's "user gesture" window, so the soft
 *     keyboard often does NOT appear — the field looks focused but no keys show.
 *     `focusWithKeyboard()` focuses the element AND, on Android, explicitly asks the
 *     keyboard to show.
 *
 *  2. When the keyboard opens it shrinks the visual viewport and can cover a fixed
 *     bottom-anchored panel (the chat input, or the login Play button). `trackKeyboard()`
 *     watches `window.visualViewport` and exposes the covered height as a CSS variable
 *     (`--kb-inset`) on <body> so panels can lift above the keyboard, and scrolls the
 *     focused field into view.
 *
 * Both are gated to Android (and degrade to a plain focus / no-op elsewhere), so the
 * browser and desktop builds are unaffected.
 */

import { Keyboard } from '@capacitor/keyboard';
import { isAndroid } from './platform';

/** Focus an input and, on Android, raise the soft keyboard (outside the gesture window). */
export function focusWithKeyboard(el: HTMLElement): void {
  el.focus();
  if (!isAndroid) return;
  // Keyboard.show() rejects on web; we're gated to Android, but guard anyway.
  void Keyboard.show().catch(() => {
    /* keyboard may already be up, or unavailable — harmless */
  });
  // Bring the field into view above the keyboard once layout settles.
  requestAnimationFrame(() => el.scrollIntoView({ block: 'center', behavior: 'smooth' }));
}

/** Hide the soft keyboard (Android). No-op elsewhere. */
export function hideKeyboard(): void {
  if (!isAndroid) return;
  void Keyboard.hide().catch(() => {
    /* nothing focused — harmless */
  });
}

/**
 * Start tracking the soft keyboard (Android only). Publishes the keyboard's covered
 * height as the CSS var `--kb-inset` on <body> (0 when hidden), so bottom-anchored
 * panels can add it to their `bottom` and stay visible. Idempotent; safe to call once
 * at startup. Returns a teardown function.
 */
export function trackKeyboard(): () => void {
  if (!isAndroid) return () => {};
  const setInset = (px: number): void => {
    document.body.style.setProperty('--kb-inset', `${Math.max(0, Math.round(px))}px`);
  };
  setInset(0);

  // Prefer Capacitor's keyboard events (they report an exact height); fall back to
  // visualViewport math if the events don't fire.
  const showPromise = Keyboard.addListener('keyboardWillShow', (info) => setInset(info.keyboardHeight));
  const hidePromise = Keyboard.addListener('keyboardWillHide', () => setInset(0));

  // visualViewport fallback: the covered height is the layout-viewport minus the
  // visual viewport's height+offset.
  const vv = window.visualViewport;
  const onVv = (): void => {
    if (!vv) return;
    const covered = window.innerHeight - (vv.height + vv.offsetTop);
    setInset(covered);
  };
  vv?.addEventListener('resize', onVv);
  vv?.addEventListener('scroll', onVv);

  return () => {
    void showPromise.then((h) => h.remove());
    void hidePromise.then((h) => h.remove());
    vv?.removeEventListener('resize', onVv);
    vv?.removeEventListener('scroll', onVv);
    setInset(0);
  };
}
