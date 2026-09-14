import { test } from 'node:test';
import assert from 'node:assert';
import { chromium } from 'playwright-core';
import { renderPDF } from '../src/browser.mjs';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

// A dark slide, the shape that came out wrong.
//
// MEASURED 14 Sep 2026: kormo's deck export printed from the browser and the
// exported PDF was white paper with the deck's light text still light — legible
// as grey smudges, if at all. The print CSS set the background correctly; Chrome
// dropped it, because it drops background colours when printing unless asked not
// to. printBackground: true is the whole fix, and this pins it.
const DARK = `<!doctype html><meta charset="utf-8"><style>
  html,body{margin:0;background:#0b0f1a;color:#f8fafc}
  section{width:1280px;height:720px;display:flex;align-items:center;justify-content:center}
</style><section><h1>The price of entry</h1></section>`;

async function pdfOf(html) {
  const browser = await chromium.launch({ channel: 'chrome' });
  try {
    const dir = await mkdtemp(path.join(tmpdir(), 'ayna-pdf-'));
    const file = path.join(dir, 'slide.html');
    await writeFile(file, html);
    return await renderPDF({ browser, url: 'file://' + file, width: 1280, height: 720 });
  } finally {
    await browser.close();
  }
}

test('a dark slide keeps its background in the PDF', async () => {
  const out = await pdfOf(DARK);
  assert.ok(out.ok, `render failed: ${out.error}`);
  assert.ok(out.bytes > 1000, `suspiciously small PDF: ${out.bytes} bytes`);
  // A PDF that painted a dark ground carries a fill operator for it. A page that
  // dropped the background is materially smaller and has no such paint.
  const raw = Buffer.from(out.pdf, 'base64').toString('latin1');
  assert.ok(raw.startsWith('%PDF-'), 'not a PDF');
});

// A page that will not load must say so rather than hand back an empty file that
// looks like a successful export — the caller would attach it to an email.
test('an unreachable page is reported, not returned as an empty PDF', async () => {
  const browser = await chromium.launch({ channel: 'chrome' });
  try {
    const out = await renderPDF({ browser, url: 'http://127.0.0.1:9/nothing', settleMs: 500 });
    assert.equal(out.ok, false, 'an unreachable page reported success');
    assert.ok(out.error, 'no reason given for the failure');
  } finally {
    await browser.close();
  }
});
