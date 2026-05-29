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
import type { Entity, WorldState } from '@shared/types';
import type { InputMsg } from '@shared/net';
import { applyInput, type Bounds } from '@shared/step';

import { PhaserRenderer } from './render/phaser';
// --- 3D SWAP (see shared/BABYLON_FALLBACK.md) ---------------------------------
// If the hour-0 genre rule forces 3D, `npm install @babylonjs/core`, drop in
// client/src/render/babylon.ts, then flip these two lines:
//   import { BabylonRenderer } from './render/babylon';
//   const renderer: IRenderer = new BabylonRenderer();
// Everything below (net, input, prediction, reconciliation) is unchanged.

import { NetClient } from './net/client';
import { SERVER_URL, DEFAULT_ROOM, PLAYER_SPEED } from './config';

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

  // --- HUD overlay (latency + player count) ---
  const hud = document.createElement('div');
  hud.id = 'hud';
  document.body.appendChild(hud);

  // --- Identity: a random name so two tabs are distinguishable. The server
  // assigns the authoritative entity id; we match "our" entity by this name. ---
  const myName = prompt('Your name?')?.trim() || randomName();

  // --- Net ---
  const net = new NetClient();
  net.connect(SERVER_URL);
  net.join(DEFAULT_ROOM, myName);

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

  // Our predicted entity id (resolved from the lobby roster by name match).
  let myId: string | undefined;
  // Highest input seq the server has acked for us (from snapshot.acks).
  let lastAckedSeq = 0;

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
    // Track how far the server has consumed our input stream.
    if (myId && msg.acks[myId] !== undefined) {
      lastAckedSeq = msg.acks[myId];
    }
  });

  // --- Input capture (WASD + arrow keys) ---
  const keys = new Set<string>();
  window.addEventListener('keydown', (e) => keys.add(e.key.toLowerCase()));
  window.addEventListener('keyup', (e) => keys.delete(e.key.toLowerCase()));
  // Drop held keys if the tab loses focus so the rectangle stops moving.
  window.addEventListener('blur', () => keys.clear());

  function inputVector(): { dx: number; dy: number } {
    let dx = 0;
    let dy = 0;
    if (keys.has('a') || keys.has('arrowleft')) dx -= 1;
    if (keys.has('d') || keys.has('arrowright')) dx += 1;
    if (keys.has('w') || keys.has('arrowup')) dy -= 1;
    if (keys.has('s') || keys.has('arrowdown')) dy += 1;
    return { dx, dy };
  }

  // --- Input send loop @ INPUT_SEND_MS: stamp seq, send, predict locally ---
  let seq = 0;
  let lastSendTime = performance.now();
  setInterval(() => {
    const { dx, dy } = inputVector();
    const now = performance.now();
    const dt = (now - lastSendTime) / 1000;
    lastSendTime = now;

    seq += 1;
    const input: InputMsg = { seq, dx, dy };
    net.sendInput(input);

    // Client-side prediction: advance OUR entity immediately so movement feels
    // instant. The next snapshot reconciles any drift (server positions win).
    if (myId) {
      const me = entities.get(myId);
      if (me && (dx !== 0 || dy !== 0)) {
        applyInput(me, input, dt, PLAYER_SPEED, PREDICTION_BOUNDS);
      }
    }
  }, INPUT_SEND_MS);

  // --- Render + HUD loop (every animation frame) ---
  function frame(): void {
    renderer.syncEntities([...entities.values()]);

    const lat = net.latency >= 0 ? `${net.latency} ms` : '...';
    // Panic/lockdown come from the snapshot's world state; show placeholders
    // until the first snapshot that carries it.
    const panic = world ? `${Math.round(world.panic)}/${world.panicCapacity}` : '...';
    const lockdown = world ? (world.lockdown ? 'yes' : 'no') : '...';
    hud.textContent =
      `TINS 2026\n` +
      `latency: ${lat}\n` +
      `players: ${playerCount}\n` +
      `seq: ${seq}  acked: ${lastAckedSeq}\n` +
      `panic: ${panic}\n` +
      `lockdown: ${lockdown}`;

    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);
}

/** A short random handle so multiple tabs are visually distinct. */
function randomName(): string {
  const animals = ['fox', 'owl', 'cat', 'bee', 'elk', 'ram', 'jay', 'koi'];
  const a = animals[Math.floor(Math.random() * animals.length)];
  const n = Math.floor(Math.random() * 100);
  return `${a}${n}`;
}

main().catch((err) => {
  console.error('client bootstrap failed:', err);
});
