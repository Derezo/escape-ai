#!/usr/bin/env node
/**
 * Headless Multiplayer Load Harness  (TINS 2026 starter kit)
 *
 * Spawns N headless Socket.IO clients that connect to the running authoritative
 * server, join one room, and emit movement input at ~20Hz each — simulating N
 * browser tabs. It's the scale evidence for Phase 1 ("multiplayer scale first"):
 * proof the server keeps ~20 concurrent players plus the ~22 world props in sync
 * without desync or bandwidth blowup.
 *
 * It conforms exactly to the wire contract in shared/src/net.ts:
 *   client -> server:  lobby:join {room, name}, input {seq, dx, dy}, ping {t}
 *   server -> client:  lobby:state {players}, snapshot {tick, entities, acks, world}, pong {t}
 *
 * The server sends DELTA snapshots: only entities that changed ride each tick,
 * with a FULL refresh (all ~42 entities = 20 players + 22 props) every ~5s. So
 * watch "entities/snap max" — it should climb to ~22+ (idle) and ~42 (with 20
 * moving bots) on full refreshes. The per-snapshot average reflects the delta.
 *
 * --- ONE-TIME SETUP (socket.io-client is NOT bundled with a clean clone) ----
 *   cd scripts && npm install        # installs socket.io-client into scripts/
 * (kept in scripts/package.json so client/ and server/ deps stay untouched.)
 *
 * --- RUN --------------------------------------------------------------------
 *   1. Start the server:   cd server && npm start
 *   2. In another shell:   node scripts/sim-clients.js [N] [options]
 *
 * Usage:
 *   node scripts/sim-clients.js [N] [--url=http://host:port] [--room=default] [--secs=15]
 *   node scripts/sim-clients.js --help
 *
 * Defaults: N=20, url=http://localhost:3000, room=default, secs=0 (run until Ctrl+C).
 */

'use strict';

let io;
try {
  ({ io } = require('socket.io-client'));
} catch (err) {
  console.error('socket.io-client is not installed.\n  Fix: cd scripts && npm install\n');
  process.exit(1);
}

// --- args -------------------------------------------------------------------

function parseArgs() {
  const args = process.argv.slice(2);
  const flag = (name, def) => {
    const hit = args.find((a) => a.startsWith(`--${name}=`));
    return hit ? hit.split('=').slice(1).join('=') : def;
  };
  // First bare (non --) arg is N.
  const bareN = args.find((a) => !a.startsWith('-'));
  return {
    help: args.includes('--help') || args.includes('-h'),
    n: Math.max(1, parseInt(bareN, 10) || 20),
    url: flag('url', 'http://localhost:3000'),
    room: flag('room', 'default'),
    secs: Math.max(0, parseInt(flag('secs', '0'), 10) || 0)
  };
}

function showHelp() {
  console.log(`
Headless Multiplayer Load Harness (socket.io-client)

Spawns N headless clients that join a room and send ~20Hz movement input,
proving the authoritative server syncs ~20 players + ~22 world props at scale.

Usage:
  node scripts/sim-clients.js [N] [options]

Arguments:
  N                Number of simulated clients (default 20)

Options:
  --url=<url>      Server URL (default http://localhost:3000)
  --room=<name>    Room to join (default 'default')
  --secs=<n>       Run for N seconds then exit (default 0 = until Ctrl+C)
  --help, -h       Show this help

Setup (once, on a clean clone):
  cd scripts && npm install

Run:
  cd server && npm start          # start the authoritative server first
  node scripts/sim-clients.js 20 --secs=15
`);
}

// --- tunables (match the contract / engine) ---------------------------------

const INPUT_HZ = 20;                 // ~20Hz input, matches the 20Hz server tick
const INPUT_INTERVAL = 1000 / INPUT_HZ;
const PING_INTERVAL = 1000;          // ping RTT sample every 1s
const REPORT_INTERVAL = 2000;        // aggregate report every 2s
const STAGGER = 25;                  // ms between client handshakes (anti-thundering-herd)
const WANDER_MIN = 1000;             // direction holds 1..2s, so bots roam 0..1000
const WANDER_MAX = 2000;

// --- a single simulated client ----------------------------------------------

function makeBot(i, opts) {
  const bot = {
    i,
    socket: null,
    connected: false,
    seq: 0,
    dx: 0,
    dy: 0,
    nextTurnAt: 0,
    // metrics (reset each report window)
    snaps: 0,
    bytes: 0,
    lastEntityCount: 0,
    maxEntityCount: 0,
    rtts: [],
    inputTimer: null,
    pingTimer: null
  };

  const socket = io(opts.url, {
    transports: ['websocket'],
    reconnection: false,
    timeout: 8000
  });
  bot.socket = socket;

  socket.on('connect', () => {
    bot.connected = true;
    socket.emit('lobby:join', { room: opts.room, name: `bot-${i}` });

    // ~20Hz wandering movement input.
    bot.inputTimer = setInterval(() => {
      const now = Date.now();
      if (now >= bot.nextTurnAt) {
        // Pick a new heading; full [-1,1] range per axis.
        bot.dx = Math.random() * 2 - 1;
        bot.dy = Math.random() * 2 - 1;
        bot.nextTurnAt = now + WANDER_MIN + Math.random() * (WANDER_MAX - WANDER_MIN);
      }
      bot.seq += 1;
      socket.emit('input', { seq: bot.seq, dx: bot.dx, dy: bot.dy });
    }, INPUT_INTERVAL);

    // Latency probe every 1s.
    bot.pingTimer = setInterval(() => {
      socket.emit('ping', { t: Date.now() });
    }, PING_INTERVAL);
  });

  socket.on('snapshot', (snap) => {
    // Robust to a malformed payload — never crash the harness.
    try {
      bot.snaps += 1;
      bot.bytes += JSON.stringify(snap).length;
      const count = snap && Array.isArray(snap.entities) ? snap.entities.length : 0;
      bot.lastEntityCount = count;
      if (count > bot.maxEntityCount) bot.maxEntityCount = count;
    } catch (_) {
      /* ignore one bad snapshot */
    }
  });

  socket.on('pong', (payload) => {
    const t = payload && typeof payload === 'object' ? payload.t : payload;
    if (typeof t === 'number') bot.rtts.push(Date.now() - t);
  });

  socket.on('lobby:state', () => { /* roster updates; counted via connect */ });

  socket.on('connect_error', (err) => {
    // Print the first connect failure with a hint, then stay quiet and keep trying
    // the other bots — the server may just not be up yet.
    if (!makeBot._warnedConnect) {
      makeBot._warnedConnect = true;
      console.error(
        `\n[connect_error] ${err && err.message ? err.message : err}\n` +
        `  Is the server running? Start it with:  cd server && npm start\n`
      );
    }
  });

  socket.on('disconnect', () => {
    bot.connected = false;
  });

  return bot;
}

function teardownBot(bot) {
  if (bot.inputTimer) clearInterval(bot.inputTimer);
  if (bot.pingTimer) clearInterval(bot.pingTimer);
  if (bot.socket) bot.socket.disconnect();
}

// --- aggregate reporting ----------------------------------------------------

function report(bots, windowMs, label) {
  const connected = bots.filter((b) => b.connected).length;
  let snaps = 0;
  let bytes = 0;
  let entSum = 0;
  let entSamples = 0;
  let entMax = 0;
  const rtts = [];

  for (const b of bots) {
    snaps += b.snaps;
    bytes += b.bytes;
    if (b.lastEntityCount > 0) { entSum += b.lastEntityCount; entSamples += 1; }
    if (b.maxEntityCount > entMax) entMax = b.maxEntityCount;
    rtts.push(...b.rtts);
  }

  const secs = windowMs / 1000;
  const snapsPerSec = connected ? (snaps / connected / secs) : 0;
  const kbPerClient = connected ? (bytes / connected / secs / 1024) : 0;
  const kbTotal = bytes / secs / 1024;
  const avgEnt = entSamples ? (entSum / entSamples) : 0;
  const avgRtt = rtts.length ? (rtts.reduce((a, b) => a + b, 0) / rtts.length) : 0;
  const maxRtt = rtts.length ? Math.max(...rtts) : 0;

  console.log(
    `${label} ` +
    `clients=${connected}/${bots.length}  ` +
    `snaps/s=${snapsPerSec.toFixed(1)}  ` +
    `ent/snap last-avg=${avgEnt.toFixed(1)} max=${entMax}  ` +
    `in=${kbPerClient.toFixed(1)}KB/s/cli ${kbTotal.toFixed(1)}KB/s total  ` +
    `rtt avg=${avgRtt.toFixed(1)}ms max=${maxRtt.toFixed(0)}ms`
  );

  // Reset the per-window accumulators (keep connection + max-entity high-water).
  for (const b of bots) {
    b.snaps = 0;
    b.bytes = 0;
    b.rtts.length = 0;
  }
}

// --- main -------------------------------------------------------------------

function main() {
  const opts = parseArgs();
  if (opts.help) {
    showHelp();
    return;
  }

  console.log(
    `Spawning ${opts.n} bot(s) -> ${opts.url} room='${opts.room}'` +
    (opts.secs ? ` for ${opts.secs}s` : ' (Ctrl+C to stop)') +
    `  [${STAGGER}ms stagger, ~${INPUT_HZ}Hz input]\n`
  );

  const bots = [];
  let spawned = 0;
  const spawnTimer = setInterval(() => {
    bots.push(makeBot(spawned, opts));
    spawned += 1;
    if (spawned >= opts.n) clearInterval(spawnTimer);
  }, STAGGER);

  let lastReport = Date.now();
  const reportTimer = setInterval(() => {
    const now = Date.now();
    report(bots, now - lastReport, '[report]');
    lastReport = now;
  }, REPORT_INTERVAL);

  let shuttingDown = false;
  const shutdown = (reason) => {
    if (shuttingDown) return;
    shuttingDown = true;
    clearInterval(spawnTimer);
    clearInterval(reportTimer);
    const now = Date.now();
    console.log(`\n--- final summary (${reason}) ---`);
    report(bots, now - lastReport, '[final] ');
    for (const b of bots) teardownBot(b);
    // Give disconnects a moment to flush, then exit.
    setTimeout(() => process.exit(0), 200).unref();
  };

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));

  if (opts.secs > 0) {
    setTimeout(() => shutdown(`${opts.secs}s elapsed`), opts.secs * 1000).unref();
  }
}

main();
