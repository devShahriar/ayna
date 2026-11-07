/*
  Whether a task still applies.

  Somebody fixing something themselves and then being asked about it anyway is
  how a task list stops being read, and once it stops being read the unsolved
  ones go with it. The division these tests protect is the whole design: a
  measured fault either reproduces or it does not, and a wish written in words
  can only ever earn a question.
*/
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { checkKindOf, applyVerdicts } from '../src/verify.mjs';
import { openStore } from '../src/tasks.mjs';
import { tempDir } from './helpers.mjs';

describe('reading what a task claims', () => {
  test('a measured fault names itself; a wish does not', () => {
    assert.equal(checkKindOf({ comment: 'covered: the Deploy button is behind the toast' }), 'covered');
    assert.equal(checkKindOf({ comment: 'lowContrast: 3.1:1 against the card' }), 'lowContrast');
    assert.equal(checkKindOf({ comment: 'make this logo bigger' }), null);
    // An explicit kind always wins over guessing from the text.
    assert.equal(checkKindOf({ checkKind: 'clipped', comment: 'anything at all' }), 'clipped');
  });
});

describe('acting on the verdicts', () => {
  test('only a measurement closes anything', async () => {
    const { dir, dispose } = await tempDir();
    try {
      const store = await openStore(dir);
      const gone = await store.create({ comment: 'covered: the button', status: 'open' });
      const changed = await store.create({ comment: 'make the logo bigger', status: 'open' });
      const same = await store.create({ comment: 'widen the nav', status: 'open' });

      const done = await applyVerdicts(store, [
        { id: gone.id, verdict: 'gone', why: 'no covered fault reported here any more' },
        { id: changed.id, verdict: 'changed', why: 'it has changed since you wrote this' },
        { id: same.id, verdict: 'unchanged' },
      ]);

      assert.deepEqual(done, { obsolete: 1, asked: 1, untouched: 1 });
      assert.equal((await store.get(gone.id)).status, 'obsolete');
      assert.equal(
        (await store.get(changed.id)).status,
        'needs_confirmation',
        'restyling a logo is not the same as making it bigger — that is a question, not a closure',
      );
      assert.equal((await store.get(same.id)).status, 'open');
    } finally {
      await dispose();
    }
  });

  test('closing carries its evidence, because nobody will read it otherwise', async () => {
    const { dir, dispose } = await tempDir();
    try {
      const store = await openStore(dir);
      const t = await store.create({ comment: 'offscreen: the card runs past the edge', status: 'open' });
      await applyVerdicts(store, [{ id: t.id, verdict: 'gone', kind: 'offscreen', why: 'no offscreen fault here any more' }]);

      const after = await store.get(t.id);
      assert.equal(after.history.at(-1).note, 'no offscreen fault here any more');
      assert.equal(after.verdict.kind, 'offscreen');
    } finally {
      await dispose();
    }
  });

  test('a page that could not be measured changes nothing', async () => {
    // Unknown is not clean. Treating it as either would be the one failure worse
    // than not checking at all.
    const { dir, dispose } = await tempDir();
    try {
      const store = await openStore(dir);
      const t = await store.create({ comment: 'covered: the button', status: 'open' });
      const done = await applyVerdicts(store, [{ id: t.id, verdict: 'unknown', why: 'the page could not be opened' }]);

      assert.equal(done.obsolete, 0);
      assert.equal((await store.get(t.id)).status, 'open');
    } finally {
      await dispose();
    }
  });

  test('an element that has gone is asked about, not assumed', async () => {
    const { dir, dispose } = await tempDir();
    try {
      const store = await openStore(dir);
      const t = await store.create({ comment: 'make the logo bigger', selector: 'img.logo', status: 'open' });
      await applyVerdicts(store, [
        { id: t.id, verdict: 'element-gone', why: 'the element it was about is no longer on the page' },
      ]);
      assert.equal((await store.get(t.id)).status, 'needs_confirmation');
    } finally {
      await dispose();
    }
  });

  test('verifyTasks navigates to each task URL and prevents cross-talk across routes', async () => {
    const http = await import('node:http');
    const { openBrowser } = await import('../src/browser.mjs');
    const { verifyTasks } = await import('../src/verify.mjs');

    const visited = [];
    const server = http.createServer((req, res) => {
      visited.push(req.url);
      res.writeHead(200, { 'Content-Type': 'text/html' });
      if (req.url === '/pricing') {
        res.end('<!DOCTYPE html><html><body><h1 class="pricing-title">Pricing</h1></body></html>');
      } else {
        res.end('<!DOCTYPE html><html><body><h1 class="home-title">Home</h1></body></html>');
      }
    });

    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = server.address().port;
    const baseUrl = `http://127.0.0.1:${port}/`;
    const browser = await openBrowser({ headless: true });

    try {
      const tasks = [
        { id: 'task-1', url: `${baseUrl}`, selector: '.home-title' },
        { id: 'task-2', url: `${baseUrl}pricing`, selector: '.pricing-title' },
      ];

      const verdicts = await verifyTasks({
        browser,
        url: baseUrl,
        tasks,
      });

      assert.equal(verdicts.length, 2);
      assert.ok(visited.includes('/'));
      assert.ok(visited.includes('/pricing'));
      const byId = Object.fromEntries(verdicts.map((v) => [v.id, v.verdict]));
      assert.notEqual(byId['task-1'], 'element-gone');
      assert.notEqual(byId['task-2'], 'element-gone');
    } finally {
      await browser.close();
      await new Promise((resolve) => server.close(resolve));
    }
  });
});
