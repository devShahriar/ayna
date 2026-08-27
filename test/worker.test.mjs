/*
  Working the queue without a Puku session in front of it.

  Sessions end and terminals get closed; the queue outlives both. These tests
  guard the three rules that make an unattended worker safe to run: it claims
  before it works, it never touches a proposal, and it checks whether the fault
  is still there before spending anything on it.
*/
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { writeFile, chmod } from 'node:fs/promises';
import path from 'node:path';

import { work, brainFor, promptFor, runBrain } from '../src/worker.mjs';
import { openStore } from '../src/tasks.mjs';
import { tempDir } from './helpers.mjs';

async function fakeBrain(dir, { fails = false } = {}) {
  const file = path.join(dir, 'brain.mjs');
  await writeFile(
    file,
    fails
      ? '#!/usr/bin/env node\nconsole.error("could not find the file");\nprocess.exit(1);\n'
      : '#!/usr/bin/env node\nconsole.log("edited styles.css");\n',
  );
  await chmod(file, 0o755);
  return { name: 'fake', cmd: process.execPath, args: [file] };
}

describe('the worker', () => {
  test('works what is waiting and leaves proposals alone', async () => {
    const { dir, dispose } = await tempDir();
    try {
      const store = await openStore(dir);
      await store.create({ comment: 'widen the nav', status: 'open' });
      await store.create({ comment: 'a suggestion ayna made', status: 'proposed' });

      const result = await work({ projectDir: dir, brain: await fakeBrain(dir) });

      assert.equal(result.worked, 1);
      const [done, proposal] = await store.list();
      assert.equal(done.status, 'applied');
      assert.equal(
        proposal.status,
        'proposed',
        'a worker approving its own suggestion would empty that word of meaning',
      );
    } finally {
      await dispose();
    }
  });

  test('finished work is not picked up again', async () => {
    /*
      "Pending" was the first filter and it loops forever: `applied` is pending —
      done, but not yet approved — so the worker finished a task, released it,
      found it pending again and did it a second time, and a third. It ran until
      it was killed.
    */
    const { dir, dispose } = await tempDir();
    try {
      const store = await openStore(dir);
      await store.create({ comment: 'widen the nav', status: 'open' });
      const brain = await fakeBrain(dir);

      assert.equal((await work({ projectDir: dir, brain })).worked, 1);
      assert.equal((await work({ projectDir: dir, brain })).worked, 0, 'it did the same task twice');

      const [t] = await store.list();
      assert.equal(t.history.filter((h) => h.status === 'applied').length, 1);
    } finally {
      await dispose();
    }
  });

  test('a task somebody else holds is left to them', async () => {
    const { dir, dispose } = await tempDir();
    try {
      const store = await openStore(dir);
      const t = await store.create({ comment: 'widen the nav', status: 'open' });
      await store.claim(t.id, 'a-puku-session');

      const result = await work({ projectDir: dir, brain: await fakeBrain(dir) });
      assert.equal(result.worked, 0, 'two things doing one task is the failure this prevents');
      assert.equal((await store.get(t.id)).status, 'open');
    } finally {
      await dispose();
    }
  });

  test('a fault that no longer reproduces costs nothing', async () => {
    const { dir, dispose } = await tempDir();
    try {
      const store = await openStore(dir);
      const t = await store.create({ comment: 'covered: the button is behind the toast', status: 'open' });

      let brainRan = false;
      const brain = { name: 'never', cmd: process.execPath, args: ['-e', 'process.exit(0)'] };
      const result = await work({
        projectDir: dir,
        brain: new Proxy(brain, {
          get(target, key) {
            if (key === 'cmd') brainRan = true;
            return target[key];
          },
        }),
        verify: async () => [{ id: t.id, verdict: 'gone', why: 'no covered fault reported here any more' }],
      });

      assert.equal(result.tasks[0].outcome, 'already-fixed');
      assert.equal((await store.get(t.id)).status, 'obsolete');
      assert.equal(brainRan, false, 'it paid a model to fix something already fixed');
    } finally {
      await dispose();
    }
  });

  test('a fix that did not work says so rather than reporting done', async () => {
    const { dir, dispose } = await tempDir();
    try {
      const store = await openStore(dir);
      const t = await store.create({ comment: 'covered: the button is behind the toast', status: 'open' });

      let call = 0;
      const result = await work({
        projectDir: dir,
        brain: await fakeBrain(dir),
        // Gone-check first, then the after-check: still there.
        verify: async () => [{ id: t.id, verdict: ++call === 1 ? 'reproduces' : 'reproduces' }],
      });

      assert.equal(result.tasks[0].outcome, 'still-broken');
      assert.match((await store.get(t.id)).history.at(-1).note, /still reproduces/);
    } finally {
      await dispose();
    }
  });

  test('a brain that fails returns the task to the pile with the reason', async () => {
    const { dir, dispose } = await tempDir();
    try {
      const store = await openStore(dir);
      const t = await store.create({ comment: 'widen the nav', status: 'open' });

      const result = await work({ projectDir: dir, brain: await fakeBrain(dir, { fails: true }) });

      assert.equal(result.tasks[0].outcome, 'failed');
      const after = await store.get(t.id);
      assert.equal(after.status, 'open', 'a failed task must not be stranded as in_progress');
      assert.equal(after.claimedBy, null, 'nor left claimed by a worker that has gone');
    } finally {
      await dispose();
    }
  });

  test('a missing brain is a setup problem, not a failed task', async () => {
    const result = await runBrain({ name: 'nope', cmd: '/nope/not-real', args: [] }, 'do a thing', { cwd: process.cwd() });
    assert.equal(result.ok, false);
    assert.match(result.error, /not installed/);
  });

  test('any tool can be the brain', async () => {
    const cfg = { brain: 'cursor', brains: { cursor: { cmd: 'cursor-agent', args: ['--headless'] } } };
    assert.deepEqual(brainFor(cfg), { name: 'cursor', cmd: 'cursor-agent', args: ['--headless'] });
    // Puku is the default and needs no config entry.
    assert.equal(brainFor({}).cmd, 'puku');
    assert.throws(() => brainFor({}, 'nobody'), /no brain called/);
  });

  test('the prompt carries what the user marked, not a paraphrase', async () => {
    const prompt = promptFor(
      {
        comment: 'the nav is too narrow',
        selector: 'header > nav',
        styles: { width: '320px' },
        sourceCandidates: [{ file: 'src/Nav.tsx', line: 12, preview: '<nav className="nav">' }],
        regionScreenshot: '/tmp/region.png',
      },
      { url: 'http://localhost:3000/' },
    );
    for (const needle of ['the nav is too narrow', 'header > nav', 'width: 320px', 'src/Nav.tsx:12', 'region.png']) {
      assert.ok(prompt.includes(needle), `the prompt dropped ${needle}`);
    }
    assert.match(prompt, /Keep the copy/);
  });
});
