import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { writeFile, mkdir, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';

import { openStore, importLegacy, isPending, SCHEMA } from '../src/tasks.mjs';
import { tempDir } from './helpers.mjs';

describe('task store', () => {
  test('a task survives being written and read back', async () => {
    const { dir, dispose } = await tempDir();
    try {
      const store = await openStore(dir);
      const made = await store.create({ comment: 'too cramped', url: 'http://x/a', kind: 'comment' });

      assert.match(made.id, /^task-\d{4}$/);
      assert.equal(made.status, 'open');
      assert.equal(made.v, SCHEMA, 'records carry a schema version');

      // A second store over the same directory sees it — nothing is held in memory.
      const reopened = await openStore(dir);
      const found = await reopened.get(made.id);
      assert.equal(found.comment, 'too cramped');
    } finally {
      await dispose();
    }
  });

  test('ids do not collide', async () => {
    const { dir, dispose } = await tempDir();
    try {
      const store = await openStore(dir);
      const made = [];
      for (let i = 0; i < 5; i++) made.push(await store.create({ comment: `c${i}` }));
      assert.equal(new Set(made.map((t) => t.id)).size, 5);
    } finally {
      await dispose();
    }
  });

  test('assets are copied in, so cleaning a run directory cannot orphan them', async () => {
    const { dir, dispose } = await tempDir();
    try {
      const scratch = path.join(dir, 'run');
      await mkdir(scratch, { recursive: true });
      const crop = path.join(scratch, 'region.png');
      const ref = path.join(scratch, 'ref.png');
      await writeFile(crop, 'crop-bytes');
      await writeFile(ref, 'ref-bytes');

      const store = await openStore(dir);
      const t = await store.create({ comment: 'look here' }, { regionScreenshot: crop, attachments: [ref] });

      assert.ok(existsSync(t.regionScreenshot), 'crop copied into the task');
      assert.equal(t.attachments.length, 1);
      assert.ok(t.regionScreenshot.startsWith(t.dir), 'and it lives with the task');

      // Delete the originals; the task is unaffected.
      const { rm } = await import('node:fs/promises');
      await rm(scratch, { recursive: true, force: true });
      const still = await (await openStore(dir)).get(t.id);
      assert.ok(existsSync(still.regionScreenshot));
      assert.equal(await readFile(still.regionScreenshot, 'utf8'), 'crop-bytes');
    } finally {
      await dispose();
    }
  });

  test('status changes are recorded with their history', async () => {
    const { dir, dispose } = await tempDir();
    try {
      const store = await openStore(dir);
      const t = await store.create({ comment: 'x' });

      await store.update(t.id, { status: 'in_progress' });
      await store.update(t.id, { status: 'applied' });
      const rejected = await store.update(t.id, { status: 'rejected' }, 'missed the point');
      assert.deepEqual(
        rejected.history.map((h) => h.status),
        ['open', 'in_progress', 'applied', 'rejected'],
      );
      assert.equal(rejected.history.at(-1).note, 'missed the point');

      const approved = await store.update(t.id, { status: 'approved' });
      assert.equal(isPending(approved), false, 'approved is the only settled state');
    } finally {
      await dispose();
    }
  });

  test('pending work is what has not been approved', async () => {
    const { dir, dispose } = await tempDir();
    try {
      const store = await openStore(dir);
      const a = await store.create({ comment: 'a', url: 'http://x/1' });
      const b = await store.create({ comment: 'b', url: 'http://x/2' });
      await store.create({ comment: 'c', url: 'http://x/1' });

      await store.update(a.id, { status: 'approved' });
      await store.update(b.id, { status: 'rejected' });

      const stats = await store.stats();
      assert.equal(stats.total, 3);
      assert.equal(stats.pending, 2, 'rejected still owes work; approved does not');
      assert.equal(stats.approved, 1);

      const onPageOne = await store.list({ url: 'http://x/1' });
      assert.equal(onPageOne.length, 2, 'tasks can be found by the page they were made on');
    } finally {
      await dispose();
    }
  });

  test('a corrupt record does not take the store down', async () => {
    const { dir, dispose } = await tempDir();
    try {
      const store = await openStore(dir);
      await store.create({ comment: 'good one' });
      await mkdir(path.join(store.dir, 'task-0099'), { recursive: true });
      await writeFile(path.join(store.dir, 'task-0099', 'task.json'), '{ broken');

      const all = await store.list();
      assert.equal(all.length, 1, 'the readable task is still returned');
    } finally {
      await dispose();
    }
  });
});

describe('importing work captured before the store existed', () => {
  async function legacySession(dir, name, comments) {
    const sdir = path.join(dir, '.ayna', 'comments', name);
    await mkdir(sdir, { recursive: true });
    await writeFile(path.join(sdir, 'comments.json'), JSON.stringify({ url: 'http://x/', comments }));
    return sdir;
  }

  test('old comments are adopted, with resolved mapped to approved', async () => {
    const { dir, dispose } = await tempDir();
    try {
      await legacySession(dir, '2026-07-30T12-00-00', [
        { n: 1, id: 1, comment: 'still open', status: 'open', url: 'http://x/a' },
        { n: 2, id: 2, comment: 'signed off', status: 'resolved', url: 'http://x/a' },
        { n: 3, id: 3, comment: 'needs work', status: 'rejected', url: 'http://x/b' },
      ]);

      const store = await openStore(dir);
      const result = await importLegacy(dir, store);
      assert.equal(result.imported, 3);

      const byComment = Object.fromEntries((await store.list()).map((t) => [t.comment, t.status]));
      assert.equal(byComment['still open'], 'open');
      assert.equal(byComment['signed off'], 'approved');
      assert.equal(byComment['needs work'], 'rejected');
    } finally {
      await dispose();
    }
  });

  test('importing twice does not duplicate anything', async () => {
    const { dir, dispose } = await tempDir();
    try {
      await legacySession(dir, '2026-07-30T12-00-00', [{ n: 1, id: 1, comment: 'once', status: 'open' }]);
      const store = await openStore(dir);
      await importLegacy(dir, store);
      await importLegacy(dir, store);
      assert.equal((await store.list()).length, 1);
    } finally {
      await dispose();
    }
  });
});

describe('watching the store', () => {
  test('announces what is already owed, then each change, with no window involved', async () => {
    const { dir, dispose } = await tempDir();
    try {
      const { watchTasks } = await import('../src/watch.mjs');
      const store = await openStore(dir);
      // Work that existed before anything was watching.
      const old = await store.create({ comment: 'from a session that ended', url: 'http://x/a' });

      const events = [];
      const controller = new AbortController();
      const { stop } = await watchTasks({
        projectDir: dir,
        signal: controller.signal,
        intervalMs: 200,
        onEvent: (e) => events.push(e),
      });

      const settle = () => new Promise((r) => setTimeout(r, 700));
      const fresh = await store.create({ comment: 'raised with nothing open', url: 'http://x/b' });
      await settle();
      await store.update(fresh.id, { status: 'rejected' });
      await settle();
      stop();
      controller.abort();

      assert.equal(events[0].event, 'ready');
      assert.equal(events[0].pending, 1, 'says up front what is already waiting');
      assert.equal(events[0].tasks[0].id, old.id);

      const kinds = events.slice(1).map((e) => `${e.status}:${e.action}`);
      assert.ok(kinds.includes('open:act-on-it'), `a new task is announced (${kinds.join(', ')})`);
      assert.ok(kinds.includes('rejected:try-again'), 'so is a rejection');
    } finally {
      await dispose();
    }
  });

  test('a status is announced once, not on every sweep', async () => {
    const { dir, dispose } = await tempDir();
    try {
      const { watchTasks } = await import('../src/watch.mjs');
      const store = await openStore(dir);
      const events = [];
      const controller = new AbortController();
      const { stop } = await watchTasks({
        projectDir: dir,
        signal: controller.signal,
        intervalMs: 150,
        onEvent: (e) => events.push(e),
      });

      await store.create({ comment: 'one task', url: 'http://x/' });
      await new Promise((r) => setTimeout(r, 900)); // several sweeps
      stop();
      controller.abort();

      const announcements = events.filter((e) => e.event === 'task');
      assert.equal(announcements.length, 1, `announced ${announcements.length} times, expected once`);
    } finally {
      await dispose();
    }
  });
});
