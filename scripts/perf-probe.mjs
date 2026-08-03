#!/usr/bin/env node
/*
  Measure the review overlay the way it is actually used.

  "It lags" is not something you can fix by reading code — every handler looks
  cheap on its own. This drives the real overlay on a deliberately heavy page and
  reports what the user feels: dropped frames while moving the mouse, how long the
  page is blocked, and whether anything resized the viewport underneath them.

  Usage: node scripts/perf-probe.mjs [--headed]
*/
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { openBrowser } from '../src/browser.mjs';
import { serveStatic } from '../src/server.mjs';
import { runAnnotate } from '../src/annotate.mjs';

const HEADED = process.argv.includes('--headed');

/* A page with enough DOM and a canvas to behave like a real app rather than a
   fixture that makes every measurement look fine. */
const PAGE = `<!doctype html><html><head><meta charset="utf-8"><title>heavy</title>
<style>
  body{margin:0;font:14px system-ui}
  .grid{display:grid;grid-template-columns:repeat(6,1fr);gap:8px;padding:12px}
  .card{border:1px solid #ccc;border-radius:8px;padding:10px;background:#fafafa}
  .card h3{margin:0 0 6px;font-size:13px}
  canvas{display:block;width:100%;height:420px;background:#123}
</style></head><body>
<canvas id="cv"></canvas>
<div class="grid" id="grid"></div>
<script>
  const grid = document.getElementById('grid');
  grid.innerHTML = Array.from({length: 600}, (_, i) =>
    '<div class="card"><h3>Card ' + i + '</h3><p>Some body copy for card ' + i + '.</p>' +
    '<button>Action ' + i + '</button></div>').join('');
  const cv = document.getElementById('cv');
  const g = cv.getContext('2d');
  function fit(){ cv.width = innerWidth; cv.height = 420; }
  fit();
  addEventListener('resize', () => { window.__resizes = (window.__resizes || 0) + 1; fit(); });
  (function draw(t){
    g.fillStyle = '#123'; g.fillRect(0,0,cv.width,cv.height);
    for (let i=0;i<220;i++){
      g.fillStyle = 'hsl(' + ((i*7 + t/40)%360) + ',60%,55%)';
      g.fillRect((i*37 + t/10)%cv.width, (i*23)%cv.height, 18, 18);
    }
    requestAnimationFrame(draw);
  })(0);
</script></body></html>`;

/* Frame intervals are what "lag" means. A run of 16ms frames is smooth; a 300ms
   gap is the freeze people describe as the window locking up. */
const INSTRUMENT = () => {
  window.__perf = { frames: [], longTasks: [], resizes: 0, shifts: 0 };
  let last = performance.now();
  (function tick(now) {
    window.__perf.frames.push(now - last);
    last = now;
    requestAnimationFrame(tick);
  })(performance.now());

  try {
    new PerformanceObserver((l) => {
      for (const e of l.getEntries()) window.__perf.longTasks.push(Math.round(e.duration));
    }).observe({ entryTypes: ['longtask'] });
  } catch {}
  try {
    new PerformanceObserver((l) => {
      for (const e of l.getEntries()) if (!e.hadRecentInput) window.__perf.shifts += e.value;
    }).observe({ type: 'layout-shift', buffered: true });
  } catch {}

  addEventListener('resize', () => window.__perf.resizes++);
  visualViewport.addEventListener('resize', () => window.__perf.resizes++);
};

const reset = (page) => page.evaluate(() => {
  window.__perf.frames.length = 0;
  window.__perf.longTasks.length = 0;
  window.__perf.resizes = 0;
});

async function report(page, label) {
  const p = await page.evaluate(() => window.__perf);
  const frames = p.frames.slice(1).sort((a, b) => a - b);
  if (!frames.length) return console.log(`${label.padEnd(26)} no frames recorded`);
  const at = (q) => Math.round(frames[Math.floor(frames.length * q)] ?? 0);
  const dropped = frames.filter((f) => f > 32).length;
  console.log(
    `${label.padEnd(26)} p50 ${String(at(0.5)).padStart(3)}ms  p95 ${String(at(0.95)).padStart(4)}ms  ` +
      `worst ${String(Math.round(frames.at(-1))).padStart(4)}ms  janky ${String(dropped).padStart(3)}/${frames.length}  ` +
      `blocking ${String(p.longTasks.reduce((a, b) => a + b, 0)).padStart(4)}ms  resizes ${p.resizes}`,
  );
}

async function main() {
  const dir = await mkdtemp(path.join(tmpdir(), 'ayna-perf-'));
  const site = path.join(dir, 'site');
  await mkdir(site, { recursive: true });
  await writeFile(path.join(site, 'index.html'), PAGE);
  const server = await serveStatic(site, 4599);
  const browser = await openBrowser({ headless: !HEADED });
  const context = await browser.newContext({ viewport: HEADED ? null : { width: 1280, height: 860 } });

  try {
    await runAnnotate({
      browser,
      context,
      url: server.url,
      outDir: path.join(dir, 'out'),
      projectDir: site,
      viewport: { width: 1280, height: 860 },
      onReady: async (page) => {
        await page.waitForTimeout(1200);
        await page.evaluate(INSTRUMENT);
        await page.waitForTimeout(600);

        await reset(page);
        await page.waitForTimeout(1500);
        await report(page, 'idle (baseline)');

        // Sweeping the cursor is the single most common thing anyone does.
        await reset(page);
        for (let i = 0; i < 120; i++) {
          await page.mouse.move(200 + (i % 60) * 14, 480 + Math.floor(i / 60) * 40);
        }
        await page.waitForTimeout(300);
        await report(page, 'moving the mouse');

        /*
          Playwright's mouse.move is one round-trip per step, so it arrives far
          slower than a real mouse and makes any per-move cost disappear. Dispatch
          the same events from inside the page to see what a 120Hz stream costs.
        */
        await reset(page);
        const burst = await page.evaluate(() => {
          const t0 = performance.now();
          for (let i = 0; i < 400; i++) {
            const el = document.elementFromPoint(200 + (i % 50) * 12, 500 + ((i * 7) % 200));
            (el ?? document.body).dispatchEvent(
              new MouseEvent('mousemove', {
                bubbles: true,
                clientX: 200 + (i % 50) * 12,
                clientY: 500 + ((i * 7) % 200),
              }),
            );
          }
          return performance.now() - t0;
        });
        await page.waitForTimeout(400);
        await report(page, 'mousemove burst (400)');
        console.log(
          `${''.padEnd(26)} ${Math.round(burst)}ms total, ${(burst / 400).toFixed(2)}ms per move`,
        );

        // Opening the comment box: click, crop, popover.
        await reset(page);
        const t0 = Date.now();
        await page.mouse.click(300, 500);
        await page.waitForSelector('.ayna-ov-pop textarea', { timeout: 15000 });
        const opened = Date.now() - t0;
        await page.waitForTimeout(600);
        await report(page, 'opening the comment box');
        console.log(`${''.padEnd(26)} box appeared after ${opened}ms`);

        await reset(page);
        await page.fill('.ayna-ov-pop textarea', 'perf probe');
        await page.click('.ayna-ov-save');
        await page.waitForTimeout(1200);
        await report(page, 'saving a comment');

        // Marquee: mousedown, drag, up — with a crop at the end.
        await reset(page);
        await page.mouse.move(120, 120);
        await page.mouse.down();
        for (let i = 0; i < 40; i++) await page.mouse.move(120 + i * 8, 120 + i * 5);
        await page.mouse.up();
        await page.waitForTimeout(1200);
        await report(page, 'dragging a region');
        await page.keyboard.press('Escape');

        await page.waitForTimeout(300);
        const canvasResizes = await page.evaluate(() => window.__resizes || 0);
        console.log(`\ncanvas re-fits during the whole session: ${canvasResizes}`);
        await page.click('[data-act=send]').catch(() => {});
        await page.waitForTimeout(300);
        await writeFile(path.join(dir, 'out', 'applied'), '1');
        await page
          .waitForFunction(() => document.querySelector('[data-act=close]') !== null, { timeout: 15000 })
          .catch(() => {});
        await page.click('[data-act=close]').catch(() => {});
      },
    });
  } finally {
    await context.close().catch(() => {});
    await browser.close().catch(() => {});
    await server.close?.();
    await rm(dir, { recursive: true, force: true });
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
