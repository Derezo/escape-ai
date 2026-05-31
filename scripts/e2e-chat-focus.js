'use strict';

/**
 * Headless-browser regression for the chat-input focus guard.
 *
 * The bug: the help (H), inventory (I), and leaderboard (L) overlays each bind their
 * own window keydown toggle, which fired even while the player was TYPING in the chat
 * input — so typing "this" popped Help (h) and Inventory (i). The fix: each toggle
 * bails when a text field is focused (client/src/dom.ts `isTypingInTextField`).
 *
 * This drives a real Chromium via the DevTools Protocol against a Vite-served harness
 * (client/test/chat-focus-harness.html) that wires the same overlays main.ts does, and
 * asserts:
 *   1. Baseline (no input focused): H / I / L DO toggle their overlays.
 *   2. With the chat input focused: typing "this" leaves Help/Inventory/Leaderboard
 *      CLOSED and the input holds "this".
 *   3. Escape from the input collapses chat AND releases focus (movement resumes).
 *   4. "Click away" (focus a non-editable element) releases focus too, and the H/I/L
 *      toggles work again afterward.
 *
 * Zero-dep: spawns `google-chrome --headless` + the repo's Node 22 built-in WebSocket
 * for CDP, and `npm run dev` for Vite. Run from the repo root: node scripts/e2e-chat-focus.js
 * Exits non-zero on any failed assertion.
 */

const { spawn, spawnSync } = require('child_process');
const path = require('path');
const os = require('os');
const fs = require('fs');
const net = require('net');

const REPO_ROOT = path.join(__dirname, '..');
const CLIENT_DIR = path.join(REPO_ROOT, 'client');

function findChrome() {
  for (const bin of ['google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser']) {
    const r = spawnSync('command', ['-v', bin], { shell: true, encoding: 'utf8' });
    if (r.status === 0 && r.stdout.trim()) return r.stdout.trim();
  }
  return null;
}

function getFreePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitForHttp(url, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url);
      if (res.ok || res.status === 404) return true; // server is up (any reply)
    } catch {
      /* not up yet */
    }
    await sleep(150);
  }
  throw new Error(`timed out waiting for ${url}`);
}

// --- Minimal CDP client over the Node built-in WebSocket -----------------------
class CDP {
  constructor(ws) {
    this.ws = ws;
    this.id = 0;
    this.pending = new Map();
    ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) reject(new Error(JSON.stringify(msg.error)));
        else resolve(msg.result);
      }
    });
  }
  send(method, params = {}) {
    const id = ++this.id;
    this.ws.send(JSON.stringify({ id, method, params }));
    return new Promise((resolve, reject) => this.pending.set(id, { resolve, reject }));
  }
  async evaluate(expression) {
    const r = await this.send('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise: true,
    });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.text + ' :: ' + expression);
    return r.result.value;
  }
  // Dispatch a single character as a keyDown+keyUp pair (text + key + DOM code).
  async typeChar(ch) {
    await this.send('Input.dispatchKeyEvent', {
      type: 'keyDown',
      text: ch,
      key: ch,
      code: 'Key' + ch.toUpperCase(),
      windowsVirtualKeyCode: ch.toUpperCase().charCodeAt(0),
    });
    await this.send('Input.dispatchKeyEvent', {
      type: 'keyUp',
      key: ch,
      code: 'Key' + ch.toUpperCase(),
      windowsVirtualKeyCode: ch.toUpperCase().charCodeAt(0),
    });
  }
  async pressKey(key, code, vk) {
    await this.send('Input.dispatchKeyEvent', { type: 'keyDown', key, code, windowsVirtualKeyCode: vk });
    await this.send('Input.dispatchKeyEvent', { type: 'keyUp', key, code, windowsVirtualKeyCode: vk });
  }
}

let failures = 0;
function assert(cond, label) {
  if (cond) {
    console.log(`  PASS  ${label}`);
  } else {
    console.error(`  FAIL  ${label}`);
    failures++;
  }
}

async function main() {
  const chrome = findChrome();
  if (!chrome) {
    console.error('No Chrome/Chromium binary found — cannot run the headless focus test.');
    process.exit(2);
  }

  const vitePort = await getFreePort();
  const cdpPort = await getFreePort();
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'chat-focus-'));

  // 1) Vite dev server (resolves the @shared alias + serves TS ESM).
  const vite = spawn('npm', ['run', 'dev', '--', '--port', String(vitePort), '--strictPort'], {
    cwd: CLIENT_DIR,
    stdio: 'ignore',
  });

  // 2) Headless Chrome with the DevTools endpoint.
  const chromeProc = spawn(chrome, [
    '--headless=new',
    '--disable-gpu',
    '--no-sandbox',
    '--no-first-run',
    `--remote-debugging-port=${cdpPort}`,
    `--user-data-dir=${userDataDir}`,
    'about:blank',
  ], { stdio: 'ignore' });

  const cleanup = () => {
    try { vite.kill('SIGKILL'); } catch { /* ignore */ }
    try { chromeProc.kill('SIGKILL'); } catch { /* ignore */ }
    try { fs.rmSync(userDataDir, { recursive: true, force: true }); } catch { /* ignore */ }
  };
  process.on('exit', cleanup);

  try {
    const harnessUrl = `http://127.0.0.1:${vitePort}/test/chat-focus-harness.html`;
    await waitForHttp(`http://127.0.0.1:${vitePort}/test/chat-focus-harness.html`, 30000);
    await waitForHttp(`http://127.0.0.1:${cdpPort}/json/version`, 15000);

    // Open a fresh tab on the harness and attach to it.
    const newTab = await (await fetch(
      `http://127.0.0.1:${cdpPort}/json/new?${encodeURIComponent(harnessUrl)}`,
      { method: 'PUT' },
    )).json();
    const ws = new WebSocket(newTab.webSocketDebuggerUrl);
    await new Promise((res, rej) => {
      ws.addEventListener('open', res, { once: true });
      ws.addEventListener('error', rej, { once: true });
    });
    const cdp = new CDP(ws);
    await cdp.send('Runtime.enable');
    await cdp.send('Page.enable');

    // Wait for the harness module to finish wiring.
    const deadline = Date.now() + 20000;
    while (Date.now() < deadline) {
      if (await cdp.evaluate('!!window.__harnessReady')) break;
      await sleep(150);
    }
    if (!(await cdp.evaluate('!!window.__harnessReady'))) throw new Error('harness never became ready');

    // --- 1. Baseline: with NOTHING focused, H / I / L toggle their overlays ----
    console.log('Baseline (no input focused): single-letter toggles fire');
    await cdp.typeChar('h');
    assert(await cdp.evaluate('window.__harness.helpOpen') === true, 'H opens help');
    await cdp.typeChar('h'); // toggle back off
    assert(await cdp.evaluate('window.__harness.helpOpen') === false, 'H closes help');
    await cdp.typeChar('i');
    assert(await cdp.evaluate('window.__harness.inventoryOpen') === true, 'I opens inventory');
    await cdp.typeChar('i');
    assert(await cdp.evaluate('window.__harness.inventoryOpen') === false, 'I closes inventory');
    await cdp.typeChar('l');
    assert(await cdp.evaluate('window.__harness.leaderboardOpen') === true, 'L opens leaderboard');
    await cdp.typeChar('l');
    assert(await cdp.evaluate('window.__harness.leaderboardOpen') === false, 'L closes leaderboard');

    // --- 2. THE BUG: open chat, focus input, type "this" → no overlay fires ----
    console.log('Chat input focused: typing "this" must not trigger H/I/L overlays');
    await cdp.evaluate('window.__harness.openChat()');
    await sleep(60); // open() defers focus one rAF
    assert(await cdp.evaluate('window.__harness.chatInputFocused') === true, 'chat input is focused after open()');
    for (const ch of 'this') await cdp.typeChar(ch);
    assert(await cdp.evaluate('window.__harness.chatInputValue') === 'this', 'input holds the typed text "this"');
    assert(await cdp.evaluate('window.__harness.helpOpen') === false, 'help did NOT open from the "h"');
    assert(await cdp.evaluate('window.__harness.inventoryOpen') === false, 'inventory did NOT open from the "i"');
    assert(await cdp.evaluate('window.__harness.leaderboardOpen') === false, 'leaderboard stayed closed');
    // And a literal 'l' typed in chat stays out of the leaderboard too.
    await cdp.typeChar('l');
    assert(await cdp.evaluate('window.__harness.leaderboardOpen') === false, 'an "l" typed in chat does not open leaderboard');

    // --- 3. Escape collapses chat AND releases focus ---------------------------
    console.log('Escape from the input releases focus (movement resumes)');
    await cdp.pressKey('Escape', 'Escape', 27);
    await sleep(40);
    assert(await cdp.evaluate('window.__harness.chatExpanded') === false, 'Escape collapsed the chat panel');
    assert(await cdp.evaluate('window.__harness.chatInputFocused') === false, 'chat input blurred on Escape');
    assert(await cdp.evaluate('window.__harness.chatFocusedFlag') === false, 'onFocusChange(false) fired → movement resumes');
    // Toggles work again now that focus is released.
    await cdp.typeChar('h');
    assert(await cdp.evaluate('window.__harness.helpOpen') === true, 'H toggles help again after Escape');
    await cdp.typeChar('h');

    // --- 4. Click-away releases focus too --------------------------------------
    console.log('Click-away (focus a non-editable element) releases focus');
    await cdp.evaluate('window.__harness.openChat()');
    await sleep(60);
    assert(await cdp.evaluate('window.__harness.chatInputFocused') === true, 'chat input refocused');
    await cdp.evaluate('window.__harness.focusGameBody()'); // simulate clicking the game
    await sleep(40);
    assert(await cdp.evaluate('window.__harness.chatInputFocused') === false, 'input blurred on click-away');
    assert(await cdp.evaluate('window.__harness.chatFocusedFlag') === false, 'onFocusChange(false) fired on click-away');
    await cdp.typeChar('i');
    assert(await cdp.evaluate('window.__harness.inventoryOpen') === true, 'I toggles inventory again after click-away');

    ws.close();
  } finally {
    cleanup();
    process.off('exit', cleanup);
  }

  console.log('');
  if (failures) {
    console.error(`chat-focus e2e FAILED: ${failures} assertion(s) failed.`);
    process.exit(1);
  }
  console.log('chat-focus e2e: ALL GREEN.');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
