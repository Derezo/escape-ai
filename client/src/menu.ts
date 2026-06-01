/**
 * The pre-game front end: a click-gate, then a splash screen, then a login
 * with a species picker.
 *
 * `runMenu()` owns the whole "before you're in the world" experience and
 * RESOLVES exactly once — when the player is authenticated and ready to join.
 * main.ts awaits it, then calls `net.join(...)`; nothing joins until auth lands.
 *
 * Flow:
 *   0. CLICK-GATE — a minimal full-screen overlay shown BEFORE the splash. Its
 *      sole purpose is to satisfy the browser audio-autoplay policy: the first
 *      keydown/pointerdown unlocks the AudioContext and starts the title music,
 *      then the gate fades out revealing the splash already behind it.
 *   1. SPLASH — animated "ESCAPE AI" title; any key/pointer dismisses it. That
 *      second gesture keeps audio unlocked (harmless second call) and title
 *      music is already playing (playMusicState is idempotent — no restart).
 *   2. LOGIN — if a token is stored, auto-login ("Welcome back, …"); else a
 *      username field + a grid species picker + Play. Submit emits auth:login.
 *   3. auth:result — on ok, persist the token, cache the stats, resolve. On a
 *      failure reason, show an inline error / fall back to manual entry.
 *
 * Audio-unlock coordination: the unlock lives in the click-gate handler (the
 * very first gesture). menu.ts calls `unlockAudio()` there AND starts
 * `title_theme` via `playMusicState`. The splash's dismissSplash() still calls
 * `unlockAudio()` (harmless — it just resumeLoops() on an already-unlocked
 * context) and does NOT restart the music (playMusicState is idempotent).
 * main.ts no longer registers its own once-listeners.
 *
 * Pure DOM/CSS overlays (renderer-agnostic). Species copy + roster come from
 * `@shared/species`; event handling goes through NetClient (no wire strings).
 */

import type { NetClient } from './net/client';
import type { AuthResult, UserStats } from '@shared/net';
import { SPECIES } from '@shared/species';
import { unlockAudio, playSfx } from './audio';
import { playMusicState } from './music';
import { loadAuth, saveAuth, clearAuth } from './auth';
import { createSpeciesSprite } from './species-sprite';

/** The tagline under the splash title — the premise in one breath. */
const SPLASH_TAGLINE = 'The zoo is under new management.';

/** What `runMenu` resolves with once the player is authed and ready to join. */
export interface MenuResult {
  username: string;
  species?: string;
  /**
   * True only on the player's genuine FIRST-EVER join — not resuming a saved
   * mid-run session (`!AuthResult.resumed`) AND their first session
   * (`AuthResult.stats.games <= 1`; the server bumps `games` to 1 on the first
   * login before stamping stats). Drives the one-time cinematic intro in main.ts.
   * Pairing the two conditions keeps the intro to the true first time — `!resumed`
   * alone would replay it whenever a returning player starts a fresh run.
   */
  isNewCharacter: boolean;
}

/**
 * Module-level cache of the most recent successful auth's stats, so the help
 * widget's Stats tab can render the logged-in player's record without threading
 * the value through main.ts. Updated in the auth:result handler below.
 */
let lastStats: UserStats | undefined;

/** The latest UserStats from a successful login, or undefined before first login. */
export function getLastStats(): UserStats | undefined {
  return lastStats;
}

/**
 * Drive the splash → login flow and resolve once the player is authenticated.
 * Builds (and tears down) its own overlays; leaves the DOM clean on resolve.
 */
export function runMenu(net: NetClient): Promise<MenuResult> {
  return new Promise<MenuResult>((resolve) => {
    // --- Build the click-gate overlay (shown FIRST, above the splash) -------
    // Its only job: satisfy the browser audio-autoplay policy. The first
    // keydown/pointerdown unlocks the AudioContext and starts title_theme, then
    // the gate fades out to reveal the splash already mounted behind it.
    const gate = document.createElement('div');
    gate.id = 'clickgate';
    gate.innerHTML = `
      <p id="clickgate-prompt">Click or press any key to start your escape...</p>
    `;
    document.body.appendChild(gate);

    const dismissGate = (): void => {
      window.removeEventListener('keydown', dismissGate);
      window.removeEventListener('pointerdown', dismissGate);
      // Unlock the AudioContext on this first user gesture.
      unlockAudio();
      // Start the title music immediately — it will keep playing through the
      // splash and login screens. playMusicState is idempotent, so later calls
      // from the main.ts guard or dismissSplash are no-ops while it's playing.
      playMusicState('title_theme');
      // Start the splash reveal NOW — its animations are mounted paused (see
      // style.css) so the staggered timeline begins from t=0 at this gesture
      // rather than burning down behind the gate while the user hesitated.
      splash.classList.add('running');
      // Fade the gate out; remove it once the transition finishes so the splash
      // (already in the DOM behind it) becomes the visible layer.
      gate.classList.add('leaving');
      window.setTimeout(() => {
        gate.remove();
        // ARM the splash listeners only NOW — after the gate gesture has been
        // fully consumed. Attaching them here (rather than at the top level of
        // runMenu) ensures gesture 1 dismisses only the gate, and the NEXT
        // gesture dismisses the splash. dismissSplash and showLogin are in scope
        // because they are defined in the same runMenu closure below.
        window.addEventListener('keydown', dismissSplash, { once: true });
        window.addEventListener('pointerdown', dismissSplash, { once: true });
      }, 280);
    };
    window.addEventListener('keydown', dismissGate, { once: true });
    window.addEventListener('pointerdown', dismissGate, { once: true });

    // --- Build the splash overlay (shown after the gate fades) --------------
    const splash = document.createElement('div');
    splash.id = 'splash';
    // The title is two separately-choreographed words: "ESCAPE" fades in slowly,
    // then "AI" pops in (flicker + shake) after a beat. Both, the tagline, and
    // the prompt start hidden and reveal on staggered CSS animation-delays — the
    // whole sequence is timed in style.css. It mounts PAUSED and only begins when
    // dismissGate adds `.running`, so the reveal starts at the gate gesture
    // rather than at page load (see the #splash play-state rules in style.css).
    splash.innerHTML = `
      <div id="splash-inner">
        <h1 id="splash-title">
          <span id="splash-word-escape">ESCAPE</span>
          <span id="splash-word-ai">AI</span>
        </h1>
        <p id="splash-tagline">${SPLASH_TAGLINE}</p>
        <p id="splash-prompt">Press any key to continue</p>
      </div>
    `;
    document.body.appendChild(splash);

    // --- Build the login overlay (hidden until the splash is dismissed) -----
    const login = document.createElement('div');
    login.id = 'login';
    login.innerHTML = `
      <div id="login-panel">
        <h2 id="login-title">Identify yourself</h2>
        <div id="login-welcome" hidden></div>
        <div id="login-form">
          <label id="login-name-label" for="login-name">Name</label>
          <input id="login-name" type="text" maxlength="32" autocomplete="off"
                 spellcheck="false" placeholder="your handle" />
          <p id="login-error" class="login-error" hidden></p>
          <p id="login-species-label">Choose your species</p>
          <div id="species-picker" role="listbox" aria-label="Species"></div>
          <button id="login-play" type="button">Play</button>
        </div>
      </div>
    `;
    login.style.display = 'none';
    document.body.appendChild(login);

    // Login form element handles (queried once).
    const welcomeEl = login.querySelector<HTMLDivElement>('#login-welcome')!;
    const formEl = login.querySelector<HTMLDivElement>('#login-form')!;
    const nameInput = login.querySelector<HTMLInputElement>('#login-name')!;
    const errorEl = login.querySelector<HTMLParagraphElement>('#login-error')!;
    const pickerEl = login.querySelector<HTMLDivElement>('#species-picker')!;
    const playBtn = login.querySelector<HTMLButtonElement>('#login-play')!;

    // --- Species picker: one selectable card per @shared species ------------
    // Default selection is filled in later (lastSpecies once stats are known,
    // else a sensible default). Start on the first roster entry so Play always
    // has a pick even before any stats arrive.
    let selectedSpecies = SPECIES[0]?.key;
    const cardByKey = new Map<string, HTMLElement>();

    const highlight = (key: string | undefined): void => {
      for (const [k, card] of cardByKey) {
        const on = k === key;
        card.classList.toggle('selected', on);
        card.setAttribute('aria-selected', on ? 'true' : 'false');
      }
    };

    for (const s of SPECIES) {
      const card = document.createElement('button');
      card.type = 'button';
      card.className = 'species-option';
      card.setAttribute('role', 'option');
      card.dataset.species = s.key;
      card.title = `${s.label} — ${s.ability}`;
      const sprite = createSpeciesSprite(s.key, { size: 48 });
      const label = document.createElement('span');
      label.className = 'species-option-label';
      label.textContent = s.label;
      card.appendChild(sprite);
      card.appendChild(label);
      card.addEventListener('click', () => {
        selectedSpecies = s.key;
        highlight(s.key);
      });
      pickerEl.appendChild(card);
      cardByKey.set(s.key, card);
    }
    highlight(selectedSpecies);

    // --- Shared teardown + resolve ------------------------------------------
    let settled = false;
    const finish = (result: MenuResult): void => {
      if (settled) return;
      settled = true;
      splash.remove();
      login.remove();
      resolve(result);
    };

    // --- auth:result handler -------------------------------------------------
    // The single place login outcomes are interpreted. Wired before we ever
    // emit a login (auto-login may fire immediately on splash dismissal).
    net.onAuthResult((msg: AuthResult) => {
      if (msg.ok) {
        // Persist the issued token + cache stats so the Stats tab can read them.
        if (msg.username && msg.token) saveAuth({ username: msg.username, token: msg.token });
        lastStats = msg.stats;
        // RESUME: a returning player with a saved session skips the picker entirely
        // — we join with NO species so the server restores their reborn one (and the
        // full mid-run snapshot). Otherwise honor the picker selection. Prefer the
        // server's authoritative username; fall back to what we sent.
        const username = msg.username ?? nameInput.value.trim();
        // NEW CHARACTER (drives the one-time cinematic intro): the player's genuine
        // first-ever join. That means NOT resuming a saved mid-run session AND this
        // being their first session — the server increments `games` to 1 on the
        // first successful login before stamping stats, so `games <= 1` is the
        // first-join signal. Gating on `!resumed` alone would replay the intro every
        // time a returning player starts a fresh run; pairing it with `games` keeps
        // it to the true first time. Missing stats (shouldn't happen on ok) is
        // treated as new.
        const games = msg.stats?.games ?? 0;
        const isNewCharacter = !msg.resumed && games <= 1;
        finish({
          username,
          species: msg.resumed ? undefined : selectedSpecies,
          isNewCharacter,
        });
        return;
      }
      // Failure: a real REJECTION (name taken, dead token) gets a short error buzz —
      // the splash-dismiss / form-submit that drove this login was a user gesture, so
      // audio is unlocked. The benign "enter a name" validation hint stays silent (a
      // buzz on an empty field is too punchy for a first-open nudge).
      switch (msg.reason) {
        case 'name_taken':
          playSfx('error');
          showManualForm();
          showError('That name is taken — try another.');
          nameInput.focus();
          nameInput.select();
          break;
        case 'bad_token':
          // The stored token no longer matches — forget it and fall back to
          // manual entry (do NOT auto-login again with the dead credential).
          playSfx('error');
          clearAuth();
          showManualForm();
          showError('Your saved session expired — sign in again.');
          break;
        case 'invalid':
        default:
          showManualForm();
          showError('Enter a name.');
          nameInput.focus();
          break;
      }
    });

    /** Show an inline error under the username field. */
    const showError = (text: string): void => {
      errorEl.textContent = text;
      errorEl.hidden = false;
    };
    const clearError = (): void => {
      errorEl.textContent = '';
      errorEl.hidden = true;
    };

    /** Swap the login panel into the "welcome back, auto-logging-in" state. */
    const showWelcome = (username: string): void => {
      welcomeEl.textContent = `Welcome back, ${username}…`;
      welcomeEl.hidden = false;
      formEl.style.display = 'none';
    };

    /** Show the manual username-entry form (the default / fallback state). */
    function showManualForm(): void {
      welcomeEl.hidden = true;
      formEl.style.display = '';
      // Default the species pick to the returning player's last choice if known.
      const last = lastStats?.lastSpecies;
      if (last && cardByKey.has(last)) {
        selectedSpecies = last;
        highlight(last);
      }
    }

    /** Validate + submit the manual login form. */
    const submitManual = (): void => {
      const username = nameInput.value.trim();
      if (!username) {
        showError('Enter a name.');
        nameInput.focus();
        return;
      }
      clearError();
      // No token on a manual login — the server claims/validates the name.
      net.login(username, undefined, selectedSpecies);
    };

    playBtn.addEventListener('click', submitManual);
    nameInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        submitManual();
      }
    });
    nameInput.addEventListener('input', clearError);

    /** Reveal the login overlay; attempt auto-login if a token is stored. */
    const showLogin = (): void => {
      login.style.display = '';
      const saved = loadAuth();
      if (saved) {
        // Session restore: show the welcome state and auto-login by token. A
        // bad_token reply falls back to the manual form (handled above).
        showWelcome(saved.username);
        net.login(saved.username, saved.token);
      } else {
        showManualForm();
        nameInput.focus();
      }
    };

    // --- Splash dismissal: second gesture — shows login ----------------------
    // Any keydown or pointerdown dismisses the splash. These listeners are
    // registered inside dismissGate's setTimeout (after the gate fade), NOT
    // here at the top level — that is the fix for the two-gesture sequence.
    // unlockAudio() is a harmless second call (it just resumeLoops() on an
    // already-unlocked context). Title music is already playing from the
    // click-gate gesture; playMusicState in the main.ts guard is idempotent.
    const dismissSplash = (): void => {
      window.removeEventListener('keydown', dismissSplash);
      window.removeEventListener('pointerdown', dismissSplash);
      unlockAudio();
      splash.classList.add('leaving');
      // Let the fade-out play, then hand off to login.
      window.setTimeout(() => {
        splash.style.display = 'none';
        showLogin();
      }, 280);
    };
    // NOTE: window.addEventListener for dismissSplash is intentionally NOT here.
    // It is deferred to dismissGate's setTimeout so the splash only arms after
    // the gate gesture is fully consumed. See dismissGate above.
  });
}
