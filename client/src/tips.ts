/**
 * The one-time Game Tips screen — a polished, species-specific "how does this
 * actually work?" walkthrough shown ONCE on a player's first login (after the
 * cinematic intro tears down). main.ts gates it on the new-character signal OR an
 * unset `escapeai.tips_seen` flag (tips-state.ts), so true first-timers AND
 * players who predate the feature each see it exactly once; the help widget
 * (H / ?) carries the same content for re-reading any time.
 *
 * Pure DOM + CSS, renderer-agnostic — the same construction idiom as help.ts /
 * inventory.ts: build a hidden `#tips-overlay` once, fill it per-open, toggle a
 * `.open` class, close on × / Esc / the "Got it" button.
 *
 * EVERYTHING is data-driven from the shared single-sources-of-truth so the copy
 * can never drift from the code:
 *   - the controls / goal / mechanic walkthrough come from help-copy.ts (the same
 *     text the help widget shows),
 *   - the per-step quest instructions come from questActionHint() (quest-help.ts),
 *     driven by the shared quest table (@shared/quests),
 *   - the species identity + ability from @shared/species, its liked food from
 *     @shared/food, and the animated header sprite from species-sprite.ts.
 *
 * `show(species)` takes the species at call time (it isn't known until the menu
 * resolves) and rebuilds the species-specific sections fresh, so the screen is
 * always correct for whoever just spawned.
 */

import { speciesByKey } from '@shared/species';
import { questForSpecies } from '@shared/quests';
import { foodForSpecies } from '@shared/food';
import { createSpeciesSprite, stopSpeciesSprite } from './species-sprite';
import { questActionHint } from './quest-help';
import { controlsHtml, howToPlayHtml, HUMAN_VS_PREY_HTML, GOAL_HTML } from './help-copy';
import { isAndroid } from './platform';

/** The handle main.ts drives: show the species' tips once, hide, or query state. */
export interface TipsHandle {
  /** Reveal the screen, (re)rendering all sections for `species`. */
  show(species: string): void;
  hide(): void;
  get visible(): boolean;
}

/** The static panel chrome; the body is filled per-open in render(species). */
const TIPS_HTML = `
  <div id="tips-panel">
    <button id="tips-close" aria-label="Close tips">×</button>
    <div id="tips-body"></div>
    <div id="tips-foot">
      <p id="tips-foot-hint"></p>
      <button id="tips-got-it" type="button">Got it — let me play</button>
    </div>
  </div>
`;

/**
 * Build the species-specific quest section: an ordered list of the player's quest
 * steps, each pairing the step title with the EXACT action instruction
 * (questActionHint). Auto-correct for every species because both come from the
 * shared quest table. All values are trusted @shared literals (no user input), so
 * they're injected as markup — the same trust model as help.ts.
 */
function questSectionHtml(species: string): string {
  const quest = questForSpecies(species);
  const items = quest.steps
    .map((step) => {
      const hint = questActionHint({
        kind: step.kind,
        blurb: step.blurb,
        species,
        need: step.need,
      });
      return `
        <li class="tips-step">
          <span class="tips-step-title">${step.title}</span>
          <span class="tips-step-hint">${hint}</span>
        </li>`;
    })
    .join('');
  return `
    <h2>Your quest, step by step</h2>
    <p class="tips-quest-name">${quest.questTitle}</p>
    <ol class="tips-steps">${items}</ol>
  `;
}

/**
 * Build the species header: an animated sprite (mounted into #tips-sprite-slot by
 * the caller after innerHTML), "You are the X", and the ability line.
 */
function headerHtml(species: string): string {
  const info = speciesByKey(species);
  const label = info?.label ?? species;
  const blurb = info?.blurb ?? '';
  const ability = info?.ability ?? '';
  const press = isAndroid ? 'tap <b>Ability</b>' : 'press <b>Space</b>';
  const abilityLine = ability
    ? `<p class="tips-ability">Your special: ${press} to <b>${ability}</b> — ${blurb}</p>`
    : '';
  return `
    <div class="tips-header">
      <div id="tips-sprite-slot" class="tips-sprite-slot"></div>
      <div class="tips-header-text">
        <h1 class="tips-title">You are the ${label}</h1>
        <p class="tips-premise">You're an animal in a zoo run by robots. The robots
          can't harm a human — so <b>look like one</b> and walk out the front gate.</p>
        ${abilityLine}
      </div>
    </div>
  `;
}

/** The food/feeding section, naming THIS species' liked food for a concrete example. */
function foodSectionHtml(species: string): string {
  const food = foodForSpecies(species);
  const feed = isAndroid ? 'tap <b>Feed</b>' : 'press <b>F</b>';
  return `
    <h2>Recruit a herd</h2>
    <p>Your animal's favourite food is <b>${food.icon} ${food.label}</b>.
      Grab some at a feeding station, stand beside a fellow animal, and ${feed} to make it
      <b>follow you</b>. A herd led out the gate is worth bonus points — and you can
      <b>steal</b> followers from other players by feeding them too.</p>
  `;
}

/** Assemble the full body for a species. */
function render(species: string): string {
  return (
    headerHtml(species) +
    GOAL_HTML +
    questSectionHtml(species) +
    foodSectionHtml(species) +
    `<h2>Controls</h2>` +
    HUMAN_VS_PREY_HTML +
    controlsHtml(isAndroid) +
    howToPlayHtml(isAndroid)
  );
}

/**
 * Build the tips overlay (hidden), wire close (× / Esc / "Got it"), and return a
 * handle. The body is (re)rendered on each show(species) so it always reflects the
 * player's current species.
 */
export function createTips(): TipsHandle {
  const overlay = document.createElement('div');
  overlay.id = 'tips-overlay';
  overlay.innerHTML = TIPS_HTML;
  document.body.appendChild(overlay);

  const body = overlay.querySelector<HTMLElement>('#tips-body')!;
  const footHint = overlay.querySelector<HTMLElement>('#tips-foot-hint')!;
  footHint.innerHTML = isAndroid
    ? 'Open the <b>help</b> panel any time to read this again.'
    : 'Press <b>H</b> or <b>?</b> any time to read this again.';

  let visible = false;
  const apply = (): void => {
    overlay.classList.toggle('open', visible);
  };

  const handle: TipsHandle = {
    show(species: string) {
      // Dispose any sprite intervals from a prior open before replacing the body,
      // then render fresh for this species (the header sprite self-stops on detach
      // too, but eager disposal keeps it tidy when re-shown).
      for (const el of body.querySelectorAll<HTMLElement>('.species-sprite')) {
        stopSpeciesSprite(el);
      }
      body.innerHTML = render(species);
      // Mount the animated header sprite into its placeholder.
      const slot = body.querySelector<HTMLElement>('#tips-sprite-slot');
      if (slot) slot.appendChild(createSpeciesSprite(species, { size: 72 }));
      visible = true;
      apply();
    },
    hide() {
      visible = false;
      apply();
    },
    get visible() {
      return visible;
    },
  };

  overlay.querySelector('#tips-close')?.addEventListener('click', () => handle.hide());
  overlay.querySelector('#tips-got-it')?.addEventListener('click', () => handle.hide());
  // Esc closes when open (it isn't a typed character; closing on Esc is always wanted).
  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && visible) handle.hide();
  });

  return handle;
}
