/*
  The bugs you only find by using it.

  Each of these was reported as "it lags" or "the window jumps" — descriptions that
  point at no line of code. They were found by driving the real overlay and
  measuring, and they are pinned here because every one of them is invisible in a
  screenshot and silent in a normal test.
*/
import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { existsSync } from 'node:fs';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { runAnnotate } from '../src/annotate.mjs';
import { hasBrowser, launchBrowser, eventually } from './helpers.mjs';

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

describe('getting out of "waiting for Claude"', { skip: !hasBrowser && 'AYNA_SKIP_BROWSER set' }, () => {
  let browser;
  beforeEach(async () => {
    browser = await launchBrowser();
  });
  afterEach(async () => {
    await browser?.close().catch(() => {});
  });

  /*
    "Sent — waiting for Claude" cleared on one thing: a marker file written by
    `ayna applied`. A session that never ran it left the window on that spinner
    permanently, over changes that were already on disk — the user waiting for
    something that had happened. There are now three ways out, and all three must
    keep working, because the failure is indistinguishable from Claude being slow.
  */
  async function reachesReview(escape, { within = 20000 } = {}) {
    const { srv, url } = await pollingServer('<h1 class="title">Hello</h1>');
    const dir = await mkdtemp(path.join(tmpdir(), 'ayna-wait-'));
    const out = path.join(dir, 'out');
    const events = [];
    try {
      await writeFile(path.join(dir, 'app.css'), 'h1{font-size:20px}');
      let reached = false;
      await runAnnotate({
        browser,
        url,
        outDir: out,
        projectDir: dir,
        viewport: { width: 1000, height: 700 },
        onEvent: (e) => events.push(e),
        onReady: async (page) => {
          await page.click('.title');
          await page.waitForSelector('.ayna-ov-pop textarea', { timeout: 10000 });
          await page.fill('.ayna-ov-pop textarea', 'make it bigger');
          await page.click('.ayna-ov-save');
          await eventually(() => existsSync(path.join(out, 'comment-01', 'comment.json')), {
            timeout: 10000,
            message: 'the comment was never saved',
          });
          await page.click('[data-act=send]');
          await page.waitForSelector('.ayna-ov-waiting', { timeout: 10000 });
          await eventually(() => events.some((e) => e.event === 'round'), {
            timeout: 10000,
            message: 'the round was never announced',
          });

          await escape(page, dir);

          reached = await page
            .waitForFunction(() => document.querySelector('[data-act=close]') !== null, null, {
              timeout: within,
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
    }, { within: 12000 });
    assert.equal(reached, false, 'writing under .ayna must not be read as an applied fix');
  });
});
