#!/usr/bin/env node
'use strict';

/**
 * End-to-end WIRE check for the animal-collection feature, over the real
 * socket.io contract. A headless client auths + joins and we assert the
 * snapshot-borne facts that prove the client↔server plumbing:
 *   - all 14 kind:'food' sources arrive in the snapshot, each carrying a foodKey
 *     and a display name (so the renderer can tint + label them);
 *   - the server accepts the new 'feed' PlayerAction verb without erroring.
 *
 * NOTE: this does NOT navigate a bot to a food source to exercise collect/feed —
 * straight-line steering can't path through the zoo's walls, and pathfinding is
 * out of scope for a wire check. The collect/feed/follow/steal/score MECHANICS are
 * covered by the server-side integration harness (which positions the player
 * exactly), and by manual two-tab play. This guards the WIRE: new fields/events
 * actually cross it. Throwaway account; exits non-zero on any failure.
 *
 * Run: server up (cd server && npm start), then `node scripts/e2e-follow.js`.
 */

const { io } = require('socket.io-client');
const { SPECIES_KEYS } = require('../shared/dist/species.js');

const URL = process.env.URL || 'http://localhost:3000';
const ROOM = 'e2e-follow';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let failed = false;
const check = (cond, msg) => { console.log(`${cond ? 'PASS' : 'FAIL'}  ${msg}`); if (!cond) failed = true; };

(async () => {
  const name = 'e2e_' + Date.now();
  const socket = io(URL, { transports: ['websocket'], forceNew: true });
  const entities = new Map();
  socket.on('snapshot', (snap) => {
    for (const e of snap.entities) entities.set(e.id, { ...entities.get(e.id), ...e });
  });

  socket.emit('auth:login', { username: name });
  await sleep(200);
  socket.emit('lobby:join', { room: ROOM, name, species: 'ape' });
  await sleep(900); // let the map + a full snapshot refresh arrive

  const food = [...entities.values()].filter((e) => e.kind === 'food');
  check(food.length === SPECIES_KEYS.length, `all ${SPECIES_KEYS.length} food sources ride the snapshot (got ${food.length})`);
  check(food.every((f) => typeof f.foodKey === 'string' && f.foodKey), 'every food source carries a foodKey over the wire');
  check(food.every((f) => typeof f.name === 'string' && f.name), 'every food source carries a display name over the wire');

  // The server must accept the new 'feed' verb (latched like interact/order/ability)
  // without dropping the socket.
  let seq = 0;
  socket.emit('input', { seq: ++seq, dx: 0, dy: 0, action: 'feed' });
  await sleep(250);
  check(socket.connected, "server accepts the 'feed' action without disconnecting");

  socket.close();
  await sleep(100);
  console.log(failed ? '\nE2E FAILED' : '\nE2E PASSED');
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error('E2E ERROR', e); process.exit(1); });
