'use strict';

/**
 * Global-chat handler — the room-wide text chat.
 * Event: chat:send {text} → chat:message {senderId, senderName, senderSpecies, text, tick}.
 *
 * A player sends a line; the server validates + trims + length-caps it, stamps the
 * AUTHORITATIVE sender identity from that socket's own player record (set at
 * lobby:join from the authenticated username + assigned species), and broadcasts it
 * to everyone in the player's room. NOTHING about the sender is trusted from the
 * client — only the message text, which is sanitized here — so a client can't forge
 * who a message is from. There is no server-side history: a line is delivered once,
 * live, to whoever is connected (late joiners start with an empty log).
 *
 * Event names come from the shared net contract (CLIENT_EVENTS.CHAT_SEND /
 * SERVER_EVENTS.CHAT_MESSAGE), require(esm)-imported from shared/dist/net.js so the
 * wire names match the client without a duplicated literal (Node>=22 require ESM).
 * Mirrors the leaderboard handler's structure (DI register, rate-limited).
 */

const { CLIENT_EVENTS, SERVER_EVENTS } = require('../../shared/dist/net.js');
const { limiter } = require('./rate-limit');
const engine = require('../game/engine');

// Hard cap on a single message's length (matches net.ts ChatSend's documented cap).
// Defends the broadcast payload from a client sending a wall of text; the trim runs
// first so leading/trailing whitespace doesn't eat into the budget.
const MAX_LEN = 256;

/**
 * @param {import('socket.io').Socket} socket
 * @param {object} deps  shared dependencies (see socket/index.js); uses io + connectedPlayers.
 */
function register(socket, deps) {
  const { io, connectedPlayers } = deps;

  socket.on(CLIENT_EVENTS.CHAT_SEND, (payload = {}) => {
    // Rate-limit: chat is bursty but low-rate. A flood is shed (silent no-op);
    // normal chatter is well within budget. See rate-limit.js 'chat:send' spec.
    if (!limiter.allow(socket.id, 'chat:send')) return;

    // Identity comes from the server-side player record, never the payload. A socket
    // that hasn't joined a room yet (no record) simply can't chat.
    const player = connectedPlayers.get(socket.id);
    if (!player || !player.room) return;

    // The ONLY client-supplied field: sanitize it. Trim, cap, drop if empty/blank.
    const text = typeof payload.text === 'string' ? payload.text.trim().slice(0, MAX_LEN) : '';
    if (!text) return;

    // Broadcast to everyone in the sender's room (including the sender, so their own
    // line lands in their log the same way it does for everyone else).
    io.to(player.room).emit(SERVER_EVENTS.CHAT_MESSAGE, {
      senderId: player.id,
      senderName: player.name,
      senderSpecies: player.species,
      text,
      tick: engine.getCurrentTick()
    });
  });
}

module.exports = { register };
