import { readFile, writeFile, rm, mkdir, readdir } from 'node:fs/promises';
import { existsSync, watch } from 'node:fs';
import path from 'node:path';

import { openSessions, alive } from './sessions.mjs';
import { openDb, appendEvent } from './db.mjs';

/**
 * The bookkeeper.
 *
 * Everything else here runs because somebody started it and stops when they stop
 * looking. That is fine for a review and useless for the state around it: a
 * window dies mid-round and its tasks stay claimed by a process that no longer
 * exists; a session ends and its pointer file sits there for a week; edits land
 * while nobody is watching and nothing records that they did.
 *
 * So this is deliberately the dullest thing in the project. It notices, it
 * writes down, and it does nothing else. It never opens a browser and never
 * edits a file — a background process that can put a window on your screen or
 * change your code is a different and much larger promise than the one being
 * made here.
 */

export const PID_FILE = (projectDir) => path.join(projectDir, '.ayna', 'watchd.pid');

/*
  Our own output changes constantly; so does anything generated. Watching those
  would mean reporting that edits landed every time a screenshot was written.
*/
const SKIP_DIRS = new Set([
  'node_modules', '.git', '.ayna', '.next', '.nuxt', '.svelte-kit', '.output',
  '.turbo', '.cache', '.parcel-cache', 'dist', 'build', 'out', 'coverage',
  'vendor', '__pycache__',
]);
const TEXT_EXT = new Set([
  '.html', '.htm', '.css', '.scss', '.sass', '.less', '.js', '.jsx', '.mjs', '.cjs',
  '.ts', '.tsx', '.vue', '.svelte', '.astro', '.php', '.erb', '.hbs', '.ejs',
]);

/** Who holds the pidfile, if anyone still does. */
export async function running(projectDir) {
  const file = PID_FILE(projectDir);
  if (!existsSync(file)) return null;
  const pid = Number((await readFile(file, 'utf8').catch(() => '')).trim());
  if (!pid || !alive(pid)) {
    // A pidfile left by something that crashed is not a running daemon.
    await rm(file, { force: true }).catch(() => {});
    return null;
  }
  return pid;
}

/**
 * The loop, importable and injectable so it can be tested without a process
 * wrapper — the pattern the rest of this project's long-running code follows,
 * because a `node --test` run cannot drive a command that never returns.
 */
export async function watchLoop({
  projectDir,
  intervalMs = 15_000,
  signal,
  onEvent = () => {},
  now = () => Date.now(),
} = {}) {
  const sessions = await openSessions(projectDir);
  const db = sessions.db;
  let stopped = false;
  const stop = () => {
    stopped = true;
  };
  signal?.addEventListener('abort', stop, { once: true });

  /*
    Edits land whether or not a window is open, and a round that was answered
    while nobody was watching should still be on the record. The recursive watch
    is best-effort: platforms that lack it simply contribute nothing here.
  */
  let editedAt = 0;
  let watcher = null;
  try {
    watcher = watch(projectDir, { recursive: true }, (_e, name) => {
      if (!name) return;
      const parts = String(name).split(/[\\/]/);
      if (parts.some((p) => SKIP_DIRS.has(p))) return;
      if (!TEXT_EXT.has(path.extname(String(name)).toLowerCase())) return;
      editedAt = now();
    });
  } catch {
    watcher = null;
  }

  let reportedEditsAt = 0;

  while (!stopped) {
    const swept = sessions.sweep({ now: now() });
    if (swept.sessions || swept.tabs || swept.leases) onEvent({ event: 'swept', ...swept });

    // Say it once per burst, not once per keystroke.
    if (editedAt && now() - editedAt > 3000 && editedAt > reportedEditsAt) {
      reportedEditsAt = editedAt;
      appendEvent(db, { event: 'edits', at: editedAt });
      onEvent({ event: 'edits', at: editedAt });
    }

    await pruneSessionFiles(projectDir).then(
      (n) => n && onEvent({ event: 'pruned', pointers: n }),
      () => {},
    );

    if (stopped) break;
    await new Promise((r) => setTimeout(r, intervalMs));
  }

  watcher?.close();
  return { stop };
}

/**
 * Remove pointer files for processes that are gone.
 *
 * These were never cleaned. Seven accumulated in one project and the newest by
 * modification time — the one every reader trusted — belonged to a process that
 * had been dead for hours.
 */
export async function pruneSessionFiles(projectDir) {
  const dir = path.join(projectDir, '.ayna', 'session');
  if (!existsSync(dir)) return 0;

  let removed = 0;
  for (const name of await readdir(dir).catch(() => [])) {
    const m = /^session-(\d+)\.json$/.exec(name);
    if (!m) continue;
    if (alive(Number(m[1]))) continue;
    await rm(path.join(dir, name), { force: true }).catch(() => {});
    removed += 1;
  }
  return removed;
}

/** Write the pidfile for this process, refusing if somebody already holds it. */
export async function takePidFile(projectDir, pid = process.pid) {
  const held = await running(projectDir);
  if (held) return { ok: false, pid: held };
  await mkdir(path.dirname(PID_FILE(projectDir)), { recursive: true });
  await writeFile(PID_FILE(projectDir), String(pid));
  return { ok: true, pid };
}

export const releasePidFile = (projectDir) => rm(PID_FILE(projectDir), { force: true }).catch(() => {});
