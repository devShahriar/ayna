import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';

import { openBrowser } from '../src/browser.mjs';
import { cropRegion } from '../src/annotate.mjs';
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

  const middlePixel = (buf) =>
    page.evaluate(async (u) => {
      const img = new Image();
      img.src = u;
      await img.decode();
      const c = document.createElement('canvas');
      c.width = img.width;
      c.height = img.height;
      const g = c.getContext('2d');
      g.drawImage(img, 0, 0);
      const d = g.getImageData(Math.floor(img.width / 2), Math.floor(img.height / 2), 1, 1).data;
      return `${d[0]},${d[1]},${d[2]}`;
    }, 'data:image/png;base64,' + buf.toString('base64'));

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

  test('a region scrolled out of view is still captured correctly', async () => {
    // Correctness wins over smoothness here: a truncated crop of what they framed
    // would be worse than one flinch.
    const opts = await cropRegion(page, await pageRect('#wide'), 12);
    assert.equal(opts.fullPage, true, 'off-screen regions need the full-page path');
    assert.equal(await middlePixel(await page.screenshot(opts)), '255,0,0');
  });
});
