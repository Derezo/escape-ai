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

import type { IRenderer, QuestGuide } from '@shared/renderer';
import type { Entity, WorldState, Dir8 } from '@shared/types';
import type { InputMsg, PlayerAction } from '@shared/net';
import { moveWithCollision, moveSpeed, facingFromVec } from '@shared/step';
import { generateWorld, WORLD_GEN_VERSION, type WorldMap } from '@shared/world';
import { speciesByKey } from '@shared/species';
import { foodByKey, foodForSpecies, FOOD_PICKUP_AMOUNT } from '@shared/food';

import { PhaserRenderer } from './render/phaser';
// --- 3D SWAP (see shared/BABYLON_FALLBACK.md) ---------------------------------
// If the hour-0 genre rule forces 3D, `npm install @babylonjs/core`, drop in
// client/src/render/babylon.ts, then flip these two lines:
//   import { BabylonRenderer } from './render/babylon';
//   const renderer: IRenderer = new BabylonRenderer();
// Everything below (net, input, prediction, reconciliation) is unchanged.

import { NetClient } from './net/client';
import { HEADLINE as CONN_HEADLINE, type ConnectionView } from './net/connection-state';
import { SERVER_URL, DEFAULT_ROOM } from './config';
import { preloadSfx, playSfx, startLoop, stopLoop, spatialGain, type SfxName } from './audio';
import { initMusic, playMusicState } from './music';
import type { MusicName } from './audio.generated';
import { createHelp } from './help';
import { createInventory } from './inventory';
import { createFoodBar } from './foodbar';
import { questHelpText } from './quest-help';
import { createLeaderboard } from './leaderboard';
import { createChat } from './chat';
import { runMenu } from './menu';
import { playIntro, preloadIntroAssets, isIntroActive } from './intro';
import { isAndroid, applyPlatformClass } from './platform';
import { getTouchVector, setActionSink } from './touch-input';
import { createTouchControls } from './touch-controls';

// Client prediction uses the SAME collision-aware integration as the server
// (shared moveWithCollision against the regenerated map's grid), so prediction
// and authority agree and there's no rubber-banding at walls. The radius MUST
// match the server's (config.RECT_SIZE * 0.4 = 32 * 0.4); keep them in lockstep.
const PREDICT_RADIUS = 32 * 0.4;

/** How often (ms) we sample input and send it to the server. */
const INPUT_SEND_MS = 50; // 20 Hz, matching the server tick

/** World-units a robot must travel per footstep foley (≈ half a 32px tile, so a
 *  ~60u/s patrol is ~2.3 steps/s and a faster chase quickens naturally). */
const ROBOT_STRIDE = 26;
/** Ignore sub-pixel per-frame jitter so a parked robot never ticks a footstep. */
const ROBOT_STEP_MIN_FRAME = 0.5;

async function main(): Promise<void> {
  // Mirror the platform onto <body> (platform-android / platform-native) so CSS can
  // gate touch-only presentation the same way the JS gates touch-only behaviour.
  applyPlatformClass();

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
  // Hidden during character selection; revealed once we're in-game (see frame()).
  hud.style.display = 'none';
  hud.innerHTML = `
    <div id="hud-title">ESCAPE AI</div>
    <div class="hud-row"><span class="hud-key">latency</span><span class="hud-val" id="hud-latency">…</span></div>
    <div class="hud-row"><span class="hud-key">players</span><span class="hud-val" id="hud-players">…</span></div>
    <div class="hud-row"><span class="hud-key">panic</span><span class="hud-val" id="hud-panic">…</span></div>
    <div class="hud-row hud-lockdown" id="hud-lockdown-row"><span class="hud-key">status</span><span class="hud-val" id="hud-lockdown">LOCKDOWN</span></div>
    <div class="hud-row"><span class="hud-key">human-like</span><span class="hud-val" id="hud-human">…</span></div>
    <div class="hud-row" id="hud-quest-row"><span class="hud-key">quest</span><span class="hud-val" id="hud-quest">…</span><button id="hud-quest-info" aria-label="What do I do?" title="What do I do?">ⓘ</button></div>
    <div class="hud-row hud-carry" id="hud-carry-row"><span class="hud-key">carrying</span><span class="hud-val">prop</span></div>
    <div id="hud-quest-help" role="tooltip"></div>
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
  const hudQuestInfo = hud.querySelector<HTMLButtonElement>('#hud-quest-info')!;
  const hudQuestHelp = hud.querySelector<HTMLElement>('#hud-quest-help')!;
  const hudCarryRow = hud.querySelector<HTMLElement>('#hud-carry-row')!;

  // The ⓘ info panel: a "what do I actually do?" readout for the current quest step,
  // shown UNDER the HUD. The detail text (frame() sets hudQuestHelp.dataset.text each
  // frame from the live step) explains the action + keybind — the bit the arrow can't
  // convey, and the only guidance an 'ability' step (no arrow) gets. Toggle by click;
  // also reveal on hover. The icon opts back into pointer events (the HUD is
  // click-through), and the panel mirrors the icon's open state.
  let questHelpPinned = false;
  const applyQuestHelp = (open: boolean): void => {
    hudQuestHelp.textContent = hudQuestHelp.dataset.text || '';
    hudQuestHelp.classList.toggle('open', open && !!hudQuestHelp.dataset.text);
  };
  hudQuestInfo.addEventListener('click', (e) => {
    e.stopPropagation();
    questHelpPinned = !questHelpPinned;
    applyQuestHelp(questHelpPinned);
  });
  hudQuestInfo.addEventListener('mouseenter', () => applyQuestHelp(true));
  hudQuestInfo.addEventListener('mouseleave', () => applyQuestHelp(questHelpPinned));

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
  const flashCue = (
    text: string,
    kind: 'collect' | 'feed' | 'steal' | 'lost' | 'reborn',
    holdMs = 900,
  ): void => {
    cue.textContent = text;
    cue.dataset.kind = kind;
    cue.classList.add('active');
    if (cueHideTimer) clearTimeout(cueHideTimer);
    cueHideTimer = setTimeout(() => cue.classList.remove('active'), holdMs);
  };

  // --- In-game help (H / ?). Built hidden; the splash handles first-run intro
  // now, so the help widget no longer opens on load. H or ? toggles it. ---
  createHelp();

  // --- Inventory overlay (I). Built hidden; lists the collected food + which
  // species each feeds. Reads the local player's server-authoritative inventory. ---
  const inventory = createInventory();

  // --- Food bar. A persistent top-right icon grid (🍌 ×10) of the food the player
  // is carrying, with a bounce on every count change. The compact at-a-glance view;
  // the detailed named readout stays in the toggle-I overlay above. ---
  const foodbar = createFoodBar();

  // --- SFX. Preload the catalogue; the AudioContext starts suspended until a
  // user gesture. The splash's first-gesture handler (menu.ts) calls unlockAudio()
  // — we deliberately do NOT register our own once-listeners here, so audio is
  // unlocked exactly once (no double-unlock). ---
  preloadSfx();
  initMusic();

  // --- Cinematic intro assets. Warm the two heavy transfer-pod PNGs now (decode
  // is fire-and-forget) so the first-run intro — played for brand-new characters
  // after they authenticate — fades in without a loading hitch. The intro SFX ride
  // the preloadSfx() catalogue load above. Cheap no-op for returning players. ---
  preloadIntroAssets();

  // --- Net: connect, then run the splash → login flow. We do NOT join until the
  // player has authenticated. runMenu resolves with the authoritative username
  // (and chosen species) once auth:result returns ok. ---
  const net = new NetClient();
  net.connect(SERVER_URL);

  // --- Connection-loss overlay (topmost, z-100) ---
  // If the connection is down for >= 5s, dim the screen and show "Unable to
  // connect… retrying" with a diagnostic box (the friendly reason + the raw
  // socket.io reason/error/transport/attempt/seconds-offline) and a "Retry now"
  // button. Built BEFORE runMenu so it also covers a first-load failure during the
  // menu. All the threshold/diagnostic logic lives in the connection-state machine
  // owned by NetClient (see net/connection-state.ts); here we only render the view
  // it hands us and drive its clock on a steady interval (the rAF frame() loop
  // below doesn't start until after the menu, so it can't drive this on its own).
  const connOverlay = document.createElement('div');
  connOverlay.id = 'connection-overlay';
  // Headline copy comes from the state machine (CONN_HEADLINE) so the constant is
  // the single source of truth — the static text here is just the pre-first-render
  // placeholder; renderConnView() overwrites it from view.headline.
  connOverlay.innerHTML = `
    <div id="connection-card">
      <div id="connection-headline">${CONN_HEADLINE}</div>
      <pre id="connection-detail"></pre>
      <button id="connection-retry" type="button">Retry now</button>
    </div>
  `;
  document.body.appendChild(connOverlay);
  const connHeadline = connOverlay.querySelector<HTMLElement>('#connection-headline')!;
  const connDetail = connOverlay.querySelector<HTMLElement>('#connection-detail')!;
  const connRetry = connOverlay.querySelector<HTMLButtonElement>('#connection-retry')!;
  connRetry.addEventListener('click', () => net.retry());
  // Render a view: toggle .active via a class (never set style.opacity from JS, so
  // the CSS fade transition isn't fought) and fill in the headline + diagnostics.
  const renderConnView = (view: ConnectionView): void => {
    connOverlay.classList.toggle('active', view.showOverlay);
    if (view.showOverlay) {
      connHeadline.textContent = view.headline;
      connDetail.textContent = view.detail;
    }
  };
  net.onConnectionChange(renderConnView);
  // Drive the health clock at 250ms so the 5s threshold trips and the "Ns offline"
  // counter advances even when no socket event fires. Imperceptible granularity for
  // a 5s gate, and cheap.
  setInterval(() => renderConnView(net.tickConnection(Date.now())), 250);

  // --- Leaderboard overlay (L). Built hidden; a sortable datatable of the top
  // players by every stat + the server-computed composite score. Opening it (and
  // each sort/poll tick) requests fresh data over the wire; the server's reply
  // (leaderboard:data) is routed to the overlay's render(). Wired here, after the
  // net client exists, so its request callback can close over `net`. ---
  const leaderboard = createLeaderboard((sort) => net.requestLeaderboard({ sort, limit: 100 }));
  net.onLeaderboard((msg) => leaderboard.render(msg));

  const { username, species, isNewCharacter } = await runMenu(net);
  // Identity: the authenticated username. The server assigns the authoritative
  // entity id; we match "our" entity by this name (roster match below).
  const myName = username;
  net.join(DEFAULT_ROOM, myName, species);

  // --- First-run cinematic: a brand-new character gets the "ESCAPE AI" transfer-pod
  // intro once. We DON'T await it here — playIntro() builds its opaque overlay (z-60)
  // synchronously, so the screen goes black immediately on join, and we let the rest
  // of main() (net handlers + the frame loop, wired below) run behind it. The world
  // therefore builds (onMap → generateWorld + the per-tile tilemap) DURING the
  // cinematic, behind the curtain, so it's ready the moment the intro tears itself
  // down — the join-build hitch is hidden. The frame loop's music guard
  // (isIntroActive()) keeps gameplay music silent until then. Returning players
  // resuming a run skip it. playIntro() never rejects. ---
  if (isNewCharacter) {
    void playIntro();
  }

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
  // Capture has no held server flag (unlike `escaped`), only the humanLikeness-crash
  // EDGE. To let the music machine play the one-shot `caught_sting` (a non-looping
  // track), we stamp a brief window here on that edge; selectMusic() returns the sting
  // while `now < caughtUntil`, so the frame-driven crossfade has a held state to lock
  // onto for the sting's duration instead of being overridden the very next frame.
  let caughtUntil = 0;
  // Whether the victory banner is currently shown. Tracks the server's `escaped`
  // edges: set true on escape, back to false when the server respawns us.
  let shownWin = false;
  // Our species last frame, to detect the REBIRTH edge: an escape respawn rolls us
  // into the next species server-side, so a change while the win banner was up means
  // "you've been reborn" — we toast the new species' label once on that change.
  let prevSpecies: string | undefined;
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
  // Per-robot footstep accumulator: last seen position + distance walked since the
  // last step sound, so we emit robot_footstep every STRIDE world-units of motion.
  // Cosmetic local foley derived from the robot's own movement — no server event,
  // gait-locked to the same position deltas the renderer animates the walk cycle on.
  const robotStep = new Map<string, { x: number; y: number; acc: number }>();
  // Quest-complete edge: fire quest_complete once when the quest first reads done.
  let prevQuestComplete = false;
  // Quest-progress edge: fire quest_progress once each time the current step's
  // done-count climbs (but not on the final completion — that's quest_complete's job).
  // Re-derived across step advances: step transitions also count as progress.
  let prevQuestDone = 0;
  // Step-index edge: fire quest_progress once each time the server advances to a
  // new step within the same quest (stepIndex rises, done resets to 0).
  let prevQuestStepIndex = 0;
  // Quest-blocked edge: fire quest_blocked once per gate brush, on the rising edge
  // of the server's questBlocked stamp (not every frame the hint is showing).
  let prevQuestBlocked = false;

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

  // --- Global chat widget (toggle `/` or click the icon). A collapsible DOM
  // overlay (bottom-left) for the room-wide text chat. While its input is focused
  // the player is TYPING, so movement must freeze + actions must not fire: the
  // widget reports focus via `chatFocused` (polled in the send loop) AND clears any
  // held keys on the focus edge (a window `blur` does NOT fire when an in-document
  // input gains focus, so a movement key held at the moment of focus would otherwise
  // "stick"). The `/` toggle is owned by the widget; we exclude `/` from the
  // movement key set below so it never leaks into walking. ---
  let chatFocused = false;
  const chat = createChat({
    send: (text) => net.sendChat(text),
    onFocusChange: (focused) => {
      chatFocused = focused;
      if (focused) {
        keys.clear();
        actionHeld.clear();
        queuedAction = undefined;
      }
    },
  });
  net.onChat((m) => chat.addMessage({ ...m, mine: !!myId && m.senderId === myId }));

  window.addEventListener('keydown', (e) => {
    const key = e.key.toLowerCase();
    // While typing in chat, let the input own every key — no walking, no actions.
    if (chatFocused) return;
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
    // The help (H/?), inventory (I), leaderboard (L), and chat (/) toggle keys are
    // handled in their own modules; don't let them leak into the movement key set.
    if (key === 'h' || key === '?' || key === 'i' || key === 'l' || key === '/') return;
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

  // Touch action buttons (Android) feed the SAME `queuedAction` slot the keyboard
  // uses — so interact/ability/feed/order ride out identically. Like the keyboard,
  // an action while typing in chat is suppressed. The press SFX is played here too
  // when the action is accepted, mirroring the send-loop confirmation; the send loop
  // still plays it on drain, so we only enqueue here (no double sound — the loop owns
  // the audio). Installed regardless of platform; only the touch UI calls it.
  setActionSink((action) => {
    if (chatFocused) return;
    queuedAction = action;
  });

  // Android-only on-screen controls: floating joystick + action buttons. Built once;
  // desktop never constructs them, so there are zero new widgets off-Android.
  const touchControls = isAndroid ? createTouchControls() : null;
  void touchControls; // retained for teardown symmetry; lives for the session

  function inputVector(): { dx: number; dy: number; sprint: boolean } {
    let dx = 0;
    let dy = 0;
    if (keys.has('a') || keys.has('arrowleft')) dx -= 1;
    if (keys.has('d') || keys.has('arrowright')) dx += 1;
    if (keys.has('w') || keys.has('arrowup')) dy -= 1;
    if (keys.has('s') || keys.has('arrowdown')) dy += 1;
    // Shift = sprint: faster, but reads as fleeing prey (collapses the disguise).
    let sprint = keys.has('shift');
    // Touch (Android) overrides the keyboard vector while a finger drives the
    // joystick: it publishes an ANALOG dx/dy in [-1,1] (proportional speed) and a
    // stick-edge sprint. The server clamps each axis to [-1,1] already, so analog is
    // safe with no wire change. When no finger is down getTouchVector() is null and
    // the keyboard vector above stands unchanged (desktop is untouched).
    const touch = getTouchVector();
    if (touch) {
      dx = touch.dx;
      dy = touch.dy;
      sprint = sprint || touch.sprint;
    }
    return { dx, dy, sprint };
  }

  // --- Input send loop @ INPUT_SEND_MS: stamp seq, send, predict locally ---
  let seq = 0;
  let lastSendTime = performance.now();
  setInterval(() => {
    // While the chat input is focused the player is typing: freeze movement. The
    // keydown handler already bails on `chatFocused` (so nothing new enters `keys`
    // and no action is queued), but a key held across the focus edge is cleared
    // there too — this zero is the authoritative guarantee we never walk while typing.
    const { dx, dy, sprint } = chatFocused ? { dx: 0, dy: 0, sprint: false } : inputVector();
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
    // The stats HUD belongs to the in-game view only — keep it hidden through
    // character selection and reveal it the moment we have our entity id.
    hud.style.display = myId ? 'block' : 'none';

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

    // --- Quest-direction guide (cosmetic, owner-only): tell the renderer where the
    // local player's CURRENT quest goal is so it can draw a path-following arrow.
    // The goal differs by quest type (the server still owns completion): a 'fetch'
    // (ape) heads to the GATE; an 'activate' (terminal-tapper) heads to the nearest
    // keeper terminal; a 'reach' returns to its OWN home questObject. We also flag
    // whether this species' own quest-object marker is meaningful, so the renderer
    // can hide the misleading do-nothing star (e.g. the ape's, whose target is the
    // gate). Cleared (null) when there's no quest, it's complete, or no goal exists.
    renderer.setQuestGuide?.(questGuideFor(myId, entities, localMap));

    // Steal-from-me cue (flavor only): our herd shrank between frames → a rival fed
    // one of our followers away. Derived from the herd count, not a server event.
    if (herdNow < prevHerd) {
      flashCue('a follower was stolen!', 'lost');
      playSfx('follower_lost', 0.55);
    }
    prevHerd = herdNow;

    // Inventory overlay + top-right food bar: refresh both from our own server-
    // authoritative bag (no-op unless it changed). Cheap to call every frame.
    const myBag = myId ? (entities.get(myId)?.inventory as Record<string, number> | undefined) : undefined;
    inventory.render(myBag);
    foodbar.render(myBag);

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
        // Name the food + show its icon so it's clear WHAT was picked up (e.g.
        // "+2 🥩 Raw Steak"). The server stamps fx.foodKey on the collect edge; fall
        // back to a generic label if an older server omits it.
        const food = typeof fx.foodKey === 'string' ? foodByKey(fx.foodKey) : undefined;
        const label = food ? `${food.icon} ${food.label}` : 'food';
        flashCue(`+${FOOD_PICKUP_AMOUNT} ${label}`, 'collect');
      } else if ((fx.kind === 'feed' || fx.kind === 'steal') && e.followerOf === myId) {
        flashCue(fx.kind === 'steal' ? 'stolen — following you!' : 'following you!', fx.kind as 'feed' | 'steal');
      }
      const name = sfxForFx(fx.kind as string);
      if (!name) continue;
      // Spatialize toward the local player. Ability FX are the player's own/
      // important actions, so when we DON'T know the distance (no local entity yet)
      // we fall back to full base volume rather than silencing them.
      let vol = 0.6;
      if (meEnt && typeof meEnt.x === 'number' && typeof e.x === 'number') {
        const d = Math.hypot((e.x as number) - (meEnt.x as number), (e.y as number) - (meEnt.y as number));
        vol = spatialGain(d, 0.6); // hard cutoff past HEAR_RADIUS
      }
      if (vol > 0) playSfx(name, vol);
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
      // Edge-only one-shots: the door-slam on seal, the all-clear chime on lift.
      playSfx(lockedNow ? 'door_lock' : 'lockdown_clear');
      prevLockdown = lockedNow;
    }
    // Klaxon loop (manifest soundLoop:true): reconcile EVERY frame, not just on the
    // edge, so it can't leak if a lockdown edge is ever missed (mirrors robot_pursuit
    // below). startLoop/stopLoop are idempotent — re-calling while already in the
    // desired state is a cheap no-op (start updates gain in place; stop on an idle
    // loop does nothing). This also covers joining straight into a sealed room.
    if (lockedNow) startLoop('lockdown_alarm', 0.7);
    else stopLoop('lockdown_alarm');

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
      // Fanfare: the gate-open thunk PLUS a celebratory chime stacked on it; the
      // victory_sting music swells underneath (selectMusic returns it while escaped,
      // and the server now holds the celebration window long enough for it to play).
      playSfx('gate_open');
      playSfx('quest_complete', 0.8);
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
      // Respawn edge: the server cleared `escaped` and rolled us into the next
      // species in its pen. Drop the banner and announce the REBIRTH — the species
      // we now are vs the one we escaped as (prevSpecies, tracked below).
      shownWin = false;
      winBanner.classList.remove('active');
      const nowSpecies = typeof me?.species === 'string' ? me.species : undefined;
      if (nowSpecies && nowSpecies !== prevSpecies) {
        const label = speciesByKey(nowSpecies)?.label ?? nowSpecies;
        const article = /^[aeiou]/i.test(label) ? 'an' : 'a';
        flashCue(`Reborn as ${article} ${label}!`, 'reborn', 2200);
        playSfx('confirm', 0.7);
      }
    }
    // Track our species every frame so the rebirth edge above sees the OLD species
    // (it's updated after the win-edge check, so the change is detected once).
    prevSpecies = typeof me?.species === 'string' ? me.species : prevSpecies;

    const hl = typeof me?.humanLikeness === 'number' ? me.humanLikeness : undefined;
    // Caught: the server zeroes humanLikeness on capture, so a sharp drop from a
    // meaningful level to ~0 means a robot just grabbed us — play the hit once.
    if (hl !== undefined) {
      if (prevHumanLike > 0.25 && hl <= 0.02) {
        playSfx('hit', 0.8);
        // Open the caught-music window so selectMusic() crossfades the one-shot
        // `caught_sting` in over the current loop. ~6s ≈ the sting's durationHint
        // (manifest caught_sting). When it lapses the loop the state machine wants
        // (explore/tension/…) fades back in normally.
        caughtUntil = performance.now() + 6000;
      }
      prevHumanLike = hl;
    }
    // Human-likeness: a 5-cell bar + percent, with the ~60% freeze-threshold hint.
    hudHuman.textContent =
      hl !== undefined ? `${bar(hl)} ${Math.round(hl * 100)}% (freeze ~60%)` : '…';

    // --- Side-quest row: surface the active quest + progress (display-only). ---
    // The server owns quest progress (gates the gate on completion); we just mirror
    // it. Multi-step quests show "step N/total · title · done/need" so the player
    // always knows which step they're on. If we recently brushed the gate WITHOUT a
    // complete quest (questBlocked stamped within ~1.5s = ~30 ticks at 20Hz), flash
    // a hint that the quest must be finished first, and tint the row.
    const quest = me?.quest;
    if (quest) {
      // New wire fields (added by the server when multi-step quests land; undefined
      // on an old single-step snapshot until the server is updated). Cast through
      // unknown first — QuestProgress lacks an index signature, so a direct cast to
      // Record<string,unknown> is rejected by strict tsc; the double-cast is safe here.
      const questAny = quest as unknown as Record<string, unknown>;
      const stepIndex = typeof questAny['stepIndex'] === 'number' ? questAny['stepIndex'] as number : 0;
      const stepsArr = Array.isArray(questAny['steps']) ? questAny['steps'] as Array<{kind: string; title: string; need: number}> : undefined;
      const stepCount = stepsArr ? stepsArr.length : 1;
      const blocked =
        typeof me?.questBlocked === 'number' && latestTick - me.questBlocked <= 30;
      if (quest.complete) {
        // Whole quest done: show the last step title with a checkmark.
        const stepLabel = stepCount > 1 ? `step ${stepCount}/${stepCount} · ` : '';
        hudQuest.textContent = `${stepLabel}${quest.title} ✓`;
      } else if (blocked) {
        hudQuest.textContent = 'finish your quest to escape!';
      } else {
        // Active step: "step N/total · title" and append "done/need" when need > 1.
        const stepPrefix = stepCount > 1 ? `step ${stepIndex + 1}/${stepCount} · ` : '';
        const progress = quest.need > 1 ? ` ${quest.done}/${quest.need}` : '';
        hudQuest.textContent = `${stepPrefix}${quest.title}${progress}`;
      }
      // Tint: green when done, amber when blocked at the gate, default otherwise.
      hudQuestRow.classList.toggle('quest-done', quest.complete);
      hudQuestRow.classList.toggle('quest-blocked', !quest.complete && blocked);
      // ⓘ help text for the CURRENT step: the action + keybind ("Press Space to
      // hush") plus the step's flavor blurb. Hidden once the quest is complete (no
      // action left to take). The icon shows only while there's a live step; the
      // panel reads its text from this dataset each time it's opened/hovered.
      if (!quest.complete) {
        const blurb = typeof quest.blurb === 'string' ? quest.blurb : '';
        hudQuestHelp.dataset.text = questHelpText({
          kind: quest.type,
          blurb,
          species: typeof me?.species === 'string' ? me.species : '',
          need: typeof quest.need === 'number' ? quest.need : 1,
        });
        hudQuestInfo.style.display = '';
      } else {
        hudQuestHelp.dataset.text = '';
        hudQuestInfo.style.display = 'none';
        applyQuestHelp(false);
      }
      // Quest-progress edge: tick once each time the current step's done-count
      // climbs while the quest is still short of complete (the final completion
      // is quest_complete's job). Also chime on a rising stepIndex — each step
      // advance counts as progress even though done resets to 0.
      const doneNow = typeof quest.done === 'number' ? quest.done : 0;
      if (!quest.complete && doneNow > prevQuestDone) playSfx('quest_progress');
      if (!quest.complete && stepIndex > prevQuestStepIndex) playSfx('quest_progress');
      prevQuestDone = doneNow;
      prevQuestStepIndex = stepIndex;
      // Quest-blocked edge: buzz once on the rising edge of a gate brush without a
      // finished quest — not every frame the "finish your quest" hint is showing.
      if (blocked && !quest.complete && !prevQuestBlocked) playSfx('quest_blocked');
      prevQuestBlocked = blocked && !quest.complete;
      // Quest-complete edge: chime once when the objective first reads done.
      if (quest.complete === true && !prevQuestComplete) playSfx('quest_complete');
      prevQuestComplete = quest.complete === true;
    } else {
      hudQuest.textContent = '…';
      hudQuestRow.classList.remove('quest-done', 'quest-blocked');
      hudQuestHelp.dataset.text = '';
      hudQuestInfo.style.display = 'none';
      applyQuestHelp(false);
      prevQuestComplete = false;
      prevQuestDone = 0;
      prevQuestStepIndex = 0;
      prevQuestBlocked = false;
    }

    // Carrying row: shown only while we actually hold the disguise prop.
    hudCarryRow.classList.toggle('active', me?.carrying === true);

    // --- Panic-warning edge: fire once when panic crosses the 66% threshold. ---
    const panicHigh =
      world && world.panicCapacity > 0 ? world.panic / world.panicCapacity >= 0.66 : false;
    if (panicHigh && !prevPanicHigh) playSfx('panic_warning');
    prevPanicHigh = panicHigh;

    // --- Robot-alert edge + pursuit loop: fire robot_alert once when any robot
    // enters 'pursue', and run the looping robot_pursuit motif for as long as at
    // least one robot is chasing (it stops when the last pursuer breaks off). ---
    let anyPursuing = false;
    // Distance (world units) to the nearest robot currently in 'pursue', so the
    // pursuit loop can swell as the closest chaser closes in. Infinity = none yet.
    let nearestPursuerDist = Infinity;
    const liveRobots = new Set<string>();
    for (const e of list) {
      if (e.kind !== 'robot') continue;
      liveRobots.add(e.id);
      // Distance to the local player (undefined if either position is unknown — guard
      // both axes so the hypot args are real numbers, not casts over maybe-undefined).
      const distToMe =
        meEnt &&
        typeof meEnt.x === 'number' &&
        typeof meEnt.y === 'number' &&
        typeof e.x === 'number' &&
        typeof e.y === 'number'
          ? Math.hypot(e.x - meEnt.x, e.y - meEnt.y)
          : undefined;
      const modeNow = typeof e.mode === 'string' ? e.mode : '';
      const modePrev = robotModeSeen.get(e.id) ?? '';
      if (modePrev !== 'pursue' && modeNow === 'pursue') {
        // Alert is spatialized: silent past HEAR_RADIUS, louder the closer the
        // robot is when it locks on. No local position known → silent.
        const v = distToMe !== undefined ? spatialGain(distToMe, 0.7) : 0;
        if (v > 0) playSfx('robot_alert', v);
      }
      if (modeNow === 'pursue') {
        anyPursuing = true;
        if (distToMe !== undefined && distToMe < nearestPursuerDist) nearestPursuerDist = distToMe;
      }
      robotModeSeen.set(e.id, modeNow);

      // Footstep foley: accumulate how far this robot has walked and tick a step
      // sound every ROBOT_STRIDE units. Derived from the robot's own position
      // delta (the same motion the renderer animates its walk cycle on), so the
      // cadence is gait-locked and quickens during a chase — no server event.
      if (typeof e.x === 'number' && typeof e.y === 'number') {
        const prev = robotStep.get(e.id);
        if (!prev) {
          robotStep.set(e.id, { x: e.x, y: e.y, acc: 0 });
        } else {
          const d = Math.hypot(e.x - prev.x, e.y - prev.y);
          prev.x = e.x;
          prev.y = e.y;
          if (d >= ROBOT_STEP_MIN_FRAME) {
            prev.acc += d;
            if (prev.acc >= ROBOT_STRIDE) {
              prev.acc %= ROBOT_STRIDE; // keep the leftover so cadence stays even
              // Footsteps are quiet foley (base 0.28) and spatialized: skip the
              // playSfx entirely when we can't place the listener or the robot is
              // out of earshot. The accumulator already advanced above, so the
              // cadence stays correct even while no step is actually heard.
              const vol = distToMe !== undefined ? spatialGain(distToMe, 0.28) : 0;
              if (vol > 0) playSfx('robot_footstep', vol);
            }
          }
        }
      }
    }
    // Idempotent start/stop (self-dedupes), so driving it from the per-frame
    // aggregate is safe and needs no separate edge state. The loop VOLUME tracks
    // the nearest pursuing robot: a far chase is silent and it swells as the robot
    // closes in. startLoop is idempotent on gain (updates in place, no restart).
    // No pursuer, no local position, or nearest chaser out of earshot → stop.
    const pursuitVol = anyPursuing && meEnt ? spatialGain(nearestPursuerDist, 0.6) : 0;
    if (pursuitVol > 0) startLoop('robot_pursuit', pursuitVol);
    else stopLoop('robot_pursuit');
    // Drop step accumulators for robots that left the snapshot, so the map can't
    // grow without bound across a long session (mirrors why we track liveRobots).
    if (robotStep.size > liveRobots.size) {
      for (const id of robotStep.keys()) if (!liveRobots.has(id)) robotStep.delete(id);
    }

    // --- Music state machine: select and crossfade the appropriate track. While
    // the first-run cinematic is up, hold title_theme (idempotent — no restart)
    // so its duck under the hum/VO remains intact. We joined before the intro,
    // so `myId` is already set and selectMusic() would otherwise crossfade the
    // explore_loop in under the still-playing intro. Instead, the frame after
    // the intro overlay tears down isIntroActive() returns false, selectMusic()
    // returns explore_loop, and playMusicState crossfades (1200ms) — the
    // natural title→gameplay crossfade on first spawn. ---
    playMusicState(isIntroActive() ? 'title_theme' : selectMusic());

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
    // Caught: a one-shot defeat sting over the held window stamped on the capture
    // edge (see caughtUntil). Below escape (you can't be both), above the loops so
    // the sting actually plays through instead of the next loop overriding it.
    if (performance.now() < caughtUntil) return 'caught_sting';
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
    // Animal-collection events (echoed on the acting player / fed animal). These
    // use the themed Escape AI SFX rather than the bare placeholder synth WAVs.
    case 'collect': return 'food_pickup';
    case 'feed': return 'feed_follow';
    case 'steal': return 'dazzle';
    default: return undefined;
  }
}

/**
 * The local player's quest-direction guide for the renderer (or null when there's
 * nothing to point at). Quests are now MULTI-STEP, so the goal tracks the CURRENT
 * step's mechanic (server sets quest.type = steps[stepIndex].kind); the server owns
 * completion, this only chooses where the cosmetic arrow points for that step:
 *   - 'fetch'/'escort' → the perimeter gate (courier the prop / lead a herd out).
 *   - 'activate'/'order' → the nearest keeper terminal still USABLE for me: the
 *               server forwards my own counted ids (quest.activatedIds) and each
 *               terminal's shared lock (entity.activatedBy), so the arrow skips
 *               consoles I've already tapped or that another player holds, advancing
 *               to the next one (falls back to nearest if all are done/locked).
 *   - 'collect'  → the NEAREST food source.
 *   - 'recruit'  → the NEAREST feedable other-species animal not already yours.
 *   - 'ability'  → no waypoint (self-contained; the arrow points at the player itself
 *               so no visible route is drawn) — the HUD still shows the step.
 *   - 'reach'    → the player's OWN home questObject.
 * Returns null when there's no quest, it's already complete, the local entity isn't
 * known yet, or no goal entity can be found.
 *
 * Also reports `questUsesMarker` (true only on a 'reach' step) so the renderer can
 * hide a species' own do-nothing star while a non-reach step is active.
 */
function questGuideFor(
  myId: string | undefined,
  entities: Map<string, Entity>,
  localMap: WorldMap | undefined,
): QuestGuide | null {
  if (!myId) return null;
  const me = entities.get(myId);
  if (!me || typeof me.x !== 'number' || typeof me.y !== 'number') return null;
  const species = typeof me.species === 'string' ? me.species : '';
  if (!species) return null;

  const quest = me.quest;
  // No quest, or it's complete → no guide (returns null). One intended consequence:
  // once a non-'reach' quest completes, the guide goes null and the renderer's marker
  // filter stops hiding this species' own questObject star, so that star re-appears.
  // That's fine — it was only hidden because it was a MISLEADING active-quest target;
  // a completed quest's home star is harmless scenery (the HUD already shows the ✓).
  if (!quest || quest.complete) return null;

  // The server always sets quest.type to steps[stepIndex].kind — so quest.type IS
  // the current step's mechanic. Switch on it to pick the right goal.
  // questUsesMarker is true ONLY for 'reach' steps: the home questObject star is the
  // real target; for every other step the star would be misleading, so hide it.
  // Widen to string so future step kinds ('escort','collect','recruit','order','ability')
  // compare cleanly — strict tsc rejects kind==='escort' when the old QuestProgress
  // type union only lists 'reach'|'fetch'|'activate'. The shared types will widen
  // once the contract architect updates shared/src/types.ts; this cast bridges the gap.
  const kind: string = quest.type;
  const questUsesMarker = kind === 'reach';

  // Pick the goal POINT by current-step mechanic. Iterate entities.values() directly
  // (no array spread) so this stays allocation-free in the per-frame loop.
  let goal: { x: number; y: number } | undefined;

  if (kind === 'fetch' || kind === 'escort') {
    // 'fetch' (ape courier) or 'escort' (lead followers out) → the perimeter gate.
    for (const e of entities.values()) {
      if (e.kind === 'gate' && typeof e.x === 'number' && typeof e.y === 'number') {
        goal = { x: e.x, y: e.y };
        break;
      }
    }
    if (!goal) goal = localMap?.gate; // fallback to the static map's gate point
  } else if (kind === 'activate' || kind === 'order') {
    // 'activate' or 'order' → the nearest keeper terminal that is still a USABLE
    // target for me, so the arrow advances to the next console as I work through
    // the step. The server now tells us enough to filter two classes out:
    //   - terminals I've ALREADY counted this step (quest.activatedIds — my own
    //     per-step distinct-terminal tally, forwarded on my entity); and
    //   - terminals currently LOCKED green by ANOTHER player (entity.activatedBy
    //     set to someone else, within the server's 15s window) — I can't use those
    //     right now, so don't route there.
    // If every terminal is filtered out (all done/locked) we fall back to the
    // nearest terminal regardless, so the arrow never vanishes mid-step.
    const mineDone = new Set(me.quest?.activatedIds ?? []);
    let nearestD2 = Infinity;
    let fallbackD2 = Infinity;
    let fallbackGoal: { x: number; y: number } | undefined;
    for (const e of entities.values()) {
      if (e.kind !== 'terminal' || typeof e.x !== 'number' || typeof e.y !== 'number') continue;
      const d2 = (e.x - me.x) ** 2 + (e.y - me.y) ** 2;
      if (d2 < fallbackD2) {
        fallbackD2 = d2;
        fallbackGoal = { x: e.x, y: e.y };
      }
      // Skip terminals I already tapped this step, or that someone else holds.
      if (mineDone.has(e.id)) continue;
      const lockedByOther = typeof e.activatedBy === 'string' && e.activatedBy !== myId;
      if (lockedByOther) continue;
      if (d2 < nearestD2) {
        nearestD2 = d2;
        goal = { x: e.x, y: e.y };
      }
    }
    if (!goal) goal = fallbackGoal; // all done/locked → keep pointing at the nearest
  } else if (kind === 'collect') {
    // 'collect' → the NEAREST food source entity.
    let nearestD2 = Infinity;
    for (const e of entities.values()) {
      if (e.kind !== 'food' || typeof e.x !== 'number' || typeof e.y !== 'number') continue;
      const d2 = (e.x - me.x) ** 2 + (e.y - me.y) ** 2;
      if (d2 < nearestD2) {
        nearestD2 = d2;
        goal = { x: e.x, y: e.y };
      }
    }
  } else if (kind === 'recruit') {
    // 'recruit' → the NEAREST animal I can ACTUALLY recruit right now. The server's
    // feedNearbyAnimal silently refuses any animal whose liked food I'm not carrying
    // (follow.js), so an arrow that ignores my inventory would send me (notably the
    // kangaroo, whose very first step is 'recruit 2') at animals I can't feed — press
    // F, nothing happens, the quest looks broken. So an IDEAL target is a different
    // species, not already mine, AND one whose food I hold. If I hold no usable food
    // at all, the right next move is to go GET food, so we fall back to the nearest
    // food source; only if there's no food entity either do we point at the nearest
    // animal as a last resort (so the arrow never simply vanishes mid-step).
    const myBag = (me.inventory as Record<string, number> | undefined) ?? {};
    let nearestD2 = Infinity; // nearest FEEDABLE ideal animal
    let foodD2 = Infinity;
    let foodGoal: { x: number; y: number } | undefined; // nearest food source
    let animalD2 = Infinity;
    let animalGoal: { x: number; y: number } | undefined; // nearest any animal
    for (const e of entities.values()) {
      if (typeof e.x !== 'number' || typeof e.y !== 'number') continue;
      const d2 = (e.x - me.x) ** 2 + (e.y - me.y) ** 2;
      if (e.kind === 'food') {
        if (d2 < foodD2) { foodD2 = d2; foodGoal = { x: e.x, y: e.y }; }
        continue;
      }
      if (e.kind !== 'animal' || e.id === myId) continue;
      if (d2 < animalD2) { animalD2 = d2; animalGoal = { x: e.x, y: e.y }; }
      // Ideal: different species, not already mine, and I carry its food so a feed
      // press would actually land.
      const liked = typeof e.species === 'string' ? foodForSpecies(e.species).key : '';
      const feedable = !!liked && (myBag[liked] || 0) > 0;
      const isIdeal = e.species !== species && e.followerOf !== myId && feedable;
      if (isIdeal && d2 < nearestD2) {
        nearestD2 = d2;
        goal = { x: e.x, y: e.y };
      }
    }
    // No feedable animal in sight → if I'm carrying NO animal food at all, the next
    // move is to stock up, so head to a food source; otherwise (I have food but no
    // valid target nearby) just point at the nearest animal.
    if (!goal) {
      const hasAnyFood = Object.values(myBag).some((n) => n > 0);
      goal = hasAnyFood ? (animalGoal ?? foodGoal) : (foodGoal ?? animalGoal);
    }
  } else if (kind === 'ability') {
    // 'ability' → no waypoint: the action is self-contained (fire your power anywhere).
    // Point the guide at the player itself so the pathfinder yields a zero-length
    // route → no visible arrow; the HUD still shows the step title/blurb.
    return { fromId: myId, goalX: me.x, goalY: me.y, ownerSpecies: species, questUsesMarker: false };
  } else {
    // 'reach' (and unknown future kinds) → this species' own home questObject.
    for (const e of entities.values()) {
      if (e.kind === 'questObject' && e.species === species
        && typeof e.x === 'number' && typeof e.y === 'number') {
        goal = { x: e.x, y: e.y };
        break;
      }
    }
    // Fallback: if the home questObject isn't in the snapshot yet (a transient miss
    // right after a respawn / before the first full snapshot), use the local map's
    // own housing center for this species — the same world-unit "reach your den"
    // anchor — so a 'reach' arrow never blinks out mid-step.
    if (!goal && localMap) {
      const home = localMap.housing.find((h) => h.species === species);
      if (home) goal = { x: home.cx, y: home.cy };
    }
  }
  if (!goal) return null;

  return { fromId: myId, goalX: goal.x, goalY: goal.y, ownerSpecies: species, questUsesMarker };
}

main().catch((err) => {
  console.error('client bootstrap failed:', err);
});
