#!/usr/bin/env node
/*
  Records the README demo.

  Runs the real overlay against a throwaway copy of demo/, drives it the way a
  person would, and makes an actual edit partway through so the reload shows a
  genuine change rather than a staged one. Frames are grabbed on a timer while the
  interaction plays out, then ffmpeg builds the gif.

  Usage:  node scripts/make-demo-gif.mjs [outfile]
  Needs:  ffmpeg on PATH.
*/
import { mkdtemp, rm, mkdir, cp, readFile, writeFile, readdir } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { openBrowser } from '../src/browser.mjs';
import { serveStatic } from '../src/server.mjs';
import { runAnnotate } from '../src/annotate.mjs';

const exec = promisify(execFile);
const ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const OUT = path.resolve(process.argv[2] ?? path.join(ROOT, 'docs', 'demo.gif'));

const VIEWPORT = { width: 1180, height: 720 };
const FPS = 10;

async function main() {
  const work = await mkdtemp(path.join(tmpdir(), 'ayna-gif-'));
  const site = path.join(work, 'site');
  const frames = path.join(work, 'frames');
  const annotateOut = path.join(work, 'out');
  await cp(path.join(ROOT, 'demo'), site, { recursive: true });
  await mkdir(frames, { recursive: true });

  const server = await serveStatic(site, 4600);
  const browser = await openBrowser({ headless: true });

  let frame = 0;
  let capturing = null;

  const startCapture = (page) => {
    capturing = setInterval(async () => {
      const file = path.join(frames, `f${String(frame++).padStart(4, '0')}.png`);
      await page.screenshot({ path: file }).catch(() => {});
    }, 1000 / FPS);
  };
  const stopCapture = () => capturing && clearInterval(capturing);

  // Type at human speed so the recording reads as someone using it.
  const type = async (page, sel, text) => {
    for (const ch of text) {
      await page.type(sel, ch, { delay: 0 });
      await page.waitForTimeout(28);
    }
  };

  await runAnnotate({
    browser,
    url: server.url,
    outDir: annotateOut,
    projectDir: site,
    viewport: VIEWPORT,
    onReady: async (page) => {
      startCapture(page);
      await page.waitForTimeout(900);

      // 1. Hover to show the element badge.
      const h1 = await page.locator('#hero h1').boundingBox();
      await page.mouse.move(h1.x + h1.width / 2, h1.y + h1.height / 2, { steps: 18 });
      await page.waitForTimeout(1100);

      // 2. Click it and write a comment.
      await page.mouse.down();
      await page.mouse.up();
      await page.waitForSelector('.ayna-ov-pop textarea');
      await page.waitForTimeout(400);
      await type(page, '.ayna-ov-pop textarea', 'Make this headline bigger and tighter');
      await page.waitForTimeout(700);
      await page.click('.ayna-ov-save');
      await page.waitForTimeout(900);

      // 3. Send it.
      await page.click('[data-act=send]');
      await page.waitForTimeout(1400);

      // 4. A real edit, so the reload shows something that actually happened.
      const cssFile = path.join(site, 'styles.css');
      const css = await readFile(cssFile, 'utf8');
      await writeFile(
        cssFile,
        css.replace(
          '#hero h1 {',
          '#hero h1 {\n  font-size: clamp(3.5rem, 7vw, 5.5rem);\n  letter-spacing: -0.045em;',
        ),
      );
      await writeFile(path.join(annotateOut, 'applied'), '1');

      // 5. Review: the commented portion is highlighted again.
      await page.waitForFunction(() => document.querySelector('[data-act=approve]') !== null, {
        timeout: 20000,
      });
      await page.waitForTimeout(1500);

      // 6. Judge it in place.
      const pin = await page.locator('.ayna-ov-revpin').first().boundingBox();
      if (pin) {
        await page.mouse.move(pin.x + pin.width / 2, pin.y + pin.height / 2, { steps: 14 });
        await page.waitForTimeout(500);
        await page.mouse.down();
        await page.mouse.up();
        await page.waitForSelector('.ayna-ov-card');
        await page.waitForTimeout(1600);
        await page.click('[data-act=resolve]');
        await page.waitForTimeout(1600);
      }

      stopCapture();
      await page.close();
    },
  });

  await browser.close().catch(() => {});
  await server.close().catch(() => {});

  const count = (await readdir(frames)).length;
  if (!count) throw new Error('no frames captured');
  console.log(`captured ${count} frames`);

  await mkdir(path.dirname(OUT), { recursive: true });
  const palette = path.join(work, 'palette.png');
  const input = path.join(frames, 'f%04d.png');

  // Two passes: a palette from the whole clip, then dithered against it. A gif is
  // 256 colours, and the default palette wrecks the UI's flat greys otherwise.
  await exec('ffmpeg', ['-y', '-framerate', String(FPS), '-i', input,
    '-vf', 'scale=900:-1:flags=lanczos,palettegen=max_colors=192:stats_mode=diff', palette]);
  await exec('ffmpeg', ['-y', '-framerate', String(FPS), '-i', input, '-i', palette,
    '-lavfi', 'scale=900:-1:flags=lanczos[x];[x][1:v]paletteuse=dither=bayer:bayer_scale=4',
    '-loop', '0', OUT]);

  const { size } = await (await import('node:fs/promises')).stat(OUT);
  console.log(`wrote ${OUT} (${(size / 1024 / 1024).toFixed(2)} MB)`);

  await rm(work, { recursive: true, force: true });
}

main().catch((err) => {
  console.error(err.message);
  process.exitCode = 1;
});
