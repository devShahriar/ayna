/*
  Visual QA an agent can do for itself.

  Everything else in ayna assumes somebody is pointing — a window, a click, a
  dragged box. An agent has no hands. It can name a thing and needs back what a
  person gets from pointing at it: the pixels, and what is measurably wrong
  inside them. Headless, so it costs a second and steals no window.

  The scoping is the whole value. An audit of a large app answers with findings
  from everywhere, and an agent checking the toolbar it just changed then has to
  guess which of them are its business.
*/
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { openBrowser } from '../src/browser.mjs';
import { inspect, summarizeInspection } from '../src/inspect.mjs';
import { hasBrowser } from './helpers.mjs';

const PAGE = `
  <style>
    body { margin: 0; font-family: system-ui }
    .toolbar { position: relative; padding: 12px; background: #eee; display: flex; gap: 8px }
    .toast { position: absolute; left: 10px; top: 10px; background: #333; color: #fff; padding: 8px 14px }
    .panel { padding: 40px }
    .faint { color: #bbbbbb }
    .later { display: none; padding: 20px }
  </style>
  <div class="toolbar">
    <button id="deploy">Deploy</button><button>Undo</button>
    <div class="toast">5 pending changes</div>
  </div>
  <div class="panel"><h1>Panel</h1><p class="faint">low contrast copy</p>
    <button id="open">Open the rest</button></div>
  <div class="later"><button id="hidden-btn">Only after opening</button></div>
  <script>
    // Not #deploy: the toast covers it, which is the fault this fixture exists
    // to demonstrate — Playwright refuses to click a covered control, and so
    // would a person.
    document.getElementById('open').addEventListener('click', () => {
      document.querySelector('.later').style.display = 'block';
    });
  </script>`;

function serve() {
  const srv = http.createServer((_q, res) => {
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end(`<!doctype html><body>${PAGE}</body>`);
  });
  return new Promise((resolve) =>
    srv.listen(0, () => resolve({ srv, url: `http://127.0.0.1:${srv.address().port}/` })),
  );
}

describe('inspecting a portion, headlessly', { skip: !hasBrowser && 'AYNA_SKIP_BROWSER set' }, () => {
  let browser;
  let srv;
  let url;
  let dir;

  before(async () => {
    browser = await openBrowser({ headless: true });
    ({ srv, url } = await serve());
    dir = await mkdtemp(path.join(tmpdir(), 'ayna-inspect-'));
  });
  after(async () => {
    await browser?.close().catch(() => {});
    srv?.close();
    await rm(dir, { recursive: true, force: true });
  });

  const look = (opts) => inspect({ browser, url, outDir: dir, viewport: { width: 1000, height: 700 }, ...opts });

  test('answers about the part it was asked about, not the whole page', async () => {
    const toolbar = await look({ selector: '.toolbar', label: 'toolbar' });
    const panel = await look({ selector: '.panel', label: 'panel' });

    assert.ok(toolbar.counts.covered > 0, 'the toast covers the toolbar buttons');
    assert.equal(panel.counts.covered, 0, 'the panel has no covered controls of its own');

    // Both see the same page; only their scope differs. That is the point.
    assert.equal(panel.pageCounts.covered, toolbar.pageCounts.covered);
    assert.ok(panel.pageCounts.lowContrast > 0, 'the faint copy is somewhere on this page');
    assert.equal(
      panel.clean,
      true,
      'a region with nothing wrong in it is clean even when the page is not',
    );
  });

  test('hands back the pixels as well as the numbers', async () => {
    // An agent that cannot see the thing is back to reading CSS, which is the
    // one habit this whole tool exists to break.
    const r = await look({ selector: '.toolbar', label: 'pixels' });
    assert.ok(existsSync(r.screenshot), 'no crop was written');
    assert.equal(r.tag, 'div');
    assert.ok(r.rect.width > 100 && r.rect.height > 10);
    assert.match(r.text, /Deploy/);
    assert.ok(r.styles.backgroundColor, 'computed styles come too, so it can see what it is overriding');
  });

  test('an explicit rectangle is taken as given', async () => {
    // An agent that worked a box out from a previous screenshot means precisely
    // those pixels, and should not have to invent a selector for them.
    const r = await look({ region: { x: 0, y: 0, width: 400, height: 90 }, label: 'rect' });
    assert.equal(r.found, true);
    assert.ok(r.counts.covered > 0, 'the same covered buttons fall inside this box');
    assert.ok(existsSync(r.screenshot));
  });

  test('a selector that matches nothing says so plainly', async () => {
    const r = await look({ selector: '.does-not-exist', label: 'missing' });
    assert.equal(r.found, false);
    assert.match(r.why, /no element matches/);
    assert.match(summarizeInspection(r), /^✗/);
  });

  test('it can look at something only reachable by clicking', async () => {
    /*
      A region that only exists after an interaction is exactly the region worth
      checking, and it is invisible to anything that only loads the page.
    */
    const closed = await look({ selector: '#hidden-btn', label: 'closed' });
    assert.equal(closed.found, false, 'it is display:none until the panel is opened');

    const opened = await look({
      selector: '#hidden-btn',
      // `on`, not `selector` — the same step shape `flow` and `qa` already use,
      // so a journey written once works everywhere.
      steps: [{ do: 'click', on: '#open' }],
      label: 'opened',
    });
    assert.equal(opened.found, true, 'after the click it is there and measurable');
    assert.ok(opened.rect.width > 0);
  });

  test('the summary is a line an agent can act on without parsing', async () => {
    const bad = await look({ selector: '.toolbar', label: 'summary-bad' });
    const good = await look({ selector: '.panel', label: 'summary-good' });
    assert.match(summarizeInspection(bad), /covered/);
    assert.match(summarizeInspection(good), /nothing measurable wrong here/);
    // And it says the page is not clean elsewhere, so "fine here" is not read as
    // "fine everywhere".
    assert.match(summarizeInspection(good), /elsewhere on the page/);
  });
});
