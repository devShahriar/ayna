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
import { Buffer } from 'node:buffer';
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

/*
  A card an agent built, in a sandboxed srcDoc iframe with no allow-same-origin.

  This is the shape that matters: the top document cannot reach into it at all —
  its scripts, its styles and its DOM are behind an opaque origin — so anything
  measuring only the top document sees a rectangle and reports it clean. A card
  with a real fault that comes back clean is the worst answer a QA gate can give,
  because it is confident and wrong.
*/
const CARD = `<style>
  body { margin: 0; font-family: system-ui; background: #fff }
  .kc { width: 260px; padding: 10px; border: 1px solid #ccc }
  .kc h3 { margin: 0 0 6px; font-size: 14px }
  .kc .label { white-space: nowrap; overflow: hidden; width: 90px }
</style>
<div class="kc">
  <h3>EC2 instance</h3>
  <div class="label">a label far too long for the box it lives in</div>
  <div style="position:relative">
    <button id="go">Deploy</button>
    <span style="position:absolute;inset:0;background:rgba(0,0,0,.02)"></span>
  </div>
</div>`;

function serveFramed() {
  const srv = http.createServer((_q, res) => {
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end(
      `<!doctype html><body style="margin:0;padding:24px;background:#111">` +
        `<iframe id="card" sandbox="allow-scripts" srcdoc='${CARD.replace(/'/g, '&apos;')}' ` +
        `style="width:300px;height:180px;border:2px solid #444;padding:4px"></iframe>` +
        `<iframe id="card-2" sandbox="allow-scripts" srcdoc='${CARD.replace(/'/g, '&apos;')}' ` +
        `style="width:300px;height:180px;border:2px solid #444;padding:4px"></iframe>` +
        `</body>`,
    );
  });
  return new Promise((resolve) =>
    srv.listen(0, () => resolve({ srv, url: `http://127.0.0.1:${srv.address().port}/` })),
  );
}

describe('inside a sandboxed frame', { skip: !hasBrowser && 'AYNA_SKIP_BROWSER set' }, () => {
  let browser;
  let srv;
  let url;
  let dir;

  before(async () => {
    browser = await openBrowser({ headless: true });
    ({ srv, url } = await serveFramed());
    dir = await mkdtemp(path.join(tmpdir(), 'ayna-frame-'));
  });
  after(async () => {
    await browser?.close().catch(() => {});
    srv?.close();
    await rm(dir, { recursive: true, force: true });
  });

  const look = (opts) => inspect({ browser, url, outDir: dir, viewport: { width: 1000, height: 700 }, ...opts });

  test('the acceptance case: a real fault inside an opaque-origin card', async () => {
    const r = await look({ frame: 'iframe#card', selector: '.kc', label: 'accept' });

    assert.equal(r.found, true);
    assert.equal(r.clean, false, 'the card has a covered control in it');
    assert.ok(
      Object.values(r.counts).some((n) => n > 0),
      `expected a fault in findings, got ${JSON.stringify(r.counts)}`,
    );
    assert.ok(existsSync(r.screenshot), 'a crop clipped to the card');
  });

  test('without the frame, the same selector simply is not there', async () => {
    // And says so. The failure that matters is not this one — it is reporting
    // clean for a card nothing ever looked at.
    const r = await look({ selector: '.kc', label: 'top-only' });
    assert.equal(r.found, false);
    assert.notEqual(r.clean, true, 'could not look must never read as looks fine');
    assert.match(r.why, /no element matches/);
  });

  test('the rect comes back in page coordinates, so a clip still works', async () => {
    /*
      Coordinates inside a frame start at that frame's origin. The offset is the
      iframe's box plus its border and padding — 24px of page padding, 2px of
      border and 4px of padding here — and getting only the position right puts
      the crop a few pixels out, which reads as a rounding error rather than as a
      wrong frame of reference.
    */
    const r = await look({ frame: 'iframe#card', selector: '.kc', label: 'coords' });
    assert.deepEqual(r.frameRect, { x: 0, y: 0, width: r.frameRect.width, height: r.frameRect.height });
    assert.equal(r.rect.x, 30, 'page padding 24 + border 2 + iframe padding 4');
    assert.equal(r.rect.y, 30);
    assert.deepEqual(r.frameOffset, { x: 30, y: 30 });
  });

  test('the piercing form says the same thing', async () => {
    const pierced = await look({ selector: 'iframe#card >> .kc', label: 'pierce' });
    const explicit = await look({ frame: 'iframe#card', selector: '.kc', label: 'explicit' });
    assert.equal(pierced.found, true);
    assert.deepEqual(pierced.rect, explicit.rect);
    assert.equal(pierced.clean, explicit.clean);
  });

  test('a frame that is not there fails closed', async () => {
    const r = await look({ frame: 'iframe#nope', selector: '.kc', label: 'noframe' });
    assert.equal(r.found, false);
    assert.notEqual(r.clean, true);
    assert.match(r.why, /no frame matches/);
  });

  test('the PNG can come back inline, for a caller with no shared filesystem', async () => {
    const r = await look({ frame: 'iframe#card', selector: '.kc', image: true, label: 'inline' });
    assert.ok(r.image && r.image.length > 100, 'no base64 image returned');
    // Real PNG bytes, not a string that happens to be long.
    assert.equal(Buffer.from(r.image, 'base64').subarray(1, 4).toString(), 'PNG');
  });
});

describe('reaching the page at all', { skip: !hasBrowser && 'AYNA_SKIP_BROWSER set' }, () => {
  test('an unreachable page is not a page with a fault', async () => {
    /*
      "The server is down" and "the card is broken" both mean the work is not
      done, and only one of them is the agent's to fix. Reverting good work over a
      connection refused is a mistake this project has already made once.
    */
    const browser = await openBrowser({ headless: true });
    const dir = await mkdtemp(path.join(tmpdir(), 'ayna-unreach-'));

    /*
      A port that was real a moment ago and is not now, so the refusal is
      genuine. A made-up low port gets ERR_UNSAFE_PORT from Chrome instead, which
      is a configuration complaint rather than a transport failure and would have
      tested the wrong thing.
    */
    const closed = await new Promise((resolve) => {
      const s = http.createServer();
      s.listen(0, () => {
        const { port } = s.address();
        s.close(() => resolve(port));
      });
    });

    try {
      const r = await inspect({
        browser,
        url: `http://127.0.0.1:${closed}/`,
        selector: '.kc',
        outDir: dir,
        viewport: { width: 800, height: 600 },
      });
      assert.equal(r.found, false);
      assert.equal(r.transportError, true);
      assert.notEqual(r.clean, true);
      assert.match(summarizeInspection(r), /unreachable/);
    } finally {
      await browser.close().catch(() => {});
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe('running somewhere that is not a laptop', () => {
  test('the sandbox flags no longer require pretending to be CI', async () => {
    /*
      They were gated on CI alone, which is true of a CI runner and of nothing
      else — so anyone running ayna in a container had to claim to be CI to get
      Chrome to start as root. That is a lie in an environment variable, and the
      sort that quietly changes other tools' behaviour too.
    */
    const { launchArgs, chromeChannel } = await import('../src/browser.mjs');
    const before = process.env.AYNA_NO_SANDBOX;
    try {
      delete process.env.AYNA_NO_SANDBOX;
      const plain = launchArgs();

      process.env.AYNA_NO_SANDBOX = '1';
      const asked = launchArgs();
      assert.ok(asked.includes('--no-sandbox'));
      assert.ok(asked.includes('--disable-dev-shm-usage'), '64MB of /dev/shm looks like random tab deaths');

      // On a developer's machine nothing changes.
      if (!process.env.CI) assert.ok(!plain.includes('--no-sandbox'));
      // And the flags that make a verdict reproducible are always there.
      assert.ok(asked.includes('--force-color-profile=srgb'));
    } finally {
      if (before === undefined) delete process.env.AYNA_NO_SANDBOX;
      else process.env.AYNA_NO_SANDBOX = before;
    }
    assert.equal(typeof chromeChannel(), 'string');
  });

  test('the browser channel is a setting, not a fact', async () => {
    // Real Chrome is ~400MB of container image for something that only has to
    // render a page; chromium is a tenth of that and renders the same.
    const { chromeChannel } = await import('../src/browser.mjs');
    const before = process.env.AYNA_CHROME_CHANNEL;
    try {
      delete process.env.AYNA_CHROME_CHANNEL;
      assert.equal(chromeChannel(), 'chrome');
      process.env.AYNA_CHROME_CHANNEL = 'chromium';
      assert.equal(chromeChannel(), 'chromium');
    } finally {
      if (before === undefined) delete process.env.AYNA_CHROME_CHANNEL;
      else process.env.AYNA_CHROME_CHANNEL = before;
    }
  });

  test('a missing browser says which one it wanted', async () => {
    const { openBrowser } = await import('../src/browser.mjs');
    await assert.rejects(
      () => openBrowser({ headless: true, channel: 'not-a-browser' }),
      /AYNA_CHROME_CHANNEL|not-a-browser/,
      'a generic launch failure leaves the reader guessing what to install',
    );
  });

  test('a missing browser in openPersistentContext says which one it wanted', async () => {
    const { openPersistentContext } = await import('../src/browser.mjs');
    const tmp = await mkdtemp(path.join(tmpdir(), 'ayna-profile-'));
    try {
      await assert.rejects(
        () => openPersistentContext({ profileDir: tmp, headless: true, channel: 'not-a-browser' }),
        /AYNA_CHROME_CHANNEL|not-a-browser/,
        'a persistent launch failure leaves the reader guessing what to install',
      );
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });
});
