/*
  Liveness, and the bookkeeping around it.

  Seven pointer files once accumulated in one project, none cleaned up, and the
  newest by modification time — the one every reader trusted — belonged to a
  process that had been dead for hours. A pid alone cannot settle this either:
  pids are reused, so a long-dead session can be revived by an unrelated process
  inheriting its number.
*/
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile, readdir } from 'node:fs/promises';
import path from 'node:path';

import { openSessions, alive, STALE_AFTER } from '../src/sessions.mjs';
import { openStore } from '../src/tasks.mjs';
import { pruneSessionFiles, running, takePidFile, releasePidFile, watchLoop } from '../src/watchd.mjs';
import { eventsSince } from '../src/db.mjs';
import { tempDir } from './helpers.mjs';

describe('who is here', () => {
  test('this process is alive and an impossible pid is not', () => {
    assert.equal(alive(process.pid), true);
    assert.equal(alive(999999), false);
    assert.equal(alive(null), false);
  });

  test('a session that stops speaking is presumed gone, even with a live pid', async () => {
    /*
      The heartbeat is the half that a pid cannot provide. A process can be
      alive and no longer doing this — hung, or reusing a number that once
      belonged to a review — and its tabs should not stay locked to it.
    */
    const { dir, dispose } = await tempDir();
    try {
      const sessions = await openSessions(dir);
      const id = sessions.register({ tool: 'puku', pid: process.pid });
      const tab = sessions.openTab({ url: 'http://x/', sessionId: id });

      assert.equal(sessions.sweep().sessions, 0, 'a live, talking session must be left alone');

      const swept = sessions.sweep({ now: Date.now() + STALE_AFTER + 1000 });
      assert.equal(swept.sessions, 1);
      assert.equal(swept.tabs, 1, 'its tab should be freed, not closed');
      assert.equal(sessions.tabs().find((t) => t.id === tab).owner, null);
    } finally {
      await dispose();
    }
  });

  test('a freed tab can be adopted, and a held one cannot be taken', async () => {
    // The work in a dead session's tab is still owed. The next session should
    // find an open door, not a locked one.
    const { dir, dispose } = await tempDir();
    try {
      const sessions = await openSessions(dir);
      const first = sessions.register({ pid: 999999 });
      const tab = sessions.openTab({ url: 'http://x/', sessionId: first });
      const second = sessions.register({ tool: 'cursor', pid: process.pid });

      assert.equal(sessions.claimTab(tab, second), false, 'it still has an owner');
      sessions.sweep();
      assert.equal(sessions.claimTab(tab, second), true);
      assert.equal(sessions.claimTab(tab, second), true, 'the same owner re-claiming is harmless');

      const third = sessions.register({ tool: 'codex', pid: process.pid });
      assert.equal(sessions.claimTab(tab, third), false, 'two owners is the failure this prevents');

      // A session that was never registered is refused rather than throwing: the
      // foreign key would take a review down over a caller's bad argument.
      assert.equal(sessions.claimTab(tab, 'never-registered'), false);
    } finally {
      await dispose();
    }
  });

  test('a lease from a worker that died expires', async () => {
    const { dir, dispose } = await tempDir();
    try {
      const store = await openStore(dir);
      const t = await store.create({ comment: 'widen the nav' });
      await store.claim(t.id, 'crashed-worker', { leaseMs: -1 });

      const sessions = await openSessions(dir, { db: store.db });
      assert.equal(sessions.sweep().leases, 1);
      assert.equal((await store.get(t.id)).claimedBy, null);
    } finally {
      await dispose();
    }
  });

  test('deaths are written down, so a later reader can see what happened', async () => {
    const { dir, dispose } = await tempDir();
    try {
      const sessions = await openSessions(dir);
      sessions.register({ tool: 'puku', pid: 999999 });
      sessions.sweep();

      const kinds = eventsSince(sessions.db, 0).map((e) => e.event);
      assert.ok(kinds.includes('session-started'));
      assert.ok(kinds.includes('session-died'));
    } finally {
      await dispose();
    }
  });
});

describe('the bookkeeper', () => {
  test('pointer files for dead processes are removed and live ones kept', async () => {
    const { dir, dispose } = await tempDir();
    try {
      const sessionDir = path.join(dir, '.ayna', 'session');
      await mkdir(sessionDir, { recursive: true });
      for (const pid of [999991, 999992]) {
        await writeFile(path.join(sessionDir, `session-${pid}.json`), '{}');
      }
      await writeFile(path.join(sessionDir, `session-${process.pid}.json`), '{}');
      await writeFile(path.join(sessionDir, 'last-comments.json'), '{}');

      assert.equal(await pruneSessionFiles(dir), 2);
      const left = (await readdir(sessionDir)).sort();
      assert.deepEqual(left, ['last-comments.json', `session-${process.pid}.json`].sort());
    } finally {
      await dispose();
    }
  });

  test('a pidfile left by something that crashed is not a running daemon', async () => {
    const { dir, dispose } = await tempDir();
    try {
      await mkdir(path.join(dir, '.ayna'), { recursive: true });
      await writeFile(path.join(dir, '.ayna', 'watchd.pid'), '999999');
      assert.equal(await running(dir), null, 'a dead pid must not look like a live daemon');

      const taken = await takePidFile(dir);
      assert.equal(taken.ok, true, 'and the file it left must not block the next one');

      const second = await takePidFile(dir);
      assert.equal(second.ok, false, 'but a real holder must not be displaced');
      await releasePidFile(dir);
    } finally {
      await dispose();
    }
  });

  test('the loop sweeps and stops when told', async () => {
    // Driven by importing it, because a `node --test` run cannot drive a command
    // that never returns.
    const { dir, dispose } = await tempDir();
    try {
      const sessions = await openSessions(dir);
      sessions.register({ tool: 'puku', pid: 999999 });

      const controller = new AbortController();
      const seen = [];
      const loop = watchLoop({
        projectDir: dir,
        intervalMs: 40,
        signal: controller.signal,
        onEvent: (e) => seen.push(e),
      });
      await new Promise((r) => setTimeout(r, 250));
      controller.abort();
      await loop;

      assert.ok(
        seen.some((e) => e.event === 'swept' && e.sessions === 1),
        `expected a sweep, saw ${JSON.stringify(seen)}`,
      );
      assert.equal(sessions.live().length, 0);
    } finally {
      await dispose();
    }
  });
});
