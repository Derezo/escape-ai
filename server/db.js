'use strict';

/**
 * Persistence layer — synchronous SQLite (better-sqlite3).
 *
 * Username-only accounts with a persisted auth token (Parasite-style): a player
 * claims a free username and the server issues a random-UUID token; a returning
 * client presents that token to restore the session. No passwords, no JWT, no
 * secret — the token IS the credential.
 *
 * Synchronous on purpose: better-sqlite3 is blocking, statements are prepared
 * once at init, and the per-call work is a single indexed lookup or UPDATE — far
 * cheaper than the event-loop overhead of an async driver. The authoritative
 * tick never blocks on the DB because the engine only writes on the rare edge
 * ticks where a stat delta is non-empty (see game/engine.js).
 *
 * All helpers are defensive: any that take a userId no-op on a falsy id or a
 * missing row, so a disconnect/flush after a failed login can never throw.
 */

const fs = require('fs');
const path = require('path');
const { randomUUID } = require('crypto');
const Database = require('better-sqlite3');

const config = require('./config');

const MAX_USERNAME_LEN = 32;

// Module-level singletons, populated by init(). Statements are prepared once so
// every call is a bound execute, not a re-parse.
let db = null;
let stmts = null;

/**
 * Resolve the configured DB path to an absolute location and ensure its parent
 * directory exists. A relative DB_PATH is taken relative to this server dir.
 * @returns {string} absolute DB file path
 */
function resolveDbPath() {
  const configured = config.DB_PATH || './data/escapeai.db';
  const abs = path.isAbsolute(configured)
    ? configured
    : path.join(__dirname, configured);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  return abs;
}

/**
 * Open/create the database, set WAL, create the idempotent schema, and prepare
 * the statements. Explicit (called from index.js at boot, before sockets) so DB
 * failures surface immediately rather than on the first login. Idempotent.
 */
function init() {
  if (db) return db;

  const dbPath = resolveDbPath();
  db = new Database(dbPath);
  db.pragma('journal_mode = WAL');

  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id           TEXT PRIMARY KEY,
      username     TEXT UNIQUE COLLATE NOCASE,
      token        TEXT UNIQUE,
      created_at   TEXT,
      last_seen    TEXT,
      last_species TEXT
    );
    CREATE TABLE IF NOT EXISTS stats (
      user_id        TEXT PRIMARY KEY REFERENCES users(id),
      games          INTEGER DEFAULT 0,
      escapes        INTEGER DEFAULT 0,
      caught         INTEGER DEFAULT 0,
      orders_issued  INTEGER DEFAULT 0,
      abilities_used INTEGER DEFAULT 0,
      play_seconds   INTEGER DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS sessions (
      user_id    TEXT PRIMARY KEY REFERENCES users(id),
      snapshot   TEXT,
      saved_at   TEXT
    );
  `);

  // Animal-collection stat columns. CREATE TABLE IF NOT EXISTS above will NOT add
  // columns to an EXISTING escapeai.db, so migrate in place with guarded ALTERs:
  // ADD COLUMN throws "duplicate column name" once the column exists, which we
  // swallow (idempotent). New flat counters default 0; the by-species breakdown is
  // a JSON TEXT column (not a flat +=x counter — see incStats) defaulting to '{}'.
  const migrate = (ddl) => {
    try {
      db.exec(`ALTER TABLE stats ADD COLUMN ${ddl}`);
    } catch (err) {
      if (!/duplicate column name/i.test(err.message)) throw err;
    }
  };
  migrate('food_collected     INTEGER DEFAULT 0');
  migrate('animals_stolen     INTEGER DEFAULT 0');
  migrate('quests_completed   INTEGER DEFAULT 0');
  migrate("escapes_by_species TEXT DEFAULT '{}'");

  stmts = {
    userByToken: db.prepare('SELECT * FROM users WHERE token = ?'),
    userByUsername: db.prepare('SELECT * FROM users WHERE username = ? COLLATE NOCASE'),
    userById: db.prepare('SELECT * FROM users WHERE id = ?'),
    insertUser: db.prepare(
      'INSERT INTO users (id, username, token, created_at, last_seen, last_species) ' +
      'VALUES (@id, @username, @token, @created_at, @last_seen, @last_species)'
    ),
    insertStats: db.prepare('INSERT INTO stats (user_id) VALUES (?)'),
    statsByUser: db.prepare('SELECT * FROM stats WHERE user_id = ?'),
    touchSeen: db.prepare('UPDATE users SET last_seen = ? WHERE id = ?'),
    setSpecies: db.prepare('UPDATE users SET last_species = ? WHERE id = ?'),
    // Session snapshot (full mid-run state) — UPSERT so the row is created on the
    // first save and overwritten thereafter; read back on the next login to resume.
    saveSession: db.prepare(
      'INSERT INTO sessions (user_id, snapshot, saved_at) VALUES (@userId, @snapshot, @savedAt) ' +
      'ON CONFLICT(user_id) DO UPDATE SET snapshot = @snapshot, saved_at = @savedAt'
    ),
    sessionByUser: db.prepare('SELECT snapshot FROM sessions WHERE user_id = ?')
  };

  console.log(`[db] opened ${dbPath}`);
  return db;
}

/** Lazy-init guard so a helper called before init() still works (tests). */
function ensure() {
  if (!db) init();
}

/**
 * Claim-on-first-use login/restore. See net.ts AuthLogin for the contract.
 *   - token present & found  → restore that account (DB username wins).
 *   - token present, missing → { ok:false, reason:'bad_token' }.
 *   - no token, name free    → create user + issue token.
 *   - no token, name taken   → { ok:false, reason:'name_taken' }.
 *   - empty/over-long name   → { ok:false, reason:'invalid' }.
 *
 * @param {{username?: string, token?: string}} arg
 * @returns {{ok: boolean, reason?: string, user?: object, token?: string, stats?: object}}
 */
function loginOrRegister({ username, token } = {}) {
  ensure();

  const name = typeof username === 'string' ? username.trim() : '';
  const now = new Date().toISOString();

  // Token path: the token is authoritative. Restore the matching account
  // regardless of the supplied username (a returning client may send a stale or
  // different display name; the DB username wins).
  if (typeof token === 'string' && token) {
    const user = stmts.userByToken.get(token);
    if (!user) return { ok: false, reason: 'bad_token' };
    stmts.touchSeen.run(now, user.id);
    user.last_seen = now;
    return { ok: true, user, token: user.token, stats: getStatsForUser(user.id) };
  }

  // No-token path: the username must be free to claim. Validate first.
  if (!name || name.length > MAX_USERNAME_LEN) {
    return { ok: false, reason: 'invalid' };
  }

  const existing = stmts.userByUsername.get(name);
  if (existing) {
    // Owned by someone else and we have no token proof → reject.
    return { ok: false, reason: 'name_taken' };
  }

  // Create a fresh account + seed its (all-zero) stats row.
  const user = {
    id: randomUUID(),
    username: name,
    token: randomUUID(),
    created_at: now,
    last_seen: now,
    last_species: null
  };

  try {
    stmts.insertUser.run(user);
    stmts.insertStats.run(user.id);
  } catch (err) {
    // Translate a UNIQUE-violation race (a concurrent claim landed between our
    // SELECT and INSERT) into the same name_taken result the SELECT would give.
    if (err && /UNIQUE/i.test(err.message)) {
      return { ok: false, reason: 'name_taken' };
    }
    throw err;
  }

  return { ok: true, user, token: user.token, stats: getStatsForUser(user.id) };
}

/**
 * Read a user's stats as a UserStats-shaped plain object (camelCase keys per the
 * net contract). Returns undefined for a falsy or unknown userId.
 * @param {string} userId
 * @returns {object|undefined}
 */
function getStatsForUser(userId) {
  if (!userId) return undefined;
  ensure();
  const user = stmts.userById.get(userId);
  if (!user) return undefined;
  const row = stmts.statsByUser.get(userId) || {};
  let escapesBySpecies = {};
  try {
    escapesBySpecies = JSON.parse(row.escapes_by_species || '{}') || {};
  } catch {
    escapesBySpecies = {}; // corrupt/legacy value → empty rather than throw
  }
  return {
    games: row.games || 0,
    escapes: row.escapes || 0,
    caught: row.caught || 0,
    ordersIssued: row.orders_issued || 0,
    abilitiesUsed: row.abilities_used || 0,
    playSeconds: row.play_seconds || 0,
    foodCollected: row.food_collected || 0,
    animalsStolen: row.animals_stolen || 0,
    questsCompleted: row.quests_completed || 0,
    escapesBySpecies,
    lastSpecies: user.last_species || undefined,
    firstSeen: user.created_at || undefined,
    lastSeen: user.last_seen || undefined
  };
}

// Map camelCase delta keys → snake_case stat columns for the col=col+@key path.
// Only flat INTEGER counters belong here. `escapesBySpecies` is DELIBERATELY absent
// — it is a JSON TEXT column handled by a dedicated read-modify-write branch in
// incStats (a `col = col + @x` against TEXT would be invalid SQL).
const DELTA_COLUMNS = {
  games: 'games',
  escapes: 'escapes',
  caught: 'caught',
  ordersIssued: 'orders_issued',
  abilitiesUsed: 'abilities_used',
  playSeconds: 'play_seconds',
  foodCollected: 'food_collected',
  animalsStolen: 'animals_stolen',
  questsCompleted: 'quests_completed'
};

/**
 * Add the provided deltas to a user's stat counters. Flat counters go in a single
 * col=col+@key UPDATE; the per-species escape breakdown (`escapesBySpecies`, a
 * {species:count} map) is merged into the JSON `escapes_by_species` TEXT column via
 * a read-modify-write. Only present keys are touched; negatives clamp to no effect.
 * No-op on a falsy userId or an empty delta.
 * @param {string} userId
 * @param {{games?, escapes?, caught?, ordersIssued?, abilitiesUsed?, playSeconds?, foodCollected?, animalsStolen?, questsCompleted?, escapesBySpecies?: Record<string,number>}} delta
 */
function incStats(userId, delta) {
  if (!userId || !delta) return;
  ensure();

  // 1) Flat counters: a single additive UPDATE built from the present >0 keys.
  const sets = [];
  const params = {};
  for (const [key, column] of Object.entries(DELTA_COLUMNS)) {
    const raw = Number(delta[key]);
    if (Number.isFinite(raw) && raw > 0) {
      sets.push(`${column} = ${column} + @${key}`);
      params[key] = Math.round(raw);
    }
  }
  if (sets.length > 0) {
    params.userId = userId;
    db.prepare(`UPDATE stats SET ${sets.join(', ')} WHERE user_id = @userId`).run(params);
  }

  // 2) Per-species escapes: merge the {species:count} delta into the JSON column.
  // Read-modify-write (the col=col+@x trick can't sum a JSON map). Only writes when
  // there is something to add, so the common (empty) case touches nothing.
  const bySpecies = delta.escapesBySpecies;
  if (bySpecies && typeof bySpecies === 'object' && Object.keys(bySpecies).length > 0) {
    const row = stmts.statsByUser.get(userId);
    if (row) {
      let merged = {};
      try {
        merged = JSON.parse(row.escapes_by_species || '{}') || {};
      } catch {
        merged = {}; // corrupt/legacy value → start fresh rather than throw
      }
      for (const [species, count] of Object.entries(bySpecies)) {
        const n = Number(count);
        if (Number.isFinite(n) && n > 0) merged[species] = (merged[species] || 0) + Math.round(n);
      }
      db.prepare('UPDATE stats SET escapes_by_species = @json WHERE user_id = @userId')
        .run({ json: JSON.stringify(merged), userId });
    }
  }
}

/**
 * Record the species a user last played. No-op unless `species` is a non-empty
 * string (and the user exists).
 * @param {string} userId
 * @param {string} species
 */
function setLastSpecies(userId, species) {
  if (!userId || typeof species !== 'string' || !species) return;
  ensure();
  stmts.setSpecies.run(species, userId);
}

/**
 * Persist a user's full mid-run session snapshot (species, position, quest,
 * inventory, scoreTotal, the room + its worldVersion) so a rejoin can resume it.
 * The snapshot is an opaque plain object serialized to JSON TEXT — its shape is
 * owned by the caller (server/game session helper). No-op on a falsy userId or a
 * non-object snapshot. UPSERT: one row per user, overwritten each save.
 * @param {string} userId
 * @param {object} snapshot
 */
function saveSession(userId, snapshot) {
  if (!userId || !snapshot || typeof snapshot !== 'object') return;
  ensure();
  stmts.saveSession.run({
    userId,
    snapshot: JSON.stringify(snapshot),
    savedAt: new Date().toISOString()
  });
}

/**
 * Load a user's saved session snapshot, or undefined if none/corrupt. The caller
 * is responsible for validating the snapshot (e.g. worldVersion match) before
 * trusting any positions in it.
 * @param {string} userId
 * @returns {object|undefined}
 */
function loadSession(userId) {
  if (!userId) return undefined;
  ensure();
  const row = stmts.sessionByUser.get(userId);
  if (!row || !row.snapshot) return undefined;
  try {
    const snap = JSON.parse(row.snapshot);
    return snap && typeof snap === 'object' ? snap : undefined;
  } catch {
    return undefined; // corrupt/legacy value → no resume rather than throw
  }
}

/** Bump a user's last_seen to now. No-op on a falsy userId. */
function touchLastSeen(userId) {
  if (!userId) return;
  ensure();
  stmts.touchSeen.run(new Date().toISOString(), userId);
}

/** Convenience: increment a user's session count (games) by one. */
function incGames(userId) {
  incStats(userId, { games: 1 });
}

/** Close the database (clean shutdown). Safe to call when never opened. */
function close() {
  if (db) {
    db.close();
    db = null;
    stmts = null;
  }
}

module.exports = {
  init,
  loginOrRegister,
  getStatsForUser,
  incStats,
  setLastSpecies,
  saveSession,
  loadSession,
  touchLastSeen,
  incGames,
  close
};
