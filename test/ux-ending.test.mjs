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
import { existsSync } from 'node:fs';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { openBrowser, gotoSettled } from '../src/browser.mjs';
import { runAnnotate } from '../src/annotate.mjs';
import { openStore } from '../src/tasks.mjs';
import { pending as pendingWork, since as pendingEvents } from '../src/events.mjs';
import { hasBrowser, press, launchBrowser, eventually } from './helpers.mjs';

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

const progress = (page) => page.evaluate(() => document.querySelector('.ayna-ov-progress')?.textContent ?? '');

/** Press a verdict and wait for the bar to count it. */
async function judge(page, button) {
  const before = await progress(page);
  await button.click({ timeout: 5000 });
  await page.waitForFunction(
    (was) => (document.querySelector('.ayna-ov-progress')?.textContent ?? '') !== was,
    before,
    { timeout: 5000 },
  );
}

describe('ending a review', { skip: !hasBrowser && 'AYNA_SKIP_BROWSER set' }, () => {
  let browser;
  beforeEach(async () => {
    browser = await launchBrowser();
  });
  afterEach(async () => {
    await browser?.close().catch(() => {});
  });

  /** Two comments, sent, applied, and left sitting in the review phase. */
  async function reviewing(run, { wideText = false } = {}) {
    const { srv, url } = await pollingServer('<h1 class="a">Right at the top</h1><p class="b">Two</p>');
    const dir = await mkdtemp(path.join(tmpdir(), 'ayna-end-'));
    const out = path.join(dir, 'out');
    const events = [];
    const heard = (name) =>
      eventually(() => events.some((e) => e.event === name), { timeout: 20000, message: `no ${name} event` });
    try {
      await runAnnotate({
        browser,
        url,
        outDir: out,
        projectDir: dir,
        viewport: { width: 1000, height: 700 },
        onEvent: (e) => events.push(e),
        onReady: async (page) => {
          if (wideText) {
            // Wider text than the bar's widths were measured with, from the first
            // paint and after every reload, the way a wider fallback font is.
            const css = '[data-ayna], [data-ayna] * { letter-spacing: .14em !important; }';
            await page.addInitScript((c) => document.addEventListener('DOMContentLoaded', () => {
              const st = document.createElement('style');
              st.textContent = c;
              document.documentElement.appendChild(st);
            }), css);
            await page.addStyleTag({ content: css });
          }
          for (const [n, sel, text] of [[1, '.a', 'first'], [2, '.b', 'second']]) {
            await page.click(sel);
            await page.waitForSelector('.ayna-ov-pop textarea', { timeout: 10000 });
            await page.fill('.ayna-ov-pop textarea', text);
            await page.click('.ayna-ov-save');
            await eventually(() => existsSync(path.join(out, `comment-0${n}`, 'comment.json')), {
              timeout: 10000,
              message: `comment ${n} was never saved`,
            });
          }
          await page.click('[data-act=send]');
          // Sending clears any old marker, so it is written only once the round is out.
          await heard('round');
          await writeFile(path.join(out, 'applied'), '1');
          await heard('gate');
          await page.waitForFunction(
            () =>
              document.querySelectorAll('.ayna-ov-revbar').length === 2 &&
              document.querySelector('.ayna-ov-progress')?.textContent,
            null,
            { timeout: 20000 },
          );
          await run(page);
          if (!page.isClosed()) {
            await press(page, 'close');
            await page.waitForEvent('close', { timeout: 5000 });
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
        await judge(page, ok);
        clicked += 1;
      }
    });
    assert.equal(hidden, 0, 'a verdict bar was behind the review bar');
    assert.equal(clicked, 2, 'not every verdict could be pressed');
  });

  test('a bar too wide for its row sheds a form instead of wrapping', async () => {
    /*
      The bar's compact forms were tied to widths measured with macOS's system
      font. On Linux CI, with a wider fallback, the review bar wrapped onto two
      rows and a verdict ended up behind it.
    */
    let seen = null;
    await reviewing(
      async (page) => {
        seen = await page.evaluate(() => {
          const bar = document.querySelector('.ayna-ov-bar');
          const b = bar.getBoundingClientRect();
          const mids = [...bar.children]
            .map((k) => k.getBoundingClientRect())
            .filter((r) => r.width && r.height)
            .map((r) => r.top + r.height / 2);
          return {
            oneRow: Math.max(...mids) - Math.min(...mids) <= 8,
            hidden: [...document.querySelectorAll('.ayna-ov-revbar')].filter((r) => r.getBoundingClientRect().top < b.bottom).length,
            stepped: Boolean(bar.dataset.crowded),
          };
        });
      },
      { wideText: true },
    );
    assert.deepEqual(seen, { oneRow: true, hidden: 0, stepped: true });
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
        const ok = await bar.$('.ayna-ov-ok');
        if (ok) await judge(page, ok);
      }
      labels.push(await page.evaluate(() => document.querySelector('[data-act=close]').textContent));
      labels.push(await page.evaluate(() => document.querySelector('.ayna-ov-progress').textContent));
    });
    assert.deepEqual(labels.slice(0, 2), ['Close window', 'Close window'], 'the promise must not change');
    assert.match(labels[2], /nothing left to do/, 'the sentence carries the state, not the button');
  });

  test('closing can be taken back, and a reload cannot stop it', async () => {
    /*
      One click used to end the review and take the window with it, and the only
      undo was to start again and re-judge everything. Then the countdown lived
      only in the page, so a reload in that moment — a dev server's full reload,
      or the overlay reloading itself — threw it away, and the window stayed
      open for good after Close. A scripted review waited on it forever, which
      is what hung this file.
    */
    let stillOpen = null;
    let midway = null;
    let ended = null;
    await reviewing(async (page) => {
      await press(page, 'close');
      const pressed = Date.now();
      await page.waitForSelector('[data-act=stay]', { timeout: 5000 });
      midway = await page.evaluate(() => document.querySelector('.ayna-ov-hint')?.textContent);
      await page.click('[data-act=stay]');
      // Past the 1.5s countdown, which Node holds, and the 300ms poll that closes the window.
      await page.waitForTimeout(Math.max(0, pressed + 2200 - Date.now()));
      stillOpen = !page.isClosed();

      await press(page, 'close');
      await page.reload();
      ended = await page.waitForEvent('close', { timeout: 8000 }).then(
        () => true,
        () => false,
      );
    });
    assert.match(midway, /Closing the review/);
    assert.equal(stillOpen, true, 'Stay open did not keep the window');
    assert.equal(ended, true, 'a reload during the countdown left the window open after Close');
  });
});
