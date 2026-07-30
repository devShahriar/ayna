import { mkdir, readdir, readFile, writeFile, rename, rm, cp } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';

/**
 * The task store.
 *
 * Everything used to live in the annotate process: the comments, their status,
 * which round we were in. Close the window and it was gone; reload the page and
 * pending approvals vanished. A comment you had not judged simply stopped
 * existing, which is the worst thing a review tool can do.
 *
 * So tasks live on disk and the window is a view of them. One directory per task,
 * holding its record and its images, with relative paths inside so the directory
 * can be moved or copied and still make sense.
 *
 *   .ayna/tasks/task-0007/
 *     task.json
 *     region.png
 *     attached-1.png
 */

export const SCHEMA = 1;

/** open → in_progress → applied → approved, or rejected back to open. */
export const STATUSES = ['open', 'in_progress', 'applied', 'approved', 'rejected'];

/** Anything not yet accepted is still owed work. */
export const isPending = (t) => t.status !== 'approved';

function storeDir(projectDir) {
  return path.join(projectDir, '.ayna', 'tasks');
}

/** Write via a temp file and rename, so a crash can't leave half a record. */
async function writeAtomic(file, text) {
  const tmp = `${file}.${process.pid}.tmp`;
  await writeFile(tmp, text);
  await rename(tmp, file);
}

export async function openStore(projectDir) {
  const dir = storeDir(projectDir);
  await mkdir(dir, { recursive: true });

  const taskDir = (id) => path.join(dir, id);
  const taskFile = (id) => path.join(taskDir(id), 'task.json');

  async function ids() {
    const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
    return entries
      .filter((e) => e.isDirectory() && /^task-\d+$/.test(e.name))
      .map((e) => e.name)
      .sort();
  }

  async function read(id) {
    const raw = await readFile(taskFile(id), 'utf8').catch(() => null);
    if (!raw) return null;
    let t;
    try {
      t = JSON.parse(raw);
    } catch {
      return null; // A corrupt record must not take the whole store down.
    }
    return hydrate(t, taskDir(id));
  }

  /** Absolute paths for callers, relative ones on disk. */
  function hydrate(t, base) {
    return {
      ...t,
      dir: base,
      regionScreenshot: t.regionScreenshot ? path.join(base, t.regionScreenshot) : null,
      attachments: (t.attachments ?? []).map((a) => path.join(base, a)),
    };
  }

  function dehydrate(t) {
    const { dir: _d, ...rest } = t;
    return {
      ...rest,
      regionScreenshot: t.regionScreenshot ? path.basename(t.regionScreenshot) : null,
      attachments: (t.attachments ?? []).map((a) => path.basename(a)),
    };
  }

  async function list(filter = {}) {
    const out = [];
    for (const id of await ids()) {
      const t = await read(id);
      if (!t) continue;
      if (filter.status && t.status !== filter.status) continue;
      if (filter.pending && !isPending(t)) continue;
      if (filter.url && (t.url ?? '').split('#')[0] !== filter.url.split('#')[0]) continue;
      out.push(t);
    }
    return out;
  }

  async function nextId() {
    const existing = await ids();
    const last = existing.length ? Number(existing[existing.length - 1].slice(5)) : 0;
    return `task-${String(last + 1).padStart(4, '0')}`;
  }

  /**
   * `assets` are files to copy in: { regionScreenshot, attachments: [] }. They are
   * copied rather than referenced so a task keeps working after a run directory
   * is cleaned up.
   */
  async function create(data, assets = {}) {
    // A directory that already exists means a parallel writer got there first.
    let id;
    for (let attempt = 0; attempt < 25; attempt++) {
      id = await nextId();
      try {
        await mkdir(taskDir(id), { recursive: false });
        break;
      } catch {
        id = null;
      }
    }
    if (!id) throw new Error('could not allocate a task id');

    const now = new Date().toISOString();
    const record = {
      v: SCHEMA,
      id,
      status: 'open',
      createdAt: now,
      updatedAt: now,
      history: [{ at: now, status: 'open' }],
      ...data,
      regionScreenshot: null,
      attachments: [],
    };

    if (assets.regionScreenshot && existsSync(assets.regionScreenshot)) {
      await cp(assets.regionScreenshot, path.join(taskDir(id), 'region.png'));
      record.regionScreenshot = 'region.png';
    }
    for (const [i, src] of (assets.attachments ?? []).entries()) {
      if (!existsSync(src)) continue;
      const name = `attached-${i + 1}${path.extname(src) || '.png'}`;
      await cp(src, path.join(taskDir(id), name));
      record.attachments.push(name);
    }

    await writeAtomic(taskFile(id), JSON.stringify(record, null, 2));
    return hydrate(record, taskDir(id));
  }

  async function update(id, patch, note) {
    const current = await read(id);
    if (!current) return null;

    const now = new Date().toISOString();
    const next = { ...dehydrate(current), ...patch, updatedAt: now };
    if (patch.status && patch.status !== current.status) {
      next.history = [...(current.history ?? []), { at: now, status: patch.status, ...(note ? { note } : {}) }];
    }
    await writeAtomic(taskFile(id), JSON.stringify(next, null, 2));
    return hydrate(next, taskDir(id));
  }

  async function remove(id) {
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
    };
  }

  return { dir, list, get: read, create, update, remove, stats };
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
  const ledgerFile = path.join(store.dir, '.imported.json');
  let seen;
  try {
    seen = new Set(JSON.parse(await readFile(ledgerFile, 'utf8')));
  } catch {
    // No ledger yet — fall back to whatever is already in the store, so an
    // upgrade from before the ledger existed doesn't duplicate everything.
    seen = new Set((await store.list()).map((t) => t.legacyKey).filter(Boolean));
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
