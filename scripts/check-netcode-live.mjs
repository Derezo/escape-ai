// check-netcode-live.mjs — EMPIRICAL netcode gate against a REAL running server.
//
// This is the gate the model-based check-netcode.mjs could never be: it boots the
// actual authoritative server, connects a real socket.io client, and measures what
// happens ON THE WIRE — including under a deliberately SLOW consumer that models an
// Android WebView. Two prior fixes shipped "green" against a model server that does
// not exist; this gate reproduces the user's actual bug (snapshot flood → inbound
// head-of-line blocking → climbing RTT + broken movement) and FAILS on it.
//
// Usage:
//   node check-netcode-live.mjs            # boots its own server on :3199, runs gate
//   node check-netcode-live.mjs --url=https://escape.mittonvillage.com  # gate a live server
//
// Exit 0 = all gates pass. Exit 1 = a bound was violated (the bug is present).
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
const require = createRequire(import.meta.url);
const __dirname = dirname(fileURLToPath(import.meta.url));
const { io } = require('../client/node_modules/socket.io-client');

const arg = (k, d) => { const a = process.argv.find(s => s.startsWith(`--${k}=`)); return a ? a.split('=')[1] : d; };
const EXTERNAL_URL = arg('url', '');
const PORT = Number(arg('port', 3199));
const URL = EXTERNAL_URL || `http://127.0.0.1:${PORT}`;

// --- Gate bounds (post-fix targets). These are the acceptance criteria. ---
const BOUNDS = {
  minSnapRate: 15,        // snaps/sec received under a NORMAL consumer (server ticks 20Hz)
  maxKBps: 50,            // KB/s per client (today: ~530)
  maxEntitiesPerSnap: 45, // avg entities/snap (today: ~105)
  maxAckGap: 8,           // seq-ack gap under normal consumer
  // Slow-consumer arm (80ms busy-block/snap, models Android WebView):
  slowMaxRttMs: 1500,     // measured RTT must stay bounded (today: climbs to ~20000)
  slowMaxRttGrowthMs: 800,// first->last bucket growth (today: +13000)
  slowMaxDisconnects: 0,  // zero ping-timeout / backpressure disconnects
};

let failures = 0;
const fail = (m) => { console.log(`  ✗ ${m}`); failures++; };
const pass = (m) => console.log(`  ✓ ${m}`);

async function runProbe({ url, name, durationMs, snapBlockMs }) {
  return new Promise((resolve) => {
    const socket = io(url, { transports: ['websocket', 'polling'], autoConnect: true, reconnection: true });
    let myId, seq = 0, started = 0, snaps = 0, bytes = 0, ents = 0, pongs = 0, disconnects = 0;
    let authFailed = false;
    let maxEnt = 0, maxBytes = 0; // peak per-snapshot — catches a full-refresh re-send regression that the AVERAGE would dilute
    const reasons = [], rtt = [], gaps = [];
    let inputTimer, pingTimer, done = false;
    const now = () => Date.now() - started;
    socket.on('connect', () => socket.emit('auth:login', { username: name }));
    socket.on('disconnect', (r) => { disconnects++; reasons.push(r); });
    // On auth failure, RECORD it and finish — do NOT silently resolve to all-zero
    // metrics (which would trivially pass every upper-bound check). The caller hard-
    // fails on authFailed / zero snaps so a dead-or-unauthed run can't ship green.
    socket.on('auth:result', (m) => { if (m.ok) { socket.emit('lobby:join', { room: 'gate', name }); } else { authFailed = true; reasons.push(`auth:${m.reason}`); finish(); } });
    socket.on('lobby:state', (m) => { if (!myId) { const me = m.players.find(p => p.name === name); if (me) { myId = me.id; start(); } } });
    socket.on('snapshot', (m) => {
      snaps++; const b = JSON.stringify(m).length; bytes += b; const ne = (m.entities?.length || 0);
      ents += ne; if (ne > maxEnt) maxEnt = ne; if (b > maxBytes) maxBytes = b;
      if (snapBlockMs > 0) { const e = Date.now() + snapBlockMs; while (Date.now() < e) { /* spin */ } }
      if (myId && typeof m.acks?.[myId] === 'number') gaps.push(seq - m.acks[myId]);
    });
    socket.on('pong', (m) => rtt.push(Date.now() - m.t));
    function start() {
      started = Date.now();
      inputTimer = setInterval(() => { seq++; socket.volatile.emit('input', { seq, dx: 1, dy: 0, sprint: false }); }, 50);
      pingTimer = setInterval(() => socket.volatile.emit('ping', { t: Date.now() }), 1000);
      setTimeout(finish, durationMs);
    }
    function bucketMeans(a, n = 5) { const o = [], per = Math.ceil(a.length / n); for (let i = 0; i < a.length; i += per) { const s = a.slice(i, i + per); o.push(s.reduce((x, y) => x + y, 0) / s.length); } return o; }
    function finish() {
      if (done) return; done = true;
      clearInterval(inputTimer); clearInterval(pingTimer);
      const dur = Math.max(0.001, now() / 1000);
      const rb = rtt.length ? bucketMeans(rtt) : [0];
      // Stop counting disconnects: the intentional teardown below is ours, not a
      // backpressure/heartbeat drop. Only mid-run disconnects (already recorded
      // before this point) count toward the gate.
      done = true;
      socket.off('disconnect');
      socket.disconnect();
      resolve({
        dur, snaps, snapRate: snaps / dur, kbps: bytes / 1024 / dur,
        avgEnt: ents / Math.max(1, snaps), maxEnt, maxBytes,
        maxGap: gaps.length ? Math.max(...gaps) : 0,
        rttFirst: rb[0], rttLast: rb.at(-1), rttMax: rtt.length ? Math.max(...rtt) : 0,
        disconnects, reasons, authFailed, reachedPlay: !!myId,
      });
    }
    setTimeout(finish, durationMs + 15000);
  });
}

async function main() {
  let server;
  if (!EXTERNAL_URL) {
    console.log(`[gate] booting server on :${PORT} ...`);
    server = spawn('node', ['index.js'], {
      cwd: join(__dirname, '..', 'server'),
      env: { ...process.env, PORT: String(PORT), NODE_ENV: 'development' },
      stdio: ['ignore', 'ignore', 'inherit'],
    });
    // wait for /health
    for (let i = 0; i < 40; i++) {
      try { const r = await fetch(`${URL}/health`); if (r.ok) break; } catch { /* not up yet */ }
      await sleep(250);
    }
  }
  // Unique per-run identities: usernames persist in server/data/escapeai.db, so a
  // FIXED name (e.g. 'gateA') collides on the 2nd run / a teammate / CI → auth returns
  // name_taken → the probe never joins → all-zero metrics. Every payload/RTT bound is
  // an UPPER bound, so zero would trivially pass — the exact "ships green while broken"
  // failure this gate exists to prevent. A timestamp+random suffix is fresh every run.
  const runId = `${Date.now()}_${Math.floor(Math.random() * 1e6)}`;

  // Hard-fail guard: a probe that never reached play state (auth/join failed, server
  // down) must FAIL LOUDLY, not pass on zeros. Call this before any upper-bound check.
  const requireLive = (r, gate) => {
    if (r.authFailed) { fail(`${gate}: auth FAILED (${r.reasons.join(',')}) — probe never joined; metrics are meaningless`); return false; }
    if (!r.reachedPlay || r.snaps === 0) { fail(`${gate}: never reached play state (snaps=${r.snaps}, myId=${r.reachedPlay}) — server down or join failed`); return false; }
    return true;
  };

  console.log(`\n=== Gate A: payload + rate (normal consumer, 12s) — ${URL} ===`);
  const a = await runProbe({ url: URL, name: `gateA_${runId}`, durationMs: 12000, snapBlockMs: 0 });
  console.log(`  snapRate=${a.snapRate.toFixed(1)}/s  KB/s=${a.kbps.toFixed(0)}  entities/snap=${a.avgEnt.toFixed(0)} (max ${a.maxEnt})  maxGap=${a.maxGap}  rttMax=${a.rttMax}ms`);
  if (requireLive(a, 'Gate A')) {
    a.snapRate >= BOUNDS.minSnapRate ? pass(`snap rate ${a.snapRate.toFixed(1)} ≥ ${BOUNDS.minSnapRate}`) : fail(`snap rate ${a.snapRate.toFixed(1)} < ${BOUNDS.minSnapRate}`);
    a.kbps <= BOUNDS.maxKBps ? pass(`KB/s ${a.kbps.toFixed(0)} ≤ ${BOUNDS.maxKBps}`) : fail(`KB/s ${a.kbps.toFixed(0)} > ${BOUNDS.maxKBps} (payload flood)`);
    a.avgEnt <= BOUNDS.maxEntitiesPerSnap ? pass(`entities/snap ${a.avgEnt.toFixed(0)} ≤ ${BOUNDS.maxEntitiesPerSnap}`) : fail(`entities/snap ${a.avgEnt.toFixed(0)} > ${BOUNDS.maxEntitiesPerSnap} (delta defeated)`);
    // Peak per-snapshot: a regression that reinstated the whole-AOI full-refresh re-send
    // would spike ONE snapshot per 100 ticks to full-roster size, which the average hides.
    a.maxEnt <= BOUNDS.maxEntitiesPerSnap * 1.5 ? pass(`peak entities/snap ${a.maxEnt} ≤ ${Math.round(BOUNDS.maxEntitiesPerSnap * 1.5)} (no full-refresh re-send burst)`) : fail(`peak entities/snap ${a.maxEnt} > ${Math.round(BOUNDS.maxEntitiesPerSnap * 1.5)} (full-refresh re-send regression)`);
    a.maxGap <= BOUNDS.maxAckGap ? pass(`ack gap ${a.maxGap} ≤ ${BOUNDS.maxAckGap}`) : fail(`ack gap ${a.maxGap} > ${BOUNDS.maxAckGap}`);
  }

  console.log(`\n=== Gate B: slow consumer 80ms/snap (models Android WebView, 30s) — the decisive one ===`);
  const b = await runProbe({ url: URL, name: `gateB_${runId}`, durationMs: 30000, snapBlockMs: 80 });
  const growth = b.rttLast - b.rttFirst;
  console.log(`  rtt first=${b.rttFirst.toFixed(0)}ms last=${b.rttLast.toFixed(0)}ms max=${b.rttMax}ms growth=${growth.toFixed(0)}ms  disconnects=${b.disconnects} [${b.reasons.join(',')}]`);
  if (requireLive(b, 'Gate B')) {
    b.rttMax <= BOUNDS.slowMaxRttMs ? pass(`slow-consumer rtt max ${b.rttMax}ms ≤ ${BOUNDS.slowMaxRttMs}`) : fail(`slow-consumer rtt ${b.rttMax}ms > ${BOUNDS.slowMaxRttMs} (head-of-line blocking)`);
    growth <= BOUNDS.slowMaxRttGrowthMs ? pass(`rtt growth ${growth.toFixed(0)}ms ≤ ${BOUNDS.slowMaxRttGrowthMs}`) : fail(`rtt growth ${growth.toFixed(0)}ms > ${BOUNDS.slowMaxRttGrowthMs} (climbing)`);
    b.disconnects <= BOUNDS.slowMaxDisconnects ? pass(`disconnects ${b.disconnects} ≤ ${BOUNDS.slowMaxDisconnects}`) : fail(`disconnects ${b.disconnects} > ${BOUNDS.slowMaxDisconnects} [${b.reasons.join(',')}]`);
  }

  if (server) server.kill('SIGTERM');
  console.log(`\n${'═'.repeat(56)}`);
  if (failures === 0) { console.log('check-netcode-live: ALL GATES PASSED ✓'); process.exit(0); }
  else { console.log(`check-netcode-live: ${failures} GATE(S) FAILED ✗  (the bug is present)`); process.exit(1); }
}
main().catch((e) => { console.error(e); process.exit(2); });
