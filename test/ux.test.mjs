/*
  The bugs you only find by using it.

  Each of these was reported as "it lags" or "the window jumps" — descriptions that
  point at no line of code. They were found by driving the real overlay and
  measuring, and they are pinned here because every one of them is invisible in a
  screenshot and silent in a normal test.
*/
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { openBrowser, gotoSettled } from '../src/browser.mjs';
import { runAnnotate } from '../src/annotate.mjs';
import { hasBrowser } from './helpers.mjs';

/** A server that behaves like a real dev server: it never stops talking. */
function pollingServer(bodyHtml, { doctype = true } = {}) {
  const srv = http.createServer((req, res) => {
    if (req.url.startsWith('/poll')) {
      // Long-poll: headers withheld, so the request stays in flight forever.
      setTimeout(() => {
        res.writeHead(200);
        res.end('{}');
      }, 25_000).unref();
      return;
    }
    if (req.url.startsWith('/api')) {
      res.writeHead(200);
      res.end('{}');
      return;
    }
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end(
      (doctype ? '<!doctype html>' : '') +
        `<body style="margin:0">${bodyHtml}
         <script>fetch('/poll'); setInterval(() => fetch('/api'), 400);</script></body>`,
    );
  });
  return new Promise((resolve) =>
    srv.listen(0, () => resolve({ srv, url: `http://127.0.0.1:${srv.address().port}/` })),
  );
}

const cards = (n) =>
  Array.from({ length: n }, (_, i) => `<div class="card" id="c${i}"><h3>Card ${i}</h3><button>Go ${i}</button></div>`).join('');
const CARD_CSS = '<style>.card{border:1px solid #ccc;padding:10px;margin:6px}</style>';

describe('a page that never goes idle', { skip: !hasBrowser && 'AYNA_SKIP_BROWSER set' }, () => {
  let browser;
  before(async () => {
    browser = await openBrowser({ headless: true });
  });
  after(async () => {
    await browser?.close().catch(() => {});
  });

  test('loads promptly instead of waiting out the timeout', async () => {
    /*
      Every load waited for `networkidle` — 500ms with no requests in flight. An app
      that polls never has that, so the wait ran to the full 30s timeout on each
      one. Against a page polling every 400ms this measured 30049ms; the same load
      without it, 222ms. That is the freeze, and on annotate's `goto` — the one
      call site with no catch — it ended in a thrown error rather than a window.
    */
    const { srv, url } = await pollingServer('<h1>Dashboard</h1>');
    const context = await browser.newContext({ viewport: { width: 900, height: 700 } });
    try {
      const page = await context.newPage();
      const started = Date.now();
      await gotoSettled(page, url);
      const took = Date.now() - started;
      assert.ok(took < 10_000, `a polling page should not stall the load (took ${took}ms)`);
      assert.equal(await page.evaluate(() => document.querySelector('h1').textContent), 'Dashboard');
    } finally {
      await context.close().catch(() => {});
      srv.close();
    }
  });

  test('the review window opens on it at all', async () => {
    const { srv, url } = await pollingServer('<h1 class="title">Dashboard</h1>');
    const dir = await mkdtemp(path.join(tmpdir(), 'ayna-poll-'));
    try {
      let openedAfter = null;
      const started = Date.now();
      await runAnnotate({
        browser,
        url,
        outDir: path.join(dir, 'out'),
        projectDir: dir,
        viewport: { width: 1000, height: 760 },
        onReady: async (page) => {
          openedAfter = Date.now() - started;
          await page.close();
        },
      });
      assert.ok(openedAfter !== null, 'the window never became usable');
      assert.ok(openedAfter < 15_000, `window took ${openedAfter}ms to become usable`);
    } finally {
      srv.close();
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe('the comment box stays reachable', { skip: !hasBrowser && 'AYNA_SKIP_BROWSER set' }, () => {
  let browser;
  before(async () => {
    browser = await openBrowser({ headless: true });
  });
  after(async () => {
    await browser?.close().catch(() => {});
  });

  /*
    Placement measured the viewport with documentElement.clientHeight, which is the
    viewport only in standards mode. Without a doctype the browser is in quirks
    mode and it returns the content height instead — 4344 on an 800px window. Every
    "is there room below?" test passed trivially, the box never flipped above its
    anchor, and "Add comment" rendered below the bottom of the screen. Worse, the
    stranded box stayed open and ate every click after it: 8 of 12 comments could
    be filed, then none.
  */
  for (const doctype of [true, false]) {
    test(`every comment can be filed (${doctype ? 'standards' : 'quirks'} mode)`, async () => {
      const { srv, url } = await pollingServer(CARD_CSS + cards(40), { doctype });
      const dir = await mkdtemp(path.join(tmpdir(), 'ayna-place-'));
      try {
        let saved = 0;
        let offScreen = 0;
        await runAnnotate({
          browser,
          url,
          outDir: path.join(dir, 'out'),
          projectDir: dir,
          viewport: { width: 1200, height: 800 },
          onReady: async (page) => {
            for (let i = 0; i < 10; i++) {
              await page.click(`#c${i} h3`, { timeout: 8000 }).catch(() => {});
              const box = await page
                .waitForSelector('.ayna-ov-pop textarea', { timeout: 8000 })
                .catch(() => null);
              if (!box) continue;
              await page.waitForTimeout(250); // let the crop arrive and grow the box

              const where = await page.evaluate(() => {
                const r = document.querySelector('.ayna-ov-save').getBoundingClientRect();
                return { vh: innerHeight, top: Math.round(r.top), bottom: Math.round(r.bottom) };
              });
              if (where.bottom > where.vh || where.top < 0) offScreen += 1;

              await page.fill('.ayna-ov-pop textarea', `comment ${i}`);
              const clicked = await page
                .click('.ayna-ov-save', { timeout: 5000 })
                .then(() => true)
                .catch(() => false);
              if (clicked) saved += 1;
              await page.waitForTimeout(120);
            }
            await page.close();
          },
        });
        assert.equal(offScreen, 0, `${offScreen} comment boxes were placed off screen`);
        assert.equal(saved, 10, `only ${saved} of 10 comments could be filed`);
      } finally {
        srv.close();
        await rm(dir, { recursive: true, force: true });
      }
    });
  }
});

describe('living with the window open', { skip: !hasBrowser && 'AYNA_SKIP_BROWSER set' }, () => {
  let browser;
  before(async () => {
    browser = await openBrowser({ headless: true });
  });
  after(async () => {
    await browser?.close().catch(() => {});
  });

  test('a fix does not throw you back to the top of the page', async () => {
    const { srv, url } = await pollingServer(
      '<h1>Top</h1><div style="height:2000px"></div><footer class="deep">Footer</footer><div style="height:800px"></div>',
    );
    const dir = await mkdtemp(path.join(tmpdir(), 'ayna-scroll-'));
    try {
      let before = null;
      let after = null;
      await runAnnotate({
        browser,
        url,
        outDir: path.join(dir, 'out'),
        projectDir: dir,
        viewport: { width: 1000, height: 760 },
        onReady: async (page) => {
          await page.click('.deep');
          await page.waitForSelector('.ayna-ov-pop textarea', { timeout: 10000 });
          await page.fill('.ayna-ov-pop textarea', 'deep comment');
          await page.click('.ayna-ov-save');
          await page.waitForTimeout(400);
          await page.click('[data-act=send]');
          await page.waitForTimeout(300);
          before = await page.evaluate(() => scrollY);
          await writeFile(path.join(dir, 'out', 'applied'), '1');
          await page.waitForFunction(() => document.querySelector('[data-act=close]') !== null, {
            timeout: 20000,
          });
          await page.waitForTimeout(400);
          after = await page.evaluate(() => scrollY);
          await page.click('[data-act=close]');
        },
      });
      assert.ok(before > 100, 'the fixture should have scrolled down to comment');
      assert.ok(
        Math.abs(after - before) < 60,
        `the reload moved them from ${before} to ${after}`,
      );
    } finally {
      srv.close();
      await rm(dir, { recursive: true, force: true });
    }
  });

  test('resizing the window does not call back into Node on every frame', async () => {
    /*
      The resize handler rebuilt every review marker, and rebuilding asks Node for
      the comment list over the exposed-function bridge. Coalesced to one per
      animation frame, dragging a window to full screen fired roughly sixty round
      trips a second — the stutter people describe while resizing. Positions are
      all that change during a resize, so they are now recomputed in the page, and
      the real rebuild happens once the dragging stops.
    */
    const { srv, url } = await pollingServer(CARD_CSS + cards(20));
    const dir = await mkdtemp(path.join(tmpdir(), 'ayna-resize-'));
    try {
      let duringDrag = null;
      let afterSettle = null;
      await runAnnotate({
        browser,
        url,
        outDir: path.join(dir, 'out'),
        projectDir: dir,
        viewport: { width: 1200, height: 800 },
        onReady: async (page) => {
          for (let i = 0; i < 6; i++) {
            await page.click(`#c${i} h3`);
            await page.waitForSelector('.ayna-ov-pop textarea', { timeout: 10000 });
            await page.fill('.ayna-ov-pop textarea', `comment ${i}`);
            await page.click('.ayna-ov-save');
            await page.waitForTimeout(120);
          }
          await page.click('[data-act=send]');
          await page.waitForTimeout(300);
          await writeFile(path.join(dir, 'out', 'applied'), '1');
          await page.waitForFunction(() => document.querySelector('[data-act=close]') !== null, {
            timeout: 20000,
          });
          await page.waitForTimeout(500); // review markers are live now

          await page.evaluate(() => {
            window.__calls = 0;
            const real = window.__aynaList;
            window.__aynaList = (...a) => {
              window.__calls += 1;
              return real(...a);
            };
          });
          for (let i = 0; i < 25; i++) {
            await page.setViewportSize({ width: 1200 - i * 14, height: 800 });
          }
          duringDrag = await page.evaluate(() => window.__calls);
          await page.waitForTimeout(600);
          afterSettle = await page.evaluate(() => window.__calls);
          await page.click('[data-act=close]');
        },
      });
      assert.ok(
        duringDrag <= 2,
        `${duringDrag} round trips to Node during 25 resize steps — should be none`,
      );
      assert.ok(afterSettle > duringDrag, 'the markers must still be rebuilt once it settles');
    } finally {
      srv.close();
      await rm(dir, { recursive: true, force: true });
    }
  });
});
