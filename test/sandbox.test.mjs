import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';

import { openBrowser, openPersistentContext, needsNoSandbox } from '../src/browser.mjs';
import { hasBrowser, tempDir } from './helpers.mjs';

/*
  The yellow bar.

  On Windows, every headed window showed "You are using an unsupported
  command-line flag: --no-sandbox" across the top of the page under review.
  launchArgs() only adds that flag in CI or a container, but Playwright adds it
  itself whenever `chromiumSandbox` is not true. A test of our own args could
  never catch that, so ask Chrome what it was actually started with.
*/
async function commandLine(context) {
  const page = await context.newPage();
  await page.goto('chrome://version');
  const line = await page.locator('#command_line').innerText();
  await page.close();
  return line;
}

describe('the Chrome sandbox', { skip: !hasBrowser && 'AYNA_SKIP_BROWSER set' }, () => {
  test('openBrowser only drops the sandbox where it has to', async () => {
    const browser = await openBrowser({ headless: true });
    try {
      const line = await commandLine(await browser.newContext());
      assert.equal(line.includes('--no-sandbox'), needsNoSandbox(), line);
    } finally {
      await browser.close();
    }
  });

  test('the review window only drops the sandbox where it has to', async () => {
    const tmp = await tempDir();
    const context = await openPersistentContext({ profileDir: path.join(tmp.dir, 'profile'), headless: true });
    try {
      const line = await commandLine(context);
      assert.equal(line.includes('--no-sandbox'), needsNoSandbox(), line);
    } finally {
      await context.close();
      await tmp.dispose();
    }
  });
});
