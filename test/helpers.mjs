import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

/** A scratch directory that cleans itself up when the returned dispose() runs. */
export async function tempDir(prefix = 'ayna-test-') {
  const dir = await mkdtemp(path.join(tmpdir(), prefix));
  return { dir, dispose: () => rm(dir, { recursive: true, force: true }) };
}

/** Writes a tiny site into `dir` so browser tests have something real to render. */
export async function fixtureSite(dir, { overflow = false, tinyText = false, blank = false } = {}) {
  await mkdir(dir, { recursive: true });
  const body = blank
    ? ''
    : `
      <header id="nav"><a id="logo">Fixture</a></header>
      <main class="container">
        <h1 class="title">A headline that is long enough to matter</h1>
        <p class="lede">Body copy for the fixture page.</p>
        ${overflow ? '<div style="width:3000px">wide</div>' : ''}
        ${tinyText ? '<span style="font-size:9px">tiny legal text</span>' : ''}
        <ul class="list"><li>one</li><li>two</li><li>three</li></ul>
      </main>`;

  await writeFile(
    path.join(dir, 'index.html'),
    `<!doctype html><html lang="en"><head><meta charset="utf-8">
<title>Fixture</title><link rel="icon" href="data:,">
<link rel="stylesheet" href="styles.css"></head><body>${body}</body></html>`,
  );
  await writeFile(path.join(dir, 'styles.css'), 'body{font-family:system-ui;margin:0}\n.title{font-size:32px}\n');
  return dir;
}

export const hasBrowser = !process.env.AYNA_SKIP_BROWSER;

/*
  A browser per test, not per describe.

  On macOS a headless browser that may not run in the background is quit by the
  system about thirty seconds after launch (see explainBackgroundQuit in
  src/browser.mjs). A browser shared by a describe outlived that, so whichever
  test was running at the thirty-second mark failed with a wrong answer, and
  every test after it with "Target page, context or browser has been closed" —
  eight failures on a full run, all passing alone. Launching per test costs
  about half a second and gives every test the same full window, whatever ran
  before it.

  Use it from beforeEach, and close it in afterEach.
*/
export async function launchBrowser() {
  const { openBrowser } = await import('../src/browser.mjs');
  return openBrowser({ headless: true });
}

/*
  Press one of the bar's actions, wherever the bar has put it.

  Short of room, the review actions move behind ⋯ (see fitBar in overlay.js),
  and how short of room depends on the fonts: a window that fits them on macOS
  does not on Linux CI. Clicking through the menu when the button is tucked
  away keeps a test about closing, or about a second round, from depending on
  the font it happens to run with.
*/
export async function press(page, act) {
  const target = page.locator(`[data-act=${act}]`);
  if (!(await target.isVisible())) await page.click('[data-act=overflow]');
  await target.click();
}
