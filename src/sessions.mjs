import { openDb, appendEvent, transact } from './db.mjs';

/**
 * Who is here, and who only used to be.
 *
 * Seven pointer files once accumulated in a single project, none of them cleaned
 * up, and `last-comments.json` resolved to a process that had been dead for
 * hours while a live window sat two files away. Liveness was decided at read time
 * by whoever happened to ask, and nobody ever wrote down the answer.
 *
 * A pid alone cannot answer it either: pids are reused, so a long-dead session
 * can be revived by an unrelated process inheriting its number. A pid that is
 * alive *and* a heartbeat that is recent is a much harder thing to fake by
 * accident.
 */

/** How long a session may go quiet before it is presumed gone. */
export const STALE_AFTER = 90_000;

/** Signal 0 sends nothing; it only asks whether the process would receive it. */
export function alive(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM means it exists and belongs to somebody else — still alive.
    return err.code === 'EPERM';
  }
}

export async function openSessions(projectDir, { db: given } = {}) {
  const db = given ?? (await openDb(projectDir));

  /** Announce a session. The id is returned so it can heartbeat and be swept. */
  function register({ tool = 'claude', pid = process.pid, project = projectDir } = {}) {
    const id = `${tool}-${pid}-${Date.now().toString(36)}`;
    const now = Date.now();
    transact(db, () => {
      db.prepare(
        'INSERT INTO sessions (id, tool, pid, project, started_at, heartbeat_at, status) VALUES (?,?,?,?,?,?,?)',
      ).run(id, tool, pid, project, now, now, 'live');
      appendEvent(db, { event: 'session-started', sessionId: id, tool, pid });
    });
    return id;
  }

  const heartbeat = (id) =>
    db.prepare('UPDATE sessions SET heartbeat_at = ? WHERE id = ?').run(Date.now(), id).changes > 0;

  function end(id) {
    transact(db, () => {
      db.prepare("UPDATE sessions SET ended_at = ?, status = 'ended' WHERE id = ?").run(Date.now(), id);
      appendEvent(db, { event: 'session-ended', sessionId: id });
    });
  }

  /** A window, so work can say which one it belongs to and who owns it now. */
  function openTab({ url, outDir, sessionId }) {
    const id = `tab-${Date.now().toString(36)}`;
    transact(db, () => {
      db.prepare(
        'INSERT INTO tabs (id, url, out_dir, opened_by, owner_session, opened_at) VALUES (?,?,?,?,?,?)',
      ).run(id, url ?? null, outDir ?? null, sessionId ?? null, sessionId ?? null, Date.now());
      appendEvent(db, { event: 'tab-opened', tabId: id, sessionId, url });
    });
    return id;
  }

  function closeTab(id) {
    transact(db, () => {
      db.prepare('UPDATE tabs SET closed_at = ? WHERE id = ?').run(Date.now(), id);
      appendEvent(db, { event: 'tab-closed', tabId: id });
    });
  }

  /** Take an unowned tab. Refused if somebody live already has it. */
  function claimTab(tabId, sessionId) {
    /*
      A tab can only be handed to a session that exists. The foreign key already
      guarantees that and does it by throwing, which would take a review down
      over a caller's bad argument — so ask first and refuse the same way as any
      other unsuccessful claim.
    */
    if (!db.prepare('SELECT 1 FROM sessions WHERE id = ?').get(sessionId)) return false;

    // Already yours is a success, not a refusal. Returning false there would tell
    // a session it had lost a tab it is holding, which is worse than useless.
    const held = db.prepare('SELECT owner_session FROM tabs WHERE id = ? AND closed_at IS NULL').get(tabId);
    if (held?.owner_session === sessionId) return true;

    return transact(db, () => {
      const info = db
        .prepare('UPDATE tabs SET owner_session = ? WHERE id = ? AND owner_session IS NULL AND closed_at IS NULL')
        .run(sessionId, tabId);
      if (info.changes) appendEvent(db, { event: 'tab-claimed', tabId, sessionId });
      return info.changes > 0;
    });
  }

  /**
   * Notice what has died.
   *
   * A session whose process is gone, or which has stopped saying anything, is
   * ended. Its tabs lose their owner rather than being closed — the work in them
   * is still owed, and the next session should be able to adopt it instead of
   * finding a locked door. Task leases expire the same way, for the same reason.
   */
  function sweep({ now = Date.now(), staleAfter = STALE_AFTER } = {}) {
    const swept = { sessions: 0, tabs: 0, leases: 0 };

    for (const s of db.prepare("SELECT * FROM sessions WHERE status = 'live'").all()) {
      const gone = !alive(s.pid) || now - s.heartbeat_at > staleAfter;
      if (!gone) continue;
      transact(db, () => {
        db.prepare("UPDATE sessions SET ended_at = ?, status = 'dead' WHERE id = ?").run(now, s.id);
        const freed = db
          .prepare('UPDATE tabs SET owner_session = NULL WHERE owner_session = ? AND closed_at IS NULL')
          .run(s.id);
        appendEvent(db, {
          event: 'session-died',
          sessionId: s.id,
          tool: s.tool,
          pid: s.pid,
          freedTabs: freed.changes,
        });
        swept.tabs += freed.changes;
      });
      swept.sessions += 1;
    }

    const expired = db
      .prepare('UPDATE tasks SET claimed_by = NULL, claim_expires_at = NULL WHERE claimed_by IS NOT NULL AND claim_expires_at < ?')
      .run(now);
    swept.leases = expired.changes;
    if (expired.changes) appendEvent(db, { event: 'leases-expired', count: expired.changes });

    return swept;
  }

  const live = () =>
    db
      .prepare("SELECT * FROM sessions WHERE status = 'live' ORDER BY started_at DESC")
      .all()
      .map((s) => ({ id: s.id, tool: s.tool, pid: s.pid, startedAt: s.started_at, heartbeatAt: s.heartbeat_at }));

  const tabs = () =>
    db
      .prepare('SELECT * FROM tabs WHERE closed_at IS NULL ORDER BY opened_at DESC')
      .all()
      .map((t) => ({ id: t.id, url: t.url, outDir: t.out_dir, owner: t.owner_session, phase: t.phase }));

  return { db, register, heartbeat, end, openTab, closeTab, claimTab, sweep, live, tabs };
}
