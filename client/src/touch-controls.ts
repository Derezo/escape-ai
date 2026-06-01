/**
 * On-screen touch controls for Android: a floating analog joystick (movement +
 * stick-edge sprint) on the left, and a cluster of action buttons (interact /
 * ability / feed / order) on the right. Gated to Android by the caller (main.ts only
 * constructs this when `isAndroid`), so desktop renders nothing.
 *
 * The widgets do NOT talk to the net layer. They write into the shared touch-input
 * state (touch-input.ts): the joystick publishes an analog {dx, dy, sprint} vector
 * that main.ts's inputVector() reads, and each action button calls queueAction(),
 * which forwards to the same `queuedAction` slot the keyboard uses. So everything
 * downstream of inputVector()/queuedAction — prediction, reconciliation, the wire
 * contract — is identical to the keyboard path.
 *
 * JOYSTICK: floating. It appears wherever the first finger lands in the left half of
 * the screen and recenters there each touch (forgiving — no need to find a fixed pad).
 * The knob offset from that origin, normalized by JOY_RADIUS and clamped to a unit
 * disc, IS the analog dx/dy in [-1, 1]. A small dead zone kills drift near centre.
 * Pushing past SPRINT_EDGE of the radius sets sprint (one thumb does move + sprint).
 *
 * BUTTONS: a fixed bottom-right cluster. Each is edge-triggered on touchstart (one tap
 * = one action), mirroring the keyboard's edge-trigger. They sit above the joystick's
 * z-band but the joystick only activates on the LEFT half, so the two never fight for a
 * touch.
 */

import { setTouchVector, clearTouchVector, queueAction } from './touch-input';
import type { PlayerAction } from '@shared/net';

/** Knob travel that maps to a full-magnitude (|v|=1) vector, in CSS px. */
const JOY_RADIUS = 60;
/** Below this fraction of the radius, treat as no input (kills thumb-rest drift). */
const DEAD_ZONE = 0.18;
/** At/above this fraction of the radius, engage sprint (stick-edge sprint). */
const SPRINT_EDGE = 0.85;

/** Handle for the touch-control overlay. */
export interface TouchControls {
  /** Remove the overlay from the DOM and detach listeners. */
  destroy(): void;
}

/** The action buttons, in render order (bottom-most = primary thumb reach). */
const ACTION_BUTTONS: ReadonlyArray<{ action: PlayerAction; label: string; glyph: string }> = [
  { action: 'interact', label: 'Interact', glyph: '✋' },
  { action: 'ability', label: 'Ability', glyph: '✦' },
  { action: 'feed', label: 'Feed', glyph: '🍎' },
  { action: 'order', label: 'Order', glyph: '⚠' },
];

/**
 * Build and mount the touch-control overlay. Call only on Android. Returns a handle
 * for teardown.
 */
export function createTouchControls(): TouchControls {
  // --- Root overlay: full-screen, pointer-events:none so taps fall through to the
  // game except on the live joystick zone and the buttons (which opt back in). ---
  const root = document.createElement('div');
  root.id = 'touch-controls';

  // The joystick base + knob. Hidden until a finger lands; positioned at the touch.
  const joyBase = document.createElement('div');
  joyBase.id = 'touch-joystick-base';
  const joyKnob = document.createElement('div');
  joyKnob.id = 'touch-joystick-knob';
  joyBase.appendChild(joyKnob);
  root.appendChild(joyBase);

  // The action-button cluster (bottom-right).
  const cluster = document.createElement('div');
  cluster.id = 'touch-actions';
  for (const btn of ACTION_BUTTONS) {
    const el = document.createElement('button');
    el.type = 'button';
    el.className = 'touch-action-btn';
    el.dataset.action = btn.action;
    el.setAttribute('aria-label', btn.label);
    el.innerHTML = `<span class="touch-action-glyph" aria-hidden="true">${btn.glyph}</span><span class="touch-action-label">${btn.label}</span>`;
    // Edge-trigger on touchstart (snappier than click; one touch = one action).
    // preventDefault stops the synthetic mouse/click + any scroll/zoom.
    const fire = (ev: Event): void => {
      ev.preventDefault();
      queueAction(btn.action);
      el.classList.add('pressed');
    };
    const release = (): void => el.classList.remove('pressed');
    el.addEventListener('touchstart', fire, { passive: false });
    el.addEventListener('touchend', release);
    el.addEventListener('touchcancel', release);
    cluster.appendChild(el);
  }
  root.appendChild(cluster);

  document.body.appendChild(root);

  // --- Joystick touch handling -------------------------------------------------
  // We track a single joystick finger by its identifier so multi-touch (a thumb on
  // an action button while the other drives the stick) doesn't cross wires. The
  // joystick only claims a touch that STARTS in the left half of the screen and not
  // on a button (buttons handle their own touches and live on the right anyway).
  let joyId: number | null = null;
  let originX = 0;
  let originY = 0;

  const isLeftHalf = (x: number): boolean => x < window.innerWidth / 2;

  const showBaseAt = (x: number, y: number): void => {
    originX = x;
    originY = y;
    joyBase.style.left = `${x}px`;
    joyBase.style.top = `${y}px`;
    joyBase.classList.add('active');
    moveKnob(0, 0);
  };

  const moveKnob = (offX: number, offY: number): void => {
    joyKnob.style.transform = `translate(calc(-50% + ${offX}px), calc(-50% + ${offY}px))`;
  };

  const updateFromTouch = (x: number, y: number): void => {
    let offX = x - originX;
    let offY = y - originY;
    const dist = Math.hypot(offX, offY);
    // Clamp the knob (and the offset we read) to the base radius.
    if (dist > JOY_RADIUS) {
      const s = JOY_RADIUS / dist;
      offX *= s;
      offY *= s;
    }
    moveKnob(offX, offY);

    const mag = Math.min(dist, JOY_RADIUS) / JOY_RADIUS; // 0..1
    if (mag < DEAD_ZONE) {
      // Inside the dead zone: no movement, but keep the stick visible/active.
      setTouchVector(0, 0, false);
      return;
    }
    // Analog vector: the clamped offset normalized by radius → dx/dy in [-1, 1].
    // (Screen Y is down, which matches the game's dy convention: down = +dy.)
    const dx = offX / JOY_RADIUS;
    const dy = offY / JOY_RADIUS;
    const sprint = mag >= SPRINT_EDGE;
    setTouchVector(dx, dy, sprint);
    joyKnob.classList.toggle('sprinting', sprint);
  };

  const onTouchStart = (e: TouchEvent): void => {
    if (joyId !== null) return; // already driving the stick
    for (let i = 0; i < e.changedTouches.length; i++) {
      const t = e.changedTouches[i];
      // Ignore touches that land on the action cluster (let the buttons own them).
      const onButton = (t.target as HTMLElement)?.closest?.('#touch-actions');
      if (onButton) continue;
      if (!isLeftHalf(t.clientX)) continue;
      joyId = t.identifier;
      showBaseAt(t.clientX, t.clientY);
      updateFromTouch(t.clientX, t.clientY);
      e.preventDefault();
      break;
    }
  };

  const findJoyTouch = (list: TouchList): Touch | null => {
    for (let i = 0; i < list.length; i++) {
      if (list[i].identifier === joyId) return list[i];
    }
    return null;
  };

  const onTouchMove = (e: TouchEvent): void => {
    if (joyId === null) return;
    const t = findJoyTouch(e.changedTouches);
    if (!t) return;
    updateFromTouch(t.clientX, t.clientY);
    e.preventDefault();
  };

  const onTouchEnd = (e: TouchEvent): void => {
    if (joyId === null) return;
    const t = findJoyTouch(e.changedTouches);
    if (!t) return;
    joyId = null;
    joyBase.classList.remove('active');
    joyKnob.classList.remove('sprinting');
    clearTouchVector();
  };

  // Listen on the root (which covers the screen) for the joystick; buttons stopped
  // their own touches above. passive:false so we can preventDefault the scroll/zoom.
  root.addEventListener('touchstart', onTouchStart, { passive: false });
  root.addEventListener('touchmove', onTouchMove, { passive: false });
  root.addEventListener('touchend', onTouchEnd);
  root.addEventListener('touchcancel', onTouchEnd);

  return {
    destroy() {
      root.removeEventListener('touchstart', onTouchStart);
      root.removeEventListener('touchmove', onTouchMove);
      root.removeEventListener('touchend', onTouchEnd);
      root.removeEventListener('touchcancel', onTouchEnd);
      clearTouchVector();
      root.remove();
    },
  };
}
