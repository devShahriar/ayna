/*
  The failure this whole layer exists for.

  Comments were written, sent, and read by nobody. The window said "waiting for
  Puku" while nine tasks sat unread, because delivery was a pipe between two
  live processes and both had gone. Nothing here is about storage for its own
  sake — every test below is a way that work used to be able to disappear.
*/
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';

import { openDb, appendEvent, eventsSince, transact, latestSeq } from '../src/db.mjs';
import { openStore, importLegacy, isPending, migrateFromFiles } from '../src/tasks.mjs';
import { since, drain, pending } from '../src/events.mjs';
import { tempDir } from './helpers.mjs';

describe('the event log', () => {
  test('an event and the change it describes commit together, or not at all', async () => {
    const db = await openDb(null, { file: ':memory:' });
    db.prepare('INSERT INTO tasks (id, status, created_at, updated_at) VALUES (?,?,?,?)')
      .run('task-0001', 'open', Date.now(), Date.now());

    // A consumer that sees an event for a change that was rolled back is worse
    // off than one that sees nothing: it goes looking for work that never landed.
    assert.throws(() =>
      transact(db, () => {
        db.prepare('UPDATE tasks SET status = ? WHERE id = ?').run('approved', 'task-0001');
        appendEvent(db, { event: 'task', taskId: 'task-0001', status: 'approved' });
        throw new Error('the write failed after the event');
      }),
    );

    assert.equal(db.prepare('SELECT status FROM tasks WHERE id = ?').get('task-0001').status, 'open');
    assert.equal(latestSeq(db), 0, 'the event must not survive its own transaction');
  });

  test('a consumer that was not running still learns what it missed', async () => {
    const { dir, dispose } = await tempDir();
    try {
      // Round one happens with nobody listening at all.
      const store = await openStore(dir);
      await store.create({ comment: 'the nav is too wide', url: 'http://x/' });
      await store.create({ comment: 'logo is small', url: 'http://x/' });

      // A different process entirely, opened afterwards, asks what happened.
      const caught = await since(dir, { since: 0 });
      assert.equal(caught.events.filter((e) => e.event === 'task').length, 2);
      assert.equal(caught.pending, 2, 'and what is still owed, not just what changed');
      assert.deepEqual(
        caught.tasks.map((t) => t.comment),
        ['the nav is too wide', 'logo is small'],
      );
    } finally {
      await dispose();
    }
  });

  test('a named consumer resumes where it stopped, and repeats nothing', async () => {
    const { dir, dispose } = await tempDir();
    try {
      const store = await openStore(dir);
      await store.create({ comment: 'first' });

      const one = await drain(dir, 'puku');
      assert.equal(one.events.length, 1);

      const nothingNew = await drain(dir, 'puku');
      assert.deepEqual(nothingNew.events, [], 'a second read must not replay what was delivered');

      await store.create({ comment: 'second' });
      const two = await drain(dir, 'puku');
      assert.equal(two.events.length, 1);
      assert.equal(two.events[0].comment, 'second');

      // A different consumer has its own place in the queue.
      const other = await drain(dir, 'cursor');
      assert.equal(other.events.length, 2, 'one consumer reading must not consume for another');
    } finally {
      await dispose();
    }
  });
});

describe('two things wanting the same task', () => {
  test('exactly one claim wins, and the loser is told', async () => {
    const { dir, dispose } = await tempDir();
    try {
      const store = await openStore(dir);
      const task = await store.create({ comment: 'widen the nav' });

      const worker = await store.claim(task.id, 'worker-1');
      const session = await store.claim(task.id, 'puku-session-2');

      assert.ok(worker, 'the first claimer takes it');
      assert.equal(session, null, 'the second is refused rather than doing the work twice');
      assert.equal((await store.get(task.id)).claimedBy, 'worker-1');
    } finally {
      await dispose();
    }
  });

  test('a claim from a process that died is taken over, not stuck forever', async () => {
    const { dir, dispose } = await tempDir();
    try {
      const store = await openStore(dir);
      const task = await store.create({ comment: 'resize the logo' });

      // A worker takes it and dies. Without expiry the task is lost to everyone.
      await store.claim(task.id, 'crashed-worker', { leaseMs: -1 });
      const next = await store.claim(task.id, 'worker-2');

      assert.ok(next, 'an expired lease returns the task to the pool');
      assert.equal(next.claimedBy, 'worker-2');
    } finally {
      await dispose();
    }
  });
});

describe('upgrading a store that already has work in it', () => {
  test('task directories are adopted with their status, history and images', async () => {
    const { dir, dispose } = await tempDir();
    try {
      const tasks = path.join(dir, '.ayna', 'tasks', 'task-0001');
      await mkdir(tasks, { recursive: true });
      await writeFile(path.join(tasks, 'region.png'), 'not really a png');
      await writeFile(
        path.join(tasks, 'task.json'),
        JSON.stringify({
          v: 1,
          id: 'task-0001',
          status: 'rejected',
          comment: 'make this logo bigger',
          selector: '#logo',
          url: 'http://x/',
          regionScreenshot: 'region.png',
          attachments: [],
          createdAt: '2026-08-01T00:00:00.000Z',
          updatedAt: '2026-08-02T00:00:00.000Z',
          history: [
            { at: '2026-08-01T00:00:00.000Z', status: 'open' },
            { at: '2026-08-02T00:00:00.000Z', status: 'rejected', note: 'still too small' },
          ],
        }),
      );

      const store = await openStore(dir);
      const t = await store.get('task-0001');

      assert.equal(t.comment, 'make this logo bigger');
      assert.equal(t.status, 'rejected');
      assert.equal(t.selector, '#logo');
      assert.equal(t.history.length, 2, 'history is what tells the user what already happened');
      assert.equal(t.history[1].note, 'still too small');
      assert.ok(existsSync(t.regionScreenshot), 'the crop is the comment; losing it loses the point');
      assert.ok(isPending(t), 'a rejected task is still owed');
    } finally {
      await dispose();
    }
  });

  test('adopting is idempotent — reopening does not duplicate the work', async () => {
    const { dir, dispose } = await tempDir();
    try {
      const taskDir = path.join(dir, '.ayna', 'tasks', 'task-0001');
      await mkdir(taskDir, { recursive: true });
      await writeFile(
        path.join(taskDir, 'task.json'),
        JSON.stringify({ id: 'task-0001', status: 'open', comment: 'once', createdAt: '2026-08-01T00:00:00.000Z' }),
      );

      await openStore(dir);
      const store = await openStore(dir);
      const all = await store.list();

      assert.equal(all.length, 1, `reopening duplicated the store: ${all.map((t) => t.id).join(', ')}`);
    } finally {
      await dispose();
    }
  });

  test('a comment already recorded live is not imported a second time', async () => {
    /*
      The window writes comments into the store as they are made, and also writes
      them to comments.json. Both are read on the next open, so without the
      window claiming the manifest key first, every comment the user made would
      appear twice — once as itself and once as its own transcript.
    */
    const { dir, dispose } = await tempDir();
    try {
      const session = '2026-08-04T10-00-00';
      const out = path.join(dir, '.ayna', 'comments', session);
      await mkdir(out, { recursive: true });
      await writeFile(
        path.join(out, 'comments.json'),
        JSON.stringify({ url: 'http://x/', comments: [{ id: 1, n: 1, comment: 'widen this nav bar' }] }),
      );

      const store = await openStore(dir);
      await store.create({ legacyKey: `${session}#1`, comment: 'widen this nav bar', url: 'http://x/' });

      const result = await importLegacy(dir, store);
      assert.equal(result.imported, 0, 'the live record already covers it');
      assert.equal((await store.list()).length, 1);
    } finally {
      await dispose();
    }
  });

  test('a deleted task stays deleted', async () => {
    // The ledger outliving the store is what stops a comment the user removed
    // coming back on the next read.
    const { dir, dispose } = await tempDir();
    try {
      const session = '2026-08-04T11-00-00';
      const out = path.join(dir, '.ayna', 'comments', session);
      await mkdir(out, { recursive: true });
      await writeFile(
        path.join(out, 'comments.json'),
        JSON.stringify({ url: 'http://x/', comments: [{ id: 1, n: 1, comment: 'gone' }] }),
      );

      const store = await openStore(dir);
      await importLegacy(dir, store);
      const [t] = await store.list();
      await store.remove(t.id);

      await importLegacy(dir, store);
      assert.deepEqual(await store.list(), [], 'a removed comment must not resurrect');
    } finally {
      await dispose();
    }
  });

  test('a corrupt task directory is skipped, not fatal', async () => {
    const { dir, dispose } = await tempDir();
    try {
      const bad = path.join(dir, '.ayna', 'tasks', 'task-0001');
      const good = path.join(dir, '.ayna', 'tasks', 'task-0002');
      await mkdir(bad, { recursive: true });
      await mkdir(good, { recursive: true });
      await writeFile(path.join(bad, 'task.json'), '{ this is not json');
      await writeFile(
        path.join(good, 'task.json'),
        JSON.stringify({ id: 'task-0002', status: 'open', comment: 'fine', createdAt: '2026-08-01T00:00:00.000Z' }),
      );

      const store = await openStore(dir);
      const all = await store.list();
      assert.equal(all.length, 1);
      assert.equal(all[0].comment, 'fine');
    } finally {
      await dispose();
    }
  });
});

describe('what is owed', () => {
  test('counts anything not settled, and settles only on approval or obsolescence', async () => {
    const { dir, dispose } = await tempDir();
    try {
      const store = await openStore(dir);
      const a = await store.create({ comment: 'a' });
      const b = await store.create({ comment: 'b' });
      const c = await store.create({ comment: 'c' });
      const d = await store.create({ comment: 'd' });

      await store.update(a.id, { status: 'approved' });
      await store.update(b.id, { status: 'obsolete' }, 'no longer reproduces');
      await store.update(c.id, { status: 'needs_confirmation' }, 'the element changed');
      await store.update(d.id, { status: 'rejected' });

      const owed = await pending(dir);
      assert.equal(owed.pending, 2, 'needs_confirmation and rejected are both still owed');
      assert.deepEqual(owed.tasks.map((t) => t.status).sort(), ['needs_confirmation', 'rejected']);

      const stats = await store.stats();
      assert.equal(stats.obsolete, 1);
      assert.equal(stats.needs_confirmation, 1);

      // The note is the evidence — a status alone tells the user nothing.
      assert.equal((await store.get(b.id)).history.at(-1).note, 'no longer reproduces');
    } finally {
      await dispose();
    }
  });
});
