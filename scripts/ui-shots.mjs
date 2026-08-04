#!/usr/bin/env node
/*
  Photograph the review overlay in every state it has.

  The rule this whole tool is built on applies to the tool: reading the CSS tells
  you what was intended, and only the screenshot tells you what the user gets. So
  before changing the bar, the comment box or the task panel, look at them.

  Usage: node scripts/ui-shots.mjs [outDir]
*/
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { openBrowser } from '../src/browser.mjs';
import { serveStatic } from '../src/server.mjs';
import { runAnnotate } from '../src/annotate.mjs';

const ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const OUT = path.resolve(process.argv[2] ?? path.join(ROOT, '.ayna', 'ui-shots'));

async function main() {
  await mkdir(OUT, { recursive: true });
  const server = await serveStatic(path.join(ROOT, 'demo'), 4610);
  const browser = await openBrowser({ headless: true });
  const dir = await mkdtemp(path.join(tmpdir(), 'ayna-shots-'));
  const shots = [];

  const shoot = async (page, name) => {
    const file = path.join(OUT, `${name}.png`);
    await page.screenshot({ path: file });
    shots.push(file);
    console.log(`  ${name}`);
  };

  try {
    await runAnnotate({
      browser,
      url: server.url,
      outDir: path.join(dir, 'out'),
      projectDir: dir,
      viewport: { width: 1440, height: 900 },
      onReady: async (page) => {
        await page.waitForTimeout(900);
        await shoot(page, '01-comment-mode');

        // Hovering: the highlight and whatever it says about the target.
        await page.mouse.move(700, 300);
        await page.waitForTimeout(400);
        await shoot(page, '02-hover-highlight');

        // The comment box, with the crop it captured.
        await page.mouse.click(700, 300);
        await page.waitForSelector('.ayna-ov-pop textarea', { timeout: 10000 });
        await page.waitForTimeout(700);
        await shoot(page, '03-comment-box');

        await page.fill('.ayna-ov-pop textarea', 'this heading is the same weight as the body copy');
        await page.waitForTimeout(200);
        await shoot(page, '04-comment-box-typed');
        await page.click('.ayna-ov-save');
        await page.waitForTimeout(600);
        await shoot(page, '05-after-first-comment');

        // Region select: the marquee, mid-drag and once framed.
        await page.mouse.move(200, 480);
        await page.mouse.down();
        for (let i = 0; i < 20; i++) await page.mouse.move(200 + i * 18, 480 + i * 7);
        await page.waitForTimeout(250);
        await shoot(page, '06-region-drag');
        await page.mouse.up();
        await page.waitForSelector('.ayna-ov-pop textarea', { timeout: 10000 });
        await page.waitForTimeout(700);
        await shoot(page, '07-region-comment-box');
        await page.keyboard.press('Escape');
        await page.waitForTimeout(300);

        // A few more comments, so the panel and review markers have content.
        for (const [x, y, text] of [
          [700, 620, 'these cards do not line up'],
          [1100, 300, 'the button has no hover state'],
        ]) {
          await page.mouse.click(x, y);
          await page.waitForSelector('.ayna-ov-pop textarea', { timeout: 10000 });
          await page.fill('.ayna-ov-pop textarea', text);
          await page.click('.ayna-ov-save');
          await page.waitForTimeout(400);
        }
        await shoot(page, '08-three-comments');

        // The task panel.
        await page.click('[data-act=tasks]');
        await page.waitForTimeout(600);
        await shoot(page, '09-task-panel');
        await page.click('[data-act=tasks]');
        await page.waitForTimeout(300);

        // Waiting, then review with its per-element verdicts.
        await page.click('[data-act=send]');
        await page.waitForSelector('.ayna-ov-waiting', { timeout: 10000 });
        await page.waitForTimeout(500);
        await shoot(page, '10-waiting');

        await page.click('[data-act=applied]');
        await page.waitForFunction(() => document.querySelector('[data-act=close]') !== null, {
          timeout: 20000,
        });
        await page.waitForTimeout(900);
        await shoot(page, '11-review');

        const pin = await page.$('.ayna-ov-revpin');
        if (pin) {
          await pin.click();
          await page.waitForTimeout(600);
          await shoot(page, '12-review-card');
        }
        await page.close();
      },
    });
  } finally {
    await browser.close().catch(() => {});
    await server.close?.();
    await rm(dir, { recursive: true, force: true });
  }

  await writeFile(path.join(OUT, 'index.json'), JSON.stringify({ shots }, null, 2));
  console.log(`\n${shots.length} shots in ${OUT}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
