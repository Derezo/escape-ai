// prod-wire-probe.mjs — empirical wire capture against a LIVE escape-ai server.
// Measures the two smoking-gun signals for the "movement broken + latency climbing"
// report: (1) does the seq->ack gap grow without bound? (2) does measured rtt climb
// over time even though the network RTT is ~constant? Plus snapshot rate + transport.
//
// Usage: node prod-wire-probe.mjs [url] [durationSec] [injectLatencyMs]
//   node prod-wire-probe.mjs https://escape.mittonvillage.com 30 0
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { io } = require('../client/node_modules/socket.io-client');

const URL = process.argv[2] || 'https://escape.mittonvillage.com';
const DURATION = (Number(process.argv[3]) || 30) * 1000;
const INJECT = Number(process.argv[4]) || 0; // extra ms delay each way (simulate latency)
const SNAP_BLOCK = Number(process.argv[5]) || 0; // ms to busy-block per snapshot (model a slow client)
const NAME = 'probe_' + Math.floor(process.uptime() * 1e6 % 1e6);

const log = (...a) => console.log(...a);
log(`[probe] connecting to ${URL}  name=${NAME}  dur=${DURATION/1000}s  inject=${INJECT}ms/way`);

const socket = io(URL, { transports: ['websocket', 'polling'], autoConnect: true });

let myId, seq = 0, started = 0;
let snapCount = 0, pongCount = 0, disconnects = 0, upgrades = 0;
const ackSamples = [];   // { t, seq, ack, gap }
const rttSamples = [];   // { t, rtt }
let lastAck = 0, present = 0, omitted = 0;

const sendMaybeDelayed = (fn) => INJECT > 0 ? setTimeout(fn, INJECT) : fn();

socket.io.engine?.on?.('upgrade', () => { upgrades++; });
socket.on('connect', () => {
  log(`[probe] connected, transport=${socket.io.engine.transport.name}`);
  socket.emit('auth:login', { username: NAME });
});
const disconnectReasons = [];
let firstDisconnectT = 0;
socket.on('disconnect', (r) => {
  disconnects++; disconnectReasons.push(r);
  if (!firstDisconnectT) firstDisconnectT = now();
  log(`[probe] DISCONNECT #${disconnects} at t=${now()}ms reason="${r}"  <-- engine.io default pingTimeout is 20000ms`);
});
socket.io.on('reconnect', (n) => log(`[probe] RECONNECT after ${n} attempts at t=${now()}ms`));
socket.on('connect_error', (e) => log(`[probe] connect_error: ${e.message}`));

socket.on('auth:result', (msg) => {
  if (!msg.ok) { log(`[probe] auth FAILED: ${msg.reason}`); process.exit(2); }
  log(`[probe] auth ok, joining room`);
  socket.emit('lobby:join', { room: 'default', name: NAME });
});

socket.on('lobby:state', (msg) => {
  if (!myId) { const me = msg.players.find(p => p.name === NAME); if (me) { myId = me.id; log(`[probe] myId=${myId}`); startLoops(); } }
});

let totalSnapBytes = 0, maxEntities = 0, totalEntities = 0, maxAcks = 0;
socket.on('snapshot', (msg) => {
  snapCount++;
  const bytes = JSON.stringify(msg).length;
  totalSnapBytes += bytes;
  const ne = msg.entities?.length || 0;
  totalEntities += ne; if (ne > maxEntities) maxEntities = ne;
  const na = msg.acks ? Object.keys(msg.acks).length : 0;
  if (na > maxAcks) maxAcks = na;
  if (snapCount <= 3 || snapCount % 50 === 0) log(`[snap #${snapCount}] bytes=${bytes} entities=${ne} acks=${na} tick=${msg.tick}`);
  // Model a SLOW client (e.g. Android WebView): busy-block the JS thread per snapshot.
  // This is the decisive reproduction of inbound head-of-line blocking.
  if (SNAP_BLOCK > 0) { const end = Date.now() + SNAP_BLOCK; while (Date.now() < end) { /* spin */ } }
  if (myId && typeof msg.acks?.[myId] === 'number') {
    lastAck = msg.acks[myId];
    ackSamples.push({ t: now(), seq, ack: lastAck, gap: seq - lastAck });
    const inMsg = msg.entities?.some(e => e.id === myId);
    if (inMsg) present++; else omitted++;
  }
});
socket.on('pong', (msg) => {
  pongCount++;
  rttSamples.push({ t: now(), rtt: Date.now() - msg.t });
});

const now = () => Date.now() - started;
let inputTimer, pingTimer;
function startLoops() {
  started = Date.now();
  // 20Hz input — hold East, like a player walking
  inputTimer = setInterval(() => {
    seq += 1;
    const payload = { seq, dx: 1, dy: 0, sprint: false };
    sendMaybeDelayed(() => socket.volatile.emit('input', payload));
  }, 50);
  // 1Hz ping exactly like client.ts
  pingTimer = setInterval(() => {
    const payload = { t: Date.now() };
    sendMaybeDelayed(() => socket.volatile.emit('ping', payload));
  }, 1000);
  setTimeout(finish, DURATION);
}

function finish() {
  clearInterval(inputTimer); clearInterval(pingTimer);
  const dur = now() / 1000;
  log(`\n========== RESULTS (${dur.toFixed(1)}s) ==========`);
  log(`transport=${socket.io?.engine?.transport?.name}  upgrades=${upgrades}  disconnects=${disconnects}  reasons=[${disconnectReasons.join(', ')}]`);
  if (firstDisconnectT) log(`  *** FIRST DISCONNECT at t=${firstDisconnectT}ms — if reason="ping timeout" and t≈20000ms, the "~20s" IS the engine.io heartbeat, not RTT ***`);
  log(`snapBlock=${SNAP_BLOCK}ms/snap`);
  log(`snapshots=${snapCount} (${(snapCount/dur).toFixed(1)}/s)  pongs=${pongCount}  present=${present} omitted=${omitted}`);
  log(`snap PAYLOAD: total=${(totalSnapBytes/1024).toFixed(0)}KB  avg=${(totalSnapBytes/Math.max(1,snapCount)).toFixed(0)}B/snap  ${(totalSnapBytes/1024/dur).toFixed(1)}KB/s`);
  log(`entities/snap: avg=${(totalEntities/Math.max(1,snapCount)).toFixed(1)} max=${maxEntities}  acks-keys max=${maxAcks}`);
  log(`inputs sent: seq=${seq}`);
  // seq-ack gap over time — does it GROW?
  if (ackSamples.length) {
    const buckets = bucketize(ackSamples, 5, s => s.gap);
    log(`\nseq-ack GAP over time (5 buckets, mean): ${buckets.map(b=>b.toFixed(1)).join(' -> ')}`);
    log(`  final gap=${ackSamples.at(-1).gap}  (seq=${ackSamples.at(-1).seq} ack=${ackSamples.at(-1).ack})  max=${Math.max(...ackSamples.map(s=>s.gap))}`);
    log(`  VERDICT: ${buckets.at(-1) > buckets[0] * 2 + 3 ? 'GAP IS GROWING — ack falling behind (smoking gun)' : 'gap bounded — ack keeps up'}`);
  }
  // rtt over time — does it CLIMB?
  if (rttSamples.length) {
    const rb = bucketize(rttSamples, 5, s => s.rtt);
    log(`\nrtt over time (5 buckets, mean ms): ${rb.map(b=>b.toFixed(0)).join(' -> ')}`);
    log(`  first=${rttSamples[0].rtt}ms  last=${rttSamples.at(-1).rtt}ms  max=${Math.max(...rttSamples.map(s=>s.rtt))}ms`);
    log(`  VERDICT: ${rb.at(-1) > rb[0] * 2 + 50 ? 'RTT IS CLIMBING — real backpressure, NOT a display artifact' : 'rtt bounded'}`);
  }
  socket.disconnect();
  process.exit(0);
}
function bucketize(samples, n, f) {
  const out = []; const per = Math.ceil(samples.length / n);
  for (let i = 0; i < samples.length; i += per) {
    const slice = samples.slice(i, i + per);
    out.push(slice.reduce((a, s) => a + f(s), 0) / slice.length);
  }
  return out;
}
setTimeout(() => { log('[probe] TIMEOUT — never reached play state'); process.exit(3); }, DURATION + 15000);
