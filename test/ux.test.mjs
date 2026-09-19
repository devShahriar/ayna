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
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { openBrowser, gotoSettled } from '../src/browser.mjs';
import { runAnnotate } from '../src/annotate.mjs';
import { openStore } from '../src/tasks.mjs';
import { pending as pendingWork, since as pendingEvents } from '../src/events.mjs';
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

describe('getting out of "waiting for Claude"', { skip: !hasBrowser && 'AYNA_SKIP_BROWSER set' }, () => {
  let browser;
  before(async () => {
    browser = await openBrowser({ headless: true });
  });
  after(async () => {
    await browser?.close().catch(() => {});
  });

  /*
    "Sent — waiting for Claude" cleared on one thing: a marker file written by
    `ayna applied`. A session that never ran it left the window on that spinner
    permanently, over changes that were already on disk — the user waiting for
    something that had happened. There are now three ways out, and all three must
    keep working, because the failure is indistinguishable from Claude being slow.
  */
  async function reachesReview(escape) {
    const { srv, url } = await pollingServer('<h1 class="title">Hello</h1>');
    const dir = await mkdtemp(path.join(tmpdir(), 'ayna-wait-'));
    try {
      await writeFile(path.join(dir, 'app.css'), 'h1{font-size:20px}');
      let reached = false;
      await runAnnotate({
        browser,
        url,
        outDir: path.join(dir, 'out'),
        projectDir: dir,
        viewport: { width: 1000, height: 700 },
        onReady: async (page) => {
          await page.click('.title');
          await page.waitForSelector('.ayna-ov-pop textarea', { timeout: 10000 });
          await page.fill('.ayna-ov-pop textarea', 'make it bigger');
          await page.click('.ayna-ov-save');
          await page.waitForTimeout(300);
          await page.click('[data-act=send]');
          await page.waitForSelector('.ayna-ov-waiting', { timeout: 10000 });
          await page.waitForTimeout(400);

          await escape(page, dir);

          reached = await page
            .waitForFunction(() => document.querySelector('[data-act=close]') !== null, {
              timeout: 20000,
            })
            .then(() => true)
            .catch(() => false);
          await page.close();
        },
      });
      return reached;
    } finally {
      srv.close();
      await rm(dir, { recursive: true, force: true });
    }
  }

  test('an edit on disk is enough, with nothing reporting in', async () => {
    const reached = await reachesReview(async (_page, dir) => {
      await writeFile(path.join(dir, 'app.css'), 'h1{font-size:48px}');
    });
    assert.ok(reached, 'a changed project file should end the wait on its own');
  });

  test('the user can always say the changes have landed', async () => {
    const reached = await reachesReview(async (page) => {
      await page.click('[data-act=applied]');
    });
    assert.ok(reached, 'the button in the window must not depend on anything else running');
  });

  test('`ayna applied` still works for anything that does report in', async () => {
    const reached = await reachesReview(async (_page, dir) => {
      await writeFile(path.join(dir, 'out', 'applied'), '1');
    });
    assert.ok(reached, 'the marker path must keep working');
  });

  test('ayna’s own output does not count as Claude finishing', async () => {
    // Comments, screenshots and status all land under .ayna while the user is
    // still commenting. Counting those would reload the page mid-sentence.
    const reached = await reachesReview(async (_page, dir) => {
      await mkdir(path.join(dir, '.ayna'), { recursive: true });
      await writeFile(path.join(dir, '.ayna', 'noise.json'), '{"a":1}');
      await writeFile(path.join(dir, 'node_modules-ish.txt'), 'not source');
      await new Promise((r) => setTimeout(r, 3500));
    });
    assert.equal(reached, false, 'writing under .ayna must not be read as an applied fix');
  });
});

describe('work is visible while it is still being done', { skip: !hasBrowser && 'AYNA_SKIP_BROWSER set' }, () => {
  let browser;
  before(async () => {
    browser = await openBrowser({ headless: true });
  });
  after(async () => {
    await browser?.close().catch(() => {});
  });

  test('a comment reaches the store the moment it is made, not when the window closes', async () => {
    /*
      `bin/ayna.mjs` built a store and never handed it to `runAnnotate`, so every
      `if (store)` branch inside was dead. A comment existed only inside the
      running process until the session ended and some later command scraped the
      finished manifest — so anything asking "what is owed?" during a review got
      nothing, which is precisely when somebody wants to know.

      The test is deliberately from the outside: a second store handle, as a
      different process would open.
    */
    const { srv, url } = await pollingServer('<h1 class="title">Hello</h1>');
    const dir = await mkdtemp(path.join(tmpdir(), 'ayna-live-'));
    try {
      let seenDuring = [];
      let owedDuring = 0;

      await runAnnotate({
        browser,
        url,
        outDir: path.join(dir, 'out'),
        projectDir: dir,
        store: await openStore(dir),
        viewport: { width: 1000, height: 700 },
        onReady: async (page) => {
          await page.click('.title');
          await page.waitForSelector('.ayna-ov-pop textarea', { timeout: 10000 });
          await page.fill('.ayna-ov-pop textarea', 'widen this nav bar');
          await page.click('.ayna-ov-save');
          await page.waitForTimeout(600);

          // Still open, still commenting — ask from outside.
          const outside = await openStore(dir);
          seenDuring = (await outside.list()).map((t) => t.comment);
          owedDuring = (await pendingWork(dir)).pending;

          await page.close();
        },
      });

      assert.deepEqual(seenDuring, ['widen this nav bar'], 'the comment was invisible while the window was open');
      assert.equal(owedDuring, 1);
    } finally {
      srv.close();
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe('ending a review', { skip: !hasBrowser && 'AYNA_SKIP_BROWSER set' }, () => {
  let browser;
  before(async () => {
    browser = await openBrowser({ headless: true });
  });
  after(async () => {
    await browser?.close().catch(() => {});
  });

  /** Two comments, sent, applied, and left sitting in the review phase. */
  async function reviewing(run) {
    const { srv, url } = await pollingServer('<h1 class="a">Right at the top</h1><p class="b">Two</p>');
    const dir = await mkdtemp(path.join(tmpdir(), 'ayna-end-'));
    try {
      await runAnnotate({
        browser,
        url,
        outDir: path.join(dir, 'out'),
        projectDir: dir,
        viewport: { width: 1000, height: 700 },
        onReady: async (page) => {
          for (const [sel, text] of [['.a', 'first'], ['.b', 'second']]) {
            await page.click(sel);
            await page.waitForSelector('.ayna-ov-pop textarea', { timeout: 10000 });
            await page.fill('.ayna-ov-pop textarea', text);
            await page.click('.ayna-ov-save');
            await page.waitForTimeout(250);
          }
          await page.click('[data-act=send]');
          await page.waitForTimeout(300);
          await writeFile(path.join(dir, 'out', 'applied'), '1');
          await page.waitForFunction(() => document.querySelector('[data-act=close]') !== null, {
            timeout: 20000,
          });
          await page.waitForTimeout(500);
          await run(page);
          if (!page.isClosed()) {
            await page.click('[data-act=close]');
            await page.waitForTimeout(2000);
          }
        },
      });
    } finally {
      srv.close();
      await rm(dir, { recursive: true, force: true });
    }
  }

  test('every verdict is clickable, including for elements at the top of the page', async () => {
    /*
      Verdict bars sit above their element and were clamped to the top of the
      window, which put the ones for anything near the top underneath ayna's own
      bar — visible and unclickable. The review phase exists to press those
      buttons, so it was the worst possible place to commit the fault this tool
      reports in other people's UIs.
    */
    let hidden = null;
    let clicked = 0;
    await reviewing(async (page) => {
      hidden = await page.evaluate(() => {
        const bar = document.querySelector('.ayna-ov-bar').getBoundingClientRect();
        return [...document.querySelectorAll('.ayna-ov-revbar')]
          .map((b) => b.getBoundingClientRect())
          .filter((r) => r.top < bar.bottom).length;
      });
      for (const bar of await page.$$('.ayna-ov-revbar')) {
        const ok = await bar.$('.ayna-ov-ok');
        if (!ok) continue;
        await ok.click({ timeout: 5000 });
        clicked += 1;
        await page.waitForTimeout(300);
      }
    });
    assert.equal(hidden, 0, 'a verdict bar was behind the review bar');
    assert.equal(clicked, 2, 'not every verdict could be pressed');
  });

  test('the button says what it does, however much is left', async () => {
    /*
      It used to relabel itself "Done" and turn primary once everything was
      judged. "Done" reads as "I have finished looking" — something you say, not
      something that ends the session — so the natural response to judging the
      last comment was to press it, and the window vanished. Reported exactly
      that way: everything done, and the UI closes immediately.
    */
    const labels = [];
    await reviewing(async (page) => {
      labels.push(await page.evaluate(() => document.querySelector('[data-act=close]').textContent));
      for (const bar of await page.$$('.ayna-ov-revbar')) {
        await bar.$('.ayna-ov-ok').then((b) => b?.click());
        await page.waitForTimeout(300);
      }
      labels.push(await page.evaluate(() => document.querySelector('[data-act=close]').textContent));
      labels.push(await page.evaluate(() => document.querySelector('.ayna-ov-progress').textContent));
    });
    assert.deepEqual(labels.slice(0, 2), ['Close window', 'Close window'], 'the promise must not change');
    assert.match(labels[2], /nothing left to do/, 'the sentence carries the state, not the button');
  });

  test('closing can be taken back', async () => {
    // One click used to end the review and take the window with it, and the only
    // undo was to start again and re-judge everything.
    let stillOpen = null;
    let midway = null;
    await reviewing(async (page) => {
      await page.click('[data-act=close]');
      await page.waitForTimeout(400);
      midway = await page.evaluate(() => document.querySelector('.ayna-ov-hint')?.textContent);
      await page.click('[data-act=stay]');
      await page.waitForTimeout(600);
      stillOpen = !page.isClosed();
    });
    assert.match(midway, /Closing the review/);
    assert.equal(stillOpen, true, 'Stay open did not keep the window');
  });
});

describe('the console in the window', { skip: !hasBrowser && 'AYNA_SKIP_BROWSER set' }, () => {
  let browser;
  before(async () => {
    browser = await openBrowser({ headless: true });
  });
  after(async () => {
    await browser?.close().catch(() => {});
  });

  /*
    The event stream went to stdout, so following a review meant watching a
    window and a terminal at once and the person who wanted to stay on the page
    kept having to leave it. Same stream, on the page, both directions.
  */
  async function withConsole(run) {
    const { srv, url } = await pollingServer('<h1 class="t">Hello</h1><div style="height:1200px"></div>');
    const dir = await mkdtemp(path.join(tmpdir(), 'ayna-console-'));
    try {
      await runAnnotate({
        browser,
        url,
        outDir: path.join(dir, 'out'),
        projectDir: dir,
        store: await openStore(dir),
        viewport: { width: 1200, height: 800 },
        onReady: async (page) => {
          await page.waitForTimeout(900);
          await run(page, dir);
          await page.close();
        },
      });
    } finally {
      srv.close();
      await rm(dir, { recursive: true, force: true });
    }
  }

  // The console is a rail down the left now, so the edge that can be covered is
  // the page's left one, not its bottom.
  const overlap = (page) =>
    page.evaluate(() => {
      const c = document.querySelector('.ayna-ov-console').getBoundingClientRect();
      const b = document.body.getBoundingClientRect();
      return Math.max(0, Math.round(c.right - b.left));
    });

  test('carries both sides of the conversation', async () => {
    const lines = [];
    await withConsole(async (page, dir) => {
      const { appendEvent, openDb } = await import('../src/db.mjs');
      appendEvent(await openDb(dir), { event: 'message', from: 'claude', text: 'starting on the nav now' });
      await page.waitForTimeout(1500);

      await page.fill('.ayna-ov-console input', 'make it wider too');
      await page.click('[data-act=say]');
      await page.waitForTimeout(1300);

      lines.push(...(await page.evaluate(() =>
        [...document.querySelectorAll('.ayna-ov-line')].map((n) => n.dataset.kind + ':' + n.querySelector('span').textContent),
      )));
    });
    assert.ok(
      lines.includes('message:starting on the nav now'),
      `Claude's line never reached the window: ${lines.join(' | ')}`,
    );
    assert.ok(lines.includes('you:make it wider too'), 'the reply typed on the page was lost');
  });

  test('never covers the app, open or minimised', async () => {
    /*
      A panel that sits on top of the thing you are reviewing is not a panel.
      Across the bottom this needed a correction pass, because a first child's
      top margin collapses out through body and the box ended lower than the
      arithmetic said. Down the left there is no equivalent, but the assertion
      stays: whatever ayna draws over an app, the app gets that much less room
      rather than being covered.
    */
    const seen = {};
    await withConsole(async (page) => {
      seen.open = await overlap(page);
      await page.click('[data-act=fold]');
      await page.waitForTimeout(800);
      seen.minimised = await overlap(page);
      await page.click('[data-act=fold]');
      await page.waitForTimeout(800);
      seen.reopened = await overlap(page);
    });
    assert.deepEqual(seen, { open: 0, minimised: 0, reopened: 0 });
  });

  test('typing in it does not reach the page underneath', async () => {
    // The page is in comment mode, where keystrokes are shortcuts.
    let comments = null;
    await withConsole(async (page) => {
      await page.fill('.ayna-ov-console input', 'escape and arrows and all');
      await page.press('.ayna-ov-console input', 'Escape');
      await page.press('.ayna-ov-console input', 'ArrowUp');
      await page.waitForTimeout(300);
      comments = await page.evaluate(() => document.querySelectorAll('.ayna-ov-pop').length);
    });
    assert.equal(comments, 0, 'typing in the console disturbed the review');
  });
});

describe('what everyone else is doing', { skip: !hasBrowser && 'AYNA_SKIP_BROWSER set' }, () => {
  let browser;
  before(async () => {
    browser = await openBrowser({ headless: true });
  });
  after(async () => {
    await browser?.close().catch(() => {});
  });

  test('agents holding work are named in the window, with what they hold', async () => {
    /*
      A review is no longer one person and one Claude. Another session, a worker,
      or a different tool can be holding a task while you are looking at the page
      it belongs to, and the alternative to showing that is two of you doing the
      same job. Nothing new is tracked for this: a task already records who
      claimed it and when that claim runs out.
    */
    const { srv, url } = await pollingServer('<h1 class="t">Heading</h1>');
    const dir = await mkdtemp(path.join(tmpdir(), 'ayna-agents-'));
    try {
      const store = await openStore(dir);
      let chips = [];
      let afterExpiry = [];

      await runAnnotate({
        browser,
        url,
        outDir: path.join(dir, 'out'),
        projectDir: dir,
        store,
        viewport: { width: 1280, height: 800 },
        onReady: async (page) => {
          const a = await store.create({ comment: 'widen the nav', url });
          const b = await store.create({ comment: 'resize the logo', url });
          await store.claim(a.id, 'cursor-2');
          await store.claim(b.id, 'worker-1');
          await page.waitForTimeout(1600);
          chips = await page.evaluate(() =>
            [...document.querySelectorAll('.ayna-ov-agent')].map((c) => c.textContent),
          );

          // A worker that died must not appear to still be holding the task.
          await store.claim(b.id, 'crashed', { leaseMs: -1 });
          await store.release(b.id);
          await page.waitForTimeout(1600);
          afterExpiry = await page.evaluate(() =>
            [...document.querySelectorAll('.ayna-ov-agent')].map((c) => c.textContent),
          );
          await page.close();
        },
      });

      assert.deepEqual(chips.sort(), ['cursor-2task-0001', 'worker-1task-0002']);
      assert.deepEqual(afterExpiry, ['cursor-2task-0001'], 'a released task still showed an owner');
    } finally {
      srv.close();
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe('resizing the window', { skip: !hasBrowser && 'AYNA_SKIP_BROWSER set' }, () => {
  let browser;
  before(async () => {
    browser = await openBrowser({ headless: true });
  });
  after(async () => {
    await browser?.close().catch(() => {});
  });

  test('the page fills the window at every size', async () => {
    /*
      The space reservation short-circuited on a key holding the bar's height and
      the rail's width, and neither changes when somebody resizes the window — so
      the page kept the width and height it was given for the old one. Going full
      screen left the app in its original box with black down two edges. The one
      event that most obviously needs a re-measure was the one it skipped.
    */
    const { srv, url } = await pollingServer(
      '<div id="app" style="position:fixed;inset:0;background:#123"><h1 class="t">app</h1></div>',
    );
    const dir = await mkdtemp(path.join(tmpdir(), 'ayna-resize-'));
    try {
      const gaps = [];
      await runAnnotate({
        browser,
        url,
        outDir: path.join(dir, 'out'),
        projectDir: dir,
        store: await openStore(dir),
        viewport: { width: 1000, height: 700 },
        onReady: async (page) => {
          const measure = async (label) => {
            await page.waitForTimeout(800);
            gaps.push({
              label,
              ...(await page.evaluate(() => {
                const b = document.body.getBoundingClientRect();
                return {
                  right: Math.round(innerWidth - b.right),
                  bottom: Math.round(innerHeight - b.bottom),
                };
              })),
            });
          };

          await measure('launch');
          await page.setViewportSize({ width: 1600, height: 1000 });
          await measure('bigger');
          await page.setViewportSize({ width: 900, height: 600 });
          await measure('smaller');
          await page.close();
        },
      });

      for (const g of gaps) {
        assert.equal(g.right, 0, `${g.label}: ${g.right}px of dead space down the right`);
        assert.equal(g.bottom, 0, `${g.label}: ${g.bottom}px of dead space along the bottom`);
      }
    } finally {
      srv.close();
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe('trying something before writing it', { skip: !hasBrowser && 'AYNA_SKIP_BROWSER set' }, () => {
  let browser;
  before(async () => {
    browser = await openBrowser({ headless: true });
  });
  after(async () => {
    await browser?.close().catch(() => {});
  });

  /*
    Every other path here edits the source and asks afterwards, which makes "no,
    not that" expensive: the change has happened, and rejecting it does not undo
    it. A preview is a stylesheet in the page and nothing else, so the answer
    arrives before anything is committed and a rejected one costs a tag being
    removed.
  */
  async function withPreview(run) {
    const { srv, url } = await pollingServer(
      '<h1 class="t" style="font-size:20px;font-weight:400">Subscribe for updates</h1>',
    );
    const dir = await mkdtemp(path.join(tmpdir(), 'ayna-preview-'));
    try {
      await runAnnotate({
        browser,
        url,
        outDir: path.join(dir, 'out'),
        projectDir: dir,
        store: await openStore(dir),
        viewport: { width: 1000, height: 700 },
        onReady: async (page) => {
          await page.waitForTimeout(800);
          await run(page, dir);
          await page.close();
        },
      });
    } finally {
      srv.close();
      await rm(dir, { recursive: true, force: true });
    }
  }

  const offer = async (dir, extra = []) => {
    const { appendEvent, openDb } = await import('../src/db.mjs');
    const db = await openDb(dir);
    return appendEvent(db, {
      event: 'preview',
      previewId: 'pv-test',
      selector: '.t',
      variants: [
        { css: 'font-size: 34px', label: 'bolder' },
        { css: 'font-size: 44px', label: 'much bigger' },
        ...extra,
      ],
    });
  };

  const size = (page) => page.evaluate(() => getComputedStyle(document.querySelector('.t')).fontSize);

  test('the variants actually render, over the page’s own inline styles', async () => {
    /*
      A plain rule in an injected stylesheet loses to style="font-size:20px" on
      the element itself. The first version of this cycled its labels
      convincingly and changed nothing on screen — the worst kind of preview, one
      that lies about what it is showing.
    */
    const seen = [];
    await withPreview(async (page, dir) => {
      seen.push(await size(page));
      await offer(dir);
      await page.waitForSelector('.ayna-ov-preview-bar', { timeout: 10000 });
      await page.waitForTimeout(400);
      seen.push(await size(page));
      await page.keyboard.press('ArrowRight');
      await page.waitForTimeout(400);
      seen.push(await size(page));
    });
    assert.deepEqual(seen, ['20px', '34px', '44px']);
  });

  test('accepting reports the chosen variant and leaves the page as it was', async () => {
    // What gets written is whatever Claude does with the answer. Leaving the
    // stylesheet up would show the change twice — once faked, once real.
    let after = null;
    let answer = null;
    await withPreview(async (page, dir) => {
      const from = await offer(dir);
      await page.waitForSelector('.ayna-ov-preview-bar', { timeout: 10000 });
      await page.keyboard.press('ArrowRight');
      await page.waitForTimeout(300);
      await page.keyboard.press('Enter');
      await page.waitForTimeout(700);

      after = await size(page);
      const { eventsSince, openDb } = await import('../src/db.mjs');
      answer = eventsSince(await openDb(dir), from).find((e) => e.event === 'preview-accepted');
    });

    assert.equal(after, '20px', 'the preview must come down when it is answered');
    assert.ok(answer, 'Claude was never told');
    assert.equal(answer.label, 'much bigger');
    assert.equal(answer.css, 'font-size: 44px');
    assert.equal(answer.action, 'write-this-to-source');
  });

  test('rejecting says so, and carries no css to write', async () => {
    let answer = null;
    await withPreview(async (page, dir) => {
      const from = await offer(dir);
      await page.waitForSelector('.ayna-ov-preview-bar', { timeout: 10000 });
      await page.keyboard.press('Escape');
      await page.waitForTimeout(700);
      const { eventsSince, openDb } = await import('../src/db.mjs');
      answer = eventsSince(await openDb(dir), from).find((e) => e.event === 'preview-rejected');
    });
    assert.ok(answer, 'a refusal is an answer and has to travel too');
    assert.equal(answer.css, null, 'nothing to write when nothing was chosen');
    assert.equal(answer.action, 'try-something-else');
  });
});

/*
  Asking for a direction, instead of describing one.

  Writing "make this bolder" and waiting for an edit is the slow path, and the
  words are the lossy part: the intent is almost always one of a small number of
  directions, and naming it is faster and less ambiguous than a sentence about
  it. The vocabulary is impeccable's, whose live mode rests on the same
  observation — on an existing surface the job is variation WITHIN an identity,
  and there are only so many axes it runs along.

  The load-bearing property is that pressing one changes nothing. It asks for
  variants, which arrive through the preview bar that already exists: rendered
  in the window, source untouched until one is kept. An action that filed work,
  or edited a file, would be a redesign nobody agreed to.
*/
describe('asking for a design direction', { skip: !hasBrowser && 'AYNA_SKIP_BROWSER set' }, () => {
  let browser;
  before(async () => {
    browser = await openBrowser({ headless: true });
  });
  after(async () => {
    await browser?.close().catch(() => {});
  });

  async function pressAction(action, { note = null } = {}) {
    const { srv, url } = await pollingServer(
      CARD_CSS + '<div class="card" id="c0"><h3>Ask in plain language</h3></div>',
    );
    const dir = await mkdtemp(path.join(tmpdir(), 'ayna-act-'));
    try {
      const store = await openStore(dir);
      let offered = [];
      await runAnnotate({
        browser,
        url,
        outDir: path.join(dir, 'out'),
        projectDir: dir,
        store,
        viewport: { width: 1100, height: 780 },
        onReady: async (page) => {
          await page.click('#c0 h3');
          await page.waitForSelector('.ayna-ov-pop textarea', { timeout: 10000 });
          await page.waitForTimeout(300);
          offered = await page.$$eval('.ayna-ov-act', (els) => els.map((e) => e.dataset.action));
          if (note) await page.fill('.ayna-ov-pop textarea', note);
          await page.click(`.ayna-ov-act[data-action=${action}]`);
          await page.waitForTimeout(500);
          await page.close();
        },
      });
      const { events } = await pendingEvents(dir);
      return { offered, events, tasks: await store.list() };
    } finally {
      srv.close();
      await rm(dir, { recursive: true, force: true });
    }
  }

  test('the directions are offered, and pressing one asks for variants', async () => {
    const { offered, events } = await pressAction('bolder');
    assert.deepEqual(offered, ['bolder', 'quieter', 'polish', 'layout', 'typeset', 'colorize']);

    const req = events.find((e) => e.event === 'design-request');
    assert.ok(req, 'no design-request reached the log');
    assert.equal(req.action, 'bolder');
    assert.equal(req.wants, 'css-variants');
    assert.match(req.respondWith, /ayna preview/);
    assert.ok(req.selector, 'the agent needs to know what was pointed at');
  });

  /*
    "bolder" plus "but keep it on one line" is a better brief than either half,
    and the note is already typed — throwing it away would make the button the
    worse option whenever the user had anything to add.
  */
  test('anything typed rides along with the direction', async () => {
    const { events } = await pressAction('typeset', { note: 'but keep it on one line' });
    const req = events.find((e) => e.event === 'design-request');
    assert.equal(req.action, 'typeset');
    assert.equal(req.note, 'but keep it on one line');
  });

  test('it files no work and edits nothing — an action is a question', async () => {
    const { tasks, events } = await pressAction('polish');
    assert.equal(tasks.length, 0, 'an action must not become a task nobody approved');
    assert.ok(
      !events.some((e) => e.event === 'applied' || e.event === 'round'),
      'nothing may be edited or sent on the strength of a button press',
    );
  });
});
