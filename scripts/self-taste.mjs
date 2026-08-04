#!/usr/bin/env node
/*
  Point the taste detectors at ayna's own review chrome.

  ayna already audits itself for layout faults — the `covered` check with its
  self-exclusion switched off, which caught the bar sitting on the app's
  controls. This is the same idea for the things layout cannot measure: is the
  overlay's own design any good, or does it carry the tells of everything else an
  LLM has drawn?

  The overlay only exists once injected, so the chrome is driven into a state
  where the bar, the comment box and the task panel are all present, and the
  rendered document is written out as a standalone page. The host page underneath
  is deliberately almost empty, so what comes back is about ayna and not about
  somebody's landing page.

  Usage: node scripts/self-taste.mjs [--keep]
*/
import { mkdtemp, writeFile, rm, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import http from 'node:http';
import path from 'node:path';

import { openBrowser } from '../src/browser.mjs';
import { runAnnotate } from '../src/annotate.mjs';

const exec = promisify(execFile);
const KEEP = process.argv.includes('--keep');

/* Enough page to comment on, and no design of its own to be judged for. */
const HOST = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>host</title></head>
<body style="margin:0;background:#ffffff;font-family:system-ui">
  <main style="padding:120px 40px">
    <h1 class="subject" style="font:600 24px system-ui;color:#111">Subject</h1>
    <p class="body" style="font:16px/1.6 system-ui;color:#333;max-width:60ch">A paragraph to comment on.</p>
  </main>
</body></html>`;

async function main() {
  const srv = http.createServer((_q, res) => {
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end(HOST);
  });
  await new Promise((r) => srv.listen(0, r));
  const url = `http://127.0.0.1:${srv.address().port}/`;

  const work = await mkdtemp(path.join(tmpdir(), 'ayna-self-taste-'));
  const out = path.join(work, 'chrome');
  await mkdir(out, { recursive: true });
  const browser = await openBrowser({ headless: true });

  const dumps = [];
  try {
    await runAnnotate({
      browser,
      url,
      outDir: path.join(work, 'run'),
      projectDir: work,
      viewport: { width: 1440, height: 900 },
      onReady: async (page) => {
        const dump = async (name) => {
          const html = await page.evaluate(() => document.documentElement.outerHTML);
          const file = path.join(out, `${name}.html`);
          await writeFile(file, '<!doctype html>' + html);
          dumps.push(file);
        };

        await page.waitForTimeout(800);
        await dump('01-bar-commenting');

        await page.click('.subject');
        await page.waitForSelector('.ayna-ov-pop textarea', { timeout: 10000 });
        await page.fill('.ayna-ov-pop textarea', 'the heading is the same weight as the body');
        await page.waitForTimeout(400);
        await dump('02-comment-box');
        await page.click('.ayna-ov-save');
        await page.waitForTimeout(400);

        await page.click('.body');
        await page.waitForSelector('.ayna-ov-pop textarea', { timeout: 10000 });
        await page.fill('.ayna-ov-pop textarea', 'the measure is too wide to read comfortably');
        await page.click('.ayna-ov-save');
        await page.waitForTimeout(400);

        await page.click('[data-act=tasks]');
        await page.waitForTimeout(500);
        await dump('03-task-panel');
        await page.click('[data-act=tasks]');
        await page.waitForTimeout(300);

        await page.click('[data-act=send]');
        await page.waitForSelector('.ayna-ov-waiting', { timeout: 10000 });
        await page.waitForTimeout(400);
        await dump('04-waiting');

        await page.click('[data-act=applied]');
        await page.waitForFunction(() => document.querySelector('[data-act=close]') !== null, {
          timeout: 20000,
        });
        await page.waitForTimeout(700);
        await dump('05-review');

        const pin = await page.$('.ayna-ov-revpin');
        if (pin) {
          await pin.click();
          await page.waitForTimeout(500);
          await dump('06-review-card');
        }
        await page.close();
      },
    });
  } finally {
    await browser.close().catch(() => {});
    srv.close();
  }

  console.log(`captured ${dumps.length} states of ayna's own chrome\n`);

  const bin = process.env.AYNA_IMPECCABLE;
  if (!bin) {
    console.log(`set AYNA_IMPECCABLE to an impeccable binary to judge them.\nthe pages are in ${out}`);
    return;
  }

  const [cmd, ...prefix] = bin.split(' ');
  let stdout = '';
  try {
    ({ stdout } = await exec(cmd, [...prefix, 'detect', out, '--json'], { maxBuffer: 8 * 1024 * 1024 }));
  } catch (err) {
    stdout = err.stdout ?? '';
  }

  let findings = [];
  try {
    findings = JSON.parse(stdout);
  } catch {
    console.log('impeccable returned something unreadable');
    return;
  }

  /* One line per rule, with where it fired — the detail belongs in the fix. */
  const byRule = new Map();
  for (const f of findings) {
    const key = f.antipattern ?? f.name;
    if (!byRule.has(key)) byRule.set(key, { ...f, where: [] });
    byRule.get(key).where.push(`${path.basename(f.file, '.html')}: ${f.snippet ?? ''}`.slice(0, 110));
  }

  console.log(`${byRule.size} rules fired on ayna's own UI (${findings.length} occurrences)\n`);
  for (const f of [...byRule.values()].sort((a, b) => b.where.length - a.where.length)) {
    console.log(`${f.severity === 'error' ? '✗' : '·'} ${f.name}  ×${f.where.length}`);
    console.log(`    ${f.description.split('. ')[0]}.`);
    for (const w of f.where.slice(0, 3)) console.log(`    · ${w}`);
    console.log('');
  }

  if (!KEEP) await rm(work, { recursive: true, force: true });
  else console.log(`pages kept in ${out}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
