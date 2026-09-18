/*
  Judge the overlay by the same measurement it judges everyone else with.

  ayna's own bar sat at bottom:20px, floating over whatever the app kept down
  there — on a canvas editor, the zoom and history controls. The user's report was
  "sometimes I can't click anything", and their own task list already contained
  the finding: "Your bottom toolbar covers Excalidraw's own controls". ayna
  reported the fault and then committed it.

  The `covered` check exists and would have caught this on day one, except that it
  deliberately excludes `[data-ayna]` from its results so a review does not report
  itself. That exclusion is right for auditing an app and exactly wrong for
  auditing the reviewer, so these tests run the same check with it removed.
*/
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { openBrowser } from '../src/browser.mjs';
import { CHECKS } from '../src/audit.mjs';
import { runAnnotate } from '../src/annotate.mjs';
import { hasBrowser } from './helpers.mjs';

/** The audit, but with ayna's own elements eligible to be found as coverers. */
const CHECKS_INCLUDING_OURS = CHECKS.replace(
  'const ours = (el) => !!(el.closest && el.closest(\'[data-ayna]\'));',
  'const ours = () => false;',
);

/** A page whose controls hug all four edges — the layout that exposed this. */
const EDGES = `
  <div id="topbar" style="position:fixed;top:0;left:0;right:0;height:44px;background:#eee">
    <button id="nav-a">Home</button><button id="nav-b">Docs</button>
  </div>
  <div id="bottombar" style="position:fixed;bottom:0;left:0;right:0;height:44px;background:#eee">
    <button id="zoom-in">+</button><button id="zoom-out">-</button><button id="undo">undo</button>
  </div>
  <div id="left" style="position:fixed;left:0;top:60px;width:48px;background:#ddd">
    <button id="tool-a">A</button>
  </div>
  <main style="padding:60px 60px 60px 60px"><h1 class="title">Canvas</h1>
    <button id="middle">In the middle</button></main>`;

/** A full-viewport pinned app, which ignores padding on the root entirely. */
const PINNED = `
  <div id="app" style="position:fixed;inset:0;background:#123">
    <h1 class="title" style="color:#fff;margin:0;padding:8px">Diagram</h1>
    <div style="position:absolute;bottom:8px;left:8px">
      <button id="zoom-in">+</button><button id="undo">undo</button>
    </div>
  </div>`;

function serve(body) {
  const srv = http.createServer((_q, res) => {
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end(`<!doctype html><body style="margin:0">${body}</body>`);
  });
  return new Promise((resolve) =>
    srv.listen(0, () => resolve({ srv, url: `http://127.0.0.1:${srv.address().port}/` })),
  );
}

describe('the overlay must not sit on the app', { skip: !hasBrowser && 'AYNA_SKIP_BROWSER set' }, () => {
  let browser;
  before(async () => {
    browser = await openBrowser({ headless: true });
  });
  after(async () => {
    await browser?.close().catch(() => {});
  });

  /** Drive the window into each phase and report what ayna covers in each. */
  async function coveredByAyna(body) {
    const { srv, url } = await serve(body);
    const dir = await mkdtemp(path.join(tmpdir(), 'ayna-chrome-'));
    const found = {};
    try {
      await runAnnotate({
        browser,
        url,
        outDir: path.join(dir, 'out'),
        projectDir: dir,
        viewport: { width: 1000, height: 700 },
        onReady: async (page) => {
          const measure = async (phase) => {
            await page.waitForTimeout(400);
            const result = await page.evaluate(CHECKS_INCLUDING_OURS);
            found[phase] = (result.covered ?? []).filter((c) => /ayna/.test(c.coveredBy ?? ''));
            // Clicking a control at each edge is the other half of the claim.
            found[`${phase}:clicks`] = await page.evaluate(() =>
              ['#zoom-in', '#undo', '#nav-a', '#middle']
                .filter((sel) => document.querySelector(sel))
                .filter((sel) => {
                  const r = document.querySelector(sel).getBoundingClientRect();
                  const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
                  return hit && !document.querySelector(sel).contains(hit) && hit.closest('[data-ayna]');
                }),
            );
          };

          await measure('comment');

          await page.click('.title');
          await page.waitForSelector('.ayna-ov-pop textarea', { timeout: 10000 });
          await page.fill('.ayna-ov-pop textarea', 'a note');
          await page.click('.ayna-ov-save');
          await page.waitForTimeout(300);
          await page.click('[data-act=send]');
          await page.waitForSelector('.ayna-ov-waiting', { timeout: 10000 });
          await measure('waiting');

          await page.click('[data-act=applied]');
          await page.waitForFunction(() => document.querySelector('[data-act=close]') !== null, {
            timeout: 20000,
          });
          await measure('review');
          await page.close();
        },
      });
      return found;
    } finally {
      srv.close();
      await rm(dir, { recursive: true, force: true });
    }
  }

  test('covers no control on a page with edge-to-edge chrome', async () => {
    const found = await coveredByAyna(EDGES);
    for (const phase of ['comment', 'waiting', 'review']) {
      assert.deepEqual(
        found[phase].map((c) => `${c.element} under ${c.coveredBy}`),
        [],
        `ayna covered the app's own controls while ${phase}`,
      );
      assert.deepEqual(found[`${phase}:clicks`], [], `controls unclickable while ${phase}`);
    }
  });

  test('covers no control on a pinned full-viewport app', async () => {
    // A canvas editor ignores padding on the root — it is positioned against the
    // viewport, not the document. This is the case the cheap fix does not cover.
    const found = await coveredByAyna(PINNED);
    for (const phase of ['comment', 'waiting', 'review']) {
      assert.deepEqual(
        found[phase].map((c) => `${c.element} under ${c.coveredBy}`),
        [],
        `ayna covered a pinned app's controls while ${phase}`,
      );
      assert.deepEqual(found[`${phase}:clicks`], [], `controls unclickable while ${phase}`);
    }
  });
});

/*
  Resizing must not play a slideshow of the page at two different heights.

  The space reservation sets a height, forces a synchronous reflow to read the
  result, and sets the height again to take off the overshoot a collapsed margin
  causes. Once, that is a correction. On a resize it ran on every animation
  frame, so going full screen laid the page out at one height and immediately
  re-laid it at another, for the whole of the transition — which is what "there
  is some flickering when we make the window full screen" describes. Not a
  repaint: two layouts per frame.

  The correction is deferred to the moment the window stops moving, so what has
  to be proved is that it still happens — following cheaply is only acceptable
  if the final geometry is the same one the expensive path would have produced.
*/
describe('resizing the review window', { skip: !hasBrowser && 'AYNA_SKIP_BROWSER set' }, () => {
  let browser;
  before(async () => {
    browser = await openBrowser({ headless: true });
  });
  after(async () => {
    await browser?.close().catch(() => {});
  });

  // A first child with a top margin: the collapse the corrective pass exists for.
  const MARGINY = '<main><h1 class="title" style="margin-top:40px">Hello</h1><p>body</p></main>';

  test('the page still fits exactly once the window stops moving', async () => {
    const { srv, url } = await serve(MARGINY);
    const dir = await mkdtemp(path.join(tmpdir(), 'ayna-resize-'));
    try {
      const sizes = [];
      await runAnnotate({
        browser,
        url,
        outDir: path.join(dir, 'out'),
        projectDir: dir,
        viewport: { width: 1000, height: 700 },
        onReady: async (page) => {
          const overshootNow = () =>
            page.evaluate(() => Math.round(document.body.getBoundingClientRect().bottom - innerHeight));

          for (const [w, h] of [[1000, 700], [1400, 900], [820, 620], [1600, 1000]]) {
            await page.setViewportSize({ width: w, height: h });
            // Longer than the 120ms settle: this is the state the user is left in.
            await page.waitForTimeout(500);
            sizes.push({ w, h, overshoot: await overshootNow() });
          }
          await page.close();
        },
      });

      for (const s of sizes) {
        assert.ok(
          s.overshoot <= 1,
          `at ${s.w}x${s.h} the page ran ${s.overshoot}px past the window — the deferred correction never landed`,
        );
      }
    } finally {
      srv.close();
      await rm(dir, { recursive: true, force: true });
    }
  });
});

/*
  A resize must not re-lay the app out on every frame.

  The user's report was that the website — not the overlay — flickers while the
  window is resized. Measuring found no wrong values and no oscillation: through
  a 24-step resize the bar stayed 53px and the rail stayed 216px, so nothing the
  reservation decides actually changed. What changed was that it rewrote height,
  width and transform on <body> in pixels on every animation frame, and a
  transform on body makes it the containing block for every fixed descendant, so
  each write re-rasterized that whole layer.

  The page's box is a calc() against 100dvh/100dvw now, so the browser follows
  the window itself. MEASURED after: 0 style writes during the drag, down from
  three per frame, and one forced layout at the end for the collapsed-margin
  correction.
*/
describe('a resize costs nothing per frame', { skip: !hasBrowser && 'AYNA_SKIP_BROWSER set' }, () => {
  let browser;
  before(async () => {
    browser = await openBrowser({ headless: true });
  });
  after(async () => {
    await browser?.close().catch(() => {});
  });

  test('dragging the window writes no styles and forces no layout', async () => {
    const { srv, url } = await serve('<main><h1 class="title" style="margin-top:40px">Hi</h1><p>body</p></main>');
    const dir = await mkdtemp(path.join(tmpdir(), 'ayna-perframe-'));
    try {
      let during = null;
      let after = null;
      await runAnnotate({
        browser,
        url,
        outDir: path.join(dir, 'out'),
        projectDir: dir,
        viewport: { width: 1000, height: 700 },
        onReady: async (page) => {
          await page.waitForTimeout(700);
          await page.evaluate(() => {
            window.__w = { writes: 0, reads: 0 };
            const sp = document.body.style.setProperty.bind(document.body.style);
            document.body.style.setProperty = (...a) => {
              window.__w.writes += 1;
              return sp(...a);
            };
            const gbcr = Element.prototype.getBoundingClientRect;
            Element.prototype.getBoundingClientRect = function (...a) {
              if (this === document.body) window.__w.reads += 1;
              return gbcr.apply(this, a);
            };
          });

          for (let i = 0; i < 20; i++) {
            await page.setViewportSize({ width: 1000 + i * 30, height: 700 + i * 10 });
            await page.waitForTimeout(16);
          }
          during = await page.evaluate(() => ({ ...window.__w }));
          await page.waitForTimeout(500); // past the 120ms settle
          after = await page.evaluate(() => ({ ...window.__w }));
          await page.close();
        },
      });

      assert.equal(during.writes, 0, `${during.writes} style writes during a drag — the per-frame relayout is back`);
      assert.equal(during.reads, 0, `${during.reads} forced layouts during a drag`);
      // The correction still has to happen, just once, and only at the end.
      assert.ok(after.reads <= 2, `${after.reads} forced layouts after settling — expected the single correction`);
    } finally {
      srv.close();
      await rm(dir, { recursive: true, force: true });
    }
  });

  test('the page still tracks the window while nothing runs', async () => {
    const { srv, url } = await serve('<main><h1 class="title">Hi</h1></main>');
    const dir = await mkdtemp(path.join(tmpdir(), 'ayna-track-'));
    try {
      const seen = [];
      await runAnnotate({
        browser,
        url,
        outDir: path.join(dir, 'out'),
        projectDir: dir,
        viewport: { width: 1000, height: 700 },
        onReady: async (page) => {
          for (const [w, h] of [[1000, 700], [1500, 950], [820, 600]]) {
            await page.setViewportSize({ width: w, height: h });
            await page.waitForTimeout(400);
            seen.push(
              await page.evaluate(() => {
                const b = document.body.getBoundingClientRect();
                return { w: Math.round(b.width), h: Math.round(b.height), vw: innerWidth, vh: innerHeight };
              }),
            );
          }
          await page.close();
        },
      });

      for (const s of seen) {
        // The page occupies the window minus the rail and the bar, no more.
        assert.ok(s.w <= s.vw && s.w > s.vw - 400, `width ${s.w} does not track a ${s.vw}px window`);
        assert.ok(s.h <= s.vh && s.h > s.vh - 200, `height ${s.h} does not track a ${s.vh}px window`);
      }
    } finally {
      srv.close();
      await rm(dir, { recursive: true, force: true });
    }
  });
});
