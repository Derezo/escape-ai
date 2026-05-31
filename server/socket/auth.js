'use strict';

/**
 * Auth handler — username-only accounts with a persisted token.
 * Events: auth:login {username, token?, species?} → auth:result {ok, ...}.
 *
 * The client always sends `auth:login` BEFORE `lobby:join`; on success we stash
 * the authenticated identity on the per-socket `state` closure so lobby.js can
 * use it as the authoritative player name + species, and connection.js can
 * attribute play-time/stats on disconnect.
 *
 * Event names come from the shared net contract (shared/src/net.ts → dist/net.js);
 * the server require(esm)-imports the same CLIENT_EVENTS/SERVER_EVENTS the client
 * uses, so the wire names are a single source of truth (Node>=22 require of ESM).
 */

const { CLIENT_EVENTS, SERVER_EVENTS } = require('../../shared/dist/net.js');
const { isPlayableSpecies } = require('./species-roster');
const { limiter } = require('./rate-limit');

/**
 * @param {import('socket.io').Socket} socket
 * @param {object} deps  shared dependencies (see socket/index.js); includes `db`.
 */
function register(socket, deps) {
  const { socket: sock, db, state } = deps;

  sock.on(CLIENT_EVENTS.AUTH_LOGIN, (payload = {}) => {
    // Rate-limit: auth:login is rare, so a flood is abuse. Over-budget packets
    // are silently dropped (no state change, no disconnect) — the client retries.
    if (!limiter.allow(sock.id, 'auth:login')) return;

    const username = typeof payload.username === 'string' ? payload.username : '';
    const token = typeof payload.token === 'string' ? payload.token : undefined;
    const species = typeof payload.species === 'string' ? payload.species : undefined;

    const result = db.loginOrRegister({ username, token });

    if (!result.ok) {
      // Rejected — leave `state` untouched so no partial identity leaks in.
      sock.emit(SERVER_EVENTS.AUTH_RESULT, { ok: false, reason: result.reason });
      return;
    }

    const user = result.user;

    // A successful login starts a session: count it once, freshen last_seen, and
    // (if the client picked a valid species) remember it as the new default.
    db.incGames(user.id);
    db.touchLastSeen(user.id);
    const validSpecies = isPlayableSpecies(species) ? species : undefined;
    if (validSpecies) db.setLastSpecies(user.id, validSpecies);

    // Stash the authenticated identity on the socket closure for lobby.js /
    // connection.js. joinedAt marks the session start for play-time accounting.
    state.userId = user.id;
    state.username = user.username;
    state.token = result.token;
    state.desiredSpecies = validSpecies;
    state.joinedAt = Date.now();

    // RESUME: load any saved mid-run session so lobby.js can restore the player
    // (species/position/quest/inventory/score) instead of a fresh pen spawn. A
    // returning player with a usable session resumes their CURRENT species — the
    // client menu skips the picker when `resumed` is set. Stash the raw snapshot
    // for lobby.js; surface only the species hint (+ a flag) to the client.
    const savedSession = db.loadSession ? db.loadSession(user.id) : undefined;
    state.session = savedSession || null;
    const resumeSpecies =
      savedSession && isPlayableSpecies(savedSession.species) ? savedSession.species : undefined;

    sock.emit(SERVER_EVENTS.AUTH_RESULT, {
      ok: true,
      token: result.token,
      username: user.username,
      stats: db.getStatsForUser(user.id),
      // Client hint: a returning player resumes (skip the species picker) as this
      // species. Absent for a brand-new account or one with no saved session.
      resumed: resumeSpecies !== undefined,
      resumeSpecies
    });
  });
}

module.exports = { register };
