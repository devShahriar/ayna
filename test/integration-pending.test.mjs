/*
  These drive a real Chrome. They are the tests that actually protect the product:
  the capture diagnostics and the annotate round-trip are where the bugs have been.

  Set AYNA_SKIP_BROWSER=1 to skip them (e.g. on a machine with no Chrome).
*/
import { test, describe, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { writeFile, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { openBrowser, capture, captureRoutes, routeSlug } from '../src/browser.mjs';
import { serveStatic } from '../src/server.mjs';
import { runAnnotate, cropRegion } from '../src/annotate.mjs';
import { tempDir, fixtureSite, hasBrowser, press, launchBrowser } from './helpers.mjs';

describe('pending work survives, and closing is not a verdict', { skip: !hasBrowser && 'AYNA_SKIP_BROWSER set' }, () => {
  let browser;
  beforeEach(async () => {
    browser = await launchBrowser();
  });
  afterEach(async () => {
    await browser?.close().catch(() => {});
  });

  test('a reload keeps you in review with the markers intact', async () => {
    const { dir, dispose } = await tempDir();
    try {
      const site = path.join(dir, 'site');
      await fixtureSite(site);
      const out = path.join(dir, 'out');
      const server = await serveStatic(site, 4710);
      try {
        await runAnnotate({
          browser,
          url: server.url,
          outDir: out,
          projectDir: site,
          viewport: { width: 1100, height: 700 },
          onReady: async (page) => {
            await page.click('.title');
            await page.waitForSelector('.ayna-ov-pop textarea');
            await page.fill('.ayna-ov-pop textarea', 'needs work');
            await page.click('.ayna-ov-save');
            await page.waitForTimeout(450);
            await page.click('[data-act=send]');
            await page.waitForTimeout(300);
            await writeFile(path.join(out, 'applied'), '1');
            await page.waitForFunction(() => document.querySelector('[data-act=close]') !== null, {
              timeout: 15000,
            });
            await page.waitForTimeout(400);

            // The user hits refresh while a change is waiting on their verdict.
            await page.reload({ waitUntil: 'networkidle' });
            await page.waitForTimeout(1200);

            assert.ok(
              await page.evaluate(() => !!document.querySelector('[data-act=close]')),
              'still in review after a reload',
            );
            assert.equal(
              await page.evaluate(() => document.querySelectorAll('.ayna-ov-rev').length),
              1,
              'the pending marker came back',
            );
            await page.close();
          },
        });
      } finally {
        await server.close();
      }
    } finally {
      await dispose();
    }
  });

  test('closing leaves anything unjudged pending rather than signing it off', async () => {
    const { dir, dispose } = await tempDir();
    try {
      const site = path.join(dir, 'site');
      await fixtureSite(site);
      const out = path.join(dir, 'out');
      const server = await serveStatic(site, 4711);
      try {
        const manifest = await runAnnotate({
          browser,
          url: server.url,
          outDir: out,
          projectDir: site,
          viewport: { width: 1100, height: 700 },
          onReady: async (page) => {
            await page.click('.title');
            await page.waitForSelector('.ayna-ov-pop textarea');
            await page.fill('.ayna-ov-pop textarea', 'never judged');
            await page.click('.ayna-ov-save');
            await page.waitForTimeout(450);
            await page.click('[data-act=send]');
            await page.waitForTimeout(300);
            await writeFile(path.join(out, 'applied'), '1');
            await page.waitForFunction(() => document.querySelector('[data-act=close]') !== null, {
              timeout: 15000,
            });
            await page.waitForTimeout(300);
            await press(page, 'close'); // close without judging
          },
        });

        assert.equal(
          manifest.comments[0].status,
          'open',
          'one click must not sign off work nobody looked at',
        );
        const status = JSON.parse(await readFile(path.join(out, 'status.json'), 'utf8'));
        assert.equal(status.resolved, 0);
        assert.equal(status.open, 1, 'it is still waiting for a verdict');
      } finally {
        await server.close();
      }
    } finally {
      await dispose();
    }
  });

  test('a framed region is attached to the comment automatically', async () => {
    const { dir, dispose } = await tempDir();
    try {
      const site = path.join(dir, 'site');
      const { mkdir } = await import('node:fs/promises');
      await mkdir(site, { recursive: true });
      await writeFile(
        path.join(site, 'index.html'),
        `<html><body style="margin:0">
           <canvas id="c" width="900" height="600" style="display:block"></canvas>
           <script>
             const x = document.getElementById('c').getContext('2d');
             x.fillStyle = '#222'; x.fillRect(0, 0, 900, 600);
             x.fillStyle = '#8fd3ff'; x.fillRect(100, 100, 200, 120);
           </script>
         </body></html>`,
      );
      const server = await serveStatic(site, 4712);
      try {
        await runAnnotate({
          browser,
          url: server.url,
          outDir: path.join(dir, 'out'),
          projectDir: site,
          viewport: { width: 900, height: 600 },
          onReady: async (page) => {
            // Inside the app's area: the rail owns the left edge and the bar the top.
            const app = await page.evaluate(() => {
              const r = document.querySelector('#c').getBoundingClientRect();
              return { x: Math.max(r.left, 0), y: Math.max(r.top, 0) };
            });
            await page.mouse.move(app.x + 40, app.y + 40);
            await page.mouse.down();
            await page.mouse.move(app.x + 290, app.y + 210, { steps: 10 });
            await page.mouse.up();
            await page.waitForSelector('.ayna-ov-pop textarea', { timeout: 5000 });
            await page.waitForFunction(() => !!document.querySelector('.ayna-ov-preview img'), {
              timeout: 10000,
            });
            assert.match(
              await page.evaluate(() => document.querySelector('.ayna-ov-preview .ayna-ov-cap')?.textContent ?? ''),
              /^attached · \d+×\d+$/,
              'the box says the region travels with the comment',
            );
            await page.close();
          },
        });
      } finally {
        await server.close();
      }
    } finally {
      await dispose();
    }
  });
});
