import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';

import { openBrowser } from '../src/browser.mjs';
import { cropRegion, captureCrop, holdTheFrame } from '../src/annotate.mjs';
import { cropPng, pngSize } from '../src/png.mjs';
import { hasBrowser } from './helpers.mjs';

/*
  The review window flinched.

  Framing a region or opening the comment box made the page visibly shrink to a
  smaller size and snap back. The cause was `fullPage: true` on the crop: on a
  window-following page it makes Chromium relay the page out at another size and
  back, which fires resize events. Node sees nothing — `innerWidth` reads the same
  either side of the call — so the only way to catch this is to ask the page.
*/
describe('cropping the page the user is looking at', { skip: !hasBrowser && 'AYNA_SKIP_BROWSER set' }, () => {
  let browser, page, context;

  before(async () => {
    browser = await openBrowser({ headless: true });
    context = await browser.newContext({ viewport: { width: 800, height: 600 } });
    page = await context.newPage();
    await page.setContent(`<body style="margin:0">
      <div id="wide" style="height:200px;background:rgb(255,0,0)"></div>
      <div style="height:1500px;background:rgb(0,128,0)">
        <div id="low" style="margin-top:700px;width:150px;height:80px;background:rgb(0,0,255)"></div>
      </div></body>`);
    // Settle into the viewport before listening. On a slow runner a resize from
    // setting the page up arrived late, inside the first test, and was counted
    // against a capture that had not caused it.
    await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
    await page.waitForTimeout(250);
    await page.evaluate(() => {
      window.__resizes = [];
      addEventListener('resize', () => window.__resizes.push('window'));
      visualViewport.addEventListener('resize', () => window.__resizes.push('visual'));
    });
  });

  after(async () => {
    await context?.close().catch(() => {});
    await browser?.close().catch(() => {});
  });

  const pageRect = (sel) =>
    page.evaluate((s) => {
      const r = document.querySelector(s).getBoundingClientRect();
      return { x: r.x + scrollX, y: r.y + scrollY, width: r.width, height: r.height };
    }, sel);

  const drain = () => page.evaluate(() => window.__resizes.splice(0));

  // One pixel of a capture, the middle one unless told otherwise.
  const pixelAt = (buf, x, y) =>
    page.evaluate(
      async ([u, px, py]) => {
        const img = new Image();
        img.src = u;
        await img.decode();
        const c = document.createElement('canvas');
        c.width = img.width;
        c.height = img.height;
        const g = c.getContext('2d');
        g.drawImage(img, 0, 0);
        const d = g.getImageData(px ?? Math.floor(img.width / 2), py ?? Math.floor(img.height / 2), 1, 1).data;
        return `${d[0]},${d[1]},${d[2]}`;
      },
      ['data:image/png;base64,' + buf.toString('base64'), x, y],
    );
  const middlePixel = (buf) => pixelAt(buf);


  test('a visible region is captured without resizing the page', async () => {
    await drain();
    const opts = await cropRegion(page, await pageRect('#wide'), 12);
    assert.equal(opts.fullPage, false, 'a region on screen must not need the full-page path');

    const buf = await page.screenshot(opts);
    await page.waitForTimeout(150);
    assert.deepEqual(await drain(), [], 'capturing a visible region must not resize the page');
    assert.equal(await middlePixel(buf), '255,0,0', 'the crop must be the element, not an offset of it');
  });

  test('padding a full-width element does not push it onto the slow path', async () => {
    // The first attempt tested the *padded* box for visibility, so anything as
    // wide as the viewport failed and the fast path was never taken at all.
    const rect = await pageRect('#wide');
    assert.equal(rect.width, 800, 'fixture must be exactly as wide as the viewport');
    assert.equal((await cropRegion(page, rect, 12)).fullPage, false);
  });

  test('scroll offset is subtracted, so the crop follows the element', async () => {
    await page.evaluate(() => scrollTo(0, 800));
    await page.waitForTimeout(200);
    await drain();

    const opts = await cropRegion(page, await pageRect('#low'), 12);
    assert.equal(opts.fullPage, false);
    const buf = await page.screenshot(opts);
    assert.equal(await middlePixel(buf), '0,0,255', 'a scrolled page must not shift the crop');
    assert.deepEqual(await drain(), []);
  });

  /*
    A section taller than the window — the most common thing to click once you
    press ↑ a couple of times — took the full-page path, and the whole window
    flinched with ayna's frame blinking out. Now the visible part is captured
    and the crop says it is partial.
  */
  test('a region only partly on screen is cropped to what shows, without a flinch', async () => {
    await page.evaluate(() => scrollTo(0, 800));
    await page.waitForTimeout(200);
    await drain();
    const tall = await page.evaluate(() => {
      const r = document.querySelector('#low').parentElement.getBoundingClientRect();
      return { x: r.x + scrollX, y: r.y + scrollY, width: r.width, height: r.height };
    });
    const opts = await cropRegion(page, tall, 12);
    assert.equal(opts.fullPage, false, 'a partly visible region must not take the full-page path');
    assert.equal(opts.truncated, true, 'the crop must say it is not the whole region');
    assert.ok(opts.clip.y >= 0 && opts.clip.y + opts.clip.height <= 600, `clip stays in the window: ${JSON.stringify(opts.clip)}`);
    const buf = await page.screenshot(opts);
    await page.waitForTimeout(150);
    assert.deepEqual(await drain(), [], 'no resize while capturing');
    assert.equal(await middlePixel(buf), '0,128,0');
  });

  test('a region fully on screen is not reported truncated', async () => {
    const opts = await cropRegion(page, await pageRect('#low'), 12);
    assert.equal(opts.truncated, false);
  });

  test('a region scrolled entirely out of view is still captured correctly', async () => {
    // Nothing of it is on screen to crop, so this is the one case left for the
    // full-page path.
    const opts = await cropRegion(page, await pageRect('#wide'), 12);
    assert.equal(opts.fullPage, true, 'off-screen regions need the full-page path');
    assert.equal(await middlePixel(await page.screenshot(opts)), '255,0,0');
  });

  /*
    The capture's style is applied to the live page, so whatever it hides
    blinks out of the user's window. Hiding all of ayna made the bar, the rail
    and the comment box flash on every note.
  */
  test('a crop hides the marks over the element, not the bar or the rail beside it', async () => {
    const chrome = await context.newPage();
    try {
      // Written the way the overlay writes it: the inset is the rail's clamp() of
      // the window, registered as a length so it reads back in pixels.
      await chrome.setContent(`<html style="--ayna-inset-top:50px;--ayna-inset-left:var(--ayna-rail-inset, clamp(150px, 25vw, 400px))">
        <style>@property --ayna-inset-left { syntax: '<length>'; inherits: true; initial-value: 0px; }</style><body style="margin:0">
        <div id="nav" style="position:absolute;top:50px;left:204px;width:300px;height:40px;background:rgb(255,0,0)"></div>
        <div class="ayna-ov-bar" data-ayna="1" style="position:fixed;top:0;left:200px;right:0;height:50px;background:#000;box-shadow:0 1px 12px rgba(0,0,0,.6)"></div>
        <div class="ayna-ov-console" data-ayna="1" style="position:fixed;top:0;bottom:0;left:0;width:clamp(150px, 25vw, 400px);background:#000"></div>
        <div class="ayna-ov-tag" data-ayna="1" style="position:fixed;top:28px;left:204px;width:200px;height:22px;background:#fff;box-shadow:0 2px 6px rgba(0,0,0,.8)"></div>
        <div class="ayna-ov-hl" data-ayna="1" style="position:fixed;top:50px;left:204px;width:300px;height:40px;outline:2px solid orange"></div>
      </body></html>`);
      const rect = await chrome.evaluate(() => {
        const r = document.querySelector('#nav').getBoundingClientRect();
        return { x: r.x, y: r.y, width: r.width, height: r.height };
      });
      const opts = await cropRegion(chrome, rect, 12);
      assert.equal(opts.fullPage, false);
      assert.ok(opts.clip.y >= 50 && opts.clip.x >= 200, `the padding stops at the app's edge: ${JSON.stringify(opts.clip)}`);

      // The label above the element and the bar both cast shadows into the crop.
      const top = await pixelAt(await chrome.screenshot(opts), 20, 2);
      assert.equal(top, '255,0,0', "no shadow of ayna's falls across the top of the crop");

      await chrome.addStyleTag({ content: opts.style });
      const after = await chrome.evaluate(() =>
        [...document.querySelectorAll('[data-ayna]')].map((el) => {
          const cs = getComputedStyle(el);
          return `${el.className}:${cs.visibility}:${cs.boxShadow === 'none' ? 'flat' : 'shadow'}`;
        }),
      );
      assert.deepEqual(
        after,
        ['ayna-ov-bar:visible:flat', 'ayna-ov-console:visible:flat', 'ayna-ov-tag:visible:flat', 'ayna-ov-hl:hidden:flat'],
        'only the mark over the element is hidden; what sits beside the crop keeps its place and loses only its shadow',
      );
    } finally {
      await chrome.close();
    }
  });
  /*
    A clipped capture flashes the clip, scaled up, in a headed window. The crop
    is cut from an unclipped capture instead, and has to be the same picture.
  */
  test('the crop is cut from an unclipped capture, at the same place and size', async () => {
    await page.evaluate(() => scrollTo(0, 800));
    await page.waitForTimeout(200);
    await drain();
    const opts = await cropRegion(page, await pageRect('#low'), 12);
    const ours = await captureCrop(page, opts);
    const theirs = await page.screenshot(opts);
    assert.deepEqual(pngSize(ours), pngSize(theirs), 'same size as the clipped capture');
    assert.equal(await middlePixel(ours), '0,0,255');
    assert.equal(await pixelAt(ours, 2, 2), await pixelAt(theirs, 2, 2), 'same corner, so not shifted');
    assert.deepEqual(await drain(), [], 'no resize while capturing');
    assert.equal(await page.evaluate(() => !!document.getElementById('ayna-capture')), false, 'the capture style is gone');
  });

  test('cropPng clamps to the image and refuses an empty crop', async () => {
    const full = await page.screenshot();
    const { width, height } = pngSize(full);
    assert.deepEqual(pngSize(cropPng(full, { x: width - 10, y: height - 10, width: 50, height: 50 })), { width: 10, height: 10 });
    assert.throws(() => cropPng(full, { x: width + 5, y: 0, width: 10, height: 10 }), /empty/);
  });

  /*
    Partly under the bar is still in the app. Treating it as "outside" made the
    crop use the whole window, which took in the bar and the rail and hid them —
    both blinked on every such note.
  */
  test('a region partly under the bar leaves the bar and rail alone, and far chrome keeps its shadow', async () => {
    const chrome = await context.newPage();
    try {
      await chrome.setContent(`<html style="--ayna-inset-top:50px;--ayna-inset-left:200px"><body style="margin:0">
        <div id="hero" style="position:absolute;top:20px;left:220px;width:300px;height:200px;background:rgb(0,0,255)"></div>
        <div class="ayna-ov-bar" data-ayna="1" style="position:fixed;top:0;left:200px;right:0;height:50px;background:#000;box-shadow:0 1px 12px #000"></div>
        <div class="ayna-ov-console" data-ayna="1" style="position:fixed;top:0;bottom:0;left:0;width:200px;background:#000"></div>
        <div class="ayna-ov-pin" data-ayna="1" style="position:fixed;top:500px;left:700px;width:20px;height:20px;box-shadow:0 2px 8px #000"></div>
      </body></html>`);
      const opts = await cropRegion(chrome, { x: 220, y: 20, width: 300, height: 200 }, 12);
      assert.equal(opts.fullPage, false);
      assert.equal(opts.truncated, true, 'the part under the bar is not in the crop');
      assert.ok(opts.clip.y >= 50 && opts.clip.x >= 200, `the crop stays in the app: ${JSON.stringify(opts.clip)}`);
      await chrome.addStyleTag({ content: opts.style });
      const after = await chrome.evaluate(() =>
        [...document.querySelectorAll('[data-ayna]')].map((el) => {
          const cs = getComputedStyle(el);
          return `${el.className}:${cs.visibility}:${cs.boxShadow === 'none' ? 'flat' : 'shadow'}`;
        }),
      );
      assert.deepEqual(after, ['ayna-ov-bar:visible:flat', 'ayna-ov-console:visible:flat', 'ayna-ov-pin:visible:shadow']);
    } finally {
      await chrome.close();
    }
  });
});

/*
  A reload painted the bare app first — full width, no bar — then jumped right
  and down when the overlay arrived. The init script puts it in its box from the
  first frame, using what the overlay left behind.
*/
describe('a reload keeps the review frame in place', { skip: !hasBrowser && 'AYNA_SKIP_BROWSER set' }, () => {
  test('the page is laid out in the reserved box before the overlay exists', async () => {
    const browser = await openBrowser({ headless: true });
    try {
      const context = await browser.newContext({ viewport: { width: 1000, height: 700 } });
      const page = await context.newPage();
      await page.route('http://ayna.test/**', (r) =>
        r.fulfill({ contentType: 'text/html', body: '<!doctype html><body style="margin:0"><h1 id="t" style="margin:0">App</h1></body>' }),
      );
      await page.addInitScript(holdTheFrame);
      await page.goto('http://ayna.test/');
      assert.equal(await page.evaluate(() => !!document.getElementById('ayna-reserve')), false, 'nothing to hold on a first visit');

      await page.evaluate(() =>
        sessionStorage.setItem(
          'ayna-reserve',
          JSON.stringify({
            top: '53px',
            left: '300px',
            over: '0px',
            bar: { x: 300, y: 0, w: 700, h: 53, bg: 'rgb(18, 18, 20)' },
            rail: { x: 0, y: 0, w: 300, h: 700, bg: 'rgb(18, 18, 20)' },
          }),
        ),
      );
      await page.reload();
      const at = await page.evaluate(() => {
        const r = document.getElementById('t').getBoundingClientRect();
        return { x: Math.round(r.x), y: Math.round(r.y), bar: getComputedStyle(document.documentElement, '::before').backgroundColor };
      });
      assert.deepEqual(at, { x: 300, y: 53, bar: 'rgb(18, 18, 20)' });
    } finally {
      await browser.close();
    }
  });
});
