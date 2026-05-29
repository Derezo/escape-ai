/**
 * Persisted identity (Parasite-style) — a thin, crash-proof localStorage wrapper.
 *
 * The login flow (menu.ts) stores the server-issued `{username, token}` under a
 * single key so a returning player is auto-logged-in (session restore) without
 * re-typing a name. The token is the only credential: the server validates it,
 * re-issues stats, and the client just remembers it.
 *
 * Every access is guarded — private-browsing / disabled-storage throws on the
 * `localStorage` accessor itself, and a corrupt blob shouldn't ever break the
 * game. On any failure we behave as if there is no saved identity.
 */

/** The single localStorage key holding the JSON `{username, token}` blob. */
const AUTH_KEY = 'escapeai.auth';

/** A persisted identity: the username we claimed and the token that proves it. */
export interface SavedAuth {
  username: string;
  token: string;
}

/**
 * Read the saved identity, or null when absent/corrupt/unavailable. Parses
 * defensively: a malformed blob, a missing field, or a thrown storage accessor
 * all collapse to "no saved auth" rather than an exception.
 */
export function loadAuth(): SavedAuth | null {
  try {
    const raw = localStorage.getItem(AUTH_KEY);
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    if (
      typeof parsed === 'object' &&
      parsed !== null &&
      typeof (parsed as Record<string, unknown>).username === 'string' &&
      typeof (parsed as Record<string, unknown>).token === 'string'
    ) {
      const { username, token } = parsed as SavedAuth;
      // Treat empty strings as "no identity" so a half-written blob can't auth.
      if (username && token) return { username, token };
    }
    return null;
  } catch {
    return null;
  }
}

/** Persist the server-issued identity. Silently no-ops if storage is unavailable. */
export function saveAuth(a: SavedAuth): void {
  try {
    localStorage.setItem(AUTH_KEY, JSON.stringify({ username: a.username, token: a.token }));
  } catch {
    // Private mode / quota — nothing to do; the player just won't auto-login next time.
  }
}

/** Forget the saved identity (called on a `bad_token` rejection). */
export function clearAuth(): void {
  try {
    localStorage.removeItem(AUTH_KEY);
  } catch {
    // Storage unavailable — there was nothing persisted to clear anyway.
  }
}
