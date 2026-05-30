/**
 * Per-species side-quests — the ONE source of truth for what each animal must do
 * before the gate will let it out. Shared by:
 *   - the server (initializes + advances quest progress step-by-step, gates the
 *     escape in server/game/quests.js + stealth.js),
 *   - the client HUD (surfaces the active step's title + progress, main.ts),
 *   - the help widget's Goal blurb (client/src/help.ts).
 *
 * Every species' quest is an ORDERED list of steps; the server advances them one
 * at a time and only opens the gate once the WHOLE quest (every step) is done.
 * The step KINDS are the small fixed set of mechanics the server knows how to
 * advance:
 *   - 'reach'    walk back to your own enclosure / home (need 1) — completes when
 *                you stand on your species' quest object tile.
 *   - 'fetch'    (ape only, final step): carry the disguise Clipboard to the gate.
 *   - 'activate' tap N distinct keeper terminals (need 3) — the robot-controllers.
 *   - 'collect'  pick up N food units from feeding stations.
 *   - 'recruit'  gain N new followers by feeding fellow animals.
 *   - 'order'    land N Second-Law orders on a robot (at a terminal or in person).
 *   - 'ability'  fire your species power once (need 1).
 *   - 'escort'   reach the gate WITH N live followers in tow (a herd-out finale).
 *
 * The legacy 'reach'/'fetch'/'activate' species keep those kinds as their FINAL
 * (or only relevant) step so old single-step assumptions still hold at the gate;
 * the redesigned species lead with collect/recruit/order/ability/activate steps.
 *
 * PURE + DETERMINISTIC: no Math.random / Date.now. The table is a fixed literal,
 * keyed by species, so questForSpecies(key) is a pure lookup returning the SAME
 * object ref each call. This mirrors the species roster's purity contract
 * (species.ts) — the quest definitions can never drift between client and server.
 */

import { SPECIES_KEYS } from './species.js';

/**
 * The fixed set of step mechanics the server knows how to advance. This union is
 * the canonical source for QuestProgress.type and QuestStepProgress.kind in
 * types.ts (kept in sync there as a literal so types.ts has no import on this
 * module). NEW kinds widen BOTH unions together.
 */
export type QuestStepKind =
  | 'reach'
  | 'fetch'
  | 'activate'
  | 'collect'
  | 'recruit'
  | 'order'
  | 'ability'
  | 'escort';

/**
 * BACK-COMPAT alias: the original three-mechanic union. Retained so existing
 * `QuestType` importers (and the legacy `type` field) keep compiling; it is a
 * strict subset of QuestStepKind.
 */
export type QuestType = 'reach' | 'fetch' | 'activate';

/** One ordered step of a species' quest. Plain literal, JSON-serializable. */
export interface QuestStep {
  /** This step's mechanic kind (one of QuestStepKind). */
  kind: QuestStepKind;
  /** Short HUD title for this step (≤ 24 chars). */
  title: string;
  /** One-line, ability-themed flavor for this step. */
  blurb: string;
  /** Target count for this step (reach/fetch/ability = 1, activate = 3, etc.). */
  need: number;
}

/** One species' side-quest: identity + its ordered list of steps. */
export interface QuestDef {
  /** The species key this quest belongs to (matches SPECIES_KEYS). */
  species: string;
  /** Short overall quest title (≤ 24 chars), e.g. "Tunnel run". */
  questTitle: string;
  /** The ordered steps; length 1 for the legacy single-step path, 2-3 otherwise. */
  steps: QuestStep[];
  /**
   * BACK-COMPAT: the FINAL step's kind. Kept typed to the legacy QuestType union
   * because the only legacy readers (the old gate logic, static help copy) cared
   * about the gate-relevant mechanic, which is always the last step. Equals
   * steps[steps.length - 1].kind.
   */
  type: QuestType;
  /** BACK-COMPAT: the FINAL step's title (steps[last].title). */
  title: string;
  /** BACK-COMPAT: the FINAL step's blurb (steps[last].blurb). */
  blurb: string;
  /** BACK-COMPAT: the FINAL step's need (steps[last].need). */
  need: number;
}

/** How many distinct terminals an 'activate' step needs. */
const ACTIVATE_NEED = 3;

/**
 * The fixed species → ordered steps assignment. Every species in SPECIES_KEYS has
 * an entry; this is the single place that decides each animal's side-quest arc.
 * Themed to each species' identity / housing kind (see world.ts SPECIES_HOUSING).
 * Titles are kept ≤ 24 chars for the HUD; blurbs carry the ability-flavored line.
 *
 * Step ordering rules (mirrored by the parity test):
 *   - The ape ENDS in 'fetch' (courier the prop out).
 *   - The three controllers (elephant, peacock, parrot) CONTAIN an 'activate' step.
 *   - The other ten END in 'reach' or 'escort' (back home, or herd-out the gate)
 *     and LEAD with a collect/recruit/order/ability/activate step.
 */
const STEPS_BY_SPECIES: Record<string, QuestStep[]> = {
  // ── ape: command a keeper, then courier the Clipboard out the gate ──────────
  ape: [
    { kind: 'order', need: 1, title: 'Command a keeper', blurb: 'Bark one keeper-code at a terminal so the courier lane stands down.' },
    { kind: 'fetch', need: 1, title: 'Courier the Clipboard', blurb: 'Grab the Clipboard from the office and walk the disguise out the gate.' },
  ],

  // ── elephant: force three consoles, then rally a beast ──────────────────────
  elephant: [
    { kind: 'activate', need: ACTIVATE_NEED, title: 'Lean on 3 terminals', blurb: 'Your bulk forces every console you lean on — tap three keeper terminals.' },
    { kind: 'recruit', need: 1, title: 'Rally one beast', blurb: 'Trumpet a fellow animal into your herd before the big push.' },
  ],

  // ── peacock: dazzle three consoles, then strut home ─────────────────────────
  peacock: [
    { kind: 'activate', need: ACTIVATE_NEED, title: 'Tap 3 terminals', blurb: 'Dazzle three keeper terminals into standing the patrols down.' },
    { kind: 'reach', need: 1, title: 'Strut to your aviary', blurb: 'Take one last vain lap back to your aviary before the curtain call.' },
  ],

  // ── parrot: mimic three codes, then voice one order ─────────────────────────
  parrot: [
    { kind: 'activate', need: ACTIVATE_NEED, title: 'Mimic at 3 terminals', blurb: 'Mimic the keeper codes at three terminals to clear your route.' },
    { kind: 'order', need: 1, title: 'Voice one order', blurb: 'Throw a perfect human voice to order one keeper aside.' },
  ],

  // ── bird: forage two seeds, then home to the aviary ─────────────────────────
  bird: [
    { kind: 'collect', need: 2, title: 'Forage 2 seeds', blurb: 'Peck up two caches of seed before the long flight out.' },
    { kind: 'reach', need: 1, title: 'Back to the aviary', blurb: 'Flit home to your aviary perch one last time before the break.' },
  ],

  // ── rat: hoard two scraps, recruit a packmate, then home to the cage ────────
  rat: [
    { kind: 'collect', need: 2, title: 'Hoard 2 scraps', blurb: 'Skitter the floor for two scraps to stash before you bolt.' },
    { kind: 'recruit', need: 1, title: 'Recruit a packmate', blurb: 'Lure one fellow rat into your pack with a shared morsel.' },
    { kind: 'reach', need: 1, title: 'Back to your cage', blurb: 'Slip through the bars to your cage to grab your stash.' },
  ],

  // ── chameleon: cloak, home to the reptile house, then escort one out ────────
  chameleon: [
    { kind: 'ability', need: 1, title: 'Cloak once', blurb: 'Throw your perfect disguise — vanish in plain sight to begin.' },
    { kind: 'reach', need: 1, title: 'Reach reptile house', blurb: 'Cloak your way back into the reptile house to gather your nerve.' },
    { kind: 'escort', need: 1, title: 'Slip one out', blurb: 'Lead one reptile to the gate under the cover of your cloak.' },
  ],

  // ── skunk: order a keeper down, then den up ─────────────────────────────────
  skunk: [
    { kind: 'order', need: 1, title: 'Stand a keeper down', blurb: 'Order one keeper aside before you foul the whole corridor.' },
    { kind: 'reach', need: 1, title: 'Den up first', blurb: 'Slink back to your den before you stink up the escape.' },
  ],

  // ── mole: burrow, unearth a grub, then tunnel home ──────────────────────────
  mole: [
    { kind: 'ability', need: 1, title: 'Burrow once', blurb: 'Dig a quick tunnel-hop to scout the way home unseen.' },
    { kind: 'collect', need: 1, title: 'Unearth a grub', blurb: 'Surface for one fat grub from a feeding station en route.' },
    { kind: 'reach', need: 1, title: 'Tunnel home', blurb: 'Burrow back to your den mound and surface where you started.' },
  ],

  // ── cheetah: rally two runners, then sprint them out ────────────────────────
  cheetah: [
    { kind: 'recruit', need: 2, title: 'Rally 2 runners', blurb: 'Coax two fellow animals to run with your breakout pack.' },
    { kind: 'escort', need: 2, title: 'Sprint them out', blurb: 'Dash a fast line to the gate with both runners on your heels.' },
  ],

  // ── tortoise: graze two greens, then bask at the pond ───────────────────────
  tortoise: [
    { kind: 'collect', need: 2, title: 'Graze 2 greens', blurb: 'Plod the stalls for two helpings of greens, shell and all.' },
    { kind: 'reach', need: 1, title: 'Bask at your pond', blurb: 'Plod back to your pond for one last bask before the long haul.' },
  ],

  // ── kangaroo: muster two of the mob, home to the pen, then bound them out ────
  kangaroo: [
    { kind: 'recruit', need: 2, title: 'Muster 2 of the mob', blurb: 'Thump up two of the mob to bound out alongside you.' },
    { kind: 'reach', need: 1, title: 'Bound to your pen', blurb: 'Leap back into your pen to gather the mob before you bolt.' },
    { kind: 'escort', need: 2, title: 'Bound them out', blurb: 'Lead the whole mob in long hops out through the gate.' },
  ],

  // ── owl: hush the alarm, then home to the roost ─────────────────────────────
  owl: [
    { kind: 'ability', need: 1, title: 'Hush the alarm', blurb: "Drain the room's panic with one hush before the night flight." },
    { kind: 'reach', need: 1, title: 'Return to your roost', blurb: 'Wing it home to your roost and settle the night before you go.' },
  ],

  // ── fox: snatch a morsel, trick a keeper, then slip to the den ──────────────
  fox: [
    { kind: 'collect', need: 1, title: 'Snatch one morsel', blurb: 'Slink to a feeding station and snatch a single morsel.' },
    { kind: 'order', need: 1, title: 'Trick a keeper', blurb: 'Con one keeper into standing down with a sly command.' },
    { kind: 'reach', need: 1, title: 'Slip to your den', blurb: 'Slip past the keepers to your den and leave a decoy behind.' },
  ],
};

/** The short per-species quest titles (HUD overall label). */
const QUEST_TITLE_BY_SPECIES: Record<string, string> = {
  ape: 'Courier the Clipboard',
  elephant: 'Force the consoles',
  peacock: 'Dazzle the floor',
  parrot: 'Mimic the codes',
  bird: 'Fledge the flock',
  rat: 'Pack the nest',
  chameleon: 'Cloak and slip',
  skunk: 'Clear the den',
  mole: 'Tunnel run',
  cheetah: 'Lead the sprint',
  tortoise: 'Slow and steady',
  kangaroo: 'Gather the mob',
  owl: 'Hush the night',
  fox: 'Decoy and den',
};

/** Assemble a frozen QuestDef from its ordered steps + back-compat mirror fields. */
function buildDef(species: string, questTitle: string, steps: QuestStep[]): QuestDef {
  const last = steps[steps.length - 1];
  return {
    species,
    questTitle,
    steps,
    // BACK-COMPAT mirror: the gate-relevant (final) step. Its kind is always one
    // of the legacy QuestType members (reach/fetch — escort/activate-ending
    // species mirror their final reach/escort kind; the only non-legacy final
    // kind is 'escort', which we surface as its real kind via the cast below).
    type: last.kind as QuestType,
    title: last.title,
    blurb: last.blurb,
    need: last.need,
  };
}

/**
 * The fixed species → quest assignment. Every species in SPECIES_KEYS has an
 * entry; questForSpecies(key) returns the SAME object ref each call (pure lookup).
 */
export const QUEST_BY_SPECIES: Record<string, QuestDef> = (() => {
  const out: Record<string, QuestDef> = {};
  for (const key of Object.keys(STEPS_BY_SPECIES)) {
    out[key] = buildDef(key, QUEST_TITLE_BY_SPECIES[key] ?? key, STEPS_BY_SPECIES[key]);
  }
  return out;
})();

/** A total fallback quest for an unknown species key (kept as a stable ref). */
const FALLBACK_QUEST: QuestDef = buildDef('', 'Reach your home', [
  { kind: 'reach', need: 1, title: 'Reach your home', blurb: 'Find your enclosure before the gate will let you out.' },
]);

/**
 * The quest for a species — a pure, deterministic lookup. Falls back to a generic
 * single-step 'reach' quest for an unknown key (never expected for a playable
 * species, but keeps the function total so callers never get undefined). Returns
 * the SAME object ref each call.
 */
export function questForSpecies(species: string): QuestDef {
  const def = QUEST_BY_SPECIES[species];
  if (def) return def;
  return FALLBACK_QUEST;
}

/** Every species in SPECIES_KEYS has exactly one quest def (parity invariant). */
export const QUEST_COUNT: number = SPECIES_KEYS.filter(
  (k) => QUEST_BY_SPECIES[k] !== undefined,
).length;
