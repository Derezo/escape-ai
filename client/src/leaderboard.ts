/**
 * The leaderboard overlay (toggle L) — a comprehensive, sortable datatable of the
 * top players by every persisted stat plus the server-computed composite score.
 *
 * Mirrors the help/inventory overlay idiom (pure DOM + CSS, a small handle, no
 * renderer dependency), but it's a real datatable: a header row with click-to-sort
 * columns, the top-N rows ranked best-first, the local player's own row highlighted
 * (and pinned at the bottom when it falls outside the top-N so you always see your
 * standing), and an expandable per-species escape breakdown per row.
 *
 * Data flow is request/response, polled while open: opening the panel (and every
 * sort-change click, and a slow poll tick) calls `request(sort)` (which wraps
 * net.requestLeaderboard); the server replies with `leaderboard:data` (rows + your
 * own ranked row + total), which `render()` paints. The SERVER owns the score +
 * rank — this only displays them. The poll stops when the panel closes (no traffic
 * while it's hidden).
 */

import type { LeaderboardMsg, LeaderboardRow, LeaderboardSort } from '@shared/net';
import { SPECIES, speciesByKey } from '@shared/species';
import { createSpeciesSprite } from './species-sprite';
import { isTypingInTextField } from './dom';

/** How often (ms) to re-poll the leaderboard while the panel is OPEN. */
const POLL_INTERVAL_MS = 4000;

export interface LeaderboardHandle {
  show(): void;
  hide(): void;
  toggle(): void;
  get visible(): boolean;
  /** Paint the latest server payload (called from the net `leaderboard:data` handler). */
  render(msg: LeaderboardMsg): void;
}

/**
 * One sortable column: its sort key (matching net.ts LeaderboardSort), the header
 * label + a short header for the narrow datatable, and how to format the value off
 * a row. Every metric cell is right-aligned + tabular-nums via the `lb-num` class.
 */
interface Column {
  key: LeaderboardSort;
  label: string;
  short: string;
  fmt: (r: LeaderboardRow) => string;
}

/** Format a play-time duration (seconds) compactly: "1h 23m", "12m", "45s". */
function formatPlayTime(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m`;
  return `${s}s`;
}

/** Thousands-separated integer, e.g. 18420 → "18,420". */
function commas(n: number): string {
  return Math.round(n).toLocaleString('en-US');
}

/** The datatable columns, in display order. `score` leads (the headline metric). */
const COLUMNS: Column[] = [
  { key: 'score', label: 'Score', short: 'Score', fmt: (r) => commas(r.score) },
  { key: 'escapes', label: 'Escapes', short: 'Esc', fmt: (r) => commas(r.escapes) },
  { key: 'questsCompleted', label: 'Quests', short: 'Quest', fmt: (r) => commas(r.questsCompleted) },
  { key: 'animalsStolen', label: 'Stolen', short: 'Steal', fmt: (r) => commas(r.animalsStolen) },
  { key: 'foodCollected', label: 'Food', short: 'Food', fmt: (r) => commas(r.foodCollected) },
  { key: 'caught', label: 'Caught', short: 'Caught', fmt: (r) => commas(r.caught) },
  { key: 'ordersIssued', label: 'Orders', short: 'Order', fmt: (r) => commas(r.ordersIssued) },
  { key: 'abilitiesUsed', label: 'Abilities', short: 'Abil', fmt: (r) => commas(r.abilitiesUsed) },
  { key: 'games', label: 'Games', short: 'Games', fmt: (r) => commas(r.games) },
  { key: 'playSeconds', label: 'Play time', short: 'Time', fmt: (r) => formatPlayTime(r.playSeconds) },
];

const LEADERBOARD_HTML = `
  <div id="lb-panel">
    <button id="lb-close" aria-label="Close leaderboard">×</button>
    <h2>Leaderboard</h2>
    <p id="lb-meta" class="lb-meta"></p>
    <div id="lb-scroll">
      <table id="lb-table">
        <thead><tr id="lb-head"></tr></thead>
        <tbody id="lb-body"></tbody>
      </table>
    </div>
    <p class="help-hint">press L to close · click a column to sort · click a row for species detail</p>
  </div>
`;

/**
 * Build the leaderboard overlay, wire L to toggle + Esc/× to close, and return a
 * handle. Starts HIDDEN.
 *
 * @param request  called to ask the server for data by sort. Wraps
 *                 net.requestLeaderboard so this module has no NetClient dependency.
 */
export function createLeaderboard(
  request: (sort: LeaderboardSort) => void,
): LeaderboardHandle {
  const overlay = document.createElement('div');
  overlay.id = 'lb-overlay';
  overlay.innerHTML = LEADERBOARD_HTML;
  document.body.appendChild(overlay);

  const headRow = overlay.querySelector<HTMLTableRowElement>('#lb-head')!;
  const body = overlay.querySelector<HTMLElement>('#lb-body')!;
  const meta = overlay.querySelector<HTMLElement>('#lb-meta')!;

  let visible = false;
  let sort: LeaderboardSort = 'score';
  let last: LeaderboardMsg | undefined; // latest payload, for re-paint on UI change
  // Rows the player has expanded (by name) to show the species breakdown. Kept
  // across re-renders so a poll refresh doesn't collapse an open detail row.
  const expanded = new Set<string>();
  let pollTimer: ReturnType<typeof setInterval> | undefined;

  // --- Header (built once; the active-sort caret is restyled per render) -------
  // Rank column first (not sortable — it always reflects the active sort), then
  // the player name, then every metric column.
  const mkTh = (label: string, title: string, sortKey?: LeaderboardSort): HTMLTableCellElement => {
    const th = document.createElement('th');
    th.textContent = label;
    th.title = title;
    if (sortKey) {
      th.classList.add('lb-sortable');
      th.dataset.sort = sortKey;
      th.addEventListener('click', () => setSort(sortKey));
    }
    return th;
  };
  headRow.appendChild(mkTh('#', 'Rank under the active sort'));
  headRow.appendChild(mkTh('Player', 'Player name'));
  for (const c of COLUMNS) headRow.appendChild(mkTh(c.short, c.label, c.key));

  /** Switch the active sort and re-request (the server re-ranks authoritatively). */
  const setSort = (key: LeaderboardSort): void => {
    if (sort === key) return;
    sort = key;
    markActiveHeader();
    request(sort); // server replies with leaderboard:data → render()
  };

  /** Add the active-sort highlight + ▾ caret to the matching header cell. */
  const markActiveHeader = (): void => {
    for (const th of headRow.querySelectorAll<HTMLTableCellElement>('th.lb-sortable')) {
      const on = th.dataset.sort === sort;
      th.classList.toggle('lb-active', on);
      // Strip any prior caret, then add one to the active column.
      const base = (th.textContent ?? '').replace(/\s*▾$/, '');
      th.textContent = on ? `${base} ▾` : base;
    }
  };

  /** Friendly label for a sort key (for the meta line). */
  const labelForSort = (key: LeaderboardSort): string =>
    COLUMNS.find((c) => c.key === key)?.label ?? key;

  /** Build one data row (a <tr>) for a leaderboard entry. `mine` highlights it. */
  const buildRow = (r: LeaderboardRow, mine: boolean): HTMLTableRowElement => {
    const tr = document.createElement('tr');
    tr.className = 'lb-row';
    if (mine) tr.classList.add('lb-mine');

    const rank = document.createElement('td');
    rank.className = 'lb-rank';
    rank.textContent = `${r.rank}`;
    tr.appendChild(rank);

    const name = document.createElement('td');
    name.className = 'lb-name';
    // A small species sprite (last-played) beside the name, when known + valid.
    if (r.lastSpecies && speciesByKey(r.lastSpecies)) {
      name.appendChild(createSpeciesSprite(r.lastSpecies, { size: 22 }));
    }
    const nameLabel = document.createElement('span');
    nameLabel.textContent = r.name + (mine ? ' (you)' : '');
    name.appendChild(nameLabel);
    tr.appendChild(name);

    for (const c of COLUMNS) {
      const td = document.createElement('td');
      td.className = 'lb-num';
      if (c.key === sort) td.classList.add('lb-active-cell');
      td.textContent = c.fmt(r);
      tr.appendChild(td);
    }

    // Click a row to expand/collapse its per-species escape breakdown.
    tr.addEventListener('click', () => {
      if (expanded.has(r.name)) expanded.delete(r.name);
      else expanded.add(r.name);
      repaint();
    });
    return tr;
  };

  /** Build the expandable per-species escape breakdown row for an entry. */
  const buildDetailRow = (r: LeaderboardRow): HTMLTableRowElement => {
    const tr = document.createElement('tr');
    tr.className = 'lb-detail';
    const cell = document.createElement('td');
    cell.colSpan = COLUMNS.length + 2; // rank + name + metrics
    const by = r.escapesBySpecies ?? {};
    const escaped = SPECIES.filter((s) => (by[s.key] ?? 0) > 0);
    if (escaped.length === 0) {
      cell.innerHTML = `<span class="lb-detail-empty">No species escapes recorded yet.</span>`;
    } else {
      const grid = document.createElement('div');
      grid.className = 'lb-detail-grid';
      for (const s of escaped) {
        const c = document.createElement('div');
        c.className = 'lb-detail-cell';
        const cap = document.createElement('span');
        cap.textContent = `${s.label} ×${by[s.key]}`;
        c.append(createSpeciesSprite(s.key, { size: 24 }), cap);
        grid.appendChild(c);
      }
      cell.appendChild(grid);
    }
    tr.appendChild(cell);
    return tr;
  };

  /** Re-paint the table body from the last payload (no network). */
  const repaint = (): void => {
    if (!last) {
      body.innerHTML = `<tr><td class="lb-empty" colspan="${COLUMNS.length + 2}">No scores yet. Be the first to escape!</td></tr>`;
      meta.textContent = '';
      return;
    }
    const youName = last.you?.name;
    const topNames = new Set(last.rows.map((r) => r.name));
    body.innerHTML = '';
    for (const r of last.rows) {
      const mine = !!youName && r.name === youName;
      body.appendChild(buildRow(r, mine));
      if (expanded.has(r.name)) body.appendChild(buildDetailRow(r));
    }
    // Pin the player's own row at the bottom when it's outside the returned top-N,
    // so they can always see their standing. A separator row sets it apart.
    if (last.you && !topNames.has(last.you.name)) {
      const sep = document.createElement('tr');
      sep.className = 'lb-sep';
      const cell = document.createElement('td');
      cell.colSpan = COLUMNS.length + 2;
      cell.textContent = '⋯';
      sep.appendChild(cell);
      body.appendChild(sep);
      body.appendChild(buildRow(last.you, true));
      if (expanded.has(last.you.name)) body.appendChild(buildDetailRow(last.you));
    }
    // Meta line: your rank + the field size.
    if (last.you) {
      meta.textContent = `You are rank ${last.you.rank} of ${last.total} · sorted by ${labelForSort(sort)}`;
    } else {
      meta.textContent = `${last.total} player${last.total === 1 ? '' : 's'} · sorted by ${labelForSort(sort)}`;
    }
  };

  const apply = (): void => {
    overlay.classList.toggle('open', visible);
  };

  /** Start polling the server while the panel is open (and fetch immediately). */
  const startPolling = (): void => {
    stopPolling();
    request(sort);
    pollTimer = setInterval(() => request(sort), POLL_INTERVAL_MS);
  };
  const stopPolling = (): void => {
    if (pollTimer) {
      clearInterval(pollTimer);
      pollTimer = undefined;
    }
  };

  const handle: LeaderboardHandle = {
    show() {
      visible = true;
      apply();
      markActiveHeader();
      startPolling();
    },
    hide() {
      visible = false;
      apply();
      stopPolling();
    },
    toggle() {
      if (visible) handle.hide();
      else handle.show();
    },
    get visible() {
      return visible;
    },
    render(msg) {
      // Ignore a stale reply for a sort we've since changed away from (a sort click
      // mid-poll can race) — the server echoes the sort it ranked by.
      if (msg.sort !== sort) return;
      last = msg;
      repaint();
    },
  };

  // Toggle on L; close on Escape. L is kept out of the movement key set in main.ts
  // (like H/?/I), so it never leaks into walking. BAIL on the toggle while the player
  // is typing in a text field (e.g. chat) so an 'l' in a message doesn't open the
  // leaderboard; Escape still closes an open panel.
  window.addEventListener('keydown', (e) => {
    const key = e.key.toLowerCase();
    if (key === 'l' && !isTypingInTextField()) {
      handle.toggle();
    } else if (key === 'escape' && visible) {
      handle.hide();
    }
  });
  overlay.querySelector('#lb-close')?.addEventListener('click', () => handle.hide());

  return handle;
}
