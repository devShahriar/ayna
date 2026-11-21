import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import path from 'node:path';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';

import { openBrowser } from '../src/browser.mjs';
import { runAnnotate } from '../src/annotate.mjs';
import { hasBrowser } from './helpers.mjs';
import { isTestPath } from '../src/skipdirs.mjs';

async function site() {
  const dir = await mkdtemp(path.join(tmpdir(), 'ayna-reload-'));
  await writeFile(
    path.join(dir, 'index.html'),
    '<!doctype html><link rel="stylesheet" href="styles.css"><body style="margin:0"><h1 id="t">Hello</h1></body>',
  );
  await writeFile(path.join(dir, 'styles.css'), 'h1 { font-style: normal; }\n');
  const srv = http.createServer(async (req, res) => {
    const p = req.url === '/' ? '/index.html' : req.url.split('?')[0];
    try {
      const body = await readFile(path.join(dir, p));
      res.writeHead(200, { 'content-type': p.endsWith('.css') ? 'text/css' : 'text/html', 'cache-control': 'no-store' });
      res.end(body);
    } catch {
      res.writeHead(404);
      res.end();
    }
  });
  await new Promise((r) => srv.listen(0, r));
  return { dir, srv, url: `http://127.0.0.1:${srv.address().port}/` };
}

async function round(browser, edit, { say = true } = {}) {
  const { dir, srv, url } = await site();
  const events = [];
  let seen = null;
  try {
    await runAnnotate({
      browser,
      url,
      outDir: path.join(dir, 'out'),
      projectDir: dir,
      viewport: { width: 1000, height: 700 },
      onEvent: (e) => events.push(e),
      onReady: async (page) => {
        try {
          await page.waitForTimeout(300);
          const box = await page.locator('#t').boundingBox();
          await page.mouse.click(box.x + 5, box.y + 5);
          await page.keyboard.type('italic, please');
          await page.locator('[class$="-save"]').click();
          await page.waitForTimeout(300);
          await page.evaluate(() => window.__aynaDone());
          for (let i = 0; i < 100 && !events.some((e) => e.event === 'round'); i++) await page.waitForTimeout(100);
          let loads = 0;
          page.on('load', () => loads++);
          await edit(dir, page, events);
          if (say) await page.evaluate(() => window.__aynaApplied());
          for (let i = 0; i < 100 && !events.some((e) => e.event === 'gate'); i++) await page.waitForTimeout(100);
          seen = {
            loads,
            applied: events.find((e) => e.event === 'applied'),
            style: await page.evaluate(() => getComputedStyle(document.querySelector('#t')).fontStyle),
            text: await page.evaluate(() => document.querySelector('#t').textContent),
            sheets: await page.evaluate(() => document.querySelectorAll('link[rel=stylesheet]').length),
          };
        } finally {
          await page.close();
        }
      },
    });
  } finally {
    srv.close();
    await rm(dir, { recursive: true, force: true });
  }
  return seen;
}

describe('when a round lands', { skip: !hasBrowser && 'AYNA_SKIP_BROWSER set' }, () => {
  let browser;
  before(async () => {
    browser = await openBrowser({ headless: true });
  });
  after(async () => {
    await browser?.close().catch(() => {});
  });

  test('a CSS-only round is swapped in place, not reloaded', async () => {
    const seen = await round(browser, (dir) => writeFile(path.join(dir, 'styles.css'), 'h1 { font-style: italic; }\n'));
    assert.equal(seen.loads, 0, 'the page must not reload for a stylesheet change');
    assert.equal(seen.style, 'italic', 'the new stylesheet is in effect');
    assert.equal(seen.sheets, 1, 'the old sheet is gone once the new one loaded');
    assert.equal(seen.applied.swapped, true);
    assert.equal(seen.applied.reloaded, false);
  });

  test('a changed sheet the page only @imports means a reload, not a swap', async () => {
    const seen = await round(browser, async (dir) => {
      await writeFile(path.join(dir, 'extra.css'), 'h1 { font-style: italic; }\n');
      await writeFile(path.join(dir, 'styles.css'), "@import 'extra.css';\nh1 { color: rgb(1, 2, 3); }\n");
    });
    assert.equal(seen.applied.swapped, false);
    assert.equal(seen.applied.reloaded, true);
    assert.equal(seen.loads, 1);
    assert.equal(seen.style, 'italic', 'after the reload the imported sheet is in effect');
  });

  test('a round that touched markup still reloads', async () => {
    const seen = await round(browser, async (dir) => {
      const file = path.join(dir, 'index.html');
      await writeFile(file, (await readFile(file, 'utf8')).replace('Hello', 'Hello!'));
    });
    assert.equal(seen.loads, 1);
    assert.equal(seen.text, 'Hello!');
    assert.equal(seen.applied.swapped, false);
    assert.equal(seen.applied.reloaded, true);
  });

  test('a test file saved during a round is not taken as its answer', async () => {
    const seen = await round(
      browser,
      async (dir, page, events) => {
        await mkdir(path.join(dir, 'test'), { recursive: true });
        await writeFile(path.join(dir, 'test', 'hero.test.mjs'), 'export {};\n');
        await writeFile(path.join(dir, 'hero.spec.js'), 'export {};\n');
        await page.waitForTimeout(3000);
        assert.equal(events.filter((e) => e.event === 'applied').length, 0, 'a test edit announced the round as applied');
        await writeFile(path.join(dir, 'styles.css'), 'h1 { font-style: italic; }\n');
      },
      { say: false },
    );
    assert.deepEqual(seen.applied.files.map((f) => f.file), ['styles.css']);
    assert.equal(seen.style, 'italic');
  });
});

test('isTestPath knows a test from a component that merely mentions one', () => {
  for (const p of ['test/a.mjs', 'src/a.test.tsx', 'src/a.spec.ts', 'x/a_test.go', 'test_ui.py', 'app/__tests__/A.jsx', 'e2e/login.ts']) {
    assert.equal(isTestPath(p), true, p);
  }
  for (const p of [
    'demo/index.html', 'src/contest.js', 'src/testimonials.tsx', 'src/spectrum.css', 'src/components/Test.vue', 'attest/x.js',
    'src/components/Test/Button.vue', 'pages/tech-specs.html', 'ab-test.css', 'speed-test.html', 'split_test.js',
  ]) {
    assert.equal(isTestPath(p), false, p);
  }
});
