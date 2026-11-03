#!/usr/bin/env node
/*
  The pictures the README walks through.

  Deliberately not the same script as ui-shots.mjs. That one photographs every
  state so a change can be judged; this one tells the story a reader follows
  once, in order, and its output is committed. Keeping them apart means a
  README picture never changes because somebody was debugging a panel.

  Usage: node scripts/readme-shots.mjs
*/
import { mkdtemp, rm, mkdir, writeFile, readFile, cp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import { openBrowser } from '../src/browser.mjs';
import { serveStatic } from '../src/server.mjs';
import { runAnnotate } from '../src/annotate.mjs';
import { DEFAULT_THEME } from '../src/config.mjs';
import { openStore } from '../src/tasks.mjs';

const exec = promisify(execFile);
const ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const OUT = path.join(ROOT, 'docs', 'screens');
const BIN = path.join(ROOT, 'bin', 'ayna.mjs');

// A light theme as a project would write it: surfaces and ink, nothing else.
const LIGHT = {
  surface: '#ffffff', bar: '#f7f7f8', panel: '#ffffff',
  line: 'rgba(0,0,0,0.08)', 'panel-line': 'rgba(0,0,0,0.10)',
  text: '#16181d', 'panel-text': '#16181d',
  muted: 'rgba(0,0,0,0.62)', dim: 'rgba(0,0,0,0.50)',
};

async function main() {
  await mkdir(OUT, { recursive: true });
  const dir = await mkdtemp(path.join(tmpdir(), 'ayna-readme-'));
  // A throwaway copy, so step 5 can make a real edit without touching demo/.
  const site = path.join(dir, 'site');
  await cp(path.join(ROOT, 'demo'), site, { recursive: true });
  const server = await serveStatic(site, 4620);
  const browser = await openBrowser({ headless: true });
  const store = await openStore(dir);
  const shots = [];

  const shoot = async (page, name, clip) => {
    await page.screenshot({ path: path.join(OUT, `${name}.png`), ...(clip ? { clip } : {}) });
    shots.push(name);
    console.log(`  ${name}`);
  };
  const say = (text) => exec('node', [BIN, 'say', text], { cwd: dir }).catch(() => {});

  const done = runAnnotate({
    browser,
    // What every real install renders; see DEFAULT_THEME in config.mjs.
    theme: DEFAULT_THEME,
    url: server.url,
    outDir: path.join(dir, 'out'),
    projectDir: site,
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

      // 5 — the verdict, on each element, with the round's files and the
      // gate's answer beside it. A real edit for the first note, as in
      // make-demo-gif.mjs, so the card lists a change that actually happened.
      const cssFile = path.join(site, 'styles.css');
      const css = await readFile(cssFile, 'utf8');
      await writeFile(cssFile, css.replace('.hero-sub {\n  margin-top: var(--s3);', '.hero-sub {\n  margin-top: var(--s4);'));
      await page.waitForFunction(() => document.querySelector('[data-act=close]') !== null, {
        timeout: 20000,
      });
      await page.waitForTimeout(1800);
      await shoot(page, '05-review');

      // 6 — one round's card up close: the file it changed, opened to its
      // diff, what ayna measured, and the way back.
      await page.waitForSelector('.ayna-ov-round [data-act=undo]', { timeout: 20000 });
      await page.click('.ayna-ov-round .ayna-ov-file');
      await page.waitForSelector('.ayna-ov-diff', { timeout: 5000 });
      await page.waitForTimeout(400);
      const rail = await page.evaluate(() => {
        const r = document.querySelector('.ayna-ov-round').getBoundingClientRect();
        return { width: Math.ceil(document.querySelector('.ayna-ov-console').getBoundingClientRect().width), bottom: Math.ceil(r.bottom) };
      });
      await shoot(page, '06-round', { x: 0, y: 0, width: rail.width, height: Math.min(860, rail.bottom + 16) });

      await page.close();
    },
  });

  await Promise.race([done, new Promise((r) => setTimeout(r, 90_000))]);

  // 7 — a phone-sized window: the rail takes no width and opens as a drawer
  // from the bar, so the app keeps the whole screen.
  await Promise.race([
    runAnnotate({
      browser,
      theme: DEFAULT_THEME,
      url: server.url,
      outDir: path.join(dir, 'out-phone'),
      projectDir: site,
      store,
      viewport: { width: 390, height: 844 },
      onReady: async (page) => {
        await page.waitForTimeout(1000);
        await page.click('.ayna-ov-bar [data-act=activity]');
        await page.waitForTimeout(700);
        await shoot(page, '07-phone');
        await page.close();
      },
    }),
    new Promise((r) => setTimeout(r, 60_000)),
  ]);

  // 8 — the same window in a light theme, set the way a project would: the
  // surfaces and ink in ayna.config.json, everything else left to adjust.
  await Promise.race([
    runAnnotate({
      browser,
      theme: { ...DEFAULT_THEME, ...LIGHT },
      url: server.url,
      outDir: path.join(dir, 'out-light'),
      projectDir: site,
      store,
      viewport: { width: 1440, height: 860 },
      onReady: async (page) => {
        await page.waitForTimeout(1000);
        const hero = await page.$('.hero-sub');
        await hero?.click();
        await page.waitForSelector('.ayna-ov-pop textarea', { timeout: 10000 });
        await page.fill('.ayna-ov-pop textarea', 'a touch more room above this');
        await page.click('.ayna-ov-save');
        await page.waitForTimeout(900);
        // Rest the pointer on the rail, where it lights up nothing on the page.
        await page.mouse.move(170, 600);
        await page.waitForTimeout(300);
        await shoot(page, '08-light');
        await page.close();
      },
    }),
    new Promise((r) => setTimeout(r, 60_000)),
  ]);
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
