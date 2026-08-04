/*
  Contrast is the one piece of visual judgement that is not taste.

  ayna's line has always been that it reports what the page can prove. "This looks
  generic" is an opinion and belongs to impeccable; "this text is 1.9:1 against
  its background" is arithmetic, and WCAG puts the threshold at 4.5:1 for body
  text and 3:1 for large text. So it belongs in the measurements, and a fixing
  loop is entitled to chase it to zero.

  The first version of this check silently found nothing, on a page of
  grey-on-white text. Its regexes were written as literals inside the template
  literal that carries the page script, which ate the backslashes — so every
  colour parsed as null and every element was skipped. A perfect score, because
  it never ran. That is the failure these tests are really guarding against.
*/
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';

import { openBrowser } from '../src/browser.mjs';
import { CHECKS, SEVERITY } from '../src/audit.mjs';
import { hasBrowser } from './helpers.mjs';

describe('contrast', { skip: !hasBrowser && 'AYNA_SKIP_BROWSER set' }, () => {
  let browser;
  let page;

  before(async () => {
    browser = await openBrowser({ headless: true });
    const context = await browser.newContext({ viewport: { width: 1000, height: 800 } });
    page = await context.newPage();
  });
  after(async () => {
    await browser?.close().catch(() => {});
  });

  const check = async (body) => {
    await page.setContent(`<!doctype html><body style="background:#ffffff">${body}</body>`);
    await page.waitForTimeout(150);
    const result = await page.evaluate(CHECKS);
    return result.lowContrast;
  };

  test('measures the ratio, and gets the arithmetic right', async () => {
    const found = await check('<p id="a" style="color:#bbbbbb">grey on white</p>');
    assert.equal(found.length, 1);
    // #bbbbbb on #ffffff is 1.92:1 by the WCAG formula. If this number drifts,
    // the luminance maths is wrong, not the threshold.
    assert.equal(found[0].ratio, 1.92);
    assert.equal(found[0].needs, 4.5);
  });

  test('passes text that meets the threshold', async () => {
    assert.deepEqual(await check('<p style="color:#111111">near black</p>'), []);
  });

  test('large text is held to 3:1, the same colour smaller is not', async () => {
    // #949494 on white is 3.03:1 — a pass at 30px and a failure at 14px. Getting
    // this wrong in either direction is what makes a contrast checker useless:
    // it either nags about compliant headings or waves through unreadable body.
    assert.deepEqual(
      await check('<p style="color:#949494;font-size:30px">large grey</p>'),
      [],
      'a compliant large heading must not be reported',
    );
    const small = await check('<p style="color:#949494;font-size:14px">small grey</p>');
    assert.equal(small.length, 1, 'the same colour at body size is a real failure');
  });

  test('bold counts as large from 18.66px, as WCAG defines it', async () => {
    assert.deepEqual(await check('<p style="color:#949494;font-size:19px;font-weight:700">bold</p>'), []);
    const notBold = await check('<p style="color:#949494;font-size:19px;font-weight:400">regular</p>');
    assert.equal(notBold.length, 1);
  });

  test('says nothing when it cannot know', async () => {
    /*
      A gradient or image behind the text has no single colour to compare
      against, and a translucent foreground is composited with whatever is under
      it. Inventing a number for either would be worse than staying quiet — the
      whole value of this check is that its findings are facts.
    */
    assert.deepEqual(
      await check('<div style="background-image:linear-gradient(#fff,#000)"><p style="color:#888">over a gradient</p></div>'),
      [],
      'a gradient backdrop is unmeasurable, not compliant',
    );
    assert.deepEqual(
      await check('<p style="color:rgba(0,0,0,0.35)">translucent text</p>'),
      [],
      'a translucent foreground is composited; the computed colour is not what is seen',
    );
  });

  test('inherits the backdrop from the nearest ancestor that paints one', async () => {
    const found = await check(
      '<section style="background:#222222"><div><p style="color:#3a3a3a">dark on dark</p></div></section>',
    );
    assert.equal(found.length, 1, 'the painted ancestor is the background, not the body');
    assert.match(found[0].background, /34, 34, 34/);
  });

  test('is a counted fault, so a fixing loop can finish it', async () => {
    const entry = SEVERITY.find(([key]) => key === 'lowContrast');
    assert.ok(entry, 'lowContrast must be in the severity list to be counted at all');
    assert.equal(entry[1], 'major');
  });
});
