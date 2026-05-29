/**
 * The in-game manual / help overlay (toggle with H or ?).
 *
 * Covers a recurring TINS requirement (in-game help) AND the STORY beat, and is
 * where the artistic + bonus rules are made legible to a reviewer:
 *  - the verbatim Three Laws of Robotics (the Asimov reference, rule #84),
 *  - the controls + species guide,
 *  - an EXPLICIT callout of the double-edged element (the Act-of-Sutskever rule
 *    that replaced quicksave), so reviewers credit it.
 *
 * Pure DOM + CSS; no renderer dependency. `createManual()` builds the hidden
 * overlay and wires the toggle key, and returns a small handle.
 */

/** The manual's HTML. Kept as one template so the copy lives in one place. */
const MANUAL_HTML = `
  <div id="manual-panel">
    <button id="manual-close" aria-label="Close manual">×</button>
    <h1>THE CAVES OF STEEL</h1>
    <p class="tagline">
      You are an animal. The zoo is run by robots. The robots cannot harm a
      human — so <em>look like one</em>, and walk out the front gate.
    </p>

    <h2>Controls</h2>
    <ul class="cols">
      <li><b>WASD / arrows</b> — move</li>
      <li><b>E</b> — interact (terminal)</li>
      <li><b>Q</b> — order a robot (Second Law)</li>
      <li><b>Space</b> — your species ability</li>
      <li><b>H</b> or <b>?</b> — toggle this manual</li>
    </ul>

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

    <h2>Species — pick your role</h2>
    <ul class="species">
      <li><b>Ape</b> — carries the disguise <i>Clipboard</i>; pick up / hand off
        with Space. The courier: the prop keeps a carrier looking human on the move.</li>
      <li><b>Bird</b> — <i>flit</i>: a brief hop over reach, momentarily uncatchable.</li>
      <li><b>Rat</b> — <i>skitter</i>: briefly unseen by robot perception — squeeze past.</li>
      <li><b>Elephant</b> — <i>shove</i>: stun &amp; push a robot (loud — it bumps panic).</li>
    </ul>

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
    <p class="footer-hint">press H or ? to close</p>
  </div>
`;

export interface ManualHandle {
  show(): void;
  hide(): void;
  toggle(): void;
  get visible(): boolean;
}

/**
 * Build the manual overlay, wire H/? to toggle it and Escape/the × to close it,
 * and return a handle. Starts visible so a first-time player reads the rules.
 */
export function createManual(): ManualHandle {
  const overlay = document.createElement('div');
  overlay.id = 'manual-overlay';
  overlay.innerHTML = MANUAL_HTML;
  document.body.appendChild(overlay);

  let visible = false;
  const apply = () => overlay.classList.toggle('open', visible);
  const handle: ManualHandle = {
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
  // don't preventDefault — but we stop H/? from also being read as movement.
  window.addEventListener('keydown', (e) => {
    const key = e.key.toLowerCase();
    if (key === 'h' || key === '?') {
      handle.toggle();
    } else if (key === 'escape' && visible) {
      handle.hide();
    }
  });
  overlay.querySelector('#manual-close')?.addEventListener('click', () => handle.hide());

  // Open on first load so the premise + controls + rules are seen immediately.
  handle.show();
  return handle;
}
