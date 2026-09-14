import { test } from 'node:test';
import assert from 'node:assert';
import { chromium } from 'playwright-core';
import { whyBlank } from '../src/browser.mjs';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

// The exact shape that defeated an agent across several rounds on 14 Sep 2026:
// no JS errors, text in the DOM, every row opacity:1 with a real rect — and
// nothing painted, because the rows are position:absolute so the section has no
// in-flow content, the wrapper is height:100% of that zero, and overflow:hidden
// clips the lot. None of it is visible in the source.
const COLLAPSED = `<!doctype html><meta charset="utf-8"><style>
  body { margin:0; background:#0b0f1a; color:#e2e8f0; }
  .deck { position:relative; height:100%; width:100%; overflow:hidden; }
  .row  { position:absolute; left:64px; right:64px; }
</style><section><div class="deck">
  <div class="row">The n2 advantage — a headline nobody can see</div>
  <div class="row">A second row of text that is also invisible here</div>
</div></section>`;

const FINE = COLLAPSED.replace('body { margin:0;', 'html, body, section { height:100%; } body { margin:0;');

async function diagnose(html) {
  const browser = await chromium.launch({ channel: 'chrome' });
  try {
    const dir = await mkdtemp(path.join(tmpdir(), 'whyblank-'));
    const file = path.join(dir, 'card.html');
    await writeFile(file, html);
    const page = await (await browser.newContext({ viewport: { width: 1100, height: 700 } })).newPage();
    await page.goto('file://' + file);
    await page.waitForTimeout(300);
    return await whyBlank(page);
  } finally {
    await browser.close();
  }
}

test('a collapsed container is named, with the reason', async () => {
  const r = await diagnose(COLLAPSED);
  assert.ok(r.textLength > 20, 'the text IS in the DOM — that is what makes this hard');
  assert.ok(r.reasons.length, 'a card that paints nothing was reported as fine');
  const all = r.reasons.join(' | ');
  assert.match(all, /computes to \d+x0/, 'the zero height is not named');
  assert.match(all, /overflow is hidden|clipped/, 'the clipping is not named');
  assert.match(all, /position:absolute/, 'the reason it has no height is not named');
});

test('a page that renders is not accused of being blank', async () => {
  const r = await diagnose(FINE);
  assert.equal(r.reasons.length, 0, `a working page was reported blank: ${r.reasons.join(' | ')}`);
});

// An entrance animation that never ran is the other common cause, and it must
// read differently from a collapse — they have opposite fixes.
test('everything left faded out is reported as an animation that did not run', async () => {
  const r = await diagnose(`<!doctype html><meta charset="utf-8"><style>
    html,body{height:100%;margin:0;background:#111}
    p{opacity:0}
  </style><p>One line of text that never faded in at all</p><p>And a second one</p>`);
  assert.match(r.reasons.join(' | '), /opacity:0 — an entrance animation has not run/);
});
