/*
  These drive a real Chrome. They are the tests that actually protect the product:
  the capture diagnostics and the annotate round-trip are where the bugs have been.

  Set AYNA_SKIP_BROWSER=1 to skip them (e.g. on a machine with no Chrome).
*/
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { writeFile, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';

import { openBrowser, capture, captureRoutes, routeSlug } from '../src/browser.mjs';
import { serveStatic } from '../src/server.mjs';
import { runAnnotate } from '../src/annotate.mjs';
import { tempDir, fixtureSite, hasBrowser } from './helpers.mjs';

describe('browser capture', { skip: !hasBrowser && 'AYNA_SKIP_BROWSER set' }, () => {
  let browser;
  before(async () => {
    browser = await openBrowser({ headless: true });
  });
  after(async () => {
    await browser?.close();
  });

  test('captures a screenshot per viewport with metrics', async () => {
    const { dir, dispose } = await tempDir();
    try {
      const site = path.join(dir, 'site');
      await fixtureSite(site);
      const server = await serveStatic(site, 4500);
      try {
        const cap = await capture({
          browser,
          url: server.url,
          viewports: [
            { name: 'desktop', width: 1200, height: 800 },
            { name: 'mobile', width: 390, height: 844 },
          ],
          outDir: dir,
          label: 'shot',
        });
        assert.equal(cap.shots.length, 2);
        for (const s of cap.shots) {
          assert.ok(existsSync(s.file), `${s.viewport} png written`);
          assert.equal(s.loadError, null);
          assert.equal(s.transportError, false);
          assert.ok(s.metrics.textLength > 20);
        }
        assert.equal(cap.blank, false);
      } finally {
        await server.close();
      }
    } finally {
      await dispose();
    }
  });

  test('flags an unreachable server as transport, not as a UI defect', async () => {
    const { dir, dispose } = await tempDir();
    try {
      const cap = await capture({
        browser,
        url: 'http://127.0.0.1:59997/',
        viewports: [{ name: 'desktop', width: 800, height: 600 }],
        outDir: dir,
        label: 'dead',
      });
      const shot = cap.shots[0];
      assert.equal(shot.transportError, true, 'must be classed as transport');
      assert.ok(shot.loadError, 'load error recorded');
    } finally {
      await dispose();
    }
  });

  test('detects horizontal overflow and sub-12px text', async () => {
    const { dir, dispose } = await tempDir();
    try {
      const site = path.join(dir, 'site');
      await fixtureSite(site, { overflow: true, tinyText: true });
      const server = await serveStatic(site, 4501);
      try {
        const cap = await capture({
          browser,
          url: server.url,
          viewports: [{ name: 'mobile', width: 390, height: 844 }],
          outDir: dir,
          label: 'shot',
        });
        assert.equal(cap.shots[0].metrics.horizontalOverflow, true);
        assert.ok(cap.shots[0].metrics.tinyTextNodes >= 1);
      } finally {
        await server.close();
      }
    } finally {
      await dispose();
    }
  });

  test('reports a blank page as blank', async () => {
    const { dir, dispose } = await tempDir();
    try {
      const site = path.join(dir, 'site');
      await fixtureSite(site, { blank: true });
      const server = await serveStatic(site, 4502);
      try {
        const cap = await capture({
          browser,
          url: server.url,
          viewports: [{ name: 'desktop', width: 800, height: 600 }],
          outDir: dir,
          label: 'shot',
        });
        assert.equal(cap.blank, true);
      } finally {
        await server.close();
      }
    } finally {
      await dispose();
    }
  });

  test('a missing favicon is not counted as a console error', async () => {
    const { dir, dispose } = await tempDir();
    try {
      const site = path.join(dir, 'site');
      await fixtureSite(site);
      // Drop the inline favicon so the browser really requests /favicon.ico.
      const html = await readFile(path.join(site, 'index.html'), 'utf8');
      await writeFile(path.join(site, 'index.html'), html.replace('<link rel="icon" href="data:,">', ''));
      const server = await serveStatic(site, 4503);
      try {
        const cap = await capture({
          browser,
          url: server.url,
          viewports: [{ name: 'desktop', width: 800, height: 600 }],
          outDir: dir,
          label: 'shot',
        });
        assert.deepEqual(cap.consoleErrors, [], 'favicon 404 must not register');
      } finally {
        await server.close();
      }
    } finally {
      await dispose();
    }
  });
});

describe('annotate round-trip', { skip: !hasBrowser && 'AYNA_SKIP_BROWSER set' }, () => {
  let browser;
  before(async () => {
    browser = await openBrowser({ headless: true });
  });
  after(async () => {
    await browser?.close();
  });

  test('captures selector, crop, styles and source location for a comment', async () => {
    const { dir, dispose } = await tempDir();
    try {
      const site = path.join(dir, 'site');
      await fixtureSite(site);
      const out = path.join(dir, 'out');
      const server = await serveStatic(site, 4510);
      try {
        const manifest = await runAnnotate({
          browser,
          url: server.url,
          outDir: out,
          projectDir: site,
          viewport: { width: 1200, height: 800 },
          onReady: async (page) => {
            await page.click('.title');
            await page.waitForSelector('.ayna-ov-pop textarea');
            await page.fill('.ayna-ov-pop textarea', 'too big');
            await page.click('.ayna-ov-save');
            await page.waitForTimeout(700);
            await page.click('[data-act=send]');
            await page.waitForTimeout(400);
            await writeFile(path.join(out, 'applied'), '1');
            await page.waitForFunction(
              () => document.querySelector('[data-act=approve]') !== null,
              { timeout: 15000 },
            );
            await page.click('[data-act=approve]');
          },
        });

        assert.equal(manifest.comments.length, 1);
        const c = manifest.comments[0];
        assert.equal(c.comment, 'too big');
        assert.match(c.selector, /\.title/);
        assert.ok(existsSync(c.regionScreenshot), 'region crop written');
        assert.ok(Object.keys(c.styles).length > 5, 'computed styles captured');
        assert.ok(
          c.sourceCandidates.some((s) => s.file === 'index.html'),
          'maps back to the source file',
        );
        assert.equal(manifest.approved, true, 'approval recorded');
      } finally {
        await server.close();
      }
    } finally {
      await dispose();
    }
  });

  test('the window stays open until the user approves', async () => {
    const { dir, dispose } = await tempDir();
    try {
      const site = path.join(dir, 'site');
      await fixtureSite(site);
      const out = path.join(dir, 'out');
      const server = await serveStatic(site, 4511);
      const phases = [];
      try {
        await runAnnotate({
          browser,
          url: server.url,
          outDir: out,
          projectDir: site,
          viewport: { width: 1200, height: 800 },
          onReady: async (page) => {
            const phase = async () =>
              JSON.parse(await readFile(path.join(out, 'status.json'), 'utf8')).phase;

            await page.click('.title');
            await page.waitForSelector('.ayna-ov-pop textarea');
            await page.fill('.ayna-ov-pop textarea', 'x');
            await page.click('.ayna-ov-save');
            await page.waitForTimeout(700);

            await page.click('[data-act=send]');
            await page.waitForTimeout(400);
            phases.push(await phase());
            assert.equal(page.isClosed(), false, 'window must stay open after send');

            await writeFile(path.join(out, 'applied'), '1');
            await page.waitForFunction(() => document.querySelector('[data-act=approve]') !== null, {
              timeout: 15000,
            });
            phases.push(await phase());
            assert.equal(page.isClosed(), false, 'window must stay open during review');

            await page.click('[data-act=approve]');
          },
        });
        assert.deepEqual(phases, ['awaiting-claude', 'reviewing']);
      } finally {
        await server.close();
      }
    } finally {
      await dispose();
    }
  });

  test('a stale applied marker does not skip the waiting phase', async () => {
    const { dir, dispose } = await tempDir();
    try {
      const site = path.join(dir, 'site');
      await fixtureSite(site);
      const out = path.join(dir, 'out');
      const { mkdir } = await import('node:fs/promises');
      await mkdir(out, { recursive: true });
      // Left behind by a previous session.
      await writeFile(path.join(out, 'applied'), 'stale');

      const server = await serveStatic(site, 4512);
      let phaseAfterSend = null;
      try {
        await runAnnotate({
          browser,
          url: server.url,
          outDir: out,
          projectDir: site,
          viewport: { width: 1200, height: 800 },
          onReady: async (page) => {
            await page.click('.title');
            await page.waitForSelector('.ayna-ov-pop textarea');
            await page.fill('.ayna-ov-pop textarea', 'x');
            await page.click('.ayna-ov-save');
            await page.waitForTimeout(700);
            await page.click('[data-act=send]');
            await page.waitForTimeout(700);
            phaseAfterSend = JSON.parse(await readFile(path.join(out, 'status.json'), 'utf8')).phase;
            await writeFile(path.join(out, 'applied'), '1');
            await page.waitForFunction(() => document.querySelector('[data-act=approve]') !== null, {
              timeout: 15000,
            });
            await page.click('[data-act=approve]');
          },
        });
        assert.equal(phaseAfterSend, 'awaiting-claude', 'must wait for a fresh marker');
      } finally {
        await server.close();
      }
    } finally {
      await dispose();
    }
  });
});

describe('selection and layout editing', { skip: !hasBrowser && 'AYNA_SKIP_BROWSER set' }, () => {
  let browser;
  before(async () => {
    browser = await openBrowser({ headless: true });
  });
  after(async () => {
    await browser?.close();
  });

  /** Boots a page with the overlay injected and the Node bridge stubbed out. */
  async function overlayPage(site, port) {
    const server = await serveStatic(site, port);
    const ctx = await browser.newContext({ viewport: { width: 1200, height: 800 } });
    const page = await ctx.newPage();
    const submissions = [];
    await page.exposeFunction('__aynaSubmit', async (p) => {
      submissions.push(p);
      return { ok: true };
    });
    for (const fn of ['__aynaDone', '__aynaMore', '__aynaApprove']) {
      await page.exposeFunction(fn, async () => ({ ok: true }));
    }
    const overlay = await readFile(new URL('../src/overlay.js', import.meta.url), 'utf8');
    await page.addInitScript(overlay);
    await page.goto(server.url, { waitUntil: 'networkidle' });
    return { page, submissions, cleanup: async () => { await ctx.close(); await server.close(); } };
  }

  test('arrow-up walks from a nested child to its container', async () => {
    const { dir, dispose } = await tempDir();
    try {
      const site = path.join(dir, 'site');
      await fixtureSite(site);
      const { page, cleanup } = await overlayPage(site, 4520);
      try {
        await page.hover('.list li:nth-of-type(2)');
        await page.waitForTimeout(150);
        const before = await page.evaluate(() => document.querySelector('.ayna-ov-tag b')?.textContent);
        await page.keyboard.press('ArrowUp');
        await page.waitForTimeout(120);
        const after = await page.evaluate(() => document.querySelector('.ayna-ov-tag b')?.textContent);
        assert.equal(before, 'li');
        assert.equal(after, 'ul.list', 'ArrowUp selects the parent');
      } finally {
        await cleanup();
      }
    } finally {
      await dispose();
    }
  });

  test('shift-click gathers several elements into one comment', async () => {
    const { dir, dispose } = await tempDir();
    try {
      const site = path.join(dir, 'site');
      await fixtureSite(site);
      const { page, submissions, cleanup } = await overlayPage(site, 4521);
      try {
        await page.click('.list li:nth-of-type(1)', { modifiers: ['Shift'] });
        await page.click('.list li:nth-of-type(2)', { modifiers: ['Shift'] });
        await page.click('.list li:nth-of-type(3)');
        await page.waitForSelector('.ayna-ov-pop textarea');
        await page.fill('.ayna-ov-pop textarea', 'align these');
        await page.click('.ayna-ov-save');
        await page.waitForTimeout(400);

        assert.equal(submissions.length, 1);
        assert.equal(submissions[0].elements.length, 3, 'all three carried in one comment');
      } finally {
        await cleanup();
      }
    } finally {
      await dispose();
    }
  });

  test('dragging reorders siblings and records a structured move', async () => {
    const { dir, dispose } = await tempDir();
    try {
      const site = path.join(dir, 'site');
      await fixtureSite(site);
      const { page, submissions, cleanup } = await overlayPage(site, 4522);
      try {
        await page.click('[data-act=mode]');
        await page.locator('.list').scrollIntoViewIfNeeded();

        const order = () => page.evaluate(() => [...document.querySelectorAll('.list li')].map((li) => li.textContent));
        assert.deepEqual(await order(), ['one', 'two', 'three']);

        const src = await page.locator('.list li:nth-of-type(3)').boundingBox();
        const dst = await page.locator('.list li:nth-of-type(1)').boundingBox();
        await page.mouse.move(src.x + src.width / 2, src.y + src.height / 2);
        await page.mouse.down();
        await page.mouse.move(dst.x + 4, dst.y + 2, { steps: 10 });
        await page.waitForTimeout(150);
        await page.mouse.up();
        await page.waitForTimeout(400);

        assert.deepEqual(await order(), ['three', 'one', 'two'], 'DOM reordered live');
        const move = submissions.at(-1);
        assert.equal(move.kind, 'move');
        assert.equal(move.move.fromIndex, 2);
        assert.equal(move.move.toIndex, 0);
        assert.match(move.comment, /three/, 'description identifies the element by its text');
      } finally {
        await cleanup();
      }
    } finally {
      await dispose();
    }
  });

  test('send is disabled until something has been captured', async () => {
    const { dir, dispose } = await tempDir();
    try {
      const site = path.join(dir, 'site');
      await fixtureSite(site);
      const { page, cleanup } = await overlayPage(site, 4523);
      try {
        assert.equal(
          await page.evaluate(() => document.querySelector('[data-act=send]').disabled),
          true,
          'nothing to send yet',
        );
        await page.click('.title');
        await page.waitForSelector('.ayna-ov-pop textarea');
        await page.fill('.ayna-ov-pop textarea', 'x');
        await page.click('.ayna-ov-save');
        await page.waitForTimeout(400);
        assert.equal(
          await page.evaluate(() => document.querySelector('[data-act=send]').disabled),
          false,
          'enabled once a comment exists',
        );
      } finally {
        await cleanup();
      }
    } finally {
      await dispose();
    }
  });
});

describe('multi-page review', { skip: !hasBrowser && 'AYNA_SKIP_BROWSER set' }, () => {
  let browser;
  before(async () => {
    browser = await openBrowser({ headless: true });
  });
  after(async () => {
    await browser?.close();
  });

  test('browse mode lets you navigate and comment on a second page', async () => {
    const { dir, dispose } = await tempDir();
    try {
      const site = path.join(dir, 'site');
      const { mkdir } = await import('node:fs/promises');
      await mkdir(site, { recursive: true });
      await writeFile(
        path.join(site, 'index.html'),
        '<html><body><h1 class="home">Home page</h1><a class="nav" href="/about.html">About</a></body></html>',
      );
      await writeFile(
        path.join(site, 'about.html'),
        '<html><body><h1 class="about">About page</h1></body></html>',
      );
      const out = path.join(dir, 'out');
      const server = await serveStatic(site, 4531);
      try {
        const manifest = await runAnnotate({
          browser,
          url: server.url,
          outDir: out,
          projectDir: site,
          viewport: { width: 1200, height: 800 },
          onReady: async (page) => {
            await page.click('.home');
            await page.waitForSelector('.ayna-ov-pop textarea');
            await page.fill('.ayna-ov-pop textarea', 'home heading');
            await page.click('.ayna-ov-save');
            await page.waitForTimeout(500);

            // comment -> move -> browse, then follow the link
            await page.click('[data-act=mode]');
            await page.click('[data-act=mode]');
            await page.click('.nav');
            await page.waitForLoadState('networkidle');
            await page.waitForTimeout(400);

            // The overlay is rebuilt, but the count and mode must survive.
            assert.match(
              await page.evaluate(() => document.querySelector('.ayna-ov-count')?.textContent),
              /1 comment/,
              'earlier comments are not forgotten across navigation',
            );

            await page.click('[data-act=mode]'); // browse -> comment
            await page.click('.about');
            await page.waitForSelector('.ayna-ov-pop textarea');
            await page.fill('.ayna-ov-pop textarea', 'about heading');
            await page.click('.ayna-ov-save');
            await page.waitForTimeout(500);

            await page.click('[data-act=send]');
            await page.waitForTimeout(300);
            await writeFile(path.join(out, 'applied'), '1');
            await page.waitForFunction(() => document.querySelector('[data-act=approve]') !== null, {
              timeout: 15000,
            });
            await page.click('[data-act=approve]');
          },
        });

        assert.equal(manifest.comments.length, 2, 'both pages captured');
        assert.match(manifest.comments[0].url, /\/$/);
        assert.match(manifest.comments[1].url, /about\.html$/);
        assert.equal(
          manifest.comments[1].elements[0].sourceCandidates[0].file,
          'about.html',
          'source ranked to the page the comment was made on',
        );
      } finally {
        await server.close();
      }
    } finally {
      await dispose();
    }
  });
});

describe('multi-route capture', { skip: !hasBrowser && 'AYNA_SKIP_BROWSER set' }, () => {
  let browser;
  before(async () => {
    browser = await openBrowser({ headless: true });
  });
  after(async () => {
    await browser?.close();
  });

  test('routeSlug makes filesystem-safe, distinguishable names', () => {
    assert.equal(routeSlug('/'), 'home');
    assert.equal(routeSlug('/pricing'), 'pricing');
    assert.equal(routeSlug('/docs/intro'), 'docs-intro');
    assert.equal(routeSlug('/about.html?x=1'), 'about-html');
  });

  test('captures every configured route, tagged and separately filed', async () => {
    const { dir, dispose } = await tempDir();
    try {
      const site = path.join(dir, 'site');
      const { mkdir } = await import('node:fs/promises');
      await mkdir(site, { recursive: true });
      // Comfortably past the 20-char "blank page" threshold.
      await writeFile(
        path.join(site, 'index.html'),
        '<html><body><h1>Home page with enough copy to not read as blank</h1></body></html>',
      );
      await writeFile(
        path.join(site, 'pricing.html'),
        '<html><body><h1>Pricing page with enough copy to not read as blank</h1></body></html>',
      );

      const server = await serveStatic(site, 4540);
      try {
        const cap = await captureRoutes({
          browser,
          baseUrl: server.url,
          routes: ['/', '/pricing.html'],
          viewports: [{ name: 'desktop', width: 900, height: 700 }],
          outDir: dir,
          label: 'shot',
        });

        assert.equal(cap.shots.length, 2, 'one shot per route');
        assert.deepEqual(cap.shots.map((s) => s.route), ['/', '/pricing.html']);
        for (const s of cap.shots) assert.ok(existsSync(s.file));
        assert.notEqual(cap.shots[0].file, cap.shots[1].file, 'routes must not overwrite each other');
        assert.equal(cap.blank, false);
      } finally {
        await server.close();
      }
    } finally {
      await dispose();
    }
  });
});

describe('region selection and image attachment', { skip: !hasBrowser && 'AYNA_SKIP_BROWSER set' }, () => {
  let browser;
  before(async () => {
    browser = await openBrowser({ headless: true });
  });
  after(async () => {
    await browser?.close();
  });

  test('dragging a box comments on an area, with an attached reference image', async () => {
    const { dir, dispose } = await tempDir();
    try {
      const site = path.join(dir, 'site');
      await fixtureSite(site);
      const out = path.join(dir, 'out');
      const ref = path.join(dir, 'ref.png');
      await writeFile(
        ref,
        Buffer.from(
          'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
          'base64',
        ),
      );

      const server = await serveStatic(site, 4550);
      try {
        const manifest = await runAnnotate({
          browser,
          url: server.url,
          outDir: out,
          projectDir: site,
          viewport: { width: 1200, height: 800 },
          onReady: async (page) => {
            const box = await page.locator('.list').boundingBox();
            await page.mouse.move(box.x - 6, box.y - 6);
            await page.mouse.down();
            await page.mouse.move(box.x + box.width + 6, box.y + box.height + 6, { steps: 12 });
            await page.waitForTimeout(150);
            await page.mouse.up();

            await page.waitForSelector('.ayna-ov-pop textarea', { timeout: 5000 });
            await page.setInputFiles('.ayna-ov-attach input', ref);
            await page.waitForTimeout(300);
            await page.fill('.ayna-ov-pop textarea', 'this block is cramped');
            await page.click('.ayna-ov-save');
            await page.waitForTimeout(700);

            await page.click('[data-act=send]');
            await page.waitForTimeout(300);
            await writeFile(path.join(out, 'applied'), '1');
            await page.waitForFunction(() => document.querySelector('[data-act=approve]') !== null, {
              timeout: 15000,
            });
            await page.click('[data-act=approve]');
          },
        });

        assert.equal(manifest.comments.length, 1);
        const c = manifest.comments[0];
        assert.equal(c.kind, 'region', 'a dragged box is a region comment');
        assert.ok(c.region.rect.width > 20 && c.region.rect.height > 20);
        assert.ok(c.elements.length >= 1, 'elements inside the box are identified');
        assert.equal(c.attachments.length, 1, 'the reference image came through');
        assert.ok(existsSync(c.attachments[0]));
        assert.ok(existsSync(c.regionScreenshot), 'the framed area was cropped');
      } finally {
        await server.close();
      }
    } finally {
      await dispose();
    }
  });

  test('a plain click still makes a single-element comment, not a region', async () => {
    const { dir, dispose } = await tempDir();
    try {
      const site = path.join(dir, 'site');
      await fixtureSite(site);
      const out = path.join(dir, 'out');
      const server = await serveStatic(site, 4551);
      try {
        const manifest = await runAnnotate({
          browser,
          url: server.url,
          outDir: out,
          projectDir: site,
          viewport: { width: 1200, height: 800 },
          onReady: async (page) => {
            await page.click('.title');
            await page.waitForSelector('.ayna-ov-pop textarea');
            await page.fill('.ayna-ov-pop textarea', 'tighten this');
            await page.click('.ayna-ov-save');
            await page.waitForTimeout(600);
            await page.click('[data-act=send]');
            await page.waitForTimeout(300);
            await writeFile(path.join(out, 'applied'), '1');
            await page.waitForFunction(() => document.querySelector('[data-act=approve]') !== null, {
              timeout: 15000,
            });
            await page.click('[data-act=approve]');
          },
        });
        assert.equal(manifest.comments[0].kind, 'comment');
        assert.equal(manifest.comments[0].region, null);
      } finally {
        await server.close();
      }
    } finally {
      await dispose();
    }
  });
});

describe('removing a comment', { skip: !hasBrowser && 'AYNA_SKIP_BROWSER set' }, () => {
  let browser;
  before(async () => {
    browser = await openBrowser({ headless: true });
  });
  after(async () => {
    await browser?.close();
  });

  test('clicking a pin removes that comment and renumbers the rest', async () => {
    const { dir, dispose } = await tempDir();
    try {
      const site = path.join(dir, 'site');
      await fixtureSite(site);
      const out = path.join(dir, 'out');
      const server = await serveStatic(site, 4560);
      try {
        const manifest = await runAnnotate({
          browser,
          url: server.url,
          outDir: out,
          projectDir: site,
          viewport: { width: 1200, height: 800 },
          onReady: async (page) => {
            const add = async (sel, text) => {
              await page.click(sel);
              await page.waitForSelector('.ayna-ov-pop textarea');
              await page.fill('.ayna-ov-pop textarea', text);
              await page.click('.ayna-ov-save');
              await page.waitForTimeout(500);
            };
            await add('.title', 'first');
            await add('.lede', 'second');
            await add('.list li:nth-of-type(1)', 'third');
            assert.equal(await page.evaluate(() => document.querySelectorAll('.ayna-ov-pin').length), 3);

            // Remove the middle one.
            await page.click('.ayna-ov-pin >> nth=1');
            await page.waitForTimeout(500);
            assert.equal(await page.evaluate(() => document.querySelectorAll('.ayna-ov-pin').length), 2);
            assert.deepEqual(
              await page.evaluate(() => [...document.querySelectorAll('.ayna-ov-pin b')].map((b) => b.textContent)),
              ['1', '2'],
              'remaining pins are renumbered contiguously',
            );
            assert.match(
              await page.evaluate(() => document.querySelector('.ayna-ov-count').textContent),
              /2 comments/,
            );

            await page.click('[data-act=send]');
            await page.waitForTimeout(300);
            await writeFile(path.join(out, 'applied'), '1');
            await page.waitForFunction(() => document.querySelector('[data-act=approve]') !== null, {
              timeout: 15000,
            });
            await page.click('[data-act=approve]');
          },
        });

        assert.equal(manifest.comments.length, 2, 'the removed comment never reaches Claude');
        assert.deepEqual(manifest.comments.map((c) => c.comment), ['first', 'third']);
        assert.deepEqual(manifest.comments.map((c) => c.n), [1, 2], 'renumbered server-side too');
      } finally {
        await server.close();
      }
    } finally {
      await dispose();
    }
  });

  test('removing every comment disables send again', async () => {
    const { dir, dispose } = await tempDir();
    try {
      const site = path.join(dir, 'site');
      await fixtureSite(site);
      const out = path.join(dir, 'out');
      const server = await serveStatic(site, 4561);
      try {
        await runAnnotate({
          browser,
          url: server.url,
          outDir: out,
          projectDir: site,
          viewport: { width: 1200, height: 800 },
          onReady: async (page) => {
            await page.click('.title');
            await page.waitForSelector('.ayna-ov-pop textarea');
            await page.fill('.ayna-ov-pop textarea', 'only one');
            await page.click('.ayna-ov-save');
            await page.waitForTimeout(500);
            assert.equal(await page.evaluate(() => document.querySelector('[data-act=send]').disabled), false);

            await page.click('.ayna-ov-pin');
            await page.waitForTimeout(500);
            assert.equal(
              await page.evaluate(() => document.querySelector('[data-act=send]').disabled),
              true,
              'nothing left to send',
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
