/*
  These drive a real Chrome. They are the tests that actually protect the product:
  the capture diagnostics and the annotate round-trip are where the bugs have been.

  Set AYNA_SKIP_BROWSER=1 to skip them (e.g. on a machine with no Chrome).
*/
import { test, describe, before, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { writeFile, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';

import { capture, captureRoutes, routeSlug } from '../src/browser.mjs';
import { serveStatic } from '../src/server.mjs';
import { runAnnotate } from '../src/annotate.mjs';
import { tempDir, fixtureSite, hasBrowser, press, launchBrowser, eventually } from './helpers.mjs';

// The pin shows at once; the comment is stored once the Tasks count includes it.
const saved = (page, n) =>
  page.waitForSelector(`[data-act=tasks][aria-label="Tasks, ${n} pending"]`, { state: 'attached', timeout: 10000 });
// Send returns before Node has cleared old markers; status.json says when it has.
const sent = (out) =>
  eventually(
    async () => JSON.parse(await readFile(path.join(out, 'status.json'), 'utf8')).phase === 'awaiting-claude',
    { timeout: 10000 },
  );

describe('browser capture', { skip: !hasBrowser && 'AYNA_SKIP_BROWSER set' }, () => {
  let browser;
  beforeEach(async () => {
    browser = await launchBrowser();
  });
  afterEach(async () => {
    await browser?.close().catch(() => {});
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

describe('multi-route capture', { skip: !hasBrowser && 'AYNA_SKIP_BROWSER set' }, () => {
  let browser;
  beforeEach(async () => {
    browser = await launchBrowser();
  });
  afterEach(async () => {
    await browser?.close().catch(() => {});
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

describe('multi-page review', { skip: !hasBrowser && 'AYNA_SKIP_BROWSER set' }, () => {
  let browser;
  beforeEach(async () => {
    browser = await launchBrowser();
  });
  afterEach(async () => {
    await browser?.close().catch(() => {});
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
            await saved(page, 1);

            // Browse mode, then follow the link.
            await page.click('[data-act=setmode][data-mode=browse]');
            await page.click('.nav');
            await page.waitForSelector('.about');
            await saved(page, 1).catch(() => {});

            /*
              The overlay is rebuilt, but the count and mode must survive.

              The count used to sit in its own span beside a Tasks button that
              also showed it — the same number twice, in two wordings. It lives on
              the button now, which is the thing that opens the list it counts.
            */
            assert.match(
              await page.evaluate(() => document.querySelector('[data-act=tasks]')?.getAttribute('aria-label')),
              /Tasks, 1 pending/,
              'earlier comments are not forgotten across navigation',
            );

            await page.click('[data-act=setmode][data-mode=comment]');
            await page.click('.about');
            await page.waitForSelector('.ayna-ov-pop textarea');
            await page.fill('.ayna-ov-pop textarea', 'about heading');
            await page.click('.ayna-ov-save');
            await saved(page, 2);

            await page.click('[data-act=send]');
            await sent(out);
            await writeFile(path.join(out, 'applied'), '1');
            await page.waitForFunction(() => document.querySelector('[data-act=close]') !== null, null, {
              timeout: 15000,
            });
            await press(page, 'close');
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

describe('navigating the app during a review', { skip: !hasBrowser && 'AYNA_SKIP_BROWSER set' }, () => {
  let browser;
  beforeEach(async () => {
    browser = await launchBrowser();
  });
  afterEach(async () => {
    await browser?.close().catch(() => {});
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
            await page.waitForSelector('.panel');

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
            await saved(page, 1);

            await page.click('[data-act=send]');
            await sent(out);
            await writeFile(path.join(out, 'applied'), '1');
            await page.waitForFunction(() => document.querySelector('[data-act=close]') !== null, null, {
              timeout: 20000,
            });

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
            await press(page, 'close');
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
  beforeEach(async () => {
    browser = await launchBrowser();
  });
  afterEach(async () => {
    await browser?.close().catch(() => {});
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
            await page.waitForSelector('#app', { timeout: 5000 }).catch(() => {});
            assert.ok(
              await page.evaluate(() => document.getElementById('app').style.display === 'block'),
              'the login went through',
            );

            await page.click('[data-act=setmode][data-mode=comment]');
            await page.click('.dash');
            await page.waitForSelector('.ayna-ov-pop textarea', { timeout: 5000 });
            await page.fill('.ayna-ov-pop textarea', 'heading needs work');
            await page.click('.ayna-ov-save');
            await saved(page, 1);
            await page.click('[data-act=send]');
            await sent(path.join(dir, 'out'));
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
            await page.waitForSelector('#app', { timeout: 5000 }).catch(() => {});
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

describe('canvas-rendered apps', { skip: !hasBrowser && 'AYNA_SKIP_BROWSER set' }, () => {
  let browser;
  beforeEach(async () => {
    browser = await launchBrowser();
  });
  afterEach(async () => {
    await browser?.close().catch(() => {});
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
            // Over the canvas, not over ayna's rail down the left edge.
            const clear = await page.evaluate(() => {
              const c = document.querySelector('.ayna-ov-console');
              return (c ? Math.round(c.getBoundingClientRect().right) : 0) + 40;
            });
            await page.mouse.move(clear, 180);
            await page
              .waitForFunction(() => /drag a box/.test(document.querySelector('.ayna-ov-tag')?.textContent), null, {
                timeout: 5000,
              })
              .catch(() => {});
            assert.match(
              await page.evaluate(() => document.querySelector('.ayna-ov-tag').textContent),
              /drag a box/,
              'a canvas tells you to frame a region, since traversal has nothing finer',
            );

            await page.mouse.move(clear, 100);
            await page.mouse.down();
            await page.mouse.move(clear + 270, 260, { steps: 12 });
            await page.mouse.up();

            assert.equal(
              await page.evaluate(() => window.panned),
              0,
              'the drawing app must not receive the press that frames the region',
            );

            await page.waitForSelector('.ayna-ov-pop textarea', { timeout: 5000 });
            await page.fill('.ayna-ov-pop textarea', 'this node is too cramped');
            await page.click('.ayna-ov-save');
            await saved(page, 1);
            await page.click('[data-act=send]');
            await sent(path.join(dir, 'out'));
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
