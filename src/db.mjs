import { mkdir } from 'node:fs/promises';
import path from 'node:path';

/**
 * One database for everything that has to outlive a process.
 *
 * The old arrangement kept comments in a per-session directory, tasks in another
 * directory, and delivery in a pipe between two live processes. If either process
 * went away the pipe went with it, and there was nothing to read afterwards to
 * find out what had been missed. Work was written down; the fact that it needed
 * doing was not.
 *
 * So: sessions, tabs, tasks and events in one file, and every state change
 * recorded in the same transaction as the event announcing it. A consumer that
 * starts an hour late asks what happened since sequence N and gets all of it.
 * Screenshots stay on disk — a database is a poor place for a megabyte of PNG —
 * and are referenced by path.
 */

/*
  node:sqlite prints an ExperimentalWarning on first use. Several commands emit
  JSON for other programs to read, and a warning on every invocation is noise in
  everybody's terminal for a fact they cannot act on. Filter that one warning and
  leave every other warning alone.
*/
const emit = process.emit;
process.emit = function (name, data, ...rest) {
  if (
    name === 'warning' &&
    data?.name === 'ExperimentalWarning' &&
    /SQLite/i.test(data?.message ?? '')
  ) {
    return false;
  }
  return emit.call(this, name, data, ...rest);
};

const { DatabaseSync } = await import('node:sqlite');

export const SCHEMA_VERSION = 2;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS sessions (
  id            TEXT PRIMARY KEY,
  tool          TEXT NOT NULL,
  pid           INTEGER,
  project       TEXT,
  started_at    INTEGER NOT NULL,
  heartbeat_at  INTEGER NOT NULL,
  ended_at      INTEGER,
  status        TEXT NOT NULL DEFAULT 'live',
  -- Who is asking, across processes.
  --
  -- pid is whichever short-lived ayna process happened to write the row, so it
  -- identifies an invocation and not an agent. A Claude session runs dozens of
  -- commands and every one of them looked like a brand new participant: a
  -- session row and a tab each, none of them reused. agent_id is stable for the
  -- whole of one Claude/Cursor/Codex run, and agent_pid is that agent's own
  -- process -- the thing whose death actually means the work is abandoned.
  agent_id      TEXT,
  agent_pid     INTEGER
);

CREATE TABLE IF NOT EXISTS tabs (
  id             TEXT PRIMARY KEY,
  url            TEXT,
  out_dir        TEXT,
  opened_by      TEXT REFERENCES sessions(id),
  owner_session  TEXT REFERENCES sessions(id),
  phase          TEXT NOT NULL DEFAULT 'commenting',
  round          INTEGER NOT NULL DEFAULT 0,
  opened_at      INTEGER NOT NULL,
  closed_at      INTEGER
);

CREATE TABLE IF NOT EXISTS tasks (
  id                TEXT PRIMARY KEY,
  tab_id            TEXT REFERENCES tabs(id),
  status            TEXT NOT NULL,
  kind              TEXT,
  comment           TEXT,
  selector          TEXT,
  url               TEXT,
  rect              TEXT,
  styles            TEXT,
  elements          TEXT,
  source_candidates TEXT,
  check_kind        TEXT,
  fingerprint       TEXT,
  legacy_key        TEXT,
  claimed_by        TEXT,
  claim_expires_at  INTEGER,
  verified_at       INTEGER,
  verdict           TEXT,
  -- Fields the store does not model as columns (region, move, fix, source…).
  -- Callers have always been able to hang arbitrary data on a task; losing it
  -- silently on the move to a schema would be worse than a JSON column.
  extra             TEXT,
  created_at        INTEGER NOT NULL,
  updated_at        INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS task_assets (
  task_id  TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  kind     TEXT NOT NULL,
  path     TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS task_history (
  task_id  TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  at       INTEGER NOT NULL,
  status   TEXT NOT NULL,
  note     TEXT
);

CREATE TABLE IF NOT EXISTS events (
  seq         INTEGER PRIMARY KEY AUTOINCREMENT,
  at          INTEGER NOT NULL,
  session_id  TEXT,
  tab_id      TEXT,
  task_id     TEXT,
  event       TEXT NOT NULL,
  payload     TEXT
);

CREATE TABLE IF NOT EXISTS cursors (
  consumer  TEXT PRIMARY KEY,
  seq       INTEGER NOT NULL,
  seen_at   INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS tasks_status ON tasks(status);
CREATE INDEX IF NOT EXISTS tasks_url ON tasks(url);
CREATE INDEX IF NOT EXISTS events_at ON events(at);
CREATE INDEX IF NOT EXISTS assets_task ON task_assets(task_id);
`;

export const dbPath = (projectDir) => path.join(projectDir, '.ayna', 'ayna.db');

/**
 * Open (creating if needed) the database for a project.
 *
 * WAL is the point: an annotate window, a worker and a watcher all read and write
 * this at once, and the default rollback journal locks readers out of the whole
 * file while anyone writes. `busy_timeout` covers the rest — a writer waits its
 * turn rather than throwing SQLITE_BUSY at whoever lost the race.
 */
export async function openDb(projectDir, { file } = {}) {
  const target = file ?? dbPath(projectDir);
  if (target !== ':memory:') await mkdir(path.dirname(target), { recursive: true });

  const db = new DatabaseSync(target);
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA busy_timeout = 5000');
  db.exec('PRAGMA foreign_keys = ON');
  db.exec(SCHEMA);

  migrate(db);
  return db;
}

/**
 * Schema changes, one step at a time.
 *
 * `user_version` was read and then simply stamped with the current number, which
 * is not a migration — it is a note claiming one happened. A database created
 * before a column existed would be marked current and then fail on the first
 * query that used it. Each entry below moves the schema up exactly one version
 * and the loop runs the ones this file has not seen.
 *
 * `CREATE TABLE IF NOT EXISTS` covers new tables on its own, so only changes to
 * tables that already exist need a step here.
 */
/** MIGRATIONS[i] moves the schema from version i to version i + 1. */
const MIGRATIONS = [
  // 0 → 1: the original tables, which CREATE TABLE IF NOT EXISTS has already made.
  () => {},

  // 1 → 2: agent identity, so one agent keeps one session across many processes.
  (db) => {
    const columns = db.prepare('PRAGMA table_info(sessions)').all().map((c) => c.name);
    if (!columns.includes('agent_id')) db.exec('ALTER TABLE sessions ADD COLUMN agent_id TEXT');
    if (!columns.includes('agent_pid')) db.exec('ALTER TABLE sessions ADD COLUMN agent_pid INTEGER');
    db.exec('CREATE INDEX IF NOT EXISTS sessions_agent ON sessions(agent_id)');
  },
];

export function migrate(db) {
  let version = db.prepare('PRAGMA user_version').get()?.user_version ?? 0;
  const applied = [];

  /*
    A database written by a newer ayna must not be migrated backwards, nor have
    its version quietly rewritten to a number this copy prefers. Stop, and let
    whichever query needs a column this build has never heard of be the thing
    that complains — with its own name on the error.
  */
  while (version < SCHEMA_VERSION && typeof MIGRATIONS[version] === 'function') {
    MIGRATIONS[version](db);
    version += 1;
    db.exec(`PRAGMA user_version = ${version}`);
    applied.push(version);
  }
  return applied;
}

/** JSON columns are stored as text; undefined and null both mean "not set". */
export const pack = (value) => (value === undefined || value === null ? null : JSON.stringify(value));
export const unpack = (text, fallback = null) => {
  if (text === null || text === undefined) return fallback;
  try {
    return JSON.parse(text);
  } catch {
    // A malformed column must not take down a listing. Same reasoning as the
    // per-record parse in the file store: lose one field, not the whole store.
    return fallback;
  }
};

/**
 * Append an event.
 *
 * Always call this inside the transaction that made the change it describes. An
 * event without its change is a lie to every consumer; a change without its event
 * is work nobody will ever hear about, which is the failure this whole file
 * exists to prevent.
 */
export function appendEvent(db, { event, sessionId = null, tabId = null, taskId = null, ...payload }) {
  const at = Date.now();
  const info = db
    .prepare('INSERT INTO events (at, session_id, tab_id, task_id, event, payload) VALUES (?, ?, ?, ?, ?, ?)')
    .run(at, sessionId, tabId, taskId, event, pack(payload));
  return Number(info.lastInsertRowid);
}

/** Everything after `seq`, oldest first, flattened back into the event shape. */
export function eventsSince(db, seq = 0, limit = 500) {
  return db
    .prepare('SELECT * FROM events WHERE seq > ? ORDER BY seq ASC LIMIT ?')
    .all(Number(seq) || 0, limit)
    .map((row) => ({
      seq: row.seq,
      at: row.at,
      event: row.event,
      ...(row.session_id ? { sessionId: row.session_id } : {}),
      ...(row.tab_id ? { tabId: row.tab_id } : {}),
      ...(row.task_id ? { taskId: row.task_id } : {}),
      ...unpack(row.payload, {}),
    }));
}

export const latestSeq = (db) => db.prepare('SELECT COALESCE(MAX(seq), 0) AS seq FROM events').get().seq;

/** Where a named consumer had got to. Unknown consumers start from the beginning. */
export const readCursor = (db, consumer) =>
  db.prepare('SELECT seq FROM cursors WHERE consumer = ?').get(consumer)?.seq ?? 0;

export const writeCursor = (db, consumer, seq) =>
  db
    .prepare(
      'INSERT INTO cursors (consumer, seq, seen_at) VALUES (?, ?, ?) ' +
        'ON CONFLICT(consumer) DO UPDATE SET seq = excluded.seq, seen_at = excluded.seen_at',
    )
    .run(consumer, seq, Date.now());

/**
 * Run `fn` in a transaction, rolling back if it throws.
 *
 * node:sqlite has no transaction helper, and the whole event-with-its-change
 * guarantee depends on there being one.
 */
let depth = 0;

export function transact(db, fn) {
  /*
    Nesting has to work.

    SQLite has no nested BEGIN, so an outer transact calling anything that also
    transacts died with "cannot start a transaction within a transaction". The
    rollback was correct, so nothing was ever corrupted — but it is a landmine
    under every future caller, and the composition it forbids (verify inside a
    worker claim, say) is exactly the composition this code wants.

    SAVEPOINT nests. The outermost call still takes a real write transaction, so
    the event-with-its-change guarantee is unchanged; inner calls become
    savepoints that unwind to their own mark and let the outer one decide.
  */
  if (depth > 0) {
    const name = `ayna_sp_${depth}`;
    db.exec(`SAVEPOINT ${name}`);
    depth += 1;
    try {
      const out = fn();
      db.exec(`RELEASE ${name}`);
      return out;
    } catch (err) {
      try {
        db.exec(`ROLLBACK TO ${name}`);
        db.exec(`RELEASE ${name}`);
      } catch {
        // The outer transaction is failing anyway; its rollback is what matters.
      }
      throw err;
    } finally {
      depth -= 1;
    }
  }

  db.exec('BEGIN IMMEDIATE');
  depth = 1;
  try {
    const out = fn();
    db.exec('COMMIT');
    return out;
  } catch (err) {
    try {
      db.exec('ROLLBACK');
    } catch {
      // Rolling back a transaction that already failed to start would mask the
      // real error with a confusing one.
    }
    throw err;
  } finally {
    depth = 0;
  }
}

/**
 * Keep the log from growing forever.
 *
 * Events are append-only and nothing ever removed one: 2000 of them is 200KB, and
 * a project used daily for a year has a great many more. But a log is only
 * useful because a consumer that arrives late can still read it, so pruning by
 * age alone would silently delete the catch-up somebody had not collected yet.
 *
 * So the floor is the lowest cursor any registered consumer holds. Nothing at or
 * above it is ever removed, however old, and `keepMin` keeps a tail for
 * consumers that have no cursor at all.
 */
export function pruneEvents(db, { olderThanMs = 30 * 24 * 60 * 60 * 1000, keepMin = 2000, now = Date.now() } = {}) {
  const cutoffAt = now - olderThanMs;

  const oldest = db.prepare('SELECT MIN(seq) AS seq FROM cursors').get()?.seq;
  const tail = db
    .prepare('SELECT seq FROM events ORDER BY seq DESC LIMIT 1 OFFSET ?')
    .get(keepMin - 1)?.seq;

  // Nothing to do until there are more events than the tail we always keep.
  if (tail === undefined || tail === null) return { removed: 0, floor: null };

  const floor = oldest === null || oldest === undefined ? tail : Math.min(oldest, tail);

  const info = transact(db, () =>
    db.prepare('DELETE FROM events WHERE seq < ? AND at < ?').run(floor, cutoffAt),
  );
  return { removed: Number(info.changes), floor };
}

/**
 * Return the WAL to the main database and shrink it.
 *
 * The write-ahead log keeps its high-water mark, so a busy afternoon leaves
 * several megabytes of -wal sitting next to a much smaller .db for as long as
 * the project exists. TRUNCATE is the only checkpoint mode that gives the space
 * back; it is best-effort because another live reader legitimately blocks it.
 */
export function checkpoint(db) {
  try {
    db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    return true;
  } catch {
    return false;
  }
}
