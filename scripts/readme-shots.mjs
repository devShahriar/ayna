#!/usr/bin/env node
/*
  The pictures the README walks through.

  Deliberately not the same script as ui-shots.mjs. That one photographs every
  state so a change can be judged; this one tells the story a reader follows
  once, in order, and its output is committed. Keeping them apart means a
  README picture never changes because somebody was debugging a panel.

  Usage: node scripts/readme-shots.mjs
*/
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import { openBrowser } from '../src/browser.mjs';
import { serveStatic } from '../src/server.mjs';
import { runAnnotate } from '../src/annotate.mjs';
import { openStore } from '../src/tasks.mjs';

const exec = promisify(execFile);
const ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const OUT = path.join(ROOT, 'docs', 'screens');
const BIN = path.join(ROOT, 'bin', 'ayna.mjs');

async function main() {
  await mkdir(OUT, { recursive: true });
  const server = await serveStatic(path.join(ROOT, 'demo'), 4620);
  const browser = await openBrowser({ headless: true });
  const dir = await mkdtemp(path.join(tmpdir(), 'ayna-readme-'));
  const store = await openStore(dir);
  const shots = [];

  const shoot = async (page, name) => {
    await page.screenshot({ path: path.join(OUT, `${name}.png`) });
    shots.push(name);
    console.log(`  ${name}`);
  };
  const say = (text) => exec('node', [BIN, 'say', text], { cwd: dir }).catch(() => {});

  const done = runAnnotate({
    browser,
    url: server.url,
    outDir: path.join(dir, 'out'),
    projectDir: dir,
    store,
    viewport: { width: 1440, height: 860 },
    onReady: async (page) => {
      await page.waitForTimeout(1000);

      // 1 — the window as it opens: rail on the left, modes across the top.
      await shoot(page, '01-window');

      // 2 — pointing at something, and saying what is wrong with it.
      const hero = await page.$('.hero-sub');
      await hero?.scrollIntoViewIfNeeded();
      await hero?.click();
      await page.waitForSelector('.ayna-ov-pop textarea', { timeout: 10000 });
      await page.fill('.ayna-ov-pop textarea', 'this sits too close to the headline above it');
      await page.waitForTimeout(500);
      await shoot(page, '02-comment');
      await page.click('.ayna-ov-save');
      await page.waitForTimeout(400);

      // A second one, so the panel and the review phase have something to show.
      const feature = await page.$('.feature-grid .feature');
      await feature?.scrollIntoViewIfNeeded();
      await page.waitForTimeout(200);
      await feature?.click();
      const box = await page.waitForSelector('.ayna-ov-pop textarea', { timeout: 10000 }).catch(() => null);
      if (box) {
        await page.fill('.ayna-ov-pop textarea', 'these cards do not line up with the grid above');
        await page.click('.ayna-ov-save');
        await page.waitForTimeout(400);
      }
      await page.evaluate(() => scrollTo(0, 0));
      await page.waitForTimeout(300);

      // 3 — everything still owed, wherever it was raised.
      await page.click('[data-act=tasks]');
      await page.waitForTimeout(600);
      await shoot(page, '03-tasks');
      await page.click('[data-act=tasks]');
      await page.waitForTimeout(300);

      // 4 — sent, and Claude talking back on the page rather than in a terminal.
      await page.click('[data-act=send]');
      await page.waitForSelector('.ayna-ov-waiting', { timeout: 10000 });
      await say('picking these up now');
      await page.waitForTimeout(1400);
      await say('tightened the spacing scale');
      await page.waitForTimeout(1400);
      await shoot(page, '04-console');

      // 5 — the verdict, on each element, with the gate's answer beside it.
      await page.click('[data-act=applied]');
      await page.waitForFunction(() => document.querySelector('[data-act=close]') !== null, {
        timeout: 20000,
      });
      await page.waitForTimeout(1800);
      await shoot(page, '05-review');

      await page.close();
    },
  });

  await Promise.race([done, new Promise((r) => setTimeout(r, 90_000))]);
  await browser.close().catch(() => {});
  await server.close?.();
  await rm(dir, { recursive: true, force: true });

  await writeFile(path.join(OUT, 'index.json'), JSON.stringify({ shots }, null, 2));
  console.log(`\n${shots.length} shots in docs/screens`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
