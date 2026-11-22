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

/*
  Wait for a condition instead of for time.

  Polls `check` until it returns something truthy (or stops throwing) and
  returns that value; after `timeout` it throws the last error, or `message`.
  A fixed sleep is either too short on a loaded machine (a flake) or longer
  than needed everywhere else (a slow suite) — usually both. Node's own
  t.waitFor needs 22.14, and CI runs the 22.13 floor.
*/
export async function eventually(check, { timeout = 5000, interval = 50, message } = {}) {
  const deadline = Date.now() + timeout;
  let last = null;
  for (;;) {
    try {
      const value = await check();
      if (value) return value;
      last = null;
    } catch (err) {
      last = err;
    }
    if (Date.now() >= deadline) {
      if (last) throw last;
      throw new Error(message ?? `condition not met within ${timeout}ms`);
    }
    await new Promise((r) => setTimeout(r, interval));
  }
}
