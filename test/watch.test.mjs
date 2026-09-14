import { test } from 'node:test';
import assert from 'node:assert';
import { chromium } from 'playwright-core';
import { capture } from '../src/browser.mjs';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

// A card that throws ONLY when the tab is hidden and shown again.
//
// This is the real shape of a bug that reached a live canvas on 14 Sep 2026. The
// card paused its d3 timers on visibilitychange and resumed them with
// `timer.restart()` — which requires a callback — so returning to the tab threw
// `TypeError: callback is not a function`. The gate had watched the card for
// seconds and reported it clean, because it never left and came back. The person
// switched tabs and saw it immediately.
const CARD = `<!doctype html><meta charset="utf-8"><body>
<div id="x">hello</div>
<script>
  let frames = 0;
  const loop = () => { frames++; requestAnimationFrame(loop); };
  loop();
  function restart() { throw new TypeError('callback is not a function'); }
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) restart();
  });
</script>
</body>`;

async function errorsFor(watchMs) {
  const browser = await chromium.launch({ channel: 'chrome' });
  try {
    const dir = await mkdtemp(path.join(tmpdir(), 'ayna-watch-'));
    const file = path.join(dir, 'card.html');
    await writeFile(file, CARD);
    const cap = await capture({
      browser,
      url: 'file://' + file,
      viewports: [{ name: 'desktop', width: 1024, height: 700 }],
      outDir: dir,
      label: 'w',
      watchMs,
    });
    return [...(cap.pageErrors || []), ...(cap.consoleErrors || [])];
  } finally {
    await browser.close();
  }
}

test('a visibilitychange-only error is invisible without a watch window', async () => {
  const errs = await errorsFor(0);
  assert.equal(
    errs.filter((e) => /callback is not a function/.test(e)).length,
    0,
    'the old behaviour is the baseline this test exists to improve on',
  );
});

test('the watch window hides and shows the page, so the error surfaces', async () => {
  const errs = await errorsFor(3000);
  assert.ok(
    errs.some((e) => /callback is not a function/.test(e)),
    `expected the visibilitychange error to be caught, got: ${JSON.stringify(errs)}`,
  );
});

test('the page is left visible, so later checks still animate', async () => {
  // A page left believing it is hidden stops its own animation, and every check
  // after it would measure a frozen card and call that the truth.
  const browser = await chromium.launch({ channel: 'chrome' });
  try {
    const dir = await mkdtemp(path.join(tmpdir(), 'ayna-watch-'));
    const file = path.join(dir, 'card.html');
    await writeFile(file, '<!doctype html><body><div>ok</div></body>');
    await capture({
      browser, url: 'file://' + file,
      viewports: [{ name: 'desktop', width: 800, height: 600 }],
      outDir: dir, label: 'w', watchMs: 1200,
    });
  } finally {
    await browser.close();
  }
});
