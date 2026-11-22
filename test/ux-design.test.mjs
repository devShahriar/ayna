/*
  The bugs you only find by using it.

  Each of these was reported as "it lags" or "the window jumps" — descriptions that
  point at no line of code. They were found by driving the real overlay and
  measuring, and they are pinned here because every one of them is invisible in a
  screenshot and silent in a normal test.
*/
import { test, describe, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { openBrowser, gotoSettled } from '../src/browser.mjs';
import { runAnnotate } from '../src/annotate.mjs';
import { openStore } from '../src/tasks.mjs';
import { pending as pendingWork, since as pendingEvents } from '../src/events.mjs';
import { hasBrowser, press, launchBrowser, eventually } from './helpers.mjs';

// Two frames: layout, observers and anything queued on rAF have all run.
const frames = (page) =>
  page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));

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

describe('trying something before writing it', { skip: !hasBrowser && 'AYNA_SKIP_BROWSER set' }, () => {
  let browser;
  beforeEach(async () => {
    browser = await launchBrowser();
  });
  afterEach(async () => {
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
          await page.waitForSelector('.ayna-ov-console .ayna-ov-console-lines', { state: 'attached' });
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
  const showing = (page, n) => page.waitForFunction((k) => document.querySelector('.ayna-ov-preview-bar [data-part=label]')?.textContent.includes(` ${k}/`), n, { timeout: 5000 });
  // The answer, once the window has written it to the log.
  const answered = (dir, from, kind) =>
    eventually(async () => {
      const { eventsSince, openDb } = await import('../src/db.mjs');
      return eventsSince(await openDb(dir), from).find((e) => e.event === kind);
    }).catch(() => null);

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
      await showing(page, 1);
      seen.push(await size(page));
      await page.keyboard.press('ArrowRight');
      await showing(page, 2);
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
      await showing(page, 2);
      await page.keyboard.press('Enter');
      answer = await answered(dir, from, 'preview-accepted');
      after = await size(page);
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
      answer = await answered(dir, from, 'preview-rejected');
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
  beforeEach(async () => {
    browser = await launchBrowser();
  });
  afterEach(async () => {
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
          offered = await page.$$eval('.ayna-ov-act', (els) => els.map((e) => e.dataset.action));
          if (note) await page.fill('.ayna-ov-pop textarea', note);
          await page.click(`.ayna-ov-act[data-action=${action}]`);
          // The box closes once Node has the request; the log write follows it.
          await page.waitForSelector('.ayna-ov-pop', { state: 'detached', timeout: 5000 }).catch(() => {});
          await eventually(async () => (await pendingEvents(dir)).events.some((e) => e.event === 'design-request')).catch(() => {});
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

/*
  A phone-sized window.

  The rail kept clamp(300px, 24vw, 480px) at every size, so a 390px window gave
  the app 90px and the bar wrapped into three rows with Send off the edge — at
  exactly the size people narrow a window to, to review a mobile layout.
*/
describe('a phone-sized window', { skip: !hasBrowser && 'AYNA_SKIP_BROWSER set' }, () => {
  let browser;
  beforeEach(async () => {
    browser = await launchBrowser();
  });
  afterEach(async () => {
    await browser?.close().catch(() => {});
  });

  test('the page keeps the width, the bar one row, and the rail opens from the bar as a drawer', async () => {
    const { srv, url } = await pollingServer('<h1 class="t">Hello</h1><p>Body copy for the page.</p>');
    const dir = await mkdtemp(path.join(tmpdir(), 'ayna-phone-'));
    const seen = {};
    try {
      await runAnnotate({
        browser,
        url,
        outDir: path.join(dir, 'out'),
        projectDir: dir,
        store: await openStore(dir),
        viewport: { width: 390, height: 844 },
        onReady: async (page) => {
          await page.waitForSelector('.ayna-ov-bar [data-act=send]');
          await frames(page);
          seen.open = await page.evaluate(() => {
            const r = (s) => document.querySelector(s)?.getBoundingClientRect();
            const shown = (s) => {
              const el = document.querySelector(s);
              return Boolean(el) && getComputedStyle(el).display !== 'none';
            };
            return {
              page: Math.round(r('body').width),
              bar: Math.round(r('.ayna-ov-bar').height),
              send: Math.round(r('[data-act=send]').right),
              rail: shown('.ayna-ov-console'),
              activity: shown('.ayna-ov-bar [data-act=activity]'),
              // In the bar, at its left end — not floating over the page.
              activityLeft: Math.round(r('.ayna-ov-bar [data-act=activity]').left),
              brand: shown('.ayna-ov-bar .ayna-ov-brand'),
            };
          });

          await page.click('.t');
          await page.waitForSelector('.ayna-ov-pop textarea');
          seen.box = await page.evaluate(() => {
            const r = document.querySelector('.ayna-ov-pop').getBoundingClientRect();
            return { left: Math.round(r.left), right: Math.round(innerWidth - r.right), bottom: Math.round(innerHeight - r.bottom) };
          });
          await page.fill('.ayna-ov-pop textarea', 'tighter');
          await page.click('.ayna-ov-save');
          await eventually(async () => (await page.evaluate(() => window.__aynaCount())) === 1, { timeout: 10000 });
          await page.click('[data-act=send]');
          // The round must be open before the marker: opening it clears any earlier one.
          await page.waitForSelector('.ayna-ov-round[data-state=waiting]', { state: 'attached', timeout: 10000 });
          await writeFile(path.join(dir, 'out', 'applied'), '1');
          await page.waitForSelector('[data-act=overflow]', { state: 'visible', timeout: 20000 });
          // The reloaded rail has read the round back, so the bar knows it is your turn.
          await page.waitForSelector('.ayna-ov-round[data-state=ready]', { state: 'attached', timeout: 10000 });
          await frames(page);

          const visible = (s) => page.evaluate((s) => {
            const el = document.querySelector(s);
            return Boolean(el) && el.getBoundingClientRect().width > 0;
          }, s);
          seen.menuBefore = await visible('[data-act=approve-all]');
          await page.click('[data-act=overflow]');
          seen.menuAfter = await visible('[data-act=approve-all]');
          await page.click('[data-act=overflow]');
          // Closed like any menu: a press anywhere else, or Escape.
          await page.click('[data-act=overflow]');
          await page.mouse.click(200, 700);
          seen.menuOutside = await visible('[data-act=approve-all]');
          await page.click('[data-act=overflow]');
          await page.keyboard.press('Escape');
          seen.menuEscape = await visible('[data-act=approve-all]');

          seen.dot = await page.evaluate(() => getComputedStyle(document.querySelector('.ayna-ov-activity-dot')).display);
          await page.click('.ayna-ov-bar [data-act=activity]');
          await page.waitForSelector('.ayna-ov-console.ayna-ov-open');
          await frames(page);
          seen.sheet = await page.evaluate(() => {
            const r = document.querySelector('.ayna-ov-console').getBoundingClientRect();
            const bar = document.querySelector('.ayna-ov-bar').getBoundingClientRect();
            const marker = document.querySelector('.ayna-ov-revbar')?.getBoundingClientRect();
            const onTop = marker && document.elementFromPoint(marker.x + marker.width / 2, marker.y + marker.height / 2);
            return {
              fold: getComputedStyle(document.querySelector('.ayna-ov-console [data-act=fold]')).display,
              left: Math.round(r.left),
              top: Math.round(r.top - bar.bottom),
              width: Math.round(r.width),
              bottom: Math.round(innerHeight - r.bottom),
              rounds: document.querySelectorAll('.ayna-ov-round').length,
              markerCovered: marker ? Boolean(onTop?.closest('.ayna-ov-scrim, .ayna-ov-console')) : null,
            };
          });
          await page.mouse.click(380, 400); // the backdrop, beside the drawer
          await page.waitForSelector('.ayna-ov-console', { state: 'hidden', timeout: 2000 }).catch(() => {});
          seen.closed = await page.evaluate(() => getComputedStyle(document.querySelector('.ayna-ov-console')).display);
          await page.click('.ayna-ov-bar [data-act=activity]');
          await page.waitForSelector('.ayna-ov-console.ayna-ov-open');
          await page.keyboard.press('Escape');
          await page.waitForSelector('.ayna-ov-console', { state: 'hidden', timeout: 2000 }).catch(() => {});
          seen.escaped = await page.evaluate(() => getComputedStyle(document.querySelector('.ayna-ov-console')).display);
          await page.close();
        },
      });
    } finally {
      srv.close();
      await rm(dir, { recursive: true, force: true });
    }

    assert.equal(seen.open.page, 390, 'the app gets the whole width, not what the rail leaves');
    assert.ok(seen.open.bar <= 60, `the bar wrapped to ${seen.open.bar}px`);
    assert.ok(seen.open.send <= 390, 'Send is on screen');
    assert.deepEqual([seen.open.rail, seen.open.activity, seen.open.brand], [false, true, false]);
    assert.ok(seen.open.activityLeft <= 16, 'Activity sits at the bar\'s left end');
    assert.equal(seen.dot, 'block', 'with a dot while it is your turn');
    assert.deepEqual(seen.box, { left: 8, right: 8, bottom: 8 }, 'the comment box is a sheet along the bottom');
    assert.deepEqual([seen.menuBefore, seen.menuAfter], [false, true], 'review actions wait behind ⋯');
    assert.deepEqual([seen.sheet.left, seen.sheet.top, seen.sheet.bottom], [0, 0, 0], 'a drawer from the left, under the bar');
    assert.equal(seen.sheet.width, Math.round(390 * 0.86));
    assert.equal(seen.sheet.rounds, 1);
    assert.equal(seen.sheet.fold, 'none', 'the drawer has no Hide: it closes from the bar, a tap beside it or Escape');
    assert.notEqual(seen.sheet.markerCovered, false, 'a review marker shows through the backdrop');
    assert.equal(seen.closed, 'none', 'tapping the backdrop closes the sheet');
    assert.deepEqual([seen.menuOutside, seen.menuEscape], [false, false], 'the ⋯ menu closes on a press elsewhere and on Escape');
    assert.equal(seen.escaped, 'none', 'Escape closes the drawer');
  });
});
