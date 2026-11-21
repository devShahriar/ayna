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

describe('more than one round in the same window', { skip: !hasBrowser && 'AYNA_SKIP_BROWSER set' }, () => {
  let browser;
  beforeEach(async () => {
    browser = await launchBrowser();
  });
  afterEach(async () => {
    await browser?.close().catch(() => {});
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
            await press(page, 'more');
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

describe('the overlay survives being resized', { skip: !hasBrowser && 'AYNA_SKIP_BROWSER set' }, () => {
  let browser;
  beforeEach(async () => {
    browser = await launchBrowser();
  });
  afterEach(async () => {
    await browser?.close().catch(() => {});
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
        clearOfBar: !barB || b.bottom <= barB.top + 1 || b.top >= barB.bottom - 1,
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
  beforeEach(async () => {
    browser = await launchBrowser();
  });
  afterEach(async () => {
    await browser?.close().catch(() => {});
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
              await page.evaluate(() => document.querySelector('[data-act=tasks]').getAttribute('aria-label')),
              /Tasks, 2 pending/,
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
  beforeEach(async () => {
    browser = await launchBrowser();
  });
  afterEach(async () => {
    await browser?.close().catch(() => {});
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
  beforeEach(async () => {
    browser = await launchBrowser();
  });
  afterEach(async () => {
    await browser?.close().catch(() => {});
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

            // The user switches to Browse and clicks into the state where things collide.
            await page.click('[data-act=setmode][data-mode=browse]');
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
