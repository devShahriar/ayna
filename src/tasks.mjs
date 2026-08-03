import { mkdir, readdir, readFile, writeFile, rm, cp } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';

import { openDb, appendEvent, pack, unpack, transact } from './db.mjs';

/**
 * The task store.
 *
 * Everything used to live in the annotate process: the comments, their status,
 * which round we were in. Close the window and it was gone; reload the page and
 * pending approvals vanished. A comment you had not judged simply stopped
 * existing, which is the worst thing a review tool can do.
 *
 * So tasks live outside the window. Records are rows now rather than one JSON
 * file per directory — several windows, a worker and a watcher all write this at
 * once, and "read, merge, rename" across processes loses updates whenever two of
 * them touch the same task. The images stay exactly where they were:
 *
 *   .ayna/tasks/task-0007/
 *     region.png
 *     attached-1.png
 *
 * so an existing store keeps working, and a task directory is still something you
 * can look inside.
 */

export const SCHEMA = 2;

/*
  proposed → open → in_progress → applied → approved, or rejected back to open.

  `proposed` is the one that keeps Claude honest: a fault it found itself is a
  suggestion, not permission. Nothing is edited until the user says so, or until
  they redirect it with a comment of their own.

  `obsolete` and `needs_confirmation` come from re-checking a task before working
  it. A measured fault that no longer reproduces was fixed by somebody — there is
  nothing left to do and nobody needs to read it. Anything asked for in words
  cannot be measured, so a changed element only earns a question, never a closure.
*/
export const STATUSES = [
  'proposed',
  'open',
  'in_progress',
  'applied',
  'approved',
  'rejected',
  'needs_confirmation',
  'obsolete',
];

/** Raised by Claude and still waiting on the user's word. */
export const isProposal = (t) => t.status === 'proposed';

/** Nothing left to do: accepted, or verified gone. */
const SETTLED = new Set(['approved', 'obsolete']);

/** Anything not yet settled is still owed work. */
export const isPending = (t) => !SETTLED.has(t.status);

const storeDir = (projectDir) => path.join(projectDir, '.ayna', 'tasks');

/** Columns that are their own field; everything else rides in `extra`. */
const COLUMNS = new Set([
  'tab_id', 'status', 'kind', 'comment', 'selector', 'url', 'rect', 'styles',
  'elements', 'source_candidates', 'check_kind', 'fingerprint', 'legacy_key',
  'claimed_by', 'claim_expires_at', 'verified_at', 'verdict',
]);

const CAMEL = {
  tabId: 'tab_id', sourceCandidates: 'source_candidates', checkKind: 'check_kind',
  legacyKey: 'legacy_key', claimedBy: 'claimed_by', claimExpiresAt: 'claim_expires_at',
  verifiedAt: 'verified_at',
};

export async function openStore(projectDir, { db: given } = {}) {
  const dir = storeDir(projectDir);
  await mkdir(dir, { recursive: true });
  const db = given ?? (await openDb(projectDir));

  const taskDir = (id) => path.join(dir, id);

  /** Absolute paths for callers, relative ones on disk. */
  function hydrate(row) {
    if (!row) return null;
    const base = taskDir(row.id);
    const assets = db.prepare('SELECT kind, path FROM task_assets WHERE task_id = ?').all(row.id);
    const region = assets.find((a) => a.kind === 'region');
    return {
      v: SCHEMA,
      id: row.id,
      dir: base,
      status: row.status,
      kind: row.kind,
      comment: row.comment,
      selector: row.selector,
      url: row.url,
      rect: unpack(row.rect),
      styles: unpack(row.styles, {}),
      elements: unpack(row.elements, []),
      sourceCandidates: unpack(row.source_candidates, []),
      checkKind: row.check_kind,
      fingerprint: unpack(row.fingerprint),
      legacyKey: row.legacy_key,
      tabId: row.tab_id,
      claimedBy: row.claimed_by,
      claimExpiresAt: row.claim_expires_at,
      verifiedAt: row.verified_at,
      verdict: unpack(row.verdict),
      createdAt: new Date(row.created_at).toISOString(),
      updatedAt: new Date(row.updated_at).toISOString(),
      history: db
        .prepare('SELECT at, status, note FROM task_history WHERE task_id = ? ORDER BY at ASC, rowid ASC')
        .all(row.id)
        .map((h) => ({ at: new Date(h.at).toISOString(), status: h.status, ...(h.note ? { note: h.note } : {}) })),
      regionScreenshot: region ? path.join(base, region.path) : null,
      attachments: assets.filter((a) => a.kind === 'attachment').map((a) => path.join(base, a.path)),
      ...unpack(row.extra, {}),
    };
  }

  const read = async (id) => hydrate(db.prepare('SELECT * FROM tasks WHERE id = ?').get(id));

  async function list(filter = {}) {
    const rows = db.prepare('SELECT * FROM tasks ORDER BY id ASC').all();
    const out = [];
    for (const row of rows) {
      const t = hydrate(row);
      if (!t) continue;
      if (filter.status && t.status !== filter.status) continue;
      if (filter.pending && !isPending(t)) continue;
      if (filter.url && (t.url ?? '').split('#')[0] !== filter.url.split('#')[0]) continue;
      out.push(t);
    }
    return out;
  }

  const JSON_COLUMNS = ['rect', 'styles', 'elements', 'source_candidates', 'fingerprint', 'verdict'];

  /*
    SQLite will not bind `undefined` or a boolean, and callers pass both — a
    comment with no selector, a flag on a proposal. The file store simply wrote
    them out, so this is the one place the move to columns can break a caller that
    was previously fine. Coerce at the boundary rather than making every call site
    remember.
  */
  const bindable = (value) => {
    if (value === undefined || value === null) return null;
    if (typeof value === 'boolean') return value ? 1 : 0;
    if (typeof value === 'object') return pack(value);
    return value;
  };

  /** Split caller data into real columns and the rest. */
  function split(data) {
    const cols = {};
    const extra = {};
    for (const [key, value] of Object.entries(data ?? {})) {
      const col = CAMEL[key] ?? key;
      if (COLUMNS.has(col)) {
        cols[col] = JSON_COLUMNS.includes(col) ? pack(value) : bindable(value);
      } else if (!['id', 'v', 'dir', 'createdAt', 'updatedAt', 'history', 'regionScreenshot', 'attachments'].includes(key)) {
        extra[key] = value;
      }
    }
    return { cols, extra };
  }

  /**
   * `assets` are files to copy in: { regionScreenshot, attachments: [] }. They are
   * copied rather than referenced so a task keeps working after a run directory
   * is cleaned up.
   */
  async function create(data, assets = {}) {
    const { cols, extra } = split(data);
    const now = Date.now();

    // The id and the row are allocated together, so two writers cannot pick the
    // same number — the retry loop the directory-based store needed is gone.
    const id = transact(db, () => {
      const last = db.prepare("SELECT id FROM tasks ORDER BY id DESC LIMIT 1").get()?.id;
      const next = `task-${String((last ? Number(last.slice(5)) : 0) + 1).padStart(4, '0')}`;
      const status = cols.status ?? 'open';
      const keys = ['id', 'created_at', 'updated_at', 'extra', ...Object.keys(cols)];
      const values = [next, now, now, pack(extra), ...Object.values(cols)];
      if (!('status' in cols)) {
        keys.push('status');
        values.push(status);
      }
      db.prepare(`INSERT INTO tasks (${keys.join(', ')}) VALUES (${keys.map(() => '?').join(', ')})`).run(...values);
      db.prepare('INSERT INTO task_history (task_id, at, status) VALUES (?, ?, ?)').run(next, now, status);
      appendEvent(db, { event: 'task', taskId: next, status, comment: cols.comment ?? null, url: cols.url ?? null });
      return next;
    });

    await mkdir(taskDir(id), { recursive: true });
    if (assets.regionScreenshot && existsSync(assets.regionScreenshot)) {
      await cp(assets.regionScreenshot, path.join(taskDir(id), 'region.png'));
      db.prepare('INSERT INTO task_assets (task_id, kind, path) VALUES (?, ?, ?)').run(id, 'region', 'region.png');
    }
    for (const [i, src] of (assets.attachments ?? []).entries()) {
      if (!existsSync(src)) continue;
      const name = `attached-${i + 1}${path.extname(src) || '.png'}`;
      await cp(src, path.join(taskDir(id), name));
      db.prepare('INSERT INTO task_assets (task_id, kind, path) VALUES (?, ?, ?)').run(id, 'attachment', name);
    }
    return read(id);
  }

  async function update(id, patch, note) {
    const current = db.prepare('SELECT * FROM tasks WHERE id = ?').get(id);
    if (!current) return null;

    const { cols, extra } = split(patch);
    const now = Date.now();
    transact(db, () => {
      const merged = { ...unpack(current.extra, {}), ...extra };
      const sets = [...Object.keys(cols).map((c) => `${c} = ?`), 'extra = ?', 'updated_at = ?'];
      db.prepare(`UPDATE tasks SET ${sets.join(', ')} WHERE id = ?`).run(
        ...Object.values(cols),
        pack(merged),
        now,
        id,
      );
      if (patch.status && patch.status !== current.status) {
        db.prepare('INSERT INTO task_history (task_id, at, status, note) VALUES (?, ?, ?, ?)').run(
          id, now, patch.status, note ?? null,
        );
        appendEvent(db, { event: 'task', taskId: id, status: patch.status, ...(note ? { note } : {}) });
      }
    });
    return read(id);
  }

  /**
   * Take a task, or find someone else already has it.
   *
   * A single conditional UPDATE is the whole mechanism: whoever's write lands
   * first owns it, and the loser is told plainly rather than quietly doing the
   * same work twice. The lease expires so a worker that dies does not take the
   * task with it.
   */
  async function claim(id, owner, { leaseMs = 10 * 60 * 1000 } = {}) {
    const now = Date.now();
    const won = transact(db, () => {
      const info = db
        .prepare(
          'UPDATE tasks SET claimed_by = ?, claim_expires_at = ? ' +
            'WHERE id = ? AND (claimed_by IS NULL OR claim_expires_at < ?)',
        )
        .run(owner, now + leaseMs, id, now);
      if (info.changes) appendEvent(db, { event: 'claimed', taskId: id, by: owner });
      return info.changes > 0;
    });
    return won ? read(id) : null;
  }

  async function release(id) {
    db.prepare('UPDATE tasks SET claimed_by = NULL, claim_expires_at = NULL WHERE id = ?').run(id);
    return read(id);
  }

  async function remove(id) {
    transact(db, () => {
      db.prepare('DELETE FROM task_assets WHERE task_id = ?').run(id);
      db.prepare('DELETE FROM task_history WHERE task_id = ?').run(id);
      db.prepare('DELETE FROM tasks WHERE id = ?').run(id);
    });
    await rm(taskDir(id), { recursive: true, force: true });
  }

  async function stats() {
    const all = await list();
    const by = (s) => all.filter((t) => t.status === s).length;
    return {
      total: all.length,
      pending: all.filter(isPending).length,
      open: by('open'),
      in_progress: by('in_progress'),
      applied: by('applied'),
      approved: by('approved'),
      rejected: by('rejected'),
      needs_confirmation: by('needs_confirmation'),
      obsolete: by('obsolete'),
    };
  }

  await migrateFromFiles(db, dir);

  return { dir, db, list, get: read, create, update, claim, release, remove, stats };
}

/**
 * Adopt task directories written by the file store.
 *
 * Runs on every open and does nothing once there is nothing left to adopt. An
 * upgrade must not be a thing the user has to know about, and least of all one
 * that loses the work they have not judged yet.
 */
export async function migrateFromFiles(db, dir) {
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
  let adopted = 0;

  for (const entry of entries) {
    if (!entry.isDirectory() || !/^task-\d+$/.test(entry.name)) continue;
    const file = path.join(dir, entry.name, 'task.json');
    if (!existsSync(file)) continue;
    if (db.prepare('SELECT 1 FROM tasks WHERE id = ?').get(entry.name)) continue;

    let t;
    try {
      t = JSON.parse(await readFile(file, 'utf8'));
    } catch {
      continue; // A corrupt record must not stop the rest being adopted.
    }

    const at = Date.parse(t.createdAt) || Date.now();
    transact(db, () => {
      db.prepare(
        'INSERT INTO tasks (id, status, kind, comment, selector, url, rect, styles, elements, ' +
          'source_candidates, legacy_key, extra, created_at, updated_at) ' +
          'VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
      ).run(
        t.id ?? entry.name, t.status ?? 'open', t.kind ?? null, t.comment ?? null, t.selector ?? null,
        t.url ?? null, pack(t.rect), pack(t.styles ?? {}), pack(t.elements ?? []),
        pack(t.sourceCandidates ?? []), t.legacyKey ?? null,
        pack({ region: t.region ?? null, move: t.move ?? null, fix: t.fix ?? null, source: t.source ?? null }),
        at, Date.parse(t.updatedAt) || at,
      );
      for (const h of t.history ?? []) {
        db.prepare('INSERT INTO task_history (task_id, at, status, note) VALUES (?,?,?,?)').run(
          entry.name, Date.parse(h.at) || at, h.status, h.note ?? null,
        );
      }
      if (t.regionScreenshot) {
        db.prepare('INSERT INTO task_assets (task_id, kind, path) VALUES (?,?,?)').run(
          entry.name, 'region', path.basename(t.regionScreenshot),
        );
      }
      for (const a of t.attachments ?? []) {
        db.prepare('INSERT INTO task_assets (task_id, kind, path) VALUES (?,?,?)').run(
          entry.name, 'attachment', path.basename(a),
        );
      }
    });
    adopted += 1;
  }
  return adopted;
}

/**
 * Pull comments out of the pre-store format so work captured before any of this
 * existed is not stranded. Idempotent: a manifest already imported is skipped.
 */
export async function importLegacy(projectDir, store) {
  const root = path.join(projectDir, '.ayna', 'comments');
  if (!existsSync(root)) return { imported: 0, sessions: 0 };

  /*
    The ledger, not the live tasks, decides what has already been adopted.

    Deduping against existing tasks meant deleting one let the next read import it
    straight back — a task you had deliberately removed reappeared, and there was
    no way to get rid of it. What has been imported is a fact about the past, so
    it is recorded separately and survives deletion.
  */
  /*
    Outside the task directory on purpose. Keeping it inside meant clearing tasks
    also cleared the record of what had been adopted, so deleted comments came
    straight back on the next read — the ledger has to outlive the thing it
    protects.
  */
  const ledgerFile = path.join(projectDir, '.ayna', 'imported.json');
  const legacyLedger = path.join(store.dir, '.imported.json');
  let seen;
  try {
    seen = new Set(JSON.parse(await readFile(ledgerFile, 'utf8')));
  } catch {
    try {
      // Carry over a ledger written by the previous location.
      seen = new Set(JSON.parse(await readFile(legacyLedger, 'utf8')));
    } catch {
      seen = null;
    }
  }
  if (!seen) seen = new Set();

  /*
    Union the ledger with the keys tasks already carry.

    The ledger alone was enough while comments only ever reached the store
    through this function. Now the window writes them as they are made and
    claims their key, so a manifest scraped afterwards must not adopt them
    again. Deleting a task still cannot resurrect it: its key stays in the
    ledger, which is the whole reason the ledger lives outside the store.
  */
  try {
    for (const t of await store.list()) if (t.legacyKey) seen.add(t.legacyKey);
  } catch {
    // A store that will not list is a bigger problem than a duplicate import.
  }

  let imported = 0;
  let sessions = 0;
  for (const entry of await readdir(root, { withFileTypes: true }).catch(() => [])) {
    if (!entry.isDirectory()) continue;
    const manifest = path.join(root, entry.name, 'comments.json');
    if (!existsSync(manifest)) continue;

    let data;
    try {
      data = JSON.parse(await readFile(manifest, 'utf8'));
    } catch {
      continue;
    }
    sessions += 1;

    for (const c of data.comments ?? []) {
      const key = `${entry.name}#${c.id ?? c.n}`;
      if (seen.has(key)) continue;
      // Old records used 'resolved'; the store's terminal state is 'approved'.
      const status = c.status === 'resolved' ? 'approved' : c.status === 'rejected' ? 'rejected' : 'open';
      await store.create(
        {
          legacyKey: key,
          status,
          url: c.url ?? data.url,
          kind: c.kind ?? 'comment',
          comment: c.comment,
          selector: c.selector,
          elements: c.elements ?? [],
          region: c.region ?? null,
          move: c.move ?? null,
          rect: c.rect ?? null,
          styles: c.styles ?? {},
          sourceCandidates: c.sourceCandidates ?? [],
        },
        { regionScreenshot: c.regionScreenshot, attachments: c.attachments ?? [] },
      );
      seen.add(key);
      imported += 1;
    }
  }

  await writeFile(ledgerFile, JSON.stringify([...seen], null, 2)).catch(() => {});
  return { imported, sessions };
}
