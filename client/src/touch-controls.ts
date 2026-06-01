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
 * Phase 1 fills in the joystick + buttons; this stub keeps Phase 0 (the input seam)
 * compiling and is a no-op until then.
 */

/** Handle for the touch-control overlay. */
export interface TouchControls {
  /** Remove the overlay from the DOM and detach listeners. */
  destroy(): void;
}

/**
 * Build and mount the touch-control overlay. Call only on Android. Returns a handle
 * for teardown. (Phase 0 stub: mounts nothing yet — filled in Phase 1.)
 */
export function createTouchControls(): TouchControls {
  return {
    destroy() {
      /* no-op until Phase 1 */
    },
  };
}
