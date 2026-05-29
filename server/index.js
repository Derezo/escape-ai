'use strict';

// Load environment variables first, before anything reads config.
require('dotenv').config();

const express = require('express');
const { createServer } = require('http');
const { Server } = require('socket.io');

const config = require('./config');
const initSockets = require('./socket');
const speciesRoster = require('./socket/species-roster');
const engine = require('./game/engine');
const db = require('./db');

// --- Persistence: open the SQLite store once, before sockets can touch it. ---
db.init();

// --- HTTP + Socket.IO bootstrap ---
const app = express();
const httpServer = createServer(app);

const io = new Server(httpServer, {
  cors: {
    // Open CORS in dev; locked down in production.
    origin: config.isProduction ? false : '*'
  }
});

app.use(express.json());

// --- Socket handlers + shared state (db threaded in for auth + stats). ---
const sockets = initSockets(io, db);

// --- Health endpoint ---
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    uptime: process.uptime(),
    tick: engine.getCurrentTick(),
    players: sockets.connectedPlayers.size
  });
});

// --- Engine: wire shared state, then start the fixed-tick loop ---
// engine.init() is async: it dynamic-import()s the ESM Three-Laws math from
// shared/dist/step.js and caches it. We MUST await that before start() so the
// math is available on the very first synchronous tick. Listen only once the
// engine is live so /health and snapshots never race the import.
Promise.all([
  // Warm the shared species roster cache (used by lobby.js) before any client
  // can connect, mirroring how the engine pre-loads the shared stealth math.
  speciesRoster.load(),
  engine.init(io, sockets.connectedPlayers, sockets.rooms, db)
])
  .then(() => {
    engine.start();

    // --- Listen ---
    httpServer.listen(config.PORT, config.HOST, () => {
      console.log(
        `tins2026-server listening on http://${config.HOST}:${config.PORT} ` +
        `(tick ${config.TICK_RATE}Hz, env ${config.NODE_ENV})`
      );
    });
  })
  .catch((err) => {
    console.error('[FATAL] engine init failed:', err);
    process.exit(1);
  });

// --- Resilience: log fatal errors and shut down cleanly ---
process.on('uncaughtException', (err) => {
  console.error('[FATAL] uncaught exception:', err);
  engine.stop();
  db.close();
  httpServer.close(() => process.exit(1));
  setTimeout(() => process.exit(1), 3000).unref();
});

process.on('unhandledRejection', (reason) => {
  console.error('[FATAL] unhandled rejection:', reason);
});

process.on('SIGTERM', () => {
  console.log('SIGTERM received, shutting down...');
  engine.stop();
  db.close();
  httpServer.close(() => process.exit(0));
});
