'use strict';

/**
 * Leaderboard handler — the on-demand, server-authoritative ranking.
 * Events: leaderboard:request {sort?, limit?} → leaderboard:data {sort, rows, total, you}.
 *
 * The client fetches on opening the L panel and re-polls while it's open (and on a
 * sort-change click). The server scores + ranks EVERY account from its own DB via
 * the shared composite scorer (db.getLeaderboard) and returns the top-N plus the
 * asker's own ranked row — so a player always sees their standing even outside the
 * top-N. NOTHING is trusted from the client but the (validated) sort key + limit;
 * scores and ranks are computed server-side and can't be forged.
 *
 * Event-name strings mirror shared/src/net.ts CLIENT_EVENTS.LEADERBOARD_REQUEST /
 * SERVER_EVENTS.LEADERBOARD_DATA (the server is CJS and can't import the TS const,
 * so — like the other handlers — we hardcode the wire names here).
 */

const { limiter } = require('./rate-limit');

// Whitelist of sort keys the client may request (mirrors net.ts LeaderboardSort).
// An unknown/absent sort falls through to db.getLeaderboard's own default ('score').
const VALID_SORTS = new Set([
  'score', 'escapes', 'questsCompleted', 'animalsStolen', 'foodCollected',
  'caught', 'ordersIssued', 'abilitiesUsed', 'playSeconds', 'games'
]);

// Hard ceiling on how many rows a single request may pull, independent of the
// DB-side clamp — defends the wire payload from a client asking for a huge limit.
const MAX_LIMIT = 200;
const DEFAULT_LIMIT = 100;

/**
 * @param {import('socket.io').Socket} socket
 * @param {object} deps  shared dependencies (see socket/index.js); includes `db`.
 */
function register(socket, deps) {
  const { socket: sock, db, state } = deps;

  sock.on('leaderboard:request', (payload = {}) => {
    // Rate-limit: the query touches every account row, so a flood is shed (the
    // panel's poll cadence is well within budget). Over-budget → silent no-op.
    if (!limiter.allow(sock.id, 'leaderboard:request')) return;

    // Validate the only two client-supplied fields. A bad sort → undefined (db
    // defaults to 'score'); limit is coerced + clamped to [1, MAX_LIMIT].
    const reqSort = typeof payload.sort === 'string' && VALID_SORTS.has(payload.sort)
      ? payload.sort
      : undefined;
    const rawLimit = Number(payload.limit);
    const limit = Number.isFinite(rawLimit)
      ? Math.max(1, Math.min(MAX_LIMIT, Math.round(rawLimit)))
      : DEFAULT_LIMIT;

    // Defensive: a bare test harness may omit db. Reply with an empty board rather
    // than throwing, so the client UI degrades gracefully.
    if (!db || typeof db.getLeaderboard !== 'function') {
      sock.emit('leaderboard:data', { sort: reqSort || 'score', rows: [], total: 0, you: null });
      return;
    }

    // The asker's own row is keyed by their authenticated account (set by auth.js).
    // Un-authed sockets simply get `you: null` (no account → no rank).
    const requesterUserId = (state && state.userId) || undefined;
    const result = db.getLeaderboard({ sort: reqSort, limit, requesterUserId });
    sock.emit('leaderboard:data', result);
  });
}

module.exports = { register };
