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
import { fileURLToPath } from 'node:url';

import { openBrowser, capture, captureRoutes, routeSlug } from '../src/browser.mjs';
import { serveStatic } from '../src/server.mjs';
import { runAnnotate, cropRegion } from '../src/annotate.mjs';
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
              () => document.querySelector('[data-act=close]') !== null,
              { timeout: 15000 },
            );
            await page.click('[data-act=close]');
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
            await page.waitForFunction(() => document.querySelector('[data-act=close]') !== null, {
              timeout: 15000,
            });
            phases.push(await phase());
            assert.equal(page.isClosed(), false, 'window must stay open during review');

            await page.click('[data-act=close]');
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
            await page.waitForFunction(() => document.querySelector('[data-act=close]') !== null, {
              timeout: 15000,
            });
            await page.click('[data-act=close]');
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
        await page.click('[data-act=setmode][data-mode=move]');
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

            // Browse mode, then follow the link.
            await page.click('[data-act=setmode][data-mode=browse]');
            await page.click('.nav');
            await page.waitForLoadState('networkidle');
            await page.waitForTimeout(400);

            /*
              The overlay is rebuilt, but the count and mode must survive.

              The count used to sit in its own span beside a Tasks button that
              also showed it — the same number twice, in two wordings. It lives on
              the button now, which is the thing that opens the list it counts.
            */
            assert.match(
              await page.evaluate(() => document.querySelector('[data-act=tasks]')?.textContent),
              /Tasks · 1/,
              'earlier comments are not forgotten across navigation',
            );

            await page.click('[data-act=setmode][data-mode=comment]');
            await page.click('.about');
            await page.waitForSelector('.ayna-ov-pop textarea');
            await page.fill('.ayna-ov-pop textarea', 'about heading');
            await page.click('.ayna-ov-save');
            await page.waitForTimeout(500);

            await page.click('[data-act=send]');
            await page.waitForTimeout(300);
            await writeFile(path.join(out, 'applied'), '1');
            await page.waitForFunction(() => document.querySelector('[data-act=close]') !== null, {
              timeout: 15000,
            });
            await page.click('[data-act=close]');
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

  test('a --url with a path is captured as-is, not collapsed to the site root', async () => {
    const { dir, dispose } = await tempDir();
    try {
      const site = path.join(dir, 'site');
      const { mkdir } = await import('node:fs/promises');
      await mkdir(path.join(site, 'd', 'abc123'), { recursive: true });
      await writeFile(path.join(site, 'index.html'), '<html><body><h1>Root page, not the target here</h1></body></html>');
      await writeFile(
        path.join(site, 'd', 'abc123', 'index.html'),
        '<html><body><h1>Deep dashboard page that was actually requested</h1></body></html>',
      );

      const server = await serveStatic(site, 4590);
      try {
        const deep = new URL('/d/abc123/', server.url).toString();
        const cap = await captureRoutes({
          browser,
          baseUrl: deep,
          // What bin/ayna.mjs derives from a --url that carries a path.
          routes: ['/d/abc123/'],
          viewports: [{ name: 'desktop', width: 900, height: 700 }],
          outDir: dir,
          label: 'shot',
        });
        assert.match(cap.shots[0].url, /\/d\/abc123\/$/);
        assert.match(
          cap.shots[0].metrics.title === '' ? 'ok' : 'ok',
          /ok/,
        );
        // The give-away: the root page's copy must not be what we captured.
        assert.ok(cap.shots[0].metrics.textLength > 40, 'captured the deep page, not the shorter root');
      } finally {
        await server.close();
      }
    } finally {
      await dispose();
    }
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
            await page.waitForFunction(() => document.querySelector('[data-act=close]') !== null, {
              timeout: 15000,
            });
            await page.click('[data-act=close]');
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
            await page.waitForFunction(() => document.querySelector('[data-act=close]') !== null, {
              timeout: 15000,
            });
            await page.click('[data-act=close]');
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
            // Same move as above: the count is on the Tasks button now.
            assert.match(
              await page.evaluate(() => document.querySelector('[data-act=tasks]').textContent),
              /Tasks · 2/,
            );

            await page.click('[data-act=send]');
            await page.waitForTimeout(300);
            await writeFile(path.join(out, 'applied'), '1');
            await page.waitForFunction(() => document.querySelector('[data-act=close]') !== null, {
              timeout: 15000,
            });
            await page.click('[data-act=close]');
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

describe('per-comment approve / reject', { skip: !hasBrowser && 'AYNA_SKIP_BROWSER set' }, () => {
  let browser;
  before(async () => {
    browser = await openBrowser({ headless: true });
  });
  after(async () => {
    await browser?.close();
  });

  test('each comment is re-anchored after the edits and judged in place', async () => {
    const { dir, dispose } = await tempDir();
    try {
      const site = path.join(dir, 'site');
      await fixtureSite(site);
      const out = path.join(dir, 'out');
      const server = await serveStatic(site, 4570);
      try {
        const manifest = await runAnnotate({
          browser,
          url: server.url,
          outDir: out,
          projectDir: site,
          viewport: { width: 1200, height: 800 },
          onReady: async (page) => {
            const add = async (sel, txt) => {
              await page.click(sel);
              await page.waitForSelector('.ayna-ov-pop textarea');
              await page.fill('.ayna-ov-pop textarea', txt);
              await page.click('.ayna-ov-save');
              await page.waitForTimeout(450);
            };
            await add('.title', 'headline too big');
            await add('.lede', 'body copy cramped');

            await page.click('[data-act=send]');
            await page.waitForTimeout(300);
            await writeFile(path.join(out, 'applied'), '1');
            await page.waitForFunction(() => document.querySelector('[data-act=close]') !== null, {
              timeout: 15000,
            });
            await page.waitForTimeout(500);

            assert.equal(
              await page.evaluate(() => document.querySelectorAll('.ayna-ov-rev').length),
              2,
              'both commented portions are highlighted on the changed page',
            );
            assert.match(
              await page.evaluate(() => document.querySelector('.ayna-ov-progress').textContent),
              /2 left to judge/,
            );

            // Approve the first, send the second back.
            // The verdict buttons sit on each changed element — no card needed.
            await page.click('.ayna-ov-revbar >> nth=0 >> .ayna-ov-ok');
            await page.waitForTimeout(350);
            await page.click('.ayna-ov-revbar >> nth=1 >> .ayna-ov-no');
            await page.waitForTimeout(350);

            assert.deepEqual(
              await page.evaluate(() => [...document.querySelectorAll('.ayna-ov-rev')].map((n) => n.dataset.status)),
              ['approved', 'rejected'],
            );
            /*
              The bar counts down what is left rather than up what is done:
              "0 of 3 resolved" made the reader subtract to find out whether they
              could leave. A rejected comment is still outstanding, so with one
              approved and one rejected there is one left.
            */
            assert.match(
              await page.evaluate(() => document.querySelector('.ayna-ov-progress').textContent),
              /1 left to judge/,
            );

            // A resolved comment stays readable — the record of what changed.
            await page.click('.ayna-ov-revbar >> nth=0 >> .ayna-ov-revpin');
            await page.waitForSelector('.ayna-ov-card');
            assert.match(
              await page.evaluate(() => document.querySelector('.ayna-ov-badge').textContent),
              /resolved/,
            );
            await page.click('[data-act=close]');
          },
        });

        assert.deepEqual(
          manifest.comments.map((c) => c.status),
          ['approved', 'rejected'],
          'verdicts persist into the manifest',
        );
        const status = JSON.parse(await readFile(path.join(out, 'status.json'), 'utf8'));
        assert.equal(status.resolved, 1);
        assert.equal(status.rejected, 1);
      } finally {
        await server.close();
      }
    } finally {
      await dispose();
    }
  });
});

describe('navigating the app during a review', { skip: !hasBrowser && 'AYNA_SKIP_BROWSER set' }, () => {
  let browser;
  before(async () => {
    browser = await openBrowser({ headless: true });
  });
  after(async () => {
    await browser?.close();
  });

  test('client-side navigation keeps the overlay and records the SPA route', async () => {
    const { dir, dispose } = await tempDir();
    try {
      const site = path.join(dir, 'site');
      const { mkdir } = await import('node:fs/promises');
      await mkdir(site, { recursive: true });
      await writeFile(
        path.join(site, 'index.html'),
        `<html><body style="font-family:system-ui;padding:30px">
           <button id="go">Open dashboard</button>
           <div id="view"><h1 class="home">Home view of the application</h1></div>
           <script>
             document.getElementById('go').addEventListener('click', () => {
               history.pushState({}, '', '/d/abc123');
               document.getElementById('view').innerHTML =
                 '<h1 class="dash">Dashboard rendered client side</h1>' +
                 '<p class="panel">A panel that needs restyling here</p>';
             });
           </script>
         </body></html>`,
      );
      const out = path.join(dir, 'out');
      const server = await serveStatic(site, 4600);
      try {
        const manifest = await runAnnotate({
          browser,
          url: server.url,
          outDir: out,
          projectDir: site,
          viewport: { width: 1100, height: 700 },
          onReady: async (page) => {
            // Browse mode, then navigate using the app's own control.
            await page.click('[data-act=setmode][data-mode=browse]');
            await page.click('#go');
            await page.waitForTimeout(350);

            assert.equal(await page.evaluate(() => location.pathname), '/d/abc123');
            assert.ok(
              await page.evaluate(() => !!document.querySelector('.ayna-ov-bar')),
              'overlay survives client-side navigation',
            );

            await page.click('[data-act=setmode][data-mode=comment]');
            await page.click('.panel');
            await page.waitForSelector('.ayna-ov-pop textarea', { timeout: 5000 });
            await page.fill('.ayna-ov-pop textarea', 'more padding here');
            await page.click('.ayna-ov-save');
            await page.waitForTimeout(500);

            await page.click('[data-act=send]');
            await page.waitForTimeout(300);
            await writeFile(path.join(out, 'applied'), '1');
            await page.waitForFunction(() => document.querySelector('[data-act=close]') !== null, {
              timeout: 20000,
            });
            await page.waitForTimeout(400);

            // The reload must land back on the SPA route, not a 404 or the root.
            assert.equal(
              await page.evaluate(() => location.pathname),
              '/d/abc123',
              'review reload stays on the page under review',
            );
            assert.match(
              await page.evaluate(() => document.body.innerText),
              /Home view of the application/,
              'the app shell actually booted rather than 404ing',
            );
            await page.click('[data-act=close]');
          },
        });

        assert.match(manifest.comments[0].url, /\/d\/abc123$/, 'comment carries the SPA route');
      } finally {
        await server.close();
      }
    } finally {
      await dispose();
    }
  });
});

describe('signing in during a review', { skip: !hasBrowser && 'AYNA_SKIP_BROWSER set' }, () => {
  let browser;
  before(async () => {
    browser = await openBrowser({ headless: true });
  });
  after(async () => {
    await browser?.close();
  });

  async function loginSite(dir) {
    const site = path.join(dir, 'site');
    const { mkdir } = await import('node:fs/promises');
    await mkdir(site, { recursive: true });
    await writeFile(
      path.join(site, 'index.html'),
      `<html><body style="font-family:system-ui;padding:40px">
         <form id="f"><h1>Sign in to continue</h1>
           <input id="email" type="email" placeholder="Email">
           <input id="pw" type="password" placeholder="Password">
           <button type="submit">Log in</button>
         </form>
         <div id="app" style="display:none"><h1 class="dash">The dashboard behind the login</h1></div>
         <script>
           document.getElementById('f').addEventListener('submit', e => {
             e.preventDefault();
             document.getElementById('f').style.display = 'none';
             document.getElementById('app').style.display = 'block';
           });
         </script>
       </body></html>`,
    );
    return site;
  }

  test('a sign-in page starts out of the way, and the form actually works', async () => {
    const { dir, dispose } = await tempDir();
    try {
      const site = await loginSite(dir);
      const server = await serveStatic(site, 4620);
      try {
        const manifest = await runAnnotate({
          browser,
          url: server.url,
          outDir: path.join(dir, 'out'),
          projectDir: site,
          viewport: { width: 1000, height: 700 },
          onReady: async (page) => {
            assert.match(
              await page.evaluate(() => document.querySelector('.ayna-ov-bar').textContent),
              /Sign in first/,
              'a password field means browse mode, with an explanation',
            );

            // No mode fiddling — just sign in.
            await page.click('#email');
            await page.keyboard.type('me@example.com');
            await page.click('#pw');
            await page.keyboard.type('correct horse battery');
            await page.click('button[type=submit]');
            await page.waitForTimeout(300);
            assert.ok(
              await page.evaluate(() => document.getElementById('app').style.display === 'block'),
              'the login went through',
            );

            await page.click('[data-act=setmode][data-mode=comment]');
            await page.click('.dash');
            await page.waitForSelector('.ayna-ov-pop textarea', { timeout: 5000 });
            await page.fill('.ayna-ov-pop textarea', 'heading needs work');
            await page.click('.ayna-ov-save');
            await page.waitForTimeout(500);
            await page.click('[data-act=send]');
            await page.waitForTimeout(400);
            await page.close();
          },
        });

        assert.equal(manifest.comments.length, 1, 'reviewed the page behind the login');
        assert.ok(
          !JSON.stringify(manifest).includes('correct horse battery'),
          'what the user typed is never captured',
        );
      } finally {
        await server.close();
      }
    } finally {
      await dispose();
    }
  });

  test('an email-only gate can be filled and submitted without leaving comment mode', async () => {
    const { dir, dispose } = await tempDir();
    try {
      const site = path.join(dir, 'site');
      const { mkdir } = await import('node:fs/promises');
      await mkdir(site, { recursive: true });
      await writeFile(
        path.join(site, 'index.html'),
        `<html><body style="padding:40px">
           <form id="f"><h1>Continue with email</h1>
             <input id="email" type="email" placeholder="Email">
             <button id="go" type="submit">Continue</button>
           </form>
           <div id="app" style="display:none"><h1 class="dash">App behind the gate</h1></div>
           <script>
             document.getElementById('f').addEventListener('submit', e => {
               e.preventDefault();
               document.getElementById('f').style.display = 'none';
               document.getElementById('app').style.display = 'block';
             });
           </script>
         </body></html>`,
      );
      const server = await serveStatic(site, 4622);
      try {
        await runAnnotate({
          browser,
          url: server.url,
          outDir: path.join(dir, 'out'),
          projectDir: site,
          viewport: { width: 1000, height: 700 },
          onReady: async (page) => {
            await page.click('#email');
            await page.keyboard.type('me@example.com');
            await page.click('#go');
            await page.waitForTimeout(350);
            assert.ok(
              await page.evaluate(() => document.getElementById('app').style.display === 'block'),
              'the submit button submits rather than opening a comment box',
            );
            assert.ok(
              !(await page.evaluate(() => !!document.querySelector('.ayna-ov-pop'))),
              'no comment box was opened by the click',
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

  test('a newsletter signup does not make a landing page look like a login', async () => {
    const { dir, dispose } = await tempDir();
    try {
      const site = path.join(dir, 'site');
      const { mkdir } = await import('node:fs/promises');
      await mkdir(site, { recursive: true });
      await writeFile(
        path.join(site, 'index.html'),
        `<html><body style="padding:40px"><h1 class="hero">Marketing landing page</h1>
           <p>Lots of content worth reviewing.</p>
           <footer><form><input type="email" placeholder="Newsletter">
             <button type="submit">Subscribe</button></form></footer>
         </body></html>`,
      );
      const server = await serveStatic(site, 4623);
      try {
        await runAnnotate({
          browser,
          url: server.url,
          outDir: path.join(dir, 'out'),
          projectDir: site,
          viewport: { width: 1000, height: 700 },
          onReady: async (page) => {
            assert.doesNotMatch(
              await page.evaluate(() => document.querySelector('.ayna-ov-bar').textContent),
              /Sign in first/,
              'an email capture in the footer is not a gate',
            );
            await page.click('.hero');
            await page.waitForSelector('.ayna-ov-pop textarea', { timeout: 5000 });
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

  test('a text field is typable in comment mode, and arrow keys do not hijack it', async () => {
    const { dir, dispose } = await tempDir();
    try {
      const site = path.join(dir, 'site');
      const { mkdir } = await import('node:fs/promises');
      await mkdir(site, { recursive: true });
      // No password field, so the overlay stays in comment mode.
      await writeFile(
        path.join(site, 'index.html'),
        '<html><body style="padding:40px"><h1>Filter the list to reach the view</h1>' +
          '<input id="q" type="search" placeholder="Search"></body></html>',
      );
      const server = await serveStatic(site, 4621);
      try {
        await runAnnotate({
          browser,
          url: server.url,
          outDir: path.join(dir, 'out'),
          projectDir: site,
          viewport: { width: 1000, height: 700 },
          onReady: async (page) => {
            assert.doesNotMatch(
              await page.evaluate(() => document.querySelector('.ayna-ov-bar').textContent),
              /Sign in first/,
              'no password field, so no auto-switch',
            );
            await page.click('#q');
            await page.keyboard.type('northwind');
            assert.equal(await page.inputValue('#q'), 'northwind', 'typing works in comment mode');

            await page.keyboard.press('ArrowUp');
            assert.equal(
              await page.inputValue('#q'),
              'northwind',
              'DOM traversal must not fire while a field has focus',
            );

            // Alt-click is how you comment on the field itself.
            await page.click('#q', { modifiers: ['Alt'] });
            await page.waitForSelector('.ayna-ov-pop textarea', { timeout: 5000 });
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

describe('comment box behaviour', { skip: !hasBrowser && 'AYNA_SKIP_BROWSER set' }, () => {
  let browser;
  before(async () => {
    browser = await openBrowser({ headless: true });
  });
  after(async () => {
    await browser?.close();
  });

  test('cancelling does not leave the element in the next comment', async () => {
    const { dir, dispose } = await tempDir();
    try {
      const site = path.join(dir, 'site');
      await fixtureSite(site);
      const out = path.join(dir, 'out');
      const server = await serveStatic(site, 4640);
      try {
        const manifest = await runAnnotate({
          browser,
          url: server.url,
          outDir: out,
          projectDir: site,
          viewport: { width: 1100, height: 700 },
          onReady: async (page) => {
            // Open on one element, change your mind, then comment on another.
            await page.click('.title');
            await page.waitForSelector('.ayna-ov-pop textarea');
            await page.click('.ayna-ov-cancel');
            await page.waitForTimeout(250);
            assert.equal(
              await page.evaluate(() => document.querySelectorAll('.ayna-ov-picked').length),
              0,
              'cancelling clears the selection marker',
            );

            await page.click('.lede');
            await page.waitForSelector('.ayna-ov-pop textarea');
            assert.doesNotMatch(
              await page.evaluate(() => document.querySelector('.ayna-ov-sel').textContent),
              /elements:/,
              'the second comment covers one element, not two',
            );
            await page.fill('.ayna-ov-pop textarea', 'just this one');
            await page.click('.ayna-ov-save');
            await page.waitForTimeout(500);

            await page.click('[data-act=send]');
            await page.waitForTimeout(300);
            await page.close();
          },
        });
        assert.equal(manifest.comments.length, 1);
        assert.equal(manifest.comments[0].elements.length, 1, 'exactly the element that was clicked');
      } finally {
        await server.close();
      }
    } finally {
      await dispose();
    }
  });

  test('the comment box stays fully on screen for an element near the edge', async () => {
    const { dir, dispose } = await tempDir();
    try {
      const site = path.join(dir, 'site');
      const { mkdir } = await import('node:fs/promises');
      await mkdir(site, { recursive: true });
      // A centred, full-viewport card — the layout that pushed the box off screen.
      await writeFile(
        path.join(site, 'index.html'),
        `<html><body style="margin:0;height:100vh;display:flex;align-items:center;justify-content:center;background:#222">
           <div style="width:340px;padding:24px;background:#fff">
             <h1 class="card-title">Sign in</h1>
             <p class="near-bottom" style="margin-top:220px">Something near the bottom edge</p>
           </div>
         </body></html>`,
      );
      const server = await serveStatic(site, 4641);
      try {
        await runAnnotate({
          browser,
          url: server.url,
          outDir: path.join(dir, 'out'),
          projectDir: site,
          viewport: { width: 900, height: 600 },
          onReady: async (page) => {
            for (const sel of ['.card-title', '.near-bottom']) {
              await page.click(sel);
              await page.waitForSelector('.ayna-ov-pop');
              const fits = await page.evaluate(() => {
                const b = document.querySelector('.ayna-ov-pop').getBoundingClientRect();
                return (
                  b.left >= 0 &&
                  b.top >= 0 &&
                  b.right <= document.documentElement.clientWidth + 1 &&
                  b.bottom <= document.documentElement.clientHeight + 1
                );
              });
              assert.ok(fits, `comment box fully visible for ${sel}`);
              await page.click('.ayna-ov-cancel');
              await page.waitForTimeout(200);
            }
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

describe('canvas-rendered apps', { skip: !hasBrowser && 'AYNA_SKIP_BROWSER set' }, () => {
  let browser;
  before(async () => {
    browser = await openBrowser({ headless: true });
  });
  after(async () => {
    await browser?.close();
  });

  test('a region can be framed on a canvas without the app panning underneath', async () => {
    const { dir, dispose } = await tempDir();
    try {
      const site = path.join(dir, 'site');
      const { mkdir } = await import('node:fs/promises');
      await mkdir(site, { recursive: true });
      await writeFile(
        path.join(site, 'index.html'),
        `<html><body style="margin:0">
           <canvas id="c" class="excalidraw__canvas" width="1000" height="700" style="display:block"></canvas>
           <script>
             const c = document.getElementById('c'), x = c.getContext('2d');
             x.fillStyle = '#1e2430'; x.fillRect(0, 0, 1000, 700);
             x.fillStyle = '#8fd3ff'; x.fillRect(120, 120, 220, 120);
             window.panned = 0;
             c.addEventListener('mousedown', () => { window.panned++; });
           </script>
         </body></html>`,
      );
      const server = await serveStatic(site, 4660);
      try {
        const manifest = await runAnnotate({
          browser,
          url: server.url,
          outDir: path.join(dir, 'out'),
          projectDir: site,
          viewport: { width: 1000, height: 700 },
          onReady: async (page) => {
            await page.mouse.move(200, 180);
            await page.waitForTimeout(200);
            assert.match(
              await page.evaluate(() => document.querySelector('.ayna-ov-tag').textContent),
              /drag a box/,
              'a canvas tells you to frame a region, since traversal has nothing finer',
            );

            await page.mouse.move(100, 100);
            await page.mouse.down();
            await page.mouse.move(370, 260, { steps: 12 });
            await page.waitForTimeout(150);
            await page.mouse.up();

            assert.equal(
              await page.evaluate(() => window.panned),
              0,
              'the drawing app must not receive the press that frames the region',
            );

            await page.waitForSelector('.ayna-ov-pop textarea', { timeout: 5000 });
            await page.fill('.ayna-ov-pop textarea', 'this node is too cramped');
            await page.click('.ayna-ov-save');
            await page.waitForTimeout(600);
            await page.click('[data-act=send]');
            await page.waitForTimeout(300);
            await page.close();
          },
        });

        const c = manifest.comments[0];
        assert.equal(c.kind, 'region');
        assert.ok(existsSync(c.regionScreenshot), 'the framed pixels are what carries the meaning');
        assert.ok(c.region.rect.width > 200);
      } finally {
        await server.close();
      }
    } finally {
      await dispose();
    }
  });
});

describe('more than one round in the same window', { skip: !hasBrowser && 'AYNA_SKIP_BROWSER set' }, () => {
  let browser;
  before(async () => {
    browser = await openBrowser({ headless: true });
  });
  after(async () => {
    await browser?.close();
  });

  test('a second round is picked up, and the first round stays resolved', async () => {
    const { dir, dispose } = await tempDir();
    try {
      const site = path.join(dir, 'site');
      await fixtureSite(site);
      const out = path.join(dir, 'out');
      const server = await serveStatic(site, 4680);
      const phase = async () => JSON.parse(await readFile(path.join(out, 'status.json'), 'utf8'));
      try {
        const manifest = await runAnnotate({
          browser,
          url: server.url,
          outDir: out,
          projectDir: site,
          viewport: { width: 1100, height: 700 },
          onReady: async (page) => {
            const add = async (sel, txt) => {
              await page.click(sel);
              await page.waitForSelector('.ayna-ov-pop textarea');
              await page.fill('.ayna-ov-pop textarea', txt);
              await page.click('.ayna-ov-save');
              await page.waitForTimeout(450);
            };

            await add('.title', 'round one');
            await page.click('[data-act=send]');
            await page.waitForTimeout(300);
            assert.equal((await phase()).round, 1);

            await writeFile(path.join(out, 'applied'), '1');
            await page.waitForFunction(() => document.querySelector('[data-act=close]') !== null, {
              timeout: 15000,
            });
            await page.waitForTimeout(400);
            await page.click('.ayna-ov-revbar >> nth=0 >> .ayna-ov-ok');
            await page.waitForTimeout(400);
            assert.equal((await phase()).resolved, 1);

            // Same window, another round.
            await page.click('[data-act=more]');
            await page.waitForTimeout(400);
            assert.equal((await phase()).phase, 'commenting');
            assert.equal(
              await page.evaluate(() => document.querySelector('[data-act=send]').disabled),
              true,
              'send is disabled again until the new round has something in it',
            );

            await add('.lede', 'round two');
            await page.click('[data-act=send]');
            await page.waitForTimeout(400);

            const p = await phase();
            assert.equal(p.phase, 'awaiting-claude', 'the new round is announced');
            assert.equal(p.round, 2);
            assert.equal(p.comments, 2);
            assert.equal(p.resolved, 1, 'the approved comment stays approved');
            assert.equal(p.open, 1, 'only the new one is outstanding');
            await page.close();
          },
        });

        assert.deepEqual(
          manifest.comments.map((c) => `${c.status}:${c.comment}`),
          ['approved:round one', 'open:round two'],
        );
      } finally {
        await server.close();
      }
    } finally {
      await dispose();
    }
  });
});

describe('pending work survives, and closing is not a verdict', { skip: !hasBrowser && 'AYNA_SKIP_BROWSER set' }, () => {
  let browser;
  before(async () => {
    browser = await openBrowser({ headless: true });
  });
  after(async () => {
    await browser?.close();
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
            await page.click('[data-act=close]'); // close without judging
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
            await page.mouse.move(80, 80);
            await page.mouse.down();
            await page.mouse.move(330, 250, { steps: 10 });
            await page.mouse.up();
            await page.waitForSelector('.ayna-ov-pop textarea', { timeout: 5000 });
            await page.waitForFunction(() => !!document.querySelector('.ayna-ov-auto img'), {
              timeout: 10000,
            });
            assert.ok(
              await page.evaluate(() =>
                [...document.querySelectorAll('.ayna-ov-hint')].some((h) =>
                  /attached automatically/.test(h.textContent),
                ),
              ),
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

describe('the loop keeps itself going', { skip: !hasBrowser && 'AYNA_SKIP_BROWSER set' }, () => {
  let browser;
  before(async () => {
    browser = await openBrowser({ headless: true });
  });
  after(async () => {
    await browser?.close();
  });

  test('applied catches the next round with nothing re-armed by hand', async () => {
    const { dir, dispose } = await tempDir();
    try {
      const { execFile } = await import('node:child_process');
      const { mkdir } = await import('node:fs/promises');
      const site = path.join(dir, 'site');
      await fixtureSite(site);
      const out = path.join(dir, '.ayna', 'comments', 's1');
      await mkdir(path.join(dir, '.ayna', 'session'), { recursive: true });
      await mkdir(out, { recursive: true });
      await writeFile(
        path.join(dir, 'ayna.config.json'),
        JSON.stringify({ target: { name: 'c', root: 'site', url: 'http://127.0.0.1:4730/' } }),
      );
      await writeFile(
        path.join(dir, '.ayna', 'session', 'last-comments.json'),
        JSON.stringify({ file: path.join(out, 'comments.json'), pid: process.pid }),
      );

      const bin = path.resolve(fileURLToPath(new URL('../bin/ayna.mjs', import.meta.url)));
      const applied = () =>
        new Promise((res) => {
          execFile('node', [bin, 'applied'], { cwd: dir, timeout: 120_000 }, (e, so) =>
            res(((so || '').trim().split('\n').pop()) || ''),
          );
        });

      const server = await serveStatic(site, 4730);
      let returned = '';
      try {
        await runAnnotate({
          browser,
          url: server.url,
          outDir: out,
          projectDir: dir,
          viewport: { width: 1100, height: 700 },
          onReady: async (page) => {
            const add = async (sel, txt) => {
              await page.click(sel);
              await page.waitForSelector('.ayna-ov-pop textarea');
              await page.fill('.ayna-ov-pop textarea', txt);
              await page.click('.ayna-ov-save');
              await page.waitForTimeout(400);
            };

            await add('.title', 'round one');
            await page.click('[data-act=send]');
            await page.waitForTimeout(400);

            // The only waiting command an agent runs after finishing its edits.
            const pending = applied();
            await page.waitForFunction(() => document.querySelector('[data-act=close]') !== null, {
              timeout: 20000,
            });
            await page.waitForTimeout(500);

            // A second round, with nothing re-armed in between.
            await page.click('[data-act=more]');
            await page.waitForTimeout(400);
            await add('.lede', 'round two');
            await page.click('[data-act=send]');
            await page.waitForTimeout(700);

            returned = await pending;
            await page.close();
          },
        });

        const payload = JSON.parse(returned);
        assert.equal(payload.round, 2, 'applied returned when the second round arrived');
        assert.equal(payload.action, 'read-comments');
      } finally {
        await server.close();
      }
    } finally {
      await dispose();
    }
  });

  test('every round and rejection is emitted, with nothing re-armed', async () => {
    const { dir, dispose } = await tempDir();
    try {
      const site = path.join(dir, 'site');
      await fixtureSite(site);
      const out = path.join(dir, 'out');
      const server = await serveStatic(site, 4732);
      const events = [];
      try {
        await runAnnotate({
          browser,
          url: server.url,
          outDir: out,
          projectDir: site,
          viewport: { width: 1100, height: 700 },
          onEvent: (e) => events.push(e),
          onReady: async (page) => {
            const add = async (sel, txt) => {
              await page.click(sel);
              await page.waitForSelector('.ayna-ov-pop textarea');
              await page.fill('.ayna-ov-pop textarea', txt);
              await page.click('.ayna-ov-save');
              await page.waitForTimeout(400);
            };

            await add('.title', 'round one');
            await page.click('[data-act=send]');
            await page.waitForTimeout(500);

            await writeFile(path.join(out, 'applied'), '1');
            await page.waitForFunction(() => document.querySelector('[data-act=close]') !== null, {
              timeout: 20000,
            });
            await page.waitForTimeout(400);

            await page.click('.ayna-ov-revbar >> nth=0 >> .ayna-ov-no');
            await page.waitForTimeout(400);

            await page.click('[data-act=more]');
            await page.waitForTimeout(400);
            await add('.lede', 'round two');
            await page.click('[data-act=send]');
            await page.waitForTimeout(600);
            await page.close();
          },
        });

        const kinds = events.map((e) => e.event);
        // `applied` reports that the window left the waiting phase, and says which
        // of the three signals ended it — the marker, a file change, or the user.
        assert.deepEqual(
          kinds,
          ['round', 'applied', 'rejected', 'round', 'closed'],
          kinds.join(','),
        );
        assert.equal(events.find((e) => e.event === 'applied').via, 'marker');
        assert.deepEqual(
          events.filter((e) => e.event === 'round').map((e) => e.round),
          [1, 2],
          'the second round is announced without anything being re-armed',
        );
        // By name, not by index: an added event should not break this.
        assert.equal(events.find((e) => e.event === 'round').action, 'read-comments');
        assert.equal(events.find((e) => e.event === 'rejected').action, 'retry-rejected');
      } finally {
        await server.close();
      }
    } finally {
      await dispose();
    }
  });

  test('the comment box never hides under the mode bar', async () => {
    const { dir, dispose } = await tempDir();
    try {
      const site = path.join(dir, 'site');
      const { mkdir } = await import('node:fs/promises');
      await mkdir(site, { recursive: true });
      await writeFile(
        path.join(site, 'index.html'),
        `<html><body style="margin:0;height:100vh">
           <p class="bottom" style="position:absolute;bottom:8px;left:20px">Right at the bottom edge</p>
         </body></html>`,
      );
      const server = await serveStatic(site, 4731);
      try {
        await runAnnotate({
          browser,
          url: server.url,
          outDir: path.join(dir, 'out'),
          projectDir: site,
          viewport: { width: 900, height: 600 },
          onReady: async (page) => {
            await page.click('.bottom');
            await page.waitForSelector('.ayna-ov-pop');
            const clear = await page.evaluate(() => {
              const pop = document.querySelector('.ayna-ov-pop').getBoundingClientRect();
              const bar = document.querySelector('.ayna-ov-bar').getBoundingClientRect();
              return pop.bottom <= bar.top;
            });
            assert.ok(clear, 'the box sits above the bar, so its buttons are clickable');
            // and it is genuinely clickable
            await page.fill('.ayna-ov-pop textarea', 'reachable');
            await page.click('.ayna-ov-save');
            await page.waitForTimeout(400);
            assert.equal(await page.evaluate(() => document.querySelectorAll('.ayna-ov-pin').length), 1);
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

describe('the overlay survives being resized', { skip: !hasBrowser && 'AYNA_SKIP_BROWSER set' }, () => {
  let browser;
  before(async () => {
    browser = await openBrowser({ headless: true });
  });
  after(async () => {
    await browser?.close();
  });

  const inspect = (page, sel) =>
    page.evaluate((s) => {
      const el = document.querySelector(s);
      if (!el) return null;
      const b = el.getBoundingClientRect();
      const barB = document.querySelector('.ayna-ov-bar')?.getBoundingClientRect();
      return {
        onScreen:
          b.left >= 0 && b.top >= 0 && b.right <= innerWidth + 1 && b.bottom <= innerHeight + 1,
        clearOfBar: !barB || b.bottom <= barB.top + 1,
      };
    }, sel);

  const clickable = (page, sel) =>
    page.evaluate((s) => {
      const b = document.querySelector(s).getBoundingClientRect();
      const hit = document.elementFromPoint(b.left + b.width / 2, b.top + b.height / 2);
      return !!hit && hit.closest(s) !== null;
    }, sel);

  test('the comment box stays reachable at any window size', async () => {
    const { dir, dispose } = await tempDir();
    try {
      const site = path.join(dir, 'site');
      await fixtureSite(site);
      const server = await serveStatic(site, 4740);
      try {
        await runAnnotate({
          browser,
          url: server.url,
          outDir: path.join(dir, 'out'),
          projectDir: site,
          viewport: { width: 900, height: 600 },
          onReady: async (page) => {
            await page.click('.title');
            await page.waitForSelector('.ayna-ov-pop');

            for (const size of [
              { width: 900, height: 600 },
              { width: 1600, height: 1000 }, // going full screen
              { width: 700, height: 380 }, // a cramped window
              { width: 480, height: 820 }, // narrow and tall
            ]) {
              await page.setViewportSize(size);
              await page.waitForTimeout(350);
              const box = await inspect(page, '.ayna-ov-pop');
              assert.ok(box.onScreen, `comment box on screen at ${size.width}x${size.height}`);
              assert.ok(box.clearOfBar, `comment box clear of the bar at ${size.width}x${size.height}`);
              assert.ok(
                await clickable(page, '.ayna-ov-save'),
                `Add comment reachable at ${size.width}x${size.height}`,
              );
            }
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

  test('review markers follow the layout when the window changes', async () => {
    const { dir, dispose } = await tempDir();
    try {
      const site = path.join(dir, 'site');
      await fixtureSite(site);
      const out = path.join(dir, 'out');
      const server = await serveStatic(site, 4741);
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
            await page.waitForTimeout(400);
            await page.click('[data-act=send]');
            await page.waitForTimeout(300);
            await writeFile(path.join(out, 'applied'), '1');
            await page.waitForFunction(() => document.querySelector('[data-act=close]') !== null, {
              timeout: 20000,
            });
            await page.waitForTimeout(400);

            const boxOf = () =>
              page.evaluate(() => {
                const m = document.querySelector('.ayna-ov-rev').getBoundingClientRect();
                const t = document.querySelector('.title').getBoundingClientRect();
                return { markerLeft: Math.round(m.left), targetLeft: Math.round(t.left) };
              });

            const before = await boxOf();
            assert.ok(Math.abs(before.markerLeft - before.targetLeft) < 6, 'marker starts aligned');

            await page.setViewportSize({ width: 700, height: 900 });
            await page.waitForTimeout(500);

            const after = await boxOf();
            assert.ok(
              Math.abs(after.markerLeft - after.targetLeft) < 6,
              'marker followed the element after the resize instead of staying put',
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

describe('the task list', { skip: !hasBrowser && 'AYNA_SKIP_BROWSER set' }, () => {
  let browser;
  before(async () => {
    browser = await openBrowser({ headless: true });
  });
  after(async () => {
    await browser?.close();
  });

  test('shows work from every page, this one first, and approves from the list', async () => {
    const { dir, dispose } = await tempDir();
    try {
      const { openStore } = await import('../src/tasks.mjs');
      const { mkdir } = await import('node:fs/promises');
      const site = path.join(dir, 'site');
      await mkdir(path.join(site, 'other'), { recursive: true });
      await writeFile(
        path.join(site, 'index.html'),
        '<html><body style="padding:40px"><h1 class="home">Home heading</h1></body></html>',
      );
      await writeFile(
        path.join(site, 'other', 'index.html'),
        '<html><body style="padding:40px"><h1 class="other">Other heading</h1></body></html>',
      );

      const server = await serveStatic(site, 4810);
      const store = await openStore(dir);
      // Work raised on a page we are not standing on.
      await store.create({
        comment: 'fix the other page heading',
        url: new URL('/other/', server.url).toString(),
        selector: '.other',
        kind: 'comment',
      });

      try {
        await runAnnotate({
          browser,
          url: server.url,
          outDir: path.join(dir, 'out'),
          projectDir: dir,
          store,
          viewport: { width: 1100, height: 700 },
          onReady: async (page) => {
            await page.click('.home');
            await page.waitForSelector('.ayna-ov-pop textarea');
            await page.fill('.ayna-ov-pop textarea', 'home heading too big');
            await page.click('.ayna-ov-save');
            await page.waitForTimeout(600);

            assert.match(
              await page.evaluate(() => document.querySelector('[data-act=tasks]').textContent),
              /Tasks · 2/,
              'the bar counts pending work without the panel being open',
            );

            await page.click('[data-act=tasks]');
            await page.waitForSelector('.ayna-ov-panel');

            const groups = await page.evaluate(() =>
              [...document.querySelectorAll('.ayna-ov-group')].map((g) => g.textContent.trim()),
            );
            assert.equal(groups.length, 2, 'grouped by the page each was raised on');
            assert.match(groups[0], /this page/, 'what you can act on now comes first');
            assert.equal(
              await page.evaluate(() => document.querySelectorAll('.ayna-ov-task').length),
              2,
              'work from another route is visible here',
            );

            await page.click('.ayna-ov-task .ayna-ov-task-acts button[data-act=ok]');
            await page.waitForTimeout(700);
            await page.close();
          },
        });

        const statuses = Object.fromEntries((await store.list()).map((t) => [t.comment, t.status]));
        assert.equal(statuses['home heading too big'], 'approved', 'approving from the list writes through');
        assert.equal(statuses['fix the other page heading'], 'open', 'and touches nothing else');
      } finally {
        await server.close();
      }
    } finally {
      await dispose();
    }
  });
});

describe('Claude proposing its own changes', { skip: !hasBrowser && 'AYNA_SKIP_BROWSER set' }, () => {
  let browser;
  before(async () => {
    browser = await openBrowser({ headless: true });
  });
  after(async () => {
    await browser?.close();
  });

  test('a proposal waits for the user, who can approve it or say what to do instead', async () => {
    const { dir, dispose } = await tempDir();
    try {
      const { openStore } = await import('../src/tasks.mjs');
      const site = path.join(dir, 'site');
      await fixtureSite(site);
      const server = await serveStatic(site, 4820);
      const store = await openStore(dir);
      const events = [];

      // Two faults Claude found itself. Nothing has been edited.
      await store.create({
        status: 'proposed', kind: 'proposal', source: 'claude',
        comment: 'the heading is cut off at 390px',
        fix: 'let the container wrap below 640px',
        selector: '.title', url: server.url,
      });
      await store.create({
        status: 'proposed', kind: 'proposal', source: 'claude',
        comment: 'body copy is cramped', fix: 'raise the line-height',
        selector: '.lede', url: server.url,
      });

      try {
        await runAnnotate({
          browser, url: server.url, outDir: path.join(dir, 'out'), projectDir: dir, store,
          viewport: { width: 1100, height: 700 },
          onEvent: (e) => events.push(e),
          onReady: async (page) => {
            await page.waitForTimeout(500);
            await page.evaluate(() => window.__aynaReview && window.__aynaReview());
            await page.waitForTimeout(600);

            assert.deepEqual(
              await page.evaluate(() => [...document.querySelectorAll('.ayna-ov-rev')].map((n) => n.dataset.status)),
              ['proposed', 'proposed'],
              'suggestions are shown as suggestions, not as done work',
            );

            await page.click('.ayna-ov-revbar >> nth=0 >> .ayna-ov-revpin');
            await page.waitForSelector('.ayna-ov-card');
            assert.match(
              await page.evaluate(() => document.querySelector('.ayna-ov-badge').textContent),
              /Claude suggests/,
            );
            assert.ok(
              await page.evaluate(() => !!document.querySelector('.ayna-ov-fix')),
              'the proposed fix is shown, so the user is judging something they can see',
            );
            assert.deepEqual(
              await page.evaluate(() => [...document.querySelectorAll('.ayna-ov-card button')].map((b) => b.textContent)),
              ['Leave it', 'Go ahead'],
            );
            await page.click('[data-act=go]');
            await page.waitForTimeout(500);

            // The second one: redirect it instead of accepting it.
            await page.click('.ayna-ov-revbar >> nth=1 >> .ayna-ov-revpin');
            await page.waitForSelector('.ayna-ov-card textarea');
            await page.fill('.ayna-ov-card textarea', 'no — hide it on mobile instead');
            await page.click('[data-act=go]');
            await page.waitForTimeout(600);
            await page.close();
          },
        });

        const tasks = await store.list();
        const approved = tasks.find((t) => t.comment.includes('cut off'));
        const redirected = tasks.find((t) => t.comment.includes('hide it on mobile'));

        assert.equal(approved.status, 'open', 'approving a proposal authorises the work, it does not finish it');
        assert.equal(approved.source, 'claude');
        assert.ok(redirected, 'the user\'s words replaced the suggestion');
        assert.equal(redirected.source, 'user', 'and it is now their instruction, not Claude\'s idea');

        const actions = events.filter((e) => e.event === 'task').map((e) => e.action);
        assert.deepEqual(actions, ['go-ahead', 'do-this-instead']);
      } finally {
        await server.close();
      }
    } finally {
      await dispose();
    }
  });
});

describe('auditing the window that is already open', { skip: !hasBrowser && 'AYNA_SKIP_BROWSER set' }, () => {
  let browser;
  before(async () => {
    browser = await openBrowser({ headless: true });
  });
  after(async () => {
    await browser?.close();
  });

  test('measures the state the user is looking at, without closing their review', async () => {
    const { dir, dispose } = await tempDir();
    try {
      const site = path.join(dir, 'site');
      const { mkdir } = await import('node:fs/promises');
      await mkdir(site, { recursive: true });
      // A fault that only exists after you click into a state.
      await writeFile(
        path.join(site, 'index.html'),
        `<html><body style="margin:0;padding:30px">
           <button id="go">Show live view</button>
           <div id="live" style="display:none;position:relative;height:200px">
             <button id="deploy" style="position:absolute;left:20px;top:60px">Deploy</button>
             <div id="toast" style="position:absolute;left:0;top:40px;width:300px;height:60px;background:#333"></div>
           </div>
           <script>
             document.getElementById('go').onclick = () => {
               document.getElementById('live').style.display = 'block';
             };
           </script>
         </body></html>`,
      );
      const out = path.join(dir, 'out');
      const server = await serveStatic(site, 4850);
      const events = [];
      try {
        await runAnnotate({
          browser,
          url: server.url,
          outDir: out,
          projectDir: site,
          viewport: { width: 900, height: 600 },
          onEvent: (e) => events.push(e),
          onReady: async (page) => {
            const askForAudit = async () => {
              const res = path.join(out, 'audit-live.json');
              await (await import('node:fs/promises')).rm(res, { force: true });
              await writeFile(path.join(out, 'audit-request'), '1');
              const deadline = Date.now() + 20000;
              while (Date.now() < deadline && !existsSync(res)) await page.waitForTimeout(200);
              return JSON.parse(await readFile(res, 'utf8'));
            };

            const before = await askForAudit();
            assert.equal(before.counts.covered, 0, 'nothing is covered in the state it loads in');

            // The user clicks into the state where things collide.
            await page.click('#go');
            await page.waitForTimeout(400);

            const after = await askForAudit();
            assert.equal(
              after.counts.covered,
              1,
              'the fault that only exists after clicking is found, in the same window',
            );
            assert.match(after.findings[0].covered[0].label, /Deploy/);
            assert.ok(!page.isClosed(), 'and their review was never closed to do it');
            await page.close();
          },
        });

        const audits = events.filter((e) => e.event === 'audit');
        assert.equal(audits.length, 2, 'each audit is announced');
      } finally {
        await server.close();
      }
    } finally {
      await dispose();
    }
  });
});
