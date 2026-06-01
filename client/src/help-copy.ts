/**
 * Shared help/tips COPY — the single source of truth for the player-facing
 * how-to-play text rendered by BOTH teaching surfaces:
 *   - the persistent H/? help widget (help.ts), and
 *   - the one-time first-login Game Tips screen (tips.ts).
 *
 * Keeping the controls list, the goal blurb, and the mechanic walkthroughs HERE
 * (rather than copy-pasted into each overlay) means the two surfaces can never
 * drift: fix the wording once and both update. The text is grounded in the
 * verified mechanics — the keybinds mirror ACTION_KEYS in main.ts (E interact /
 * collect, F feed, Q order, Space ability) and the food/follower/robot rules
 * match server/game/follow.js + stealth.js. The per-STEP quest instructions are
 * NOT here — those come from questActionHint() in quest-help.ts, driven by the
 * shared quest table, so a quest edit needs no change in this file.
 *
 * Everything is returned as HTML-string fragments (the overlays build via
 * innerHTML) or as plain section helpers, scoped to the `.help-pane` / `.tips`
 * CSS so the same classes style both. Platform-aware: pass `isAndroid` to swap
 * keyboard keys for the on-screen touch controls.
 */

/**
 * The controls reference, grouped under Move / Act / Panels sub-headings for
 * scanability. Keyboard on desktop, the on-screen touch controls on Android.
 * Both lists name the SAME actions in the same order so the two platforms teach
 * an identical mental model.
 */
export function controlsHtml(isAndroid: boolean): string {
  if (isAndroid) {
    return `
      <h3 class="copy-subhead">Move</h3>
      <ul class="cols">
        <li><b>Left thumb</b> — drag anywhere on the left to steer (a stick appears)</li>
        <li><b>Push to the edge</b> — sprint (fast, but reads as prey)</li>
      </ul>
      <h3 class="copy-subhead">Act</h3>
      <ul class="cols">
        <li><b>Interact</b> — terminal / prop / collect food</li>
        <li><b>Feed</b> — feed the nearest animal (it joins your herd)</li>
        <li><b>Order</b> — order a robot aside (Second Law)</li>
        <li><b>Ability</b> — your species special</li>
      </ul>
      <h3 class="copy-subhead">Panels</h3>
      <ul class="cols">
        <li><b>HUD tap</b> — inventory, leaderboard, and chat icons on screen</li>
        <li>Tap <b>×</b> to close any panel</li>
      </ul>
    `;
  }
  return `
    <h3 class="copy-subhead">Move</h3>
    <ul class="cols">
      <li><b>WASD / arrows</b> — walk (stays human)</li>
      <li><b>Shift</b> — sprint (fast, but reads as prey)</li>
    </ul>
    <h3 class="copy-subhead">Act</h3>
    <ul class="cols">
      <li><b>E</b> — interact: terminal / prop / collect food</li>
      <li><b>F</b> — feed the nearest animal (it joins your herd)</li>
      <li><b>Q</b> — order a robot aside (Second Law)</li>
      <li><b>Space</b> — your species ability</li>
    </ul>
    <h3 class="copy-subhead">Panels</h3>
    <ul class="cols">
      <li><b>I</b> — inventory (food + who it feeds)</li>
      <li><b>L</b> — leaderboard (top players + your score)</li>
      <li><b>/</b> — chat with everyone in the world</li>
      <li><b>H</b> or <b>?</b> — toggle this help</li>
    </ul>
  `;
}

/**
 * The single most-missed idea, as a one-liner banner: speed is your disguise's
 * enemy. Rendered above the controls so it's the first thing a player reads.
 */
export const HUMAN_VS_PREY_HTML = `
  <p class="copy-lede"><b>Walk to look human; sprint and you read as fleeing prey.</b>
    Standing still rebuilds your disguise — robots freeze when they can't tell you
    from a person.</p>
`;

/** The shared one-paragraph Goal blurb (gate + complete-quest gate). */
export const GOAL_HTML = `
  <h2>Goal</h2>
  <p>Reach the <b>gate</b> to escape — but the gate stays shut until your animal's
    <b>side-quest</b> reads <b>✓</b>. Your quest has a few ordered steps, shown in the
    <b>HUD</b> (top-left) as <em>step N/total</em>; the ⓘ next to it always says what to
    press for the step you're on, and an on-screen arrow points the way.</p>
`;

/**
 * "How to play" — the mechanic walkthrough (food/followers, robots/stealth), as
 * a reusable block. Used as the lead of the help widget's Controls tab AND inside
 * the tips screen, so the explanation lives once. Keybinds match ACTION_KEYS;
 * the touch variant drops the letters for the on-screen-button names.
 */
export function howToPlayHtml(isAndroid: boolean): string {
  const collect = isAndroid ? 'tap <b>Interact</b>' : 'press <b>E</b>';
  const feed = isAndroid ? 'tap <b>Feed</b>' : 'press <b>F</b>';
  const order = isAndroid ? 'tap <b>Order</b>' : 'press <b>Q</b>';
  const ability = isAndroid ? 'tap <b>Ability</b>' : 'press <b>Space</b>';
  return `
    <h2>Food, feeding &amp; followers</h2>
    <p>${collect} at a <b>feeding station</b> to scoop up food (a handful at a time).
      Carry an animal's <em>liked</em> food, stand beside it, and ${feed} to <b>recruit
      it as a follower</b> — it trails you in a line. Lead followers out the gate for
      <b>bonus points</b>. Feed an animal that's <em>already following someone else</em>
      and you <b>steal</b> it onto your own line (worth more — and they lose it).</p>

    <h2>Robots &amp; staying hidden</h2>
    <p>The keepers are robots bound by the <b>Three Laws</b>. They <b>can't touch a
      human</b> — so when you look human enough (walking, standing still, or using a
      disguise ability) the nearest robot <b>freezes</b>. Sprinting or a loud ability
      reads as prey and they give chase. You can ${order} next to a robot to make it
      <b>stand down</b> — but each order makes that robot <b>more suspicious</b> and
      stokes the zoo-wide <b>panic meter</b>. Let panic overflow and the zoo flips into
      <b>LOCKDOWN</b>, where robots hunt you regardless of disguise; lie low to drain it.
      ${ability} to fire your species' special — your edge for slipping past.</p>

    <h2>If a robot catches you</h2>
    <p>You're hauled back to your own pen: your <b>herd scatters</b>, your <b>food bag
      empties</b>, and your <b>quest restarts</b>. Robots can also grab a <b>follower</b>
      mid-line and carry it home — keep your herd close and your route quiet.</p>
  `;
}
