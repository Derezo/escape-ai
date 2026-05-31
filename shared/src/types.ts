/**
 * Core serializable game types shared by client and server.
 *
 * Everything here is a plain data shape — no methods, no class instances —
 * so it round-trips cleanly through Socket.IO / JSON. The renderer never sees
 * anything richer than these objects (see ARCHITECTURE.md: "Entities are plain
 * serializable objects `{id, x, y, ...}`; renderer-agnostic").
 */

/**
 * What an entity *is* in Escape AI. Plain string union so it stays
 * serializable; the renderer and the deterministic step() branch on it.
 *   - `animal`   a player-controlled escapee (also covers idle pen animals)
 *   - `robot`    a Three-Laws keeper-robot (server-driven NPC)
 *   - `pen`      an enclosure / holding area (static)
 *   - `terminal` an interactable that issues Second-Law orders (static)
 *   - `gate`     a perimeter or zone door (static, openable)
 *   - `prop`     a carryable disguise item (the Clipboard) — the ape's courier prop
 */
export type EntityKind = 'animal' | 'robot' | 'pen' | 'terminal' | 'gate' | 'prop' | 'hazard' | 'questObject' | 'food';

/**
 * The 8 facing directions in screen space (y-down), used to pick the right
 * directional sprite animation. These strings ARE the `dir` segment of every
 * atlas frame key (`<species>_<state>_<dir>_<frame>`) — they must match the
 * sprite generator's contract (scripts/sprites/contract.js DIRECTIONS) exactly.
 * `facingFromVec` in step.ts maps a movement vector to one of these.
 */
export type Dir8 = 's' | 'se' | 'e' | 'ne' | 'n' | 'nw' | 'w' | 'sw';

/**
 * Which spectacular ability effect is active / just fired on an entity. Drives
 * the client FX layer (particles/tweens/glow/shake). Defined here (not in
 * step.ts) so types.ts has no import cycle with step.ts.
 */
export type FxKind =
  | 'flit' | 'skitter' | 'shove' | 'carry'
  | 'cloak' | 'dazzle' | 'stink' | 'burrow'
  | 'dash' | 'mimic' | 'shell' | 'leap' | 'hush' | 'decoy'
  // Animal-collection feedback (Phase: food/follow): a food pickup, a successful
  // feed-to-follow, and a steal (feeding away another player's follower).
  | 'collect' | 'feed' | 'steal';

/**
 * The render-echo of an ability effect, carried in the snapshot so ANY client
 * can show FX for ANY player/robot (not just the local one). `startTick` is the
 * rising edge the client triggers a one-shot burst on; `untilTick` drives any
 * sustained FX (a glow that lasts the effect). The gameplay timers
 * (flitUntilTick, etc.) remain server-side as the source of truth; `fx` is the
 * compact echo derived from them at serialization time.
 */
export interface EntityFx {
  kind: FxKind;
  startTick: number;
  untilTick: number;
  /** For a `collect` fx: the food key that was just picked up, so the client can
   *  show the food's name + icon in the pickup toast. Absent for other fx kinds. */
  foodKey?: string;
}

/**
 * A player's live side-quest progress (Phase 6), as it rides the snapshot. The
 * static quest DEFINITIONS live in quests.ts (QuestDef + QuestStep); this is the
 * per-player mutable view the server owns and the client HUD reads. Quests are
 * now MULTI-STEP: the top-level `type`/`title`/`blurb`/`done`/`need` always mirror
 * the CURRENT step (steps[stepIndex]) so legacy single-field readers keep working,
 * while `stepIndex`/`steps` expose the full arc. `complete` (whole-quest done)
 * gates the escape gate server-side and is the ONLY flag isComplete() reads.
 *
 * Plain JSON — no methods, no class instances — so it round-trips on the wire via
 * Entity.quest's index signature. The step-kind union below MUST stay in lockstep
 * with QuestStepKind in quests.ts.
 */
export interface QuestProgress {
  /**
   * BACK-COMPAT alias of the CURRENT step's mechanic kind. Kept named `type` and
   * typed to the (now-widened) union so existing readers (client HUD, the old
   * star-filter) never break: for a single-step quest this is the same value it
   * was before; for a multi-step quest it is the kind of step `stepIndex`. Always
   * equals steps[stepIndex].kind.
   */
  type: 'reach' | 'fetch' | 'activate' | 'collect' | 'recruit' | 'order' | 'ability' | 'escort';
  /**
   * The CURRENT step's short HUD title (≤ 24 chars). Mirrors steps[stepIndex].title
   * so a client that only reads `title` shows the right step's name.
   */
  title: string;
  /** The CURRENT step's one-line, ability-themed flavor (steps[stepIndex].blurb). */
  blurb: string;
  /** Progress on the CURRENT step (0..need). Re-zeroed on each step advance. */
  done: number;
  /** Target count for the CURRENT step (reach/fetch/ability=1, activate=3, etc.). */
  need: number;
  /**
   * True once the WHOLE quest (every step) is satisfied — the gate-gate condition.
   * isComplete() reads ONLY this; it flips exactly once, on the final step's
   * completion, where the single bumpStat('questsCompleted') also fires.
   */
  complete: boolean;
  /**
   * 0-based index of the active step into `steps`. Drives "step i+1/N" in the HUD
   * and tells the client which step kind to resolve the arrow goal from. Pinned to
   * steps.length-1 once `complete`. Reset to 0 by resetSteps(player) on a catch.
   */
  stepIndex: number;
  /**
   * The ordered step list for this species (a per-player COPY of the shared def's
   * steps, so `done` can be carried per step if ever needed; today only the active
   * step's done rides the top-level fields). Length 1 for the legacy single-step
   * species path; 2-3 for the redesigned ones. JSON-serializable.
   */
  steps: QuestStepProgress[];
}

/** One step of a multi-step quest, as it rides the snapshot (plain JSON). */
export interface QuestStepProgress {
  /** This step's mechanic kind (one of the QuestProgress.type union members). */
  kind: 'reach' | 'fetch' | 'activate' | 'collect' | 'recruit' | 'order' | 'ability' | 'escort';
  /** ≤ 24-char HUD title for this step. */
  title: string;
  /** One-line ability-themed flavor for this step. */
  blurb: string;
  /** Target count for this step. */
  need: number;
  /**
   * Per-step progress (0..need). The server carries it on every step (re-zeroed
   * until that step becomes active), so a future HUD can show a full step-by-step
   * checklist; today only the ACTIVE step's `done` is surfaced via the top-level
   * QuestProgress.done. Declared here so the wire shape the server sends is honest.
   */
  done: number;
}

/**
 * The atomic thing the world is made of. The index signature lets gameplay
 * rules bolt on arbitrary fields without breaking serialization; the named
 * optional fields below are the ones Escape AI reads on both sides, so
 * they're typed (rather than hidden in the index signature) for safety.
 */
export interface Entity {
  id: string;
  x: number;
  y: number;
  name?: string;
  /** What this entity is. Absent on the bare starter-kit point; defaults to a player animal. */
  kind?: EntityKind;
  /** For `animal`: which species (drives the special ability). */
  species?: string;
  /** For `animal`: 0..1 how human this looks to robots right now (First-Law stealth). */
  humanLikeness?: number;
  /** For `robot`: 0..1 how convinced it is that a nearby "human" is faking it. */
  suspicion?: number;
  /** For `animal` (player): true once it has reached the gate and escaped (win). */
  escaped?: boolean;
  /** 8-way facing for directional sprite animation. Absent → renderer derives from motion. */
  facing?: Dir8;
  /** Active/just-fired ability effect, for one-shot + sustained FX on any client. */
  fx?: EntityFx;
  /** For `animal` (player): its per-species side-quest progress (Phase 6). */
  quest?: QuestProgress;
  /** For `animal` (player): the last tick it brushed the gate WITHOUT a complete quest. */
  questBlocked?: number;

  // --- Animal collection (food / follow / steal / score) -------------------
  // All optional; serialized onto the snapshot by engine.toEntity (player fields)
  // or written directly on the world entity (follower fields). They ride the
  // delta diff like every other entity field.

  /** For `food`: which food key this source dispenses (drives tint/label + feed match). */
  foodKey?: string;
  /** For an `animal` follower: the playerId currently leading it (its owner). */
  followerOf?: string;
  /** For an `animal` follower: the tick the follow lapses (server-authoritative TICKS). */
  followUntilTick?: number;
  /** For an `animal` follower: the tick the CURRENT follow window started — the
   *  client decaying-ring denominator: frac = (followUntilTick - tick)/(followUntilTick - followSince). */
  followSince?: number;
  /** For an `animal` follower: true if it was STOLEN from another player (worth more at the gate). */
  stolen?: boolean;
  /** For `animal` (player): the owner's collected-food bag, foodKey → count. Owner's own entity only. */
  inventory?: Record<string, number>;
  /** For `animal` (player): the award stamped on the escape edge (a one-shot client toast). */
  lastScore?: { points: number; herd: number; stolen: number; tick: number };
  /** For `animal` (player): the running session/round score (persists across respawns). */
  scoreTotal?: number;

  // --- NPC movement / behavior state (server-authoritative) ----------------
  // Mutated only by the single server orchestrator that owns the NPC (robots by
  // behaviors.js, animals by follow.js / stealth.js — single-writer, like the
  // follower fields above). They ride the snapshot delta via the index signature,
  // only on the ticks they change. The client doesn't need any of these to render
  // (it derives gait from `species` via the shared locomotion registry); they're
  // typed here purely for server-side safety, not because they're a wire contract.

  /** Behavior FSM state. Robots: 'patrol'|'investigate'|'pursue'. Animals: 'wander'|'return-home'. */
  behavior?: string;
  /** For `robot`: current target waypoint index into the room's patrolRoute (looping). */
  patrolIndex?: number;
  /** For `robot`: the patrolIndex captured when patrol was broken, to resume the loop. */
  lastPatrolIndex?: number;
  /** For `robot` (investigating): last-known world position of the suspicious target. */
  investigateX?: number;
  investigateY?: number;
  /** For `robot` (investigating): the tick the investigate/linger window expires. */
  investigateUntilTick?: number;
  /** For an `animal` follower: its 0-based position in its owner's follow chain
   *  (0 = closest to the player). Derived + rewritten each tick by stepFollowers
   *  (client-cosmetic cache; gameplay recomputes from followSince every tick). */
  chainIndex?: number;
  /** For an `animal` follower: the tick a lapsed follow's GRACE window ends. A
   *  re-feed before this snaps it back into the chain; after it, it drifts home. */
  graceUntilTick?: number;
  /** For an `animal` released from following: true while it drifts back toward its
   *  home enclosure (home-biased wander). Cleared once back inside its home bounds. */
  returningHome?: boolean;
  /** For a `returningHome` animal: world-unit center of its home enclosure to drift toward. */
  homeX?: number;
  homeY?: number;
  /** For an `animal` being hauled home by a robot: that robot's id (set on capture,
   *  cleared on release). While set the NPC is inert to idle drift + invisible to other
   *  robots. ALSO set on the ROBOT as the captured NPC's id (single-writer: behaviors.js). */
  capturedBy?: string;
  /** For a captured NPC / its hauling robot: the species key used to look up the destination pen. */
  captureSpecies?: string;

  [key: string]: unknown;
}

/**
 * A connected human (or bot) controlling an entity. Players ARE entities so the
 * renderer and step() treat them uniformly; subtype only adds connection-level
 * bookkeeping.
 */
export interface Player extends Entity {
  /** Last input sequence number the server has processed (for reconciliation). */
  lastAckSeq?: number;
}

/**
 * One frame of player intent. `seq` is a monotonically increasing per-client
 * counter the client stamps on every input so the server can ack it and the
 * client can reconcile prediction. `dx`/`dy` are a normalized-ish move vector
 * in the range [-1, 1] per axis (raw axis values; step() applies speed * dt).
 */
export interface Input {
  seq: number;
  dx: number;
  dy: number;
}

/**
 * Global per-room state that isn't tied to a single entity — the "container"
 * for the catastrophic-overflow rule. Lives alongside the entity list in every
 * snapshot so all clients render the same meter and lockdown state.
 */
export interface WorldState {
  /** Current fill of the zoo-wide alarm/panic meter (0..panicCapacity). */
  panic: number;
  /** Capacity of the panic meter; reaching it triggers overflow → lockdown. */
  panicCapacity: number;
  /** True once panic has overflowed: robots drop First-Law caution, doors seal. */
  lockdown: boolean;
}

/** A freshly-initialized, calm world. */
export const INITIAL_WORLD_STATE: WorldState = {
  panic: 0,
  panicCapacity: 100,
  lockdown: false,
};

// The authoritative per-tick wire payload is `SnapshotMsg` in net.ts (it also
// carries input `acks` for reconciliation). There is no separate `Snapshot`
// type — net.ts owns the contract so client and server import one shape.
