/*
  What a round changed, told from the files themselves.

  "Changes landed" asked the user to judge a round without its diff. These pin
  down the pieces that answer "which files, and what in them": the copy taken
  before anyone edits, the comparison afterwards, and a diff small enough for a
  narrow panel.
*/
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile, readFile, rm, chmod } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';

import { snapshotProject, roundChanges, diffLines, hunks, undoChanges } from '../src/rounds.mjs';
import { tempDir } from './helpers.mjs';

const TEXT = new Set(['.css', '.html', '.tsx', '.js']);
const SKIP = ['node_modules', '.ayna'];

describe('a line diff', () => {
  test('a changed line is one removal and one addition, in place', () => {
    const ops = diffLines('a\nb\nc\n', 'a\nB\nc\n');
    assert.deepEqual(
      ops.filter((o) => o.t !== ' '),
      [{ t: '-', s: 'b' }, { t: '+', s: 'B' }],
    );
    assert.deepEqual(ops.map((o) => o.t).join(''), ' -+ ', 'the unchanged lines around it are kept');
  });

  test('a new file is all additions, a deleted one all removals', () => {
    assert.deepEqual(diffLines('', 'x\ny').map((o) => o.t), ['+', '+']);
    assert.deepEqual(diffLines('x\ny', '').map((o) => o.t), ['-', '-']);
  });

  test('a middle too large to compare is reported replaced, not hung on', () => {
    const big = (tag) => Array.from({ length: 2500 }, (_, i) => `${tag}${i}`).join('\n');
    const ops = diffLines('head\n' + big('a') + '\ntail', 'head\n' + big('b') + '\ntail');
    assert.equal(ops.filter((o) => o.t === '-').length, 2500);
    assert.equal(ops.filter((o) => o.t === '+').length, 2500);
    assert.equal(ops[0].s, 'head');
    assert.equal(ops.at(-1).s, 'tail');
  });
});

describe('the diff a panel shows', () => {
  test('keeps one line of context and folds the rest', () => {
    const before = Array.from({ length: 20 }, (_, i) => `line ${i}`).join('\n');
    const after = before.replace('line 3', 'LINE 3').replace('line 15', 'LINE 15');
    const shown = hunks(diffLines(before, after));
    assert.deepEqual(
      shown.map((l) => l.t + l.s),
      [' line 2', '-line 3', '+LINE 3', ' line 4', '…', ' line 14', '-line 15', '+LINE 15', ' line 16'],
    );
  });

  test('stops at a budget and says how much it left out', () => {
    const after = Array.from({ length: 100 }, (_, i) => `new ${i}`).join('\n');
    const shown = hunks(diffLines('', after), { max: 10 });
    assert.equal(shown.length, 11);
    assert.deepEqual(shown.at(-1), { t: '…', s: '90 more lines' });
  });
});

describe('what a round changed', () => {
  async function project() {
    const { dir, dispose } = await tempDir();
    await mkdir(path.join(dir, 'src'), { recursive: true });
    await mkdir(path.join(dir, 'node_modules', 'pkg'), { recursive: true });
    await writeFile(path.join(dir, 'src', 'a.css'), 'h1 { color: red }\n');
    await writeFile(path.join(dir, 'src', 'b.tsx'), 'export const b = 1;\n');
    await writeFile(path.join(dir, 'src', 'gone.js'), 'old\n');
    await writeFile(path.join(dir, 'node_modules', 'pkg', 'x.js'), 'dependency\n');
    await writeFile(path.join(dir, 'logo.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    return { dir, dispose };
  }

  test('the copy is of source only, taken before anything moves', async () => {
    const { dir, dispose } = await project();
    try {
      const snap = await snapshotProject(dir, { skipDirs: SKIP, textExt: TEXT });
      assert.deepEqual([...snap.files.keys()].sort(), ['src/a.css', 'src/b.tsx', 'src/gone.js']);
      assert.equal(snap.complete, true);
    } finally {
      await dispose();
    }
  });

  test('modified, added and deleted are told apart, and a touched-but-same file is not a change', async () => {
    const { dir, dispose } = await project();
    try {
      const snap = await snapshotProject(dir, { skipDirs: SKIP, textExt: TEXT });
      await writeFile(path.join(dir, 'src', 'a.css'), 'h1 { color: red; letter-spacing: -0.02em }\n');
      await writeFile(path.join(dir, 'src', 'b.tsx'), 'export const b = 1;\n'); // saved, unchanged
      await writeFile(path.join(dir, 'src', 'new.tsx'), 'export const n = 2;\nexport const m = 3;\n');
      await rm(path.join(dir, 'src', 'gone.js'));

      const changes = await roundChanges(snap, ['src/a.css', 'src/b.tsx', 'src/new.tsx', 'src/gone.js', 'src/a.css']);
      assert.deepEqual(
        changes.map(({ file, status, added, removed }) => ({ file, status, added, removed })),
        [
          { file: 'src/a.css', status: 'modified', added: 1, removed: 1 },
          { file: 'src/gone.js', status: 'deleted', added: 0, removed: 1 },
          { file: 'src/new.tsx', status: 'added', added: 2, removed: 0 },
        ],
      );
    } finally {
      await dispose();
    }
  });

  test('a file the copy never reached is changed, but not called new', async () => {
    const { dir, dispose } = await project();
    try {
      // A budget of one file: the snapshot stops early and says so.
      const snap = await snapshotProject(dir, { skipDirs: SKIP, textExt: TEXT, maxFiles: 1 });
      assert.equal(snap.complete, false);
      assert.equal(snap.files.size, 1, 'what fitted in the budget is still copied, so it can still be undone');
      const unread = ['src/a.css', 'src/b.tsx', 'src/gone.js'].find((f) => !snap.files.has(f));
      await writeFile(path.join(dir, unread), 'changed\n');

      const [change] = await roundChanges(snap, [unread]);
      assert.equal(change.status, 'modified');
      assert.equal(change.before, undefined, 'there is no "before" to compare or restore');
    } finally {
      await dispose();
    }
  });

  test('a file that was there but unreadable is not called new, so undo cannot delete it', { skip: process.platform === 'win32' || process.getuid?.() === 0 }, async () => {
    const { dir, dispose } = await project();
    const locked = path.join(dir, 'src', 'b.tsx');
    try {
      await chmod(locked, 0o000);
      const snap = await snapshotProject(dir, { skipDirs: SKIP, textExt: TEXT });
      await chmod(locked, 0o644);
      assert.equal(snap.complete, true, 'the rest of the project was still read');
      await writeFile(locked, 'export const b = 2;\n');

      const changes = await roundChanges(snap, ['src/b.tsx']);
      assert.equal(changes[0].status, 'modified');
      assert.equal(changes[0].undoable, false);
      const undo = await undoChanges(dir, changes);
      assert.equal(undo.ok, false);
      assert.ok(existsSync(locked), 'a file that existed before the round is never deleted by its undo');
    } finally {
      await chmod(locked, 0o644).catch(() => {});
      await dispose();
    }
  });
});

describe('taking a round back', () => {
  async function editedRound() {
    const { dir, dispose } = await tempDir();
    await mkdir(path.join(dir, 'src'), { recursive: true });
    await writeFile(path.join(dir, 'src', 'a.css'), 'h1 { color: red }\n');
    await writeFile(path.join(dir, 'src', 'gone.js'), 'old\n');
    const snap = await snapshotProject(dir, { skipDirs: SKIP, textExt: TEXT });
    await writeFile(path.join(dir, 'src', 'a.css'), 'h1 { color: blue }\n');
    await rm(path.join(dir, 'src', 'gone.js'));
    await mkdir(path.join(dir, 'src', 'new'), { recursive: true });
    await writeFile(path.join(dir, 'src', 'new', 'b.tsx'), 'export {};\n');
    const changes = await roundChanges(snap, ['src/a.css', 'src/gone.js', 'src/new/b.tsx']);
    return { dir, dispose, changes };
  }

  test('puts every file back: edited, deleted and added alike', async () => {
    const { dir, dispose, changes } = await editedRound();
    try {
      const result = await undoChanges(dir, changes);
      assert.deepEqual(result.restored.sort(), ['src/a.css', 'src/gone.js', 'src/new/b.tsx']);
      assert.equal(await readFile(path.join(dir, 'src', 'a.css'), 'utf8'), 'h1 { color: red }\n');
      assert.equal(await readFile(path.join(dir, 'src', 'gone.js'), 'utf8'), 'old\n');
      assert.equal(existsSync(path.join(dir, 'src', 'new', 'b.tsx')), false, 'a file the round made is removed');
    } finally {
      await dispose();
    }
  });

  test('refuses, and writes nothing, when a file has moved on since the round', async () => {
    const { dir, dispose, changes } = await editedRound();
    try {
      // A later edit to one of the round's files: overwriting it would lose that work.
      await writeFile(path.join(dir, 'src', 'a.css'), 'h1 { color: green }\n');
      const result = await undoChanges(dir, changes);
      assert.equal(result.ok, false);
      assert.deepEqual(result.conflicts, ['src/a.css']);
      assert.equal(existsSync(path.join(dir, 'src', 'gone.js')), false, 'all or nothing: no other file was restored');
      assert.equal(await readFile(path.join(dir, 'src', 'a.css'), 'utf8'), 'h1 { color: green }\n');
    } finally {
      await dispose();
    }
  });

  test('refuses a file it never had a copy of', async () => {
    const { dir, dispose } = await tempDir();
    try {
      await writeFile(path.join(dir, 'a.css'), 'a\n');
      await writeFile(path.join(dir, 'b.css'), 'b\n');
      const snap = await snapshotProject(dir, { textExt: TEXT, maxFiles: 1 });
      const unread = ['a.css', 'b.css'].find((f) => !snap.files.has(f));
      await writeFile(path.join(dir, unread), 'changed\n');
      const result = await undoChanges(dir, await roundChanges(snap, [unread]));
      assert.equal(result.ok, false);
      assert.deepEqual(result.unknown, [unread]);
      assert.equal(await readFile(path.join(dir, unread), 'utf8'), 'changed\n');
    } finally {
      await dispose();
    }
  });
});
