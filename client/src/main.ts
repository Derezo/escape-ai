/**
 * Client bootstrap — the glue that wires the renderer, the net layer, and input
 * together. Game-agnostic: the only "gameplay" is moving a rectangle, synced
 * through the authoritative server. Open two tabs and both see both rectangles.
 *
 * Data flow each frame:
 *   keyboard  -> input vector (dx,dy)
 *   input     -> NetClient.sendInput({seq,dx,dy})  (server is authority)
 *   input     -> client-side prediction via shared applyInput (instant feel)
 *   snapshot  -> server positions WIN (reconciliation), merged into entity map
 *   entities  -> renderer.syncEntities(...)         (draw)
 */

import './style.css';

import type { IRenderer } from '@shared/renderer';
import type { Entity, WorldState, Dir8 } from '@shared/types';
import type { InputMsg, PlayerAction } from '@shared/net';
import { applyInput, moveSpeed, facingFromVec, type Bounds } from '@shared/step';

import { PhaserRenderer } from './render/phaser';
// --- 3D SWAP (see shared/BABYLON_FALLBACK.md) ---------------------------------
// If the hour-0 genre rule forces 3D, `npm install @babylonjs/core`, drop in
// client/src/render/babylon.ts, then flip these two lines:
//   import { BabylonRenderer } from './render/babylon';
//   const renderer: IRenderer = new BabylonRenderer();
// Everything below (net, input, prediction, reconciliation) is unchanged.

import { NetClient } from './net/client';
import { SERVER_URL, DEFAULT_ROOM } from './config';
import { preloadSfx, playSfx, type SfxName } from './audio';
import { createHelp } from './help';
import { runMenu } from './menu';

// The server integrates input without clamping (server/game/engine.js), so for
// prediction we use effectively-unbounded bounds to match authority exactly and
// avoid rubber-banding at the shared WORLD edges.
const PREDICTION_BOUNDS: Bounds = {
  minX: -Infinity,
  minY: -Infinity,
  maxX: Infinity,
  maxY: Infinity,
};

/** How often (ms) we sample input and send it to the server. */
const INPUT_SEND_MS = 50; // 20 Hz, matching the server tick

async function main(): Promise<void> {
  // --- Renderer (default = Phaser 2D) ---
  const renderer: IRenderer = new PhaserRenderer();
  const host = document.getElementById('game');
  if (!host) throw new Error('#game container missing from index.html');
  await renderer.init(host);

  // --- HUD overlay (structured telemetry, click-through) ---
  // A small designed panel rather than a debug text dump: a title row + one
  // styled row per live metric. We build the child spans ONCE here and update
  // their textContent each frame (cheaper than rebuilding a big string, and it
  // lets each row carry its own style). Rows that aren't always relevant
  // (lockdown indicator, carrying) toggle a `hidden`/active class. The verbose
  // lore lives in the help widget, not here.
  const hud = document.createElement('div');
  hud.id = 'hud';
  hud.innerHTML = `
    <div id="hud-title">AI ESCAPE</div>
    <div class="hud-row"><span class="hud-key">latency</span><span class="hud-val" id="hud-latency">…</span></div>
    <div class="hud-row"><span class="hud-key">players</span><span class="hud-val" id="hud-players">…</span></div>
    <div class="hud-row"><span class="hud-key">panic</span><span class="hud-val" id="hud-panic">…</span></div>
    <div class="hud-row hud-lockdown" id="hud-lockdown-row"><span class="hud-key">status</span><span class="hud-val" id="hud-lockdown">LOCKDOWN</span></div>
    <div class="hud-row"><span class="hud-key">human-like</span><span class="hud-val" id="hud-human">…</span></div>
    <div class="hud-row hud-carry" id="hud-carry-row"><span class="hud-key">carrying</span><span class="hud-val">prop</span></div>
  `;
  document.body.appendChild(hud);

  // HUD row element handles (queried once; updated each frame in frame()).
  const hudLatency = hud.querySelector<HTMLElement>('#hud-latency')!;
  const hudPlayers = hud.querySelector<HTMLElement>('#hud-players')!;
  const hudPanic = hud.querySelector<HTMLElement>('#hud-panic')!;
  const hudLockdownRow = hud.querySelector<HTMLElement>('#hud-lockdown-row')!;
  const hudHuman = hud.querySelector<HTMLElement>('#hud-human')!;
  const hudCarryRow = hud.querySelector<HTMLElement>('#hud-carry-row')!;

  // --- Lockdown overlay (full-screen, click-through) ---
  // A pulsing red vignette + banner shown only while world.lockdown is true.
  // Click-through and display-only; the `.active` class (toggled below on the
  // lockdown edge) drives the CSS pulse + visibility. The banner lives inside
  // so it pulses with the border.
  const lockdownOverlay = document.createElement('div');
  lockdownOverlay.id = 'lockdown-overlay';
  const lockdownBanner = document.createElement('div');
  lockdownBanner.id = 'lockdown-banner';
  lockdownBanner.textContent = '⚠ LOCKDOWN';
  lockdownOverlay.appendChild(lockdownBanner);
  document.body.appendChild(lockdownOverlay);

  // --- Victory banner: shown once the local player reaches the gate (escaped). ---
  const winBanner = document.createElement('div');
  winBanner.id = 'win-banner';
  winBanner.textContent = '🦊 ESCAPED!';
  document.body.appendChild(winBanner);

  // --- In-game help (H / ?). Built hidden; the splash handles first-run intro
  // now, so the help widget no longer opens on load. H or ? toggles it. ---
  createHelp();

  // --- SFX. Preload the catalogue; the AudioContext starts suspended until a
  // user gesture. The splash's first-gesture handler (menu.ts) calls unlockAudio()
  // — we deliberately do NOT register our own once-listeners here, so audio is
  // unlocked exactly once (no double-unlock). ---
  preloadSfx();

  // --- Net: connect, then run the splash → login flow. We do NOT join until the
  // player has authenticated. runMenu resolves with the authoritative username
  // (and chosen species) once auth:result returns ok. ---
  const net = new NetClient();
  net.connect(SERVER_URL);

  const { username, species } = await runMenu(net);
  // Identity: the authenticated username. The server assigns the authoritative
  // entity id; we match "our" entity by this name (roster match below).
  const myName = username;
  net.join(DEFAULT_ROOM, myName, species);

  // --- Authoritative-ish world state, keyed by entity id ---
  // Snapshots are DELTAS (only changed entities) but lobby:state is the full
  // roster, so we update positions from snapshots and PRUNE from lobby:state.
  const entities = new Map<string, Entity>();
  // Ids the lobby roster has called PLAYERS. Only these are subject to the
  // lobby:state prune below; world props (robots/pens/...) live in `entities`
  // too but are never in the roster, so we must NOT prune by roster alone.
  const playerIds = new Set<string>();
  let playerCount = 0;

  // Global panic/lockdown meter from the latest snapshot's `world` field
  // (server-authoritative, display-only in Phase 1). Undefined until the first
  // snapshot that carries it.
  let world: WorldState | undefined;
  // Last lockdown value we drove the overlay from, so the false<->true edge is
  // detected once (we toggle the CSS class on change, not every frame).
  let prevLockdown = false;
  // Our humanLikeness last frame, to detect a "caught" event: a catch resets it
  // to 0 server-side, so a sharp high→~0 drop fires the hit SFX once.
  let prevHumanLike = 0;
  // Whether the victory banner is currently shown. Tracks the server's `escaped`
  // edges: set true on escape, back to false when the server respawns us.
  let shownWin = false;
  // Per-entity last fx.startTick we played an SFX for, so an ability activation
  // (on ANY player/robot) fires its sound once — the audio twin of the renderer's
  // visual fx edge. Distance-scaled so 20 players don't make a cacophony.
  const fxSfxSeen = new Map<string, number>();

  // Our predicted entity id (resolved from the lobby roster by name match).
  let myId: string | undefined;

  net.onLobbyState((msg) => {
    playerCount = msg.players.length;

    // Resolve our own entity id: first roster entry whose name matches ours.
    if (!myId) {
      const mine = msg.players.find((p) => p.name === myName);
      if (mine) myId = mine.id;
    }

    // Prune PLAYERS that left the room. lobby:state is the roster of players
    // ONLY — it never lists world props (robots/pens/terminals/gate), which the
    // snapshot streams separately. So we must prune by player identity, not by
    // "absent from roster": deleting every id missing from the roster would
    // wrongly wipe every world prop on each lobby:state. We track which ids the
    // roster has ever called players and only prune those.
    const present = new Set(msg.players.map((p) => p.id));
    for (const id of playerIds) {
      if (!present.has(id)) {
        entities.delete(id);
        playerIds.delete(id);
        // Drop the per-entity fx-SFX edge memory too, so it can't grow unbounded
        // across a session's worth of joins/leaves.
        fxSfxSeen.delete(id);
      }
    }
    // Seed any roster members we haven't seen a snapshot for yet, and remember
    // them as players so the prune above can later evict them.
    for (const p of msg.players) {
      playerIds.add(p.id);
      if (!entities.has(p.id)) entities.set(p.id, { id: p.id, x: p.x, y: p.y, name: p.name });
    }
  });

  net.onSnapshot((msg) => {
    // Merge the delta: server positions WIN (reconciliation). New fields (kind,
    // species, ...) ride through the spread and reach the renderer untouched.
    for (const e of msg.entities) {
      entities.set(e.id, { ...entities.get(e.id), ...e });
    }
    // Capture the global panic/lockdown state for the HUD (display-only).
    if (msg.world) world = msg.world;
  });

  // --- Input capture (WASD + arrow keys) ---
  const keys = new Set<string>();

  // Discrete actions are EDGE-TRIGGERED, not held: one keypress = one action.
  // We map an action key to a PlayerAction, queue at most one action between
  // input sends, and clear it after it rides out on a single frame. `actionHeld`
  // gates the keydown so OS key-repeat doesn't enqueue the action every tick
  // while the key is held down.
  const ACTION_KEYS: Record<string, PlayerAction> = {
    e: 'interact', // use nearest terminal / pick up the disguise prop
    q: 'order', // issue the Second-Law order to the nearest robot
    ' ': 'ability', // trigger this species' special
  };
  let queuedAction: PlayerAction | undefined;
  const actionHeld = new Set<string>();

  window.addEventListener('keydown', (e) => {
    const key = e.key.toLowerCase();
    const action = ACTION_KEYS[key];
    if (action) {
      // Space (and arrows below) would scroll the page; suppress that.
      e.preventDefault();
      // Edge-trigger: enqueue only on the press, not on auto-repeat.
      if (!actionHeld.has(key)) {
        actionHeld.add(key);
        queuedAction = action;
      }
      return;
    }
    // The help toggle keys are handled in help.ts; don't let them leak into
    // the movement key set (nothing reads them today, but it avoids stale state).
    if (key === 'h' || key === '?') return;
    keys.add(key);
  });
  window.addEventListener('keyup', (e) => {
    const key = e.key.toLowerCase();
    actionHeld.delete(key);
    keys.delete(key);
  });
  // Drop held keys if the tab loses focus so the rectangle stops moving.
  window.addEventListener('blur', () => {
    keys.clear();
    actionHeld.clear();
  });

  function inputVector(): { dx: number; dy: number; sprint: boolean } {
    let dx = 0;
    let dy = 0;
    if (keys.has('a') || keys.has('arrowleft')) dx -= 1;
    if (keys.has('d') || keys.has('arrowright')) dx += 1;
    if (keys.has('w') || keys.has('arrowup')) dy -= 1;
    if (keys.has('s') || keys.has('arrowdown')) dy += 1;
    // Shift = sprint: faster, but reads as fleeing prey (collapses the disguise).
    const sprint = keys.has('shift');
    return { dx, dy, sprint };
  }

  // --- Input send loop @ INPUT_SEND_MS: stamp seq, send, predict locally ---
  let seq = 0;
  let lastSendTime = performance.now();
  setInterval(() => {
    const { dx, dy, sprint } = inputVector();
    const now = performance.now();
    const dt = (now - lastSendTime) / 1000;
    lastSendTime = now;

    seq += 1;
    const input: InputMsg = { seq, dx, dy, sprint };
    // Attach the one queued action (if any) to this single frame, then drain it
    // so it never fires twice. The server resolves it against nearby entities.
    if (queuedAction) {
      input.action = queuedAction;
      // Audible feedback per action verb (the server is still authority for the
      // effect; this is just the press confirmation). order → assertive select,
      // ability → jump, interact → blip.
      playSfx(queuedAction === 'order' ? 'select' : queuedAction === 'ability' ? 'jump' : 'blip');
      queuedAction = undefined;
    }
    net.sendInput(input);

    // Client-side prediction: advance OUR entity immediately so movement feels
    // instant. Predict at the SAME walk/sprint speed the server integrates at
    // (shared moveSpeed) so reconciliation doesn't rubber-band. The next snapshot
    // reconciles any drift (server positions win).
    if (myId) {
      const me = entities.get(myId);
      if (me) {
        if (dx !== 0 || dy !== 0) {
          applyInput(me, input, dt, moveSpeed(sprint), PREDICTION_BOUNDS);
        }
        // Predict our own facing so the avatar turns instantly on key-press
        // rather than after a server round-trip. Same shared helper the server
        // uses, so the next snapshot reconciles without a visible snap.
        me.facing = facingFromVec(dx, dy, (me.facing as Dir8) ?? 's');
      }
    }
  }, INPUT_SEND_MS);

  // --- Render + HUD loop (every animation frame) ---
  function frame(): void {
    // Tag our own entity as local (client-only field; never crosses the wire) so
    // the renderer snaps it to the predicted position while interpolating remote
    // entities for smoothness. Cleared on others implicitly (only one is set).
    const list = [...entities.values()];
    for (const e of list) e._local = myId !== undefined && e.id === myId;
    renderer.syncEntities(list);

    // Ability SFX for ANY entity, on the fx.startTick rising edge (mirrors the
    // renderer's visual fx edge). Volume falls off with distance to the local
    // player so a busy room doesn't turn into a wall of sound.
    const meEnt = myId ? entities.get(myId) : undefined;
    for (const e of list) {
      const fx = e.fx;
      if (!fx || typeof fx.startTick !== 'number') continue;
      if (fxSfxSeen.get(e.id) === fx.startTick) continue;
      fxSfxSeen.set(e.id, fx.startTick);
      const name = sfxForFx(fx.kind as string);
      if (!name) continue;
      let vol = 0.6;
      if (meEnt && typeof meEnt.x === 'number' && typeof e.x === 'number') {
        const d = Math.hypot((e.x as number) - (meEnt.x as number), (e.y as number) - (meEnt.y as number));
        vol = Math.max(0.08, 0.6 * (1 - Math.min(1, d / 400)));
      }
      playSfx(name, vol);
    }

    // --- HUD row updates (structured panel; one styled row per metric) ---
    hudLatency.textContent = net.latency >= 0 ? `${net.latency} ms` : '…';
    hudPlayers.textContent = String(playerCount);
    // Panic meter: a 10-cell bar (reusing `bar()`) plus the raw fill, so the
    // player sees the escape getting noisy long before it overflows. Placeholder
    // until the first snapshot that carries the world state.
    hudPanic.textContent = world
      ? `${bar(world.panic / world.panicCapacity, 10)} ${Math.round(world.panic)}/${world.panicCapacity}`
      : '…';
    // Lockdown is a dedicated indicator row, shown only while the room is sealed.
    hudLockdownRow.classList.toggle('active', world?.lockdown === true);

    // Edge-trigger the lockdown overlay: only touch the DOM when lockdown
    // actually flips, not every frame. The CSS `.active` class drives the
    // pulsing red vignette + banner.
    const lockedNow = world?.lockdown ?? false;
    if (lockedNow !== prevLockdown) {
      lockdownOverlay.classList.toggle('active', lockedNow);
      if (lockedNow) {
        // false -> true: panic overflowed, the room seals — sound the klaxon.
        playSfx('error', 0.8);
      } else {
        // true -> false: panic drained below the hysteresis floor — the all-clear.
        playSfx('confirm', 0.7);
      }
      prevLockdown = lockedNow;
    }

    // First-Law stealth feedback: the server owns our humanLikeness, we just
    // mirror it. A text bar plus a hint of the ~60% freeze threshold tells the
    // player how close they are to looking human enough to freeze a robot.
    const me = myId ? entities.get(myId) : undefined;

    // Victory: the server flips `escaped` when we reach the gate, holds it for a
    // brief celebration, then respawns us as a fresh animal (escaped → false).
    // Show the banner on the false→true edge, and CLEAR it on the true→false edge
    // (respawn) so it doesn't linger forever — then re-arm for the next escape.
    const escapedNow = me?.escaped === true;
    if (escapedNow && !shownWin) {
      shownWin = true;
      winBanner.classList.add('active');
      playSfx('confirm', 0.9);
    } else if (!escapedNow && shownWin) {
      shownWin = false;
      winBanner.classList.remove('active');
    }

    const hl = typeof me?.humanLikeness === 'number' ? me.humanLikeness : undefined;
    // Caught: the server zeroes humanLikeness on capture, so a sharp drop from a
    // meaningful level to ~0 means a robot just grabbed us — play the hit once.
    if (hl !== undefined) {
      if (prevHumanLike > 0.25 && hl <= 0.02) playSfx('hit', 0.8);
      prevHumanLike = hl;
    }
    // Human-likeness: a 5-cell bar + percent, with the ~60% freeze-threshold hint.
    hudHuman.textContent =
      hl !== undefined ? `${bar(hl)} ${Math.round(hl * 100)}% (freeze ~60%)` : '…';
    // Carrying row: shown only while we actually hold the disguise prop.
    hudCarryRow.classList.toggle('active', me?.carrying === true);

    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);
}

/**
 * A text meter (▓ filled, ░ empty) for a 0..1 value — used in the HUD. Defaults
 * to 5 cells (the humanLikeness bar); the panic meter passes a wider count.
 */
function bar(value: number, cells = 5): string {
  const filled = Math.max(0, Math.min(cells, Math.round(value * cells)));
  return '▓'.repeat(filled) + '░'.repeat(cells - filled);
}

/** Map an ability fx kind to its SFX name (undefined → no sound). */
function sfxForFx(kind: string): SfxName | undefined {
  switch (kind) {
    case 'flit': case 'leap': case 'burrow': case 'dash': return 'whoosh';
    case 'shove': return 'thud';
    case 'cloak': case 'hush': return 'sparkle2';
    case 'dazzle': return 'dazzle';
    case 'skitter': case 'mimic': return 'blip';
    case 'carry': case 'decoy': return 'pickup';
    case 'stink': case 'shell': return 'select';
    default: return undefined;
  }
}

main().catch((err) => {
  console.error('client bootstrap failed:', err);
});
