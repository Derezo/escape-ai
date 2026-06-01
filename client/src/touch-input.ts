/**
 * Touch input state — the seam that lets on-screen controls feed the EXISTING
 * input path without touching the net contract.
 *
 * The keyboard builds a movement vector in main.ts's `inputVector()` and queues one
 * discrete `PlayerAction` verb; the send loop combines them into the wire `InputMsg`
 * {seq, dx, dy, sprint, action} and calls net.sendInput. This module is a tiny shared
 * state object the touch widgets (joystick + action buttons, see touch-controls.ts)
 * write into, and that main.ts reads from — upstream of sendInput. Nothing downstream
 * (prediction, reconciliation, server) changes.
 *
 * MOVEMENT is ANALOG: the joystick writes dx/dy in [-1, 1]. The server already clamps
 * each axis to [-1, 1] (server/socket/lobby.js), so analog passes through as
 * proportional speed with no server change. SPRINT is the joystick's stick-edge state.
 * ACTIONS are edge-triggered: a button calls `queueAction`, which forwards to the
 * single setter main.ts installs via `setActionSink`.
 */

import type { PlayerAction } from '@shared/net';

/** Live analog movement intent from the joystick. dx/dy in [-1, 1]; sprint when the
 *  stick is pushed past its outer edge. `active` is true while a finger is down. */
export interface TouchVector {
  dx: number;
  dy: number;
  sprint: boolean;
  active: boolean;
}

const vector: TouchVector = { dx: 0, dy: 0, sprint: false, active: false };

/** The send loop's action enqueue (main.ts installs this). Until then, actions no-op. */
let actionSink: ((action: PlayerAction) => void) | null = null;

/** main.ts installs the queued-action setter here so touch buttons feed the same
 *  `queuedAction` slot the keyboard uses. */
export function setActionSink(sink: (action: PlayerAction) => void): void {
  actionSink = sink;
}

/** Called by the joystick on every move to publish the current analog intent. */
export function setTouchVector(dx: number, dy: number, sprint: boolean): void {
  vector.dx = dx;
  vector.dy = dy;
  vector.sprint = sprint;
  vector.active = true;
}

/** Called by the joystick on release: zero the intent so movement stops. */
export function clearTouchVector(): void {
  vector.dx = 0;
  vector.dy = 0;
  vector.sprint = false;
  vector.active = false;
}

/** Read the current touch movement intent (or null when no finger is driving it). */
export function getTouchVector(): TouchVector | null {
  return vector.active ? vector : null;
}

/** Edge-trigger a discrete action from a touch button; forwarded to main.ts's queue. */
export function queueAction(action: PlayerAction): void {
  actionSink?.(action);
}
