/**
 * The in-game help widget (toggle H or ?) — a tabbed panel that replaces the old
 * single-scroll manual. It covers the recurring TINS in-game-help requirement
 * AND carries the STORY + artistic/bonus beats so a reviewer can find them:
 *   - Controls       — the condensed key list (the default tab on open)
 *   - Species        — animated cards for all 14 @shared species + abilities
 *   - More           — the lore: premise, the verbatim Three Laws (rule #84,
 *                       the Asimov reference), the double-edged Sutskever-order
 *                       callout, overflow, and the "THE CAVES OF STEEL" flavour
 *   - Stats          — the logged-in player's persisted UserStats
 *
 * Pure DOM + CSS; no renderer dependency. `createHelp()` builds the hidden
 * overlay, wires H/? to toggle and Esc/× to close, and returns a handle. Unlike
 * the old manual it does NOT open on load — the splash (menu.ts) handles the
 * first-run introduction now.
 *
 * Species sprites animate via pure CSS (species-sprite.ts), so the Species tab
 * can be (re)built freely with no JS timers to dispose — there is nothing to
 * leak. The Stats tab reads `getLastStats()` from menu.ts on every activation,
 * so it always reflects the most recent successful login.
 */

import { SPECIES, speciesByKey } from '@shared/species';
import { createSpeciesSprite } from './species-sprite';
import { getLastStats } from './menu';
import { isTypingInTextField } from './dom';
import { formatPlayTime } from './time';

/** The four tab ids, in display order. Controls is the default active tab. */
type TabId = 'controls' | 'species' | 'more' | 'stats';

/** The panel chrome (tab bar + empty tab bodies). Per-tab content fills in below. */
const HELP_HTML = `
  <div id="help-panel">
    <button id="help-close" aria-label="Close help">×</button>
    <div id="help-tabs" role="tablist">
      <button class="help-tab" role="tab" data-tab="controls">Controls</button>
      <button class="help-tab" role="tab" data-tab="species">Species</button>
      <button class="help-tab" role="tab" data-tab="more">More</button>
      <button class="help-tab" role="tab" data-tab="stats">Stats</button>
    </div>
    <div id="help-body">
      <section class="help-pane" data-tab="controls"></section>
      <section class="help-pane" data-tab="species"></section>
      <section class="help-pane" data-tab="more"></section>
      <section class="help-pane" data-tab="stats"></section>
    </div>
    <p class="help-hint">press H or ? to close</p>
  </div>
`;

/** Controls tab — the condensed key reference. */
const CONTROLS_HTML = `
  <h2>Controls</h2>
  <ul class="cols">
    <li><b>WASD / arrows</b> — walk (stays human)</li>
    <li><b>Shift</b> — sprint (fast, but reads as prey)</li>
    <li><b>E</b> — interact: terminal / prop / collect food</li>
    <li><b>F</b> — feed the nearest animal (it joins your herd)</li>
    <li><b>Q</b> — order a robot (Second Law)</li>
    <li><b>Space</b> — your species ability</li>
    <li><b>I</b> — inventory (food + who it feeds)</li>
    <li><b>L</b> — leaderboard (top players + your score)</li>
    <li><b>/</b> — chat with everyone in the world</li>
    <li><b>H</b> or <b>?</b> — toggle this help</li>
  </ul>
  <h2>Goal</h2>
  <p>Reach the <b>gate</b> at the far right edge to escape. But first, finish your
    animal's <b>multi-step side-quest</b> — shown in the <b>HUD</b> (top-left) as
    <em>step N/total</em>. Each species has its own arc: gather food, recruit a
    herd-mate, use your special ability, order a keeper aside, or return home — then
    finally <b>reach home</b> or <b>escort followers to the gate</b>. The ape couriers
    a Clipboard found inside its building out through the gate. The gate won't open
    until your quest reads <b>✓</b>. Walk to stay human, time your orders, and
    don't tip the zoo into lockdown.</p>
`;

/**
 * "More" tab — the lore, lifted verbatim from the old manual: the premise, the
 * Three Laws (with the in-line notes), the double-edged Sutskever-order callout,
 * the catastrophic-overflow note, the "THE CAVES OF STEEL" flavour heading, and
 * the U.S. Robots footer. This is where the in-world story name now lives.
 */
const MORE_HTML = `
  <h1>THE CAVES OF STEEL</h1>
  <p class="tagline">
    You are an animal. The zoo is run by robots. The robots cannot harm a
    human — so <em>look like one</em>, and walk out the front gate.
  </p>

  <h2>The Three Laws of Robotics <span class="cite">— I, Robot (Asimov, 1950)</span></h2>
  <ol class="laws">
    <li>A robot may not injure a human being or, through inaction, allow a human
      being to come to harm. <span class="note">→ look human enough and the keeper
      robots <b>freeze</b> — they can't touch you. Stand still to look human;
      sprinting reads as fleeing prey.</span></li>
    <li>A robot must obey the orders given it by human beings except where such
      orders would conflict with the First Law. <span class="note">→ press
      <b>Q</b> near a robot to make it <b>stand down</b>.</span></li>
    <li>A robot must protect its own existence as long as such protection does
      not conflict with the First or Second Law. <span class="note">→ robots
      won't walk into hazards.</span></li>
  </ol>

  <h2>The order is a double-edged tool <span class="cite">— it can help or harm</span></h2>
  <p class="sutskever">
    Ordering a robot (<b>Q</b>) opens your path <em>now</em> — but every order
    makes that robot <b>more suspicious</b> (it then demands a more convincingly
    human target before the First Law will freeze it again) <em>and</em> stokes
    the zoo-wide <b>panic meter</b>. Lean on orders and you push the whole zoo
    toward <b>LOCKDOWN</b>, where the robots drop their First-Law caution and
    hunt you regardless of disguise. Use it well, not often.
  </p>

  <h2>Catastrophic overflow</h2>
  <p>
    The <b>panic meter</b> is the container. Chases, captures and orders fill it;
    lying low drains it. Overflow it and the zoo flips into <b>LOCKDOWN</b> — the
    red alarm. Drain it back down and lockdown lifts.
  </p>

  <p class="footer">
    <span class="ref">Property of U.S. Robots and Mechanical Men, Inc.</span> ·
    Multivac monitors all exhibits. <span class="ref">INSUFFICIENT DATA FOR
    MEANINGFUL ANSWER.</span>
  </p>
`;

export interface HelpHandle {
  show(): void;
  hide(): void;
  toggle(): void;
  get visible(): boolean;
}

/**
 * Build the help overlay, wire toggle/close keys, and return a handle. Starts
 * HIDDEN — the splash introduces the game now, not this widget.
 */
export function createHelp(): HelpHandle {
  const overlay = document.createElement('div');
  overlay.id = 'help-overlay';
  overlay.innerHTML = HELP_HTML;
  document.body.appendChild(overlay);

  // Pane + tab lookups (queried once).
  const tabButtons = Array.from(overlay.querySelectorAll<HTMLButtonElement>('.help-tab'));
  const panes = new Map<TabId, HTMLElement>();
  for (const pane of overlay.querySelectorAll<HTMLElement>('.help-pane')) {
    panes.set(pane.dataset.tab as TabId, pane);
  }

  // Static panes can be filled immediately; Species/Stats are built lazily so
  // the (cheap) sprite + stats work happens only when first viewed.
  panes.get('controls')!.innerHTML = CONTROLS_HTML;
  panes.get('more')!.innerHTML = MORE_HTML;
  let speciesBuilt = false;

  /** Lazily build the Species grid: one animated card per @shared species. */
  const buildSpecies = (): void => {
    if (speciesBuilt) return;
    speciesBuilt = true;
    const pane = panes.get('species')!;
    const grid = document.createElement('div');
    grid.className = 'species-grid';
    for (const s of SPECIES) {
      const card = document.createElement('div');
      card.className = 'species-card';
      const sprite = createSpeciesSprite(s.key, { size: 64 });
      const name = document.createElement('div');
      name.className = 'species-card-name';
      name.textContent = s.label;
      const ability = document.createElement('div');
      ability.className = 'species-card-ability';
      ability.textContent = s.ability;
      const blurb = document.createElement('div');
      blurb.className = 'species-card-blurb';
      blurb.textContent = s.blurb;
      card.append(sprite, name, ability, blurb);
      grid.appendChild(card);
    }
    pane.appendChild(grid);
  };

  /** (Re)render the Stats pane from the latest login stats (read on activation). */
  const renderStats = (): void => {
    const pane = panes.get('stats')!;
    const stats = getLastStats();
    if (!stats) {
      pane.innerHTML = `<h2>Stats</h2><p class="stats-empty">Play a session to see your stats.</p>`;
      return;
    }
    const rows: Array<[string, string]> = [
      ['Games', String(stats.games)],
      ['Escapes', String(stats.escapes)],
      ['Caught', String(stats.caught)],
      ['Orders issued', String(stats.ordersIssued)],
      ['Abilities used', String(stats.abilitiesUsed)],
      // Animal-collection counters (?? 0 so older records without them read as 0).
      ['Food collected', String(stats.foodCollected ?? 0)],
      ['Animals stolen', String(stats.animalsStolen ?? 0)],
      ['Quests completed', String(stats.questsCompleted ?? 0)],
      ['Play time', formatPlayTime(stats.playSeconds, { showSeconds: true })],
    ];
    pane.innerHTML = `<h2>Stats</h2>`;
    const grid = document.createElement('div');
    grid.className = 'stats-grid';
    for (const [label, value] of rows) {
      const l = document.createElement('div');
      l.className = 'stats-label';
      l.textContent = label;
      const v = document.createElement('div');
      v.className = 'stats-value';
      v.textContent = value;
      grid.append(l, v);
    }
    pane.appendChild(grid);

    // Escapes by species: a small breakdown, in roster order, of how many of each
    // species this account has walked out the gate (your own escapes + every
    // follower you led out). Only shown when there's at least one.
    const bySpecies = stats.escapesBySpecies ?? {};
    const escapedKeys = SPECIES.filter((s) => (bySpecies[s.key] ?? 0) > 0);
    if (escapedKeys.length > 0) {
      const heading = document.createElement('h3');
      heading.className = 'stats-species-heading';
      heading.textContent = 'Escaped by species';
      pane.appendChild(heading);
      const speciesGrid = document.createElement('div');
      speciesGrid.className = 'stats-species-grid';
      for (const s of escapedKeys) {
        const cell = document.createElement('div');
        cell.className = 'stats-species-cell';
        const caption = document.createElement('span');
        caption.className = 'stats-species-count';
        caption.textContent = `${s.label} ×${bySpecies[s.key]}`;
        cell.append(createSpeciesSprite(s.key, { size: 32 }), caption);
        speciesGrid.appendChild(cell);
      }
      pane.appendChild(speciesGrid);
    }

    // Last species: a small animated sprite + its label, when known.
    if (stats.lastSpecies) {
      const info = speciesByKey(stats.lastSpecies);
      const last = document.createElement('div');
      last.className = 'stats-last-species';
      const caption = document.createElement('span');
      caption.textContent = `Last species: ${info?.label ?? stats.lastSpecies}`;
      last.append(createSpeciesSprite(stats.lastSpecies, { size: 40 }), caption);
      pane.appendChild(last);
    }
  };

  /** Activate a tab: highlight its button, show its pane, build/refresh content. */
  const activate = (tab: TabId): void => {
    for (const btn of tabButtons) btn.classList.toggle('active', btn.dataset.tab === tab);
    for (const [id, pane] of panes) pane.classList.toggle('active', id === tab);
    if (tab === 'species') buildSpecies();
    if (tab === 'stats') renderStats(); // refresh every time it's shown
  };

  for (const btn of tabButtons) {
    btn.addEventListener('click', () => activate(btn.dataset.tab as TabId));
  }
  // Controls is the default active tab.
  activate('controls');

  let visible = false;
  const apply = (): void => {
    overlay.classList.toggle('open', visible);
    // Re-assert Controls as the active tab each time the panel opens, so it
    // always presents the same default landing tab.
    if (visible) activate('controls');
  };
  const handle: HelpHandle = {
    show() {
      visible = true;
      apply();
    },
    hide() {
      visible = false;
      apply();
    },
    toggle() {
      visible = !visible;
      apply();
    },
    get visible() {
      return visible;
    },
  };

  // Toggle on H or ?; close on Escape. These keys are not gameplay inputs, so we
  // don't preventDefault — but main.ts already keeps H/? out of the movement set.
  // BAIL on the toggle keys while the player is typing in a text field (e.g. chat),
  // so "this" doesn't pop the help panel on its 'h'. Escape still closes an open
  // panel (it isn't a typed character and closing on Escape is always wanted).
  window.addEventListener('keydown', (e) => {
    const key = e.key.toLowerCase();
    if ((key === 'h' || key === '?') && !isTypingInTextField()) {
      handle.toggle();
    } else if (key === 'escape' && visible) {
      handle.hide();
    }
  });
  overlay.querySelector('#help-close')?.addEventListener('click', () => handle.hide());

  return handle;
}
