'use strict';

// Load environment variables first, before anything reads config.
require('dotenv').config();

const express = require('express');
const { createServer } = require('http');
const { Server } = require('socket.io');

const config = require('./config');
const initSockets = require('./socket');
const engine = require('./game/engine');

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

// --- Socket handlers + shared state ---
const sockets = initSockets(io);

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
engine.init(io, sockets.connectedPlayers, sockets.rooms);
engine.start();

// --- Listen ---
httpServer.listen(config.PORT, config.HOST, () => {
  console.log(
    `tins2026-server listening on http://${config.HOST}:${config.PORT} ` +
    `(tick ${config.TICK_RATE}Hz, env ${config.NODE_ENV})`
  );
});

// --- Resilience: log fatal errors and shut down cleanly ---
process.on('uncaughtException', (err) => {
  console.error('[FATAL] uncaught exception:', err);
  engine.stop();
  httpServer.close(() => process.exit(1));
  setTimeout(() => process.exit(1), 3000).unref();
});

process.on('unhandledRejection', (reason) => {
  console.error('[FATAL] unhandled rejection:', reason);
});

process.on('SIGTERM', () => {
  console.log('SIGTERM received, shutting down...');
  engine.stop();
  httpServer.close(() => process.exit(0));
});
