/**
 * Shared client-side time-formatting utilities (no renderer dependency).
 */

/** Format a play-time duration (seconds) compactly: "1h 23m", "12m" / "12m 05s", "45s". */
export function formatPlayTime(seconds: number, opts?: { showSeconds?: boolean }): string {
  const s = Math.max(0, Math.floor(seconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return opts?.showSeconds ? `${m}m ${String(sec).padStart(2, '0')}s` : `${m}m`;
  return `${sec}s`;
}
