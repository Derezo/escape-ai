'use strict';

/**
 * Per-socket, in-memory rate limiter for the three client→server handlers.
 *
 * Threat model is LOW (a co-op jam game on a private server): the job is to shed
 * a pathological flood (a buggy/abusive client spamming hundreds of packets/sec),
 * NOT to police legitimate play. So the budgets are deliberately generous — normal
 * traffic must NEVER be throttled.
 *
 * Design: a classic token bucket per (socketId, kind). A bucket holds up to
 * `burst` tokens and refills at `refillPerSec` tokens/second (lazily, computed
 * from elapsed wall time on each `allow()` — no timers). Each allowed packet
 * costs one token; when the bucket is empty the packet is dropped (the handler
 * no-ops for that packet). Dropping is always safe here:
 *   - input: the engine just keeps the last good input, so a shed frame is invisible.
 *   - auth:login / lobby:join: a dropped packet is simply ignored (no state change);
 *     the client can retry.
 *
 * State is keyed by socket.id in a Map and removed on disconnect via drop(socketId)
 * (wired from connection.js), so memory can't grow across reconnects.
 *
 * No external dependencies — pure JS, mirroring the project's CommonJS style.
 */

// ---------------------------------------------------------------------------
// Tunables. Named constants up top, env-overridable mirroring config.js's
// `parseFloat(process.env.X) || default` pattern so they can be tightened on a
// hostile host without a code change. Defaults are sized for a 20 Hz tick.
// ---------------------------------------------------------------------------

// COARSE class — auth:login and lobby:join. These are rare (a handful per
// session), so a small burst that refills slowly is plenty of headroom for a
// human reconnecting / re-picking a species, while a spammer is stopped cold.
//   burst 5, refill 0.5/sec  ⇒  ~5 immediate, then 1 every 2s sustained.
const COARSE_BURST = parseFloat(process.env.RL_COARSE_BURST) || 5;
const COARSE_REFILL_PER_SEC = parseFloat(process.env.RL_COARSE_REFILL_PER_SEC) || 0.5;

// INPUT class — the movement/action stream. The client sends at the 20 Hz tick
// (~20 packets/sec per socket). We cap SUSTAINED throughput at 40/sec — a full
// 2x headroom over the legitimate 20/sec — so normal play is NEVER throttled
// even with jitter/burstiness, while a flood of hundreds/sec is shed. The burst
// (60) absorbs a brief catch-up clump (e.g. after a stall) without dropping a
// single real frame.
const INPUT_BURST = parseFloat(process.env.RL_INPUT_BURST) || 60;
const INPUT_REFILL_PER_SEC = parseFloat(process.env.RL_INPUT_REFILL_PER_SEC) || 40;

// LEADERBOARD class — the on-demand leaderboard:request. The client fetches on
// opening the panel and re-polls every few seconds WHILE it's open, plus a fetch
// per sort-change click. Sized for that: a burst that absorbs a flurry of sort
// clicks, refilling ~1/sec so an open panel polling at ~0.25 Hz is never throttled
// while a spammer (the query touches every account row) is stopped cold.
//   burst 8, refill 1/sec ⇒ ~8 immediate, then 1/sec sustained.
const LEADERBOARD_BURST = parseFloat(process.env.RL_LEADERBOARD_BURST) || 8;
const LEADERBOARD_REFILL_PER_SEC = parseFloat(process.env.RL_LEADERBOARD_REFILL_PER_SEC) || 1;

// CHAT class — the global chat:send stream. Chat is bursty (a few lines fired off in
// quick succession) but low-rate overall. Sized so real chatter is NEVER throttled —
// a burst of 12 absorbs a rapid back-and-forth, refilling 2/sec sustained (well above
// human typing cadence) — while a spammer flooding the room is shed.
//   burst 12, refill 2/sec ⇒ ~12 immediate, then 2/sec sustained.
const CHAT_BURST = parseFloat(process.env.RL_CHAT_BURST) || 12;
const CHAT_REFILL_PER_SEC = parseFloat(process.env.RL_CHAT_REFILL_PER_SEC) || 2;

// Per-kind bucket spec. `allow(socketId, kind)` looks the kind up here.
const SPECS = {
  // auth:login and lobby:join share the COARSE budget (separate buckets, same size).
  'auth:login': { burst: COARSE_BURST, refillPerSec: COARSE_REFILL_PER_SEC },
  'lobby:join': { burst: COARSE_BURST, refillPerSec: COARSE_REFILL_PER_SEC },
  // the high-rate movement stream.
  input: { burst: INPUT_BURST, refillPerSec: INPUT_REFILL_PER_SEC },
  // the on-demand leaderboard fetch/poll.
  'leaderboard:request': { burst: LEADERBOARD_BURST, refillPerSec: LEADERBOARD_REFILL_PER_SEC },
  // the global chat stream.
  'chat:send': { burst: CHAT_BURST, refillPerSec: CHAT_REFILL_PER_SEC }
};

/**
 * Build a rate limiter.
 *
 * @returns {{ allow(socketId: string, kind: string): boolean, drop(socketId: string): void }}
 *   - allow(socketId, kind): consume one token of `kind` for `socketId`.
 *       Returns true if the packet is within budget (handler should run), false
 *       if it should be shed. An unknown `kind` is always allowed (fail-open).
 *   - drop(socketId): forget all of a socket's buckets (call on disconnect).
 */
function createRateLimiter() {
  // socketId -> { [kind]: { tokens: number, last: number(ms) } }
  const bySocket = new Map();

  function allow(socketId, kind) {
    const spec = SPECS[kind];
    if (!spec) return true; // fail-open for anything we don't gate.

    const now = Date.now();

    let buckets = bySocket.get(socketId);
    if (!buckets) {
      buckets = {};
      bySocket.set(socketId, buckets);
    }

    let bucket = buckets[kind];
    if (!bucket) {
      // A fresh bucket starts full, so the first packets of a session always pass.
      bucket = { tokens: spec.burst, last: now };
      buckets[kind] = bucket;
    }

    // Lazy refill: add the tokens that have accrued since we last looked, capped
    // at the burst size. Guard against clock skew with Math.max(0, …).
    const elapsedSec = Math.max(0, (now - bucket.last) / 1000);
    bucket.tokens = Math.min(spec.burst, bucket.tokens + elapsedSec * spec.refillPerSec);
    bucket.last = now;

    if (bucket.tokens >= 1) {
      bucket.tokens -= 1;
      return true;
    }

    // Over budget — shed this packet.
    return false;
  }

  function drop(socketId) {
    bySocket.delete(socketId);
  }

  return { allow, drop };
}

// The server runs a single socket layer, so a module-level singleton is the
// simplest fit: every handler requires this same instance and keys by socket.id.
// (createRateLimiter is exported too, for tests / isolated instances.)
const limiter = createRateLimiter();

module.exports = { createRateLimiter, limiter };
