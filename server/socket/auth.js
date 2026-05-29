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
 * Event-name strings mirror shared/src/net.ts CLIENT_EVENTS.AUTH_LOGIN /
 * SERVER_EVENTS.AUTH_RESULT (the server is JS and can't import the TS const, so
 * — like the existing 'lobby:join' handler — we hardcode the wire names here).
 */

const { isPlayableSpecies } = require('./species-roster');

/**
 * @param {import('socket.io').Socket} socket
 * @param {object} deps  shared dependencies (see socket/index.js); includes `db`.
 */
function register(socket, deps) {
  const { socket: sock, db, state } = deps;

  sock.on('auth:login', (payload = {}) => {
    const username = typeof payload.username === 'string' ? payload.username : '';
    const token = typeof payload.token === 'string' ? payload.token : undefined;
    const species = typeof payload.species === 'string' ? payload.species : undefined;

    const result = db.loginOrRegister({ username, token });

    if (!result.ok) {
      // Rejected — leave `state` untouched so no partial identity leaks in.
      sock.emit('auth:result', { ok: false, reason: result.reason });
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

    sock.emit('auth:result', {
      ok: true,
      token: result.token,
      username: user.username,
      stats: db.getStatsForUser(user.id)
    });
  });
}

module.exports = { register };
