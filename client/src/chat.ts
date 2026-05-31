/**
 * Global-chat widget (toggle `/` or click the icon) — a collapsible DOM overlay for
 * the room-wide text chat. Mirrors the help/leaderboard overlay idiom (pure DOM + CSS,
 * a small handle, no renderer dependency), bottom-left anchored so it never eats the
 * screen and the game stays playable while collapsed.
 *
 * Two visual modes:
 *   - COLLAPSED: a small icon that GLOWS while there are unread messages. Each
 *     incoming message pops as a 3s bubble, shown one at a time in sequence (a queue
 *     that drains 3s/message — a single self-rescheduling setTimeout chain, no drift).
 *   - EXPANDED: the full panel — every message in a scrollable block + a text input
 *     and Send button. Opening (icon click OR `/`) clears the glow + cancels the
 *     bubble queue (the scroll now shows everything).
 *
 * State is modeled as two orthogonal booleans + a queue — `expanded`, `unread`, and
 * the bubble queue are independent concerns (per the design): the glow tracks "you
 * haven't opened it", independent of the bubble animation.
 *
 * Keyboard contract with main.ts (the careful part):
 *   - `/` opens chat. The widget binds its own window keydown for it; main.ts adds
 *     `/` to its movement-exclusion list so the slash never leaks into walking.
 *   - While the input is FOCUSED, main.ts must freeze movement + skip actions. The
 *     widget exposes `inputFocused` (polled each tick) and calls `onFocusChange` on
 *     the focus/blur edge so main.ts can clear any held keys (a window `blur` does
 *     NOT fire when an input in the same document gains focus, so the held-`w`-sticks
 *     bug is only fixable from this edge callback).
 *   - Enter sends; Escape closes + blurs. The opening `/` is kept out of the input by
 *     deferring focus to the next frame (+ preventDefault + value-clear as insurance).
 */

import type { ChatMessage } from '@shared/net';
import { speciesByKey } from '@shared/species';
import { createSpeciesSprite } from './species-sprite';
import { playSfx } from './audio';

/** How long (ms) each collapsed bubble is held before the next one shows. */
const BUBBLE_MS = 3000;
/** Cap the in-memory message log so a long session can't grow it unbounded. */
const MAX_LOG = 200;
/** Hard cap mirrored from the server (net.ts ChatSend) — trims the input client-side
 *  too so the field can't hold more than the server will accept. */
const MAX_LEN = 256;

/** A chat line plus the client-derived `mine` flag (senderId === our own entity id). */
export type ChatEntry = ChatMessage & { mine: boolean };

export interface ChatHandle {
  /** A message arrived (from the net) — render it per the current mode (see below). */
  addMessage(msg: ChatEntry): void;
  /** Expand the panel: clears glow + bubble queue, focuses the input. Idempotent. */
  open(): void;
  /** Collapse to the icon: blurs the input, re-enables bubbles. Idempotent. */
  close(): void;
  toggle(): void;
  get expanded(): boolean;
  /** True while the chat input holds focus — main.ts polls this every tick to freeze
   *  movement + skip actions while the player is typing. */
  get inputFocused(): boolean;
  /** Tear down listeners/timers/DOM (symmetry; not strictly needed in this SPA). */
  destroy(): void;
}

/** Options for {@link createChat}. */
export interface ChatOptions {
  /** Called to send a message over the wire (wraps net.sendChat). */
  send: (text: string) => void;
  /** Called on the input focus/blur edge. main.ts clears held keys on focus=true so a
   *  movement key held when the input gains focus doesn't "stick". */
  onFocusChange?: (focused: boolean) => void;
}

/** Does the user prefer reduced motion? (Mirrors intro.ts's private helper.) */
function prefersReducedMotion(): boolean {
  return (
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches
  );
}

const WIDGET_HTML = `
  <button id="chat-icon" aria-label="Open chat (press /)" title="Chat (/)">
    <span class="chat-icon-glyph" aria-hidden="true">💬</span>
    <span id="chat-badge" aria-hidden="true"></span>
  </button>
  <div id="chat-bubble" class="chat-bubble" role="status" aria-live="polite"></div>
  <div id="chat-panel" role="dialog" aria-label="Chat">
    <div id="chat-panel-head">
      <span class="chat-title">Chat</span>
      <button id="chat-close" aria-label="Close chat">×</button>
    </div>
    <div id="chat-scroll"></div>
    <form id="chat-form" autocomplete="off">
      <input id="chat-input" type="text" maxlength="${MAX_LEN}" placeholder="Say something…"
             aria-label="Chat message" autocomplete="off" />
      <button id="chat-send" type="submit" aria-label="Send">Send</button>
    </form>
    <p class="chat-hint">enter to send · esc to close · / to open</p>
  </div>
`;

/**
 * Build the chat widget, wire `/`/click to toggle + Esc/× to close, and return a
 * handle. Starts COLLAPSED (just the icon).
 */
export function createChat(opts: ChatOptions): ChatHandle {
  const { send, onFocusChange } = opts;

  const root = document.createElement('div');
  root.id = 'chat-widget';
  if (prefersReducedMotion()) root.classList.add('reduced-motion');
  root.innerHTML = WIDGET_HTML;
  document.body.appendChild(root);

  const iconBtn = root.querySelector<HTMLButtonElement>('#chat-icon')!;
  const badge = root.querySelector<HTMLElement>('#chat-badge')!;
  const bubble = root.querySelector<HTMLElement>('#chat-bubble')!;
  const scroll = root.querySelector<HTMLElement>('#chat-scroll')!;
  const form = root.querySelector<HTMLFormElement>('#chat-form')!;
  const input = root.querySelector<HTMLInputElement>('#chat-input')!;
  const sendBtn = root.querySelector<HTMLButtonElement>('#chat-send')!;

  // --- State (two orthogonal booleans + a queue) -----------------------------
  const log: ChatEntry[] = [];
  let expanded = false;
  let unread = 0;

  // Bubble queue (collapsed only). The head is whatever is currently on screen.
  const bubbleQueue: ChatEntry[] = [];
  let bubbleTimer: ReturnType<typeof setTimeout> | undefined;
  let bubbleShowing = false;

  let chatInputFocused = false;

  // --- Helpers ----------------------------------------------------------------

  const isAtBottom = (): boolean =>
    scroll.scrollHeight - scroll.scrollTop - scroll.clientHeight < 24;

  const scrollToBottom = (): void => {
    scroll.scrollTop = scroll.scrollHeight;
  };

  /** Build one message row. `mine` right-accents it; others get a species sprite. */
  const buildRow = (msg: ChatEntry, animate: boolean): HTMLElement => {
    const row = document.createElement('div');
    row.className = 'chat-row' + (msg.mine ? ' mine' : '');
    if (animate) {
      row.classList.add('chat-row-in');
      row.addEventListener('animationend', () => row.classList.remove('chat-row-in'), { once: true });
    }

    // A small species sprite beside the sender, when the species is known + valid.
    if (msg.senderSpecies && speciesByKey(msg.senderSpecies)) {
      const avatar = createSpeciesSprite(msg.senderSpecies, { size: 20 });
      avatar.classList.add('chat-avatar');
      row.appendChild(avatar);
    }

    const bodyWrap = document.createElement('div');
    bodyWrap.className = 'chat-row-body';
    const who = document.createElement('span');
    who.className = 'chat-who';
    who.textContent = msg.mine ? 'You' : msg.senderName;
    const text = document.createElement('span');
    text.className = 'chat-text';
    text.textContent = msg.text; // textContent — never innerHTML — so a message can't inject markup.
    bodyWrap.append(who, text);
    row.appendChild(bodyWrap);
    return row;
  };

  /** Repaint the whole scroll from the log (used on open). */
  const repaintScroll = (): void => {
    scroll.innerHTML = '';
    if (log.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'chat-empty';
      empty.textContent = 'No messages yet. Say hi!';
      scroll.appendChild(empty);
      return;
    }
    for (const m of log) scroll.appendChild(buildRow(m, false));
  };

  // --- Glow / unread ----------------------------------------------------------

  const applyGlow = (): void => {
    iconBtn.classList.toggle('chat-unread', unread > 0);
    badge.textContent = unread > 99 ? '99+' : String(unread);
    badge.classList.toggle('show', unread > 0);
  };
  const clearGlow = (): void => {
    unread = 0;
    iconBtn.classList.remove('chat-unread');
    badge.classList.remove('show');
  };

  // --- Bubble queue (single self-rescheduling setTimeout chain) ---------------

  const showBubble = (msg: ChatEntry): void => {
    bubble.textContent = '';
    const who = document.createElement('span');
    who.className = 'chat-bubble-who';
    who.textContent = `${msg.senderName}: `;
    const text = document.createElement('span');
    text.textContent = msg.text;
    bubble.append(who, text);
    // Re-trigger the fade-in even when reusing the element: drop .show, force a
    // reflow, re-add .show so the CSS transition replays for each new bubble.
    bubble.classList.remove('show');
    void bubble.offsetWidth; // reflow
    bubble.classList.add('show');
  };
  const hideBubble = (): void => {
    bubble.classList.remove('show');
  };

  const pumpBubbles = (): void => {
    // Re-entrancy guard: a live bubble's timer will call pump() again on expiry.
    if (bubbleShowing || bubbleQueue.length === 0) return;
    const msg = bubbleQueue.shift()!;
    bubbleShowing = true;
    showBubble(msg);
    bubbleTimer = setTimeout(() => {
      bubbleTimer = undefined;
      hideBubble();
      bubbleShowing = false;
      pumpBubbles(); // drain the next, or idle if the queue is empty
    }, BUBBLE_MS);
  };

  const cancelBubbles = (): void => {
    if (bubbleTimer) clearTimeout(bubbleTimer);
    bubbleTimer = undefined;
    bubbleShowing = false;
    bubbleQueue.length = 0;
    hideBubble();
  };

  // --- Focus / input ----------------------------------------------------------

  const focusInput = (): void => {
    input.value = ''; // insurance: the opening '/' never lands here
    input.focus();
  };
  const blurInput = (): void => {
    input.blur();
  };

  input.addEventListener('focus', () => {
    chatInputFocused = true;
    onFocusChange?.(true);
  });
  input.addEventListener('blur', () => {
    chatInputFocused = false;
    onFocusChange?.(false);
  });

  const submit = (): void => {
    const text = input.value.trim();
    input.value = '';
    if (!text) return;
    send(text);
    playSfx('chat_send', 0.5);
    sendBtn.classList.add('pressed');
    sendBtn.addEventListener('animationend', () => sendBtn.classList.remove('pressed'), { once: true });
    // Keep the panel open + input focused so the player can keep chatting.
  };

  form.addEventListener('submit', (e) => {
    e.preventDefault();
    submit();
  });

  // Escape closes from within the input (Enter is the form's submit).
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      handle.close();
    }
  });

  // --- Open / close -----------------------------------------------------------

  const applyOpenClass = (): void => {
    root.classList.toggle('open', expanded);
  };

  const handle: ChatHandle = {
    addMessage(msg) {
      log.push(msg);
      if (log.length > MAX_LOG) log.shift();

      if (expanded) {
        // Looking at it: append, autoscroll only if pinned to bottom, no glow/bubble.
        const wasAtBottom = isAtBottom();
        // Replace the empty-state placeholder on the first real message.
        const placeholder = scroll.querySelector('.chat-empty');
        if (placeholder) placeholder.remove();
        scroll.appendChild(buildRow(msg, true));
        if (wasAtBottom) scrollToBottom();
        if (!msg.mine) playSfx('chat_receive', 0.4);
        return;
      }

      // Collapsed. Your own echoed line isn't "unread" and a bubble of your own
      // text is noise — skip glow/bubble for it.
      if (msg.mine) return;

      unread += 1;
      applyGlow();
      bubbleQueue.push(msg);
      pumpBubbles();
      playSfx('chat_receive', 0.4);
    },

    open() {
      if (expanded) {
        focusInput();
        return;
      }
      expanded = true;
      applyOpenClass();
      clearGlow();      // opening IS the "I've seen it" event
      cancelBubbles();  // the scroll now shows everything; drop in-flight bubbles
      repaintScroll();
      scrollToBottom();
      playSfx('chat_open', 0.5);
      // Defer focus one frame so the '/' that opened us can't be typed into the
      // input, and (mobile) the soft keyboard opens from the real user gesture.
      requestAnimationFrame(focusInput);
    },

    close() {
      if (!expanded) return;
      expanded = false;
      applyOpenClass();
      blurInput(); // releases focus → onFocusChange(false) → movement resumes
    },

    toggle() {
      if (expanded) handle.close();
      else handle.open();
    },

    get expanded() {
      return expanded;
    },
    get inputFocused() {
      return chatInputFocused;
    },

    destroy() {
      cancelBubbles();
      window.removeEventListener('keydown', onKeyDown);
      root.remove();
    },
  };

  // Icon click toggles. (Primary affordance on touch, where there's no '/' key.)
  iconBtn.addEventListener('click', () => handle.toggle());
  root.querySelector('#chat-close')?.addEventListener('click', () => handle.close());

  // `/` opens (mirrors leaderboard.ts's window keydown). Guarded by !expanded &&
  // !inputFocused so pressing `/` while typing inserts a literal slash. main.ts
  // adds `/` to its movement-exclusion list so it never leaks into walking.
  const onKeyDown = (e: KeyboardEvent): void => {
    if (e.key === '/' && !expanded && !chatInputFocused) {
      e.preventDefault();
      handle.open();
    } else if (e.key === 'Escape' && expanded) {
      handle.close();
    }
  };
  window.addEventListener('keydown', onKeyDown);

  return handle;
}
