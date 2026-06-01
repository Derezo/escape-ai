/**
 * The "have you seen the one-time tips screen?" gate — a thin, crash-proof
 * localStorage wrapper, modelled on auth.ts.
 *
 * The first-login Game Tips screen (tips.ts) walks a new player through the
 * mechanics + their species' quest. It must show ONCE and then stay out of the
 * way. main.ts opens it when the player is a genuine new character OR when this
 * flag is unset (so existing players who predate the feature still get it once),
 * and stamps it seen via markTipsSeen() the moment it's shown.
 *
 * Kept as its OWN key (not a field on the auth blob) on purpose: clearAuth() on a
 * bad token must not also forget that the tips were already seen. The two
 * lifecycles are independent.
 *
 * A `v` (schema version) is stored rather than a bare boolean so a future tips
 * revamp can re-show the screen to everyone by bumping TIPS_VERSION — a stored
 * record from an older version reads as "not yet seen" for the new content.
 *
 * Every access is guarded — private-browsing / disabled-storage throws on the
 * `localStorage` accessor itself, and a corrupt blob shouldn't ever break the
 * game. On any failure we behave as if the tips have NOT been seen (so the worst
 * case is the screen showing again, never a crash).
 */

/** The single localStorage key holding the JSON `{ v: number }` blob. */
const TIPS_KEY = 'escapeai.tips_seen';

/**
 * Current tips-content schema version. Bump this when the tips screen changes
 * enough that returning players should see it again; a stored `v` below this
 * counts as "not yet seen".
 */
const TIPS_VERSION = 1;

/**
 * Has this device already seen the current tips screen? True only when a stored
 * record's version is at least the current TIPS_VERSION. Absent/corrupt/older
 * records, or unavailable storage, all read as false ("show the tips").
 */
export function hasSeenTips(): boolean {
  try {
    const raw = localStorage.getItem(TIPS_KEY);
    if (!raw) return false;
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed === 'object' && parsed !== null) {
      const v = (parsed as Record<string, unknown>).v;
      if (typeof v === 'number' && v >= TIPS_VERSION) return true;
    }
    return false;
  } catch {
    return false;
  }
}

/** Record that the current tips screen has been shown. No-ops if storage is unavailable. */
export function markTipsSeen(): void {
  try {
    localStorage.setItem(TIPS_KEY, JSON.stringify({ v: TIPS_VERSION }));
  } catch {
    // Private mode / quota — nothing to do; the tips may just show again next time.
  }
}
