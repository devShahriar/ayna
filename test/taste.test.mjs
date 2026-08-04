/*
  The taste adapter.

  ayna measures; impeccable judges. The whole value of keeping those apart is that
  `clean` stays a statement about what the page can prove — a fixing loop needs a
  condition under which it is finished, and taste has no such condition. These
  tests exist mostly to stop the two being merged by a future good intention.

  Every case runs against a stub, so the suite needs no network and no impeccable.
*/
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { writeFile, chmod } from 'node:fs/promises';
import path from 'node:path';

import { judgeTaste, proposeTaste, summarizeTaste } from '../src/taste.mjs';
import { openStore } from '../src/tasks.mjs';
import { tempDir } from './helpers.mjs';

/** A stand-in for the real CLI: prints `payload`, exits with `code`. */
async function stub(dir, payload, code = 0) {
  const file = path.join(dir, 'fake-impeccable.mjs');
  await writeFile(
    file,
    `#!/usr/bin/env node\nprocess.stdout.write(${JSON.stringify(JSON.stringify(payload))});\nprocess.exit(${code});\n`,
  );
  await chmod(file, 0o755);
  return `${process.execPath} ${file}`;
}

const FINDINGS = [
  {
    antipattern: 'icon-tile-stack',
    name: 'Icon tile stacked above heading',
    description: 'The universal AI feature-card template.',
    severity: 'warning',
    category: 'slop',
    snippet: '40x40px icon tile above h3 "Ask in plain language"',
  },
  {
    antipattern: 'icon-tile-stack',
    name: 'Icon tile stacked above heading',
    description: 'The universal AI feature-card template.',
    severity: 'warning',
    category: 'slop',
    snippet: '40x40px icon tile above h3 "Warehouse native"',
  },
  {
    antipattern: 'overused-font',
    name: 'Overused font',
    description: 'Primary font is the one every generator picks.',
    severity: 'error',
    category: 'type',
    snippet: 'Primary font: inter',
  },
];

describe('borrowing taste', () => {
  test('repeats of one rule collapse into a single note with its places', async () => {
    const { dir, dispose } = await tempDir();
    try {
      const result = await judgeTaste('http://x/', { command: await stub(dir, FINDINGS) });

      assert.equal(result.available, true);
      assert.equal(result.total, 3, 'the occurrence count is kept');
      assert.equal(result.findings.length, 2, 'three findings, two rules');

      // Worst first: an error outranks a warning even with fewer occurrences.
      assert.equal(result.findings[0].rule, 'overused-font');
      const tile = result.findings.find((f) => f.rule === 'icon-tile-stack');
      assert.equal(tile.where.length, 2, 'both places are listed under the one note');
    } finally {
      await dispose();
    }
  });

  test('findings reported with a failing exit code are still read', async () => {
    // impeccable exits 2 when it finds something, which execFile treats as an
    // error. Reading only the happy path would mean the tool reported nothing
    // exactly when it had something to say.
    const { dir, dispose } = await tempDir();
    try {
      const result = await judgeTaste('http://x/', { command: await stub(dir, FINDINGS, 2) });
      assert.equal(result.findings.length, 2);
    } finally {
      await dispose();
    }
  });

  test('a missing impeccable is absent, not broken', async () => {
    const result = await judgeTaste('http://x/', { command: '/nope/not-a-real-binary' });
    assert.equal(result.available, false);
    assert.match(result.hint, /not installed/);
    assert.deepEqual(result.findings, []);
  });

  test('unreadable output is reported without throwing', async () => {
    const { dir, dispose } = await tempDir();
    try {
      const file = path.join(dir, 'garbage.mjs');
      await writeFile(file, 'process.stdout.write("not json at all");\n');
      const result = await judgeTaste('http://x/', { command: `${process.execPath} ${file}` });
      assert.equal(result.available, true);
      assert.match(result.error, /not JSON/);
      assert.deepEqual(result.findings, []);
    } finally {
      await dispose();
    }
  });

  test('the summary says these are opinions', async () => {
    const { dir, dispose } = await tempDir();
    try {
      const result = await judgeTaste('http://x/', { command: await stub(dir, FINDINGS) });
      const text = summarizeTaste(result);
      assert.match(text, /opinions, not measurements/);
      assert.match(text, /never affect whether an audit is clean/);
    } finally {
      await dispose();
    }
  });
});

describe('taste becomes a proposal, never an edit', () => {
  test('each rule is raised once, as `proposed`', async () => {
    const { dir, dispose } = await tempDir();
    try {
      const store = await openStore(dir);
      const result = await judgeTaste('http://x/', { command: await stub(dir, FINDINGS) });

      const first = await proposeTaste(store, result, { url: 'http://x/' });
      assert.equal(first.proposed, 2);

      const tasks = await store.list();
      assert.equal(tasks.length, 2);
      for (const t of tasks) {
        // `proposed` is the status that means "found by a tool, not permitted
        // yet". An opinion about how a page looks is exactly that.
        assert.equal(t.status, 'proposed', 'taste must never arrive as work to do');
        assert.equal(t.kind, 'taste');
        assert.equal(t.source, 'impeccable');
      }

      // Running it again must not re-raise what is already on the list.
      const again = await proposeTaste(store, result, { url: 'http://x/' });
      assert.equal(again.proposed, 0, 'a second run nagged about the same rules');
      assert.equal((await store.list()).length, 2);
    } finally {
      await dispose();
    }
  });

  test('nothing is raised when the tool is not there', async () => {
    const { dir, dispose } = await tempDir();
    try {
      const store = await openStore(dir);
      const result = await judgeTaste('http://x/', { command: '/nope/not-a-real-binary' });
      assert.equal((await proposeTaste(store, result, {})).proposed, 0);
      assert.deepEqual(await store.list(), []);
    } finally {
      await dispose();
    }
  });
});
