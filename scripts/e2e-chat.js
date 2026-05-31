'use strict';

/**
 * Two-client end-to-end check for global chat. Boots the REAL server on a temp port
 * with a throwaway DB, connects two socket.io clients (auth → join), has client A
 * send chat lines, and asserts:
 *   1. BOTH A and B receive the broadcast with server-stamped sender identity.
 *   2. The sender fields match A's player (name/species), not anything A supplied.
 *   3. Whitespace is trimmed; an empty/blank message is dropped (no broadcast).
 *   4. An over-long message is capped at 256 chars.
 *   5. A line sent before joining a room is dropped (no record → can't chat).
 *
 * Run from the repo root:  node scripts/e2e-chat.js
 * Requires socket.io-client in scripts/ (cd scripts && npm install). Exits non-zero
 * on any failed assertion.
 */

const path = require('path');
const { spawn } = require('child_process');
const os = require('os');
const fs = require('fs');

let io;
try {
  ({ io } = require('socket.io-client'));
} catch {
  console.error('socket.io-client is not installed.\n  Fix: cd scripts && npm install\n');
  process.exit(2);
}

const ROOT = path.resolve(__dirname, '..');
const PORT = 31987;
const URL = `http://127.0.0.1:${PORT}`;
const ROOM = 'default';

const tmpDb = path.join(os.tmpdir(), `escapeai-e2e-chat-${process.pid}.db`);

const failures = [];
function check(cond, label) {
  if (cond) console.log(`  OK  ${label}`);
  else {
    console.error(`  FAIL ${label}`);
    failures.push(label);
  }
}

function wait(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/** Connect, auth, join. Resolves with {socket, received: ChatMessage[]}. */
function connectClient(username, species) {
  return new Promise((resolve, reject) => {
    const socket = io(URL, { transports: ['websocket'], forceNew: true });
    const received = [];
    socket.on('chat:message', (m) => received.push(m));
    socket.on('connect_error', (e) => reject(new Error(`connect_error: ${e.message}`)));

    socket.on('connect', () => {
      socket.once('auth:result', (res) => {
        if (!res || !res.ok) {
          reject(new Error(`auth failed for ${username}: ${res && res.reason}`));
          return;
        }
        socket.emit('lobby:join', { room: ROOM, name: username, species });
        // lobby:state confirms we're in the room; resolve a beat after.
        socket.once('lobby:state', () => resolve({ socket, received, username }));
      });
      socket.emit('auth:login', { username, species });
    });
  });
}

async function main() {
  // --- Boot the real server on a temp port + throwaway DB. ---
  const server = spawn(process.execPath, ['index.js'], {
    cwd: path.join(ROOT, 'server'),
    env: {
      ...process.env,
      PORT: String(PORT),
      HOST: '127.0.0.1',
      DB_PATH: tmpDb,
      NODE_ENV: 'test',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let serverUp = false;
  server.stdout.on('data', (d) => {
    if (/listening on/.test(String(d))) serverUp = true;
  });
  server.stderr.on('data', (d) => process.stderr.write(`[server] ${d}`));

  // Wait for the listen line (up to ~5s).
  for (let i = 0; i < 50 && !serverUp; i++) await wait(100);
  if (!serverUp) throw new Error('server did not start within 5s');

  let a;
  let b;
  let beforeJoin;
  try {
    // A client that sends BEFORE joining a room (to assert it's dropped).
    beforeJoin = await new Promise((resolve, reject) => {
      const socket = io(URL, { transports: ['websocket'], forceNew: true });
      socket.on('connect_error', (e) => reject(new Error(e.message)));
      socket.on('connect', () => resolve(socket));
    });
    // Fire a chat:send with no auth/join at all — must be silently dropped.
    beforeJoin.emit('chat:send', { text: 'i should be dropped' });

    a = await connectClient('alice', 'rat');
    b = await connectClient('bob', 'ape');
    await wait(300); // let rosters settle

    const baselineA = a.received.length;
    const baselineB = b.received.length;

    // 1+2. A sends; both receive with A's server-stamped identity.
    a.socket.emit('chat:send', { text: '  hello world  ' });
    await wait(400);

    const gotA = a.received.slice(baselineA);
    const gotB = b.received.slice(baselineB);
    check(gotA.length === 1, 'sender A receives its own broadcast (echo)');
    check(gotB.length === 1, 'other client B receives the broadcast');
    const msg = gotB[0] || {};
    check(msg.text === 'hello world', `text is trimmed ("${msg.text}")`);
    check(msg.senderName === 'alice', `senderName is server-stamped ("${msg.senderName}")`);
    check(msg.senderSpecies === 'rat', `senderSpecies is server-stamped ("${msg.senderSpecies}")`);
    check(typeof msg.senderId === 'string' && msg.senderId.length > 0, 'senderId present');
    check(typeof msg.tick === 'number', 'tick present');

    // 3. Empty / whitespace-only is dropped.
    const cntA = a.received.length;
    const cntB = b.received.length;
    a.socket.emit('chat:send', { text: '    ' });
    a.socket.emit('chat:send', { text: '' });
    a.socket.emit('chat:send', {}); // missing text
    await wait(300);
    check(a.received.length === cntA, 'blank/empty/missing message is dropped (A)');
    check(b.received.length === cntB, 'blank/empty/missing message is dropped (B)');

    // 4. Over-long message is capped at 256.
    const longText = 'x'.repeat(500);
    const cntB2 = b.received.length;
    a.socket.emit('chat:send', { text: longText });
    await wait(300);
    const capped = b.received[b.received.length - 1];
    check(b.received.length === cntB2 + 1, 'long message is broadcast');
    check(capped && capped.text.length === 256, `long message capped to 256 (got ${capped && capped.text.length})`);

    // 5. The pre-join client's message never reached anyone.
    const sawDropped = [...a.received, ...b.received].some((m) => m.text === 'i should be dropped');
    check(!sawDropped, 'pre-join (no room) message was dropped');
  } finally {
    a && a.socket.close();
    b && b.socket.close();
    beforeJoin && beforeJoin.close();
    server.kill('SIGTERM');
    await wait(200);
    try { fs.rmSync(tmpDb, { force: true }); fs.rmSync(`${tmpDb}-wal`, { force: true }); fs.rmSync(`${tmpDb}-shm`, { force: true }); } catch { /* ignore */ }
  }

  console.log('');
  if (failures.length) {
    console.error(`CHAT E2E FAILED — ${failures.length} assertion(s) failed.`);
    process.exit(1);
  }
  console.log('CHAT E2E PASSED — all assertions green.');
  process.exit(0);
}

main().catch((e) => {
  console.error('CHAT E2E ERROR:', e && e.stack ? e.stack : e);
  process.exit(1);
});
