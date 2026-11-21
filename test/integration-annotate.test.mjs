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
import { tempDir, fixtureSite, hasBrowser, press, launchBrowser, eventually } from './helpers.mjs';

// The pin shows at once; the comment is stored once the Tasks count includes it.
const saved = (page, n) =>
  page.waitForSelector(`[data-act=tasks][aria-label="Tasks, ${n} pending"]`, { state: 'attached', timeout: 10000 });
// Send returns before Node has cleared old markers; status.json says when it has.
const phaseOf = async (out) => JSON.parse(await readFile(path.join(out, 'status.json'), 'utf8')).phase;
const sent = (out) => eventually(async () => (await phaseOf(out)) === 'awaiting-claude', { timeout: 10000 });

describe('annotate round-trip', { skip: !hasBrowser && 'AYNA_SKIP_BROWSER set' }, () => {
  let browser;
  beforeEach(async () => {
    browser = await launchBrowser();
  });
  afterEach(async () => {
    await browser?.close().catch(() => {});
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
            await saved(page, 1);
            await page.click('[data-act=send]');
            await sent(out);
            await writeFile(path.join(out, 'applied'), '1');
            await page.waitForFunction(
              () => document.querySelector('[data-act=close]') !== null,
              null,
              { timeout: 15000 },
            );
            await press(page, 'close');
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
            const phase = () => phaseOf(out);

            await page.click('.title');
            await page.waitForSelector('.ayna-ov-pop textarea');
            await page.fill('.ayna-ov-pop textarea', 'x');
            await page.click('.ayna-ov-save');
            await saved(page, 1);

            await page.click('[data-act=send]');
            await sent(out);
            phases.push(await phase());
            assert.equal(page.isClosed(), false, 'window must stay open after send');

            await writeFile(path.join(out, 'applied'), '1');
            await page.waitForFunction(() => document.querySelector('[data-act=close]') !== null, null, {
              timeout: 15000,
            });
            phases.push(await phase());
            assert.equal(page.isClosed(), false, 'window must stay open during review');

            await press(page, 'close');
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
            await saved(page, 1);
            await page.click('[data-act=send]');
            await sent(out);
            // Two 300ms watch ticks: a stale marker would have been acted on by now.
            await page.waitForTimeout(600);
            phaseAfterSend = await phaseOf(out);
            await writeFile(path.join(out, 'applied'), '1');
            await page.waitForFunction(() => document.querySelector('[data-act=close]') !== null, null, {
              timeout: 15000,
            });
            await press(page, 'close');
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
  beforeEach(async () => {
    browser = await launchBrowser();
  });
  afterEach(async () => {
    await browser?.close().catch(() => {});
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
        const tag = () => page.evaluate(() => document.querySelector('.ayna-ov-tag b')?.textContent);
        await page.hover('.list li:nth-of-type(2)');
        const before = await eventually(tag);
        await page.keyboard.press('ArrowUp');
        const after = await eventually(async () => {
          const t = await tag();
          return t !== before && t;
        }).catch(tag);
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
        await eventually(() => submissions.length > 0);

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
        await page.mouse.up();
        await eventually(() => submissions.length > 0);

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
        await page
          .waitForFunction(() => !document.querySelector('[data-act=send]').disabled, null, { timeout: 5000 })
          .catch(() => {});
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

describe('region selection and image attachment', { skip: !hasBrowser && 'AYNA_SKIP_BROWSER set' }, () => {
  let browser;
  beforeEach(async () => {
    browser = await launchBrowser();
  });
  afterEach(async () => {
    await browser?.close().catch(() => {});
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
            /*
              Start inside the page, not in ayna's own rail.

              The console occupies the left edge now, the way the bar occupies the
              top, so a drag beginning six pixels left of an element near the page
              edge begins on the overlay and never reaches the app. That is the
              cost of docking anything, and the test asserts marquee behaviour
              rather than the geometry around it.
            */
            const box = await page.locator('.list').boundingBox();
            const rail = await page.evaluate(() => {
              const c = document.querySelector('.ayna-ov-console');
              return c ? Math.round(c.getBoundingClientRect().right) : 0;
            });
            await page.mouse.move(Math.max(box.x - 6, rail + 8), box.y - 6);
            await page.mouse.down();
            await page.mouse.move(box.x + box.width + 6, box.y + box.height + 6, { steps: 12 });
            await page.mouse.up();

            await page.waitForSelector('.ayna-ov-pop textarea', { timeout: 5000 });
            await page.setInputFiles('.ayna-ov-attach input', ref);
            await page.waitForSelector('.ayna-ov-thumbs img');
            await page.fill('.ayna-ov-pop textarea', 'this block is cramped');
            await page.click('.ayna-ov-save');
            await saved(page, 1);

            await page.click('[data-act=send]');
            await sent(out);
            await writeFile(path.join(out, 'applied'), '1');
            await page.waitForFunction(() => document.querySelector('[data-act=close]') !== null, null, {
              timeout: 15000,
            });
            await press(page, 'close');
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
            await saved(page, 1);
            await page.click('[data-act=send]');
            await sent(out);
            await writeFile(path.join(out, 'applied'), '1');
            await page.waitForFunction(() => document.querySelector('[data-act=close]') !== null, null, {
              timeout: 15000,
            });
            await press(page, 'close');
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
  beforeEach(async () => {
    browser = await launchBrowser();
  });
  afterEach(async () => {
    await browser?.close().catch(() => {});
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
            let added = 0;
            const add = async (sel, text) => {
              await page.click(sel);
              await page.waitForSelector('.ayna-ov-pop textarea');
              await page.fill('.ayna-ov-pop textarea', text);
              await page.click('.ayna-ov-save');
              await saved(page, ++added);
            };
            await add('.title', 'first');
            await add('.lede', 'second');
            await add('.list li:nth-of-type(1)', 'third');
            assert.equal(await page.evaluate(() => document.querySelectorAll('.ayna-ov-pin').length), 3);

            // Remove the middle one.
            await page.click('.ayna-ov-pin >> nth=1');
            await saved(page, 2);
            assert.equal(await page.evaluate(() => document.querySelectorAll('.ayna-ov-pin').length), 2);
            assert.deepEqual(
              await page.evaluate(() => [...document.querySelectorAll('.ayna-ov-pin b')].map((b) => b.textContent)),
              ['1', '2'],
              'remaining pins are renumbered contiguously',
            );
            // Same move as above: the count is on the Tasks button now.
            assert.match(
              await page.evaluate(() => document.querySelector('[data-act=tasks]').getAttribute('aria-label')),
              /Tasks, 2 pending/,
            );

            await page.click('[data-act=send]');
            await sent(out);
            await writeFile(path.join(out, 'applied'), '1');
            await page.waitForFunction(() => document.querySelector('[data-act=close]') !== null, null, {
              timeout: 15000,
            });
            await press(page, 'close');
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
            await saved(page, 1);
            assert.equal(await page.evaluate(() => document.querySelector('[data-act=send]').disabled), false);

            await page.click('.ayna-ov-pin');
            await page.waitForSelector('.ayna-ov-pin', { state: 'detached', timeout: 5000 }).catch(() => {});
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
  beforeEach(async () => {
    browser = await launchBrowser();
  });
  afterEach(async () => {
    await browser?.close().catch(() => {});
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
            let added = 0;
            const add = async (sel, txt) => {
              await page.click(sel);
              await page.waitForSelector('.ayna-ov-pop textarea');
              await page.fill('.ayna-ov-pop textarea', txt);
              await page.click('.ayna-ov-save');
              await saved(page, ++added);
            };
            await add('.title', 'headline too big');
            await add('.lede', 'body copy cramped');

            await page.click('[data-act=send]');
            await sent(out);
            await writeFile(path.join(out, 'applied'), '1');
            await page.waitForFunction(() => document.querySelector('[data-act=close]') !== null, null, {
              timeout: 15000,
            });
            // The markers are drawn, then the progress line is filled in.
            await page.waitForFunction(() => document.querySelector('.ayna-ov-progress')?.textContent, null, {
              timeout: 5000,
            });

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
            await page.waitForSelector('.ayna-ov-rev[data-status=approved]', { state: 'attached' });
            await page.click('.ayna-ov-revbar >> nth=1 >> .ayna-ov-no');
            await page.waitForSelector('.ayna-ov-rev[data-status=rejected]', { state: 'attached' });
            await page
              .waitForFunction(() => /^1 left/.test(document.querySelector('.ayna-ov-progress').textContent), null, {
                timeout: 5000,
              })
              .catch(() => {});

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
              /approved/i,
            );
            // Approved reads as done: green, not the amber of work still owed.
            assert.deepEqual(
              await page.evaluate(() => [
                getComputedStyle(document.querySelector('.ayna-ov-badge')).backgroundColor,
                getComputedStyle(document.querySelector('.ayna-ov-revpin[data-status=approved]')).backgroundColor,
              ]),
              ['rgb(220, 252, 231)', 'rgb(123, 196, 127)'],
            );
            await press(page, 'close');
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

describe('comment box behaviour', { skip: !hasBrowser && 'AYNA_SKIP_BROWSER set' }, () => {
  let browser;
  beforeEach(async () => {
    browser = await launchBrowser();
  });
  afterEach(async () => {
    await browser?.close().catch(() => {});
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
            await page.waitForSelector('.ayna-ov-pop', { state: 'detached' });
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
            await saved(page, 1);

            await page.click('[data-act=send]');
            await sent(out);
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
              await page.waitForSelector('.ayna-ov-pop', { state: 'detached' });
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
