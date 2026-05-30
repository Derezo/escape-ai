/**
 * Client bootstrap — the glue that wires the renderer, the net layer, and input
 * together. Game-agnostic: the only "gameplay" is moving a rectangle, synced
 * through the authoritative server. Open two tabs and both see both rectangles.
 *
 * Data flow each frame:
 *   keyboard  -> input vector (dx,dy)
 *   input     -> NetClient.sendInput({seq,dx,dy})  (server is authority)
 *   input     -> client-side prediction via shared moveWithCollision (instant feel)
 *   snapshot  -> server positions WIN (reconciliation), merged into entity map
 *   entities  -> renderer.syncEntities(...)         (draw)
 */

import './style.css';

import type { IRenderer } from '@shared/renderer';
import type { Entity, WorldState, Dir8 } from '@shared/types';
import type { InputMsg, PlayerAction } from '@shared/net';
import { moveWithCollision, moveSpeed, facingFromVec } from '@shared/step';
import { generateWorld, WORLD_GEN_VERSION, type WorldMap } from '@shared/world';

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
import { initMusic, playMusicState } from './music';
import type { MusicName } from './audio.generated';
import { createHelp } from './help';
import { createInventory } from './inventory';
import { runMenu } from './menu';

// Client prediction uses the SAME collision-aware integration as the server
// (shared moveWithCollision against the regenerated map's grid), so prediction
// and authority agree and there's no rubber-banding at walls. The radius MUST
// match the server's (config.RECT_SIZE * 0.4 = 32 * 0.4); keep them in lockstep.
const PREDICT_RADIUS = 32 * 0.4;

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
    <div id="hud-title">ESCAPE AI</div>
    <div class="hud-row"><span class="hud-key">latency</span><span class="hud-val" id="hud-latency">…</span></div>
    <div class="hud-row"><span class="hud-key">players</span><span class="hud-val" id="hud-players">…</span></div>
    <div class="hud-row"><span class="hud-key">panic</span><span class="hud-val" id="hud-panic">…</span></div>
    <div class="hud-row hud-lockdown" id="hud-lockdown-row"><span class="hud-key">status</span><span class="hud-val" id="hud-lockdown">LOCKDOWN</span></div>
    <div class="hud-row"><span class="hud-key">human-like</span><span class="hud-val" id="hud-human">…</span></div>
    <div class="hud-row" id="hud-quest-row"><span class="hud-key">quest</span><span class="hud-val" id="hud-quest">…</span></div>
    <div class="hud-row hud-carry" id="hud-carry-row"><span class="hud-key">carrying</span><span class="hud-val">prop</span></div>
  `;
  document.body.appendChild(hud);

  // HUD row element handles (queried once; updated each frame in frame()).
  const hudLatency = hud.querySelector<HTMLElement>('#hud-latency')!;
  const hudPlayers = hud.querySelector<HTMLElement>('#hud-players')!;
  const hudPanic = hud.querySelector<HTMLElement>('#hud-panic')!;
  const hudLockdownRow = hud.querySelector<HTMLElement>('#hud-lockdown-row')!;
  const hudHuman = hud.querySelector<HTMLElement>('#hud-human')!;
  const hudQuest = hud.querySelector<HTMLElement>('#hud-quest')!;
  const hudQuestRow = hud.querySelector<HTMLElement>('#hud-quest-row')!;
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
  // A title line + a subtitle that reports the points + herd earned this escape.
  const winBanner = document.createElement('div');
  winBanner.id = 'win-banner';
  const winTitle = document.createElement('div');
  winTitle.id = 'win-title';
  winTitle.textContent = '🦊 ESCAPED!';
  const winSub = document.createElement('div');
  winSub.id = 'win-sub';
  winBanner.append(winTitle, winSub);
  document.body.appendChild(winBanner);

  // --- Action cue: a brief centered toast for collect / feed / steal events. ---
  const cue = document.createElement('div');
  cue.id = 'cue';
  document.body.appendChild(cue);
  let cueHideTimer: ReturnType<typeof setTimeout> | undefined;
  const flashCue = (text: string, kind: 'collect' | 'feed' | 'steal' | 'lost'): void => {
    cue.textContent = text;
    cue.dataset.kind = kind;
    cue.classList.add('active');
    if (cueHideTimer) clearTimeout(cueHideTimer);
    cueHideTimer = setTimeout(() => cue.classList.remove('active'), 900);
  };

  // --- In-game help (H / ?). Built hidden; the splash handles first-run intro
  // now, so the help widget no longer opens on load. H or ? toggles it. ---
  createHelp();

  // --- Inventory overlay (I). Built hidden; lists the collected food + which
  // species each feeds. Reads the local player's server-authoritative inventory. ---
  const inventory = createInventory();

  // --- SFX. Preload the catalogue; the AudioContext starts suspended until a
  // user gesture. The splash's first-gesture handler (menu.ts) calls unlockAudio()
  // — we deliberately do NOT register our own once-listeners here, so audio is
  // unlocked exactly once (no double-unlock). ---
  preloadSfx();
  initMusic();

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
  // The size of our herd last frame (animals whose followerOf === myId), so a DROP
  // (a rival stole one) fires a flavor "lost a follower" cue. Derived client-side.
  let prevHerd = 0;
  // Per-entity last fx.startTick we played an SFX for, so an ability activation
  // (on ANY player/robot) fires its sound once — the audio twin of the renderer's
  // visual fx edge. Distance-scaled so 20 players don't make a cacophony.
  const fxSfxSeen = new Map<string, number>();
  // Panic-warning edge: fire once when panic crosses the high threshold.
  let prevPanicHigh = false;
  // Per-robot mode seen last frame, so entering 'pursue' fires robot_alert once.
  const robotModeSeen = new Map<string, string>();
  // Quest-complete edge: fire quest_complete once when the quest first reads done.
  let prevQuestComplete = false;

  // Our predicted entity id (resolved from the lobby roster by name match).
  let myId: string | undefined;

  // The latest server tick we've seen (from snapshots). Used to judge whether a
  // transient stamp like `questBlocked` is RECENT — i.e. we just brushed the gate
  // without a complete quest — so the HUD can flash a short "finish your quest"
  // hint rather than show it forever. 0 until the first snapshot.
  let latestTick = 0;

  // The regenerated world map (from the seed the server sends once on join). Used
  // for collision-aware client prediction AND handed to the renderer to draw the
  // tilemap. Undefined until the `map` event arrives.
  let localMap: WorldMap | undefined;

  net.onMap((msg) => {
    // The seed is authoritative (server-chosen); we only assert the generator
    // version matches so we can't silently desync from a server on different gen
    // code. Then regenerate the identical WorldMap and hand it to the renderer.
    if (msg.version !== WORLD_GEN_VERSION) {
      console.error(
        `map version mismatch: server ${msg.version} vs client ${WORLD_GEN_VERSION}. ` +
          'Client/server world generators are out of sync — rebuild shared.',
      );
    }
    localMap = generateWorld(msg.seed);
    renderer.setMap(localMap);
  });

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
    // species, quest, ...) ride through the spread and reach the renderer untouched.
    for (const e of msg.entities) {
      entities.set(e.id, { ...entities.get(e.id), ...e });
    }
    // Track the authoritative tick clock (for transient-stamp recency like
    // questBlocked) and capture the global panic/lockdown state for the HUD.
    if (typeof msg.tick === 'number') latestTick = msg.tick;
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
    e: 'interact', // use nearest terminal / pick up the disguise prop / collect food
    q: 'order', // issue the Second-Law order to the nearest robot
    ' ': 'ability', // trigger this species' special
    f: 'feed', // give the nearest feedable animal its liked food → it follows you
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
    // The help (H/?) and inventory (I) toggle keys are handled in their own
    // modules; don't let them leak into the movement key set.
    if (key === 'h' || key === '?' || key === 'i') return;
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
      // ability → jump, feed → confirm, interact → blip.
      playSfx(
        queuedAction === 'order' ? 'select'
        : queuedAction === 'ability' ? 'jump'
        : queuedAction === 'feed' ? 'confirm'
        : 'blip',
      );
      queuedAction = undefined;
    }
    net.sendInput(input);

    // Client-side prediction: advance OUR entity immediately so movement feels
    // instant. We predict with the SAME collision-aware integration the server
    // runs authoritatively (shared moveWithCollision against the regenerated map's
    // grid, same speed + radius), so prediction stops at walls exactly where the
    // server will and reconciliation doesn't rubber-band. Before the map arrives
    // we simply don't predict movement (the first snapshot seeds our position).
    if (myId && localMap && (dx !== 0 || dy !== 0)) {
      const me = entities.get(myId);
      if (me) {
        moveWithCollision(
          me as { x: number; y: number },
          dx,
          dy,
          dt,
          moveSpeed(sprint),
          localMap.collision,
          localMap.w,
          localMap.h,
          localMap.tile,
          PREDICT_RADIUS,
        );
      }
    }
    // Predict our own facing so the avatar turns instantly on key-press rather
    // than after a server round-trip. Same shared helper the server uses, so the
    // next snapshot reconciles without a visible snap. (Independent of movement
    // prediction so facing still updates the frame the map is still loading.)
    if (myId) {
      const me = entities.get(myId);
      if (me) me.facing = facingFromVec(dx, dy, (me.facing as Dir8) ?? 's');
    }
  }, INPUT_SEND_MS);

  // --- Render + HUD loop (every animation frame) ---
  function frame(): void {
    // Tag our own entity as local (client-only field; never crosses the wire) so
    // the renderer snaps it to the predicted position while interpolating remote
    // entities for smoothness. Cleared on others implicitly (only one is set).
    //
    // Also stamp the decaying follow-ring inputs on any FOLLOWING animal: the
    // renderer has no server tick, but main.ts owns `latestTick`, so we derive the
    // remaining FRACTION here as a client-only underscore field (like _local) and
    // hand it down via syncEntities — no IRenderer/shared signature change. We also
    // count our own herd this frame to drive the "stolen from me" cue below.
    const list = [...entities.values()];
    let herdNow = 0;
    for (const e of list) {
      e._local = myId !== undefined && e.id === myId;
      // Follow ring: active iff this animal has an owner and an un-lapsed timer.
      const until = typeof e.followUntilTick === 'number' ? e.followUntilTick : undefined;
      const since = typeof e.followSince === 'number' ? e.followSince : undefined;
      if (e.followerOf && until !== undefined && until > latestTick) {
        const span = since !== undefined && until > since ? until - since : 1;
        e._followFrac = Math.max(0, Math.min(1, (until - latestTick) / span));
        e._followMine = myId !== undefined && e.followerOf === myId;
        if (e._followMine) herdNow += 1;
      } else if (e._followFrac !== undefined) {
        // No longer following — clear the stamps so the renderer drops the ring.
        e._followFrac = undefined;
        e._followMine = undefined;
      }
    }
    renderer.syncEntities(list);

    // Steal-from-me cue (flavor only): our herd shrank between frames → a rival fed
    // one of our followers away. Derived from the herd count, not a server event.
    if (herdNow < prevHerd) {
      flashCue('a follower was stolen!', 'lost');
      playSfx('error', 0.55);
    }
    prevHerd = herdNow;

    // Inventory overlay: refresh from our own server-authoritative bag (no-op
    // unless it changed). Cheap to call every frame.
    inventory.render(myId ? (entities.get(myId)?.inventory as Record<string, number> | undefined) : undefined);

    // Ability SFX for ANY entity, on the fx.startTick rising edge (mirrors the
    // renderer's visual fx edge). Volume falls off with distance to the local
    // player so a busy room doesn't turn into a wall of sound.
    const meEnt = myId ? entities.get(myId) : undefined;
    for (const e of list) {
      const fx = e.fx;
      if (!fx || typeof fx.startTick !== 'number') continue;
      if (fxSfxSeen.get(e.id) === fx.startTick) continue;
      fxSfxSeen.set(e.id, fx.startTick);
      // Animal-collection cue toast for OUR OWN actions: 'collect' fx rides our
      // player entity; 'feed'/'steal' ride the animal we just claimed (followerOf
      // === myId by now). Flavor only — the press already played its sound.
      if (fx.kind === 'collect' && e.id === myId) {
        flashCue('+1 food', 'collect');
      } else if ((fx.kind === 'feed' || fx.kind === 'steal') && e.followerOf === myId) {
        flashCue(fx.kind === 'steal' ? 'stolen — following you!' : 'following you!', fx.kind as 'feed' | 'steal');
      }
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
        playSfx('lockdown_alarm');
        playSfx('door_lock');
      } else {
        // true -> false: panic drained below the hysteresis floor — the all-clear.
        playSfx('lockdown_clear');
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
      playSfx('gate_open');
      // Score subtitle: the server stamps `lastScore` on the escape edge (the same
      // moment `escaped` flips). Report the points + herd; call out a stolen bonus.
      const ls = me?.lastScore as { points: number; herd: number; stolen: number } | undefined;
      if (ls && typeof ls.points === 'number') {
        const herd = ls.herd > 0
          ? `herd of ${ls.herd}${ls.stolen > 0 ? ` (${ls.stolen} stolen)` : ''}`
          : 'solo escape';
        winSub.textContent = `+${ls.points} pts · ${herd}`;
      } else {
        winSub.textContent = '';
      }
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

    // --- Side-quest row: surface the active quest + progress (display-only). ---
    // The server owns quest progress (gates the gate on completion); we just mirror
    // it. Show the title with a ✓ when complete; an 'activate' quest also shows
    // its N/need tally. If we recently brushed the gate WITHOUT a complete quest
    // (questBlocked stamped within ~1.5s = ~30 ticks at 20Hz), flash a hint that
    // the quest must be finished first, and tint the row.
    const quest = me?.quest;
    if (quest) {
      const blocked =
        typeof me?.questBlocked === 'number' && latestTick - me.questBlocked <= 30;
      if (quest.complete) {
        hudQuest.textContent = `${quest.title} ✓`;
      } else if (blocked) {
        hudQuest.textContent = 'finish your quest to escape!';
      } else if (quest.type === 'activate') {
        hudQuest.textContent = `${quest.title} ${quest.done}/${quest.need}`;
      } else {
        hudQuest.textContent = quest.title;
      }
      // Tint: green when done, amber when blocked at the gate, default otherwise.
      hudQuestRow.classList.toggle('quest-done', quest.complete);
      hudQuestRow.classList.toggle('quest-blocked', !quest.complete && blocked);
      // Quest-complete edge: chime once when the objective first reads done.
      if (quest.complete === true && !prevQuestComplete) playSfx('quest_complete');
      prevQuestComplete = quest.complete === true;
    } else {
      hudQuest.textContent = '…';
      hudQuestRow.classList.remove('quest-done', 'quest-blocked');
      prevQuestComplete = false;
    }

    // Carrying row: shown only while we actually hold the disguise prop.
    hudCarryRow.classList.toggle('active', me?.carrying === true);

    // --- Panic-warning edge: fire once when panic crosses the 66% threshold. ---
    const panicHigh =
      world && world.panicCapacity > 0 ? world.panic / world.panicCapacity >= 0.66 : false;
    if (panicHigh && !prevPanicHigh) playSfx('panic_warning');
    prevPanicHigh = panicHigh;

    // --- Robot-alert edge: fire once when any robot enters 'pursue' mode. ---
    for (const e of list) {
      if (e.kind !== 'robot') continue;
      const modeNow = typeof e.mode === 'string' ? e.mode : '';
      const modePrev = robotModeSeen.get(e.id) ?? '';
      if (modePrev !== 'pursue' && modeNow === 'pursue') {
        playSfx('robot_alert');
      }
      robotModeSeen.set(e.id, modeNow);
    }

    // --- Music state machine: select and crossfade the appropriate track. ---
    playMusicState(selectMusic());

    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);

  /**
   * Select the appropriate music track based on current game state.
   * Closes over the live `entities`, `world`, `myId`, and `me` vars from main().
   * Called every frame from the tail of frame(); playMusicState() is idempotent
   * so it only acts when the track actually changes.
   */
  function selectMusic(): MusicName | null {
    if (!myId) return 'title_theme'; // pre-join / menu
    const localMe = myId ? entities.get(myId) : undefined;
    if (localMe?.escaped === true) return 'victory_sting';
    if (world?.lockdown === true) return 'lockdown_loop';
    const panicFrac =
      world && world.panicCapacity > 0 ? world.panic / world.panicCapacity : 0;
    const pursued = [...entities.values()].some(
      (e) => e.kind === 'robot' && (typeof e.mode === 'string' ? e.mode : '') === 'pursue',
    );
    if (panicFrac >= 0.85) return 'panic_loop';
    if (pursued || panicFrac >= 0.66) return 'tension_loop';
    return 'explore_loop';
  }
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
    // Animal-collection events (echoed on the acting player / fed animal).
    case 'collect': return 'pickup';
    case 'feed': return 'confirm';
    case 'steal': return 'dazzle';
    default: return undefined;
  }
}

main().catch((err) => {
  console.error('client bootstrap failed:', err);
});
