import { watch } from 'node:fs';
import { existsSync } from 'node:fs';

import { openStore, isPending } from './tasks.mjs';

/**
 * Announce work that needs doing, for as long as it needs doing.
 *
 * Until now delivery rode on the annotate process: close the window and tasks sat
 * in the store with nothing to say so. This watches the store itself, so a task
 * raised in a session that has since ended is still announced to the next one —
 * the queue outlives whatever created it.
 *
 * Emits one event per change. Run it under a monitor and each becomes a
 * notification; there is nothing to poll and nothing to re-arm.
 */
export async function watchTasks({ projectDir, onEvent, signal, intervalMs = 1500 }) {
  const store = await openStore(projectDir);

  // What we have already spoken about, so a change speaks once.
  const announced = new Map();
  let stopped = false;

  const scan = async (initial = false) => {
    if (stopped) return;
    const tasks = await store.list().catch(() => []);
    const pending = tasks.filter(isPending);

    if (initial) {
      for (const t of tasks) announced.set(t.id, t.status);
      onEvent({
        event: 'ready',
        pending: pending.length,
        total: tasks.length,
        // Say what is owed up front: a session starting with work already waiting
        // should know before the user has to ask why nothing happened.
        tasks: pending.map((t) => ({ id: t.id, status: t.status, comment: t.comment, url: t.url })),
      });
      return;
    }

    for (const t of tasks) {
      const was = announced.get(t.id);
      if (was === t.status) continue;
      announced.set(t.id, t.status);

      if (was === undefined && t.status === 'open') {
        onEvent({ event: 'task', id: t.id, status: t.status, comment: t.comment, url: t.url, action: 'act-on-it' });
      } else if (t.status === 'rejected') {
        onEvent({ event: 'task', id: t.id, status: t.status, comment: t.comment, url: t.url, action: 'try-again' });
      } else if (t.status === 'approved') {
        onEvent({ event: 'task', id: t.id, status: t.status, comment: t.comment, action: 'done' });
      }
    }

    for (const [id] of announced) {
      if (!tasks.some((t) => t.id === id)) {
        announced.delete(id);
        onEvent({ event: 'task', id, status: 'removed', action: 'dropped' });
      }
    }
  };

  await scan(true);

  /*
    Both a watcher and a poll. fs.watch misses changes on some platforms and
    network filesystems, and a missed task is the whole failure this exists to
    prevent, so a slow sweep backs it up.
  */
  let queued = null;
  const nudge = () => {
    if (queued) return;
    queued = setTimeout(() => {
      queued = null;
      scan().catch(() => {});
    }, 250);
  };

  let watcher = null;
  if (existsSync(store.dir)) {
    try {
      watcher = watch(store.dir, { recursive: true }, nudge);
    } catch {
      // Recursive watching is not available everywhere; the poll covers it.
    }
  }
  const timer = setInterval(() => scan().catch(() => {}), intervalMs);

  const stop = () => {
    stopped = true;
    clearInterval(timer);
    if (queued) clearTimeout(queued);
    watcher?.close();
  };
  signal?.addEventListener('abort', stop, { once: true });

  return { stop, store };
}
