import { openDb, eventsSince, latestSeq, readCursor, writeCursor } from './db.mjs';

/**
 * Catching up, for anyone who was not listening at the time.
 *
 * The old delivery was a pipe: the window printed events on stdout and a session
 * had to be reading them. Nobody reading meant nobody would ever know — the
 * events were not stored anywhere, so there was no question you could ask
 * afterwards that would tell you what you had missed. A review sat untouched for
 * a day because the session that opened it had ended.
 *
 * Events are rows now, written in the same transaction as the change they
 * describe. So the interesting question — "what has happened since I last
 * looked?" — has an answer, and it stays true whether the asker is the session
 * that started the review, one that began an hour later, or a different tool
 * entirely.
 */

/**
 * What is owed right now, regardless of when it was raised.
 *
 * The log answers "what changed", which is not the same question as "what is
 * still outstanding" — a task raised before this log existed, or before the
 * consumer's cursor, has no event to find. `watch` already solved this with a
 * `ready` line stating the standing debt; catch-up needs the same, or a session
 * that arrives late reads an empty list and concludes there is nothing to do.
 */
export async function pending(projectDir, { db: given } = {}) {
  const { openStore, isPending } = await import('./tasks.mjs');
  const store = await openStore(projectDir, { db: given });
  const owed = (await store.list()).filter(isPending);
  return {
    event: 'ready',
    pending: owed.length,
    tasks: owed.map((t) => ({ id: t.id, status: t.status, comment: t.comment, url: t.url })),
  };
}

/** Everything after `since`. Returns the new cursor even when nothing happened. */
export async function since(projectDir, { since: from = 0, limit = 500, db: given } = {}) {
  const db = given ?? (await openDb(projectDir));
  const events = eventsSince(db, from, limit);
  const owed = await pending(projectDir, { db });
  return {
    events,
    cursor: events.length ? events.at(-1).seq : Number(from) || 0,
    latest: latestSeq(db),
    pending: owed.pending,
    tasks: owed.tasks,
  };
}

/**
 * The same, but remembering where a named consumer had got to.
 *
 * A consumer that crashes mid-batch has not moved its cursor, so it sees those
 * events again on restart. Delivering twice is recoverable; silently skipping is
 * the failure this whole file exists to prevent.
 */
export async function drain(projectDir, consumer, { limit = 500, db: given } = {}) {
  const db = given ?? (await openDb(projectDir));
  const from = readCursor(db, consumer);
  const events = eventsSince(db, from, limit);
  if (events.length) writeCursor(db, consumer, events.at(-1).seq);
  return { events, from, cursor: events.length ? events.at(-1).seq : from };
}

/**
 * Block until something happens, then hand it over.
 *
 * Polls rather than watching the file: SQLite in WAL mode gives no change
 * notification, and the alternative — a watcher on the -wal file — fires on
 * checkpoints and vacuums as readily as on real writes. A 400ms sweep of an
 * indexed integer column costs nothing next to being wrong.
 */
export async function follow(projectDir, { consumer, onEvent, signal, intervalMs = 400, db: given } = {}) {
  const db = given ?? (await openDb(projectDir));
  let cursor = consumer ? readCursor(db, consumer) : latestSeq(db);
  let stopped = false;

  const stop = () => {
    stopped = true;
  };
  signal?.addEventListener('abort', stop, { once: true });

  // State the standing debt before streaming changes. A consumer that starts
  // late must not have to wait for the next change to discover it was already
  // behind — the first line says what is owed, as `watch` has always done.
  onEvent(await pending(projectDir, { db }));

  while (!stopped) {
    const batch = eventsSince(db, cursor);
    for (const event of batch) {
      if (stopped) break;
      onEvent(event);
      cursor = event.seq;
      if (consumer) writeCursor(db, consumer, cursor);
    }
    if (stopped) break;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  return { cursor, stop };
}
