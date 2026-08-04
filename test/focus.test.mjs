/*
  Whether a keyboard user can see where they are.

  `outline: none` with nothing put back is one of the most common failures in
  AI-written CSS: it tidies up a screenshot, and the cost only appears when you
  stop using a mouse. It is also entirely measurable — focus the thing, see
  whether anything changed — which is why it belongs with the counted faults and
  not with taste.

  Two subtleties carry the whole check, and both are tested below: `:focus-visible`
  only matches keyboard focus, so a page that styles it the modern way looks
  bare unless the browser has been told focus arrived by keyboard; and measuring
  any of this means moving focus, which must never happen in a window someone is
  using.
*/
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { openBrowser } from '../src/browser.mjs';
import { auditPage, CHECKS, FOCUS_CHECKS, SEVERITY } from '../src/audit.mjs';
import { hasBrowser } from './helpers.mjs';

const PAGE = `
  <style>
    .stripped:focus { outline: none; }
    .modern:focus-visible { outline: 3px solid #1a56db; outline-offset: 2px; }
    .faint:focus { outline: 2px solid #f2f2f2; }
    .shadow:focus { outline: none; box-shadow: 0 0 0 3px #1a56db; }
  </style>
  <button class="stripped">outline removed</button>
  <button class="modern">focus-visible ring</button>
  <button class="faint" style="background:#ffffff">near-white ring</button>
  <button class="shadow">box-shadow ring</button>
  <a href="#x">a plain link</a>`;

function serve(body) {
  const srv = http.createServer((_q, res) => {
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end(`<!doctype html><body style="background:#fff">${body}</body>`);
  });
  return new Promise((resolve) =>
    srv.listen(0, () => resolve({ srv, url: `http://127.0.0.1:${srv.address().port}/` })),
  );
}

describe('focus indicators', { skip: !hasBrowser && 'AYNA_SKIP_BROWSER set' }, () => {
  let browser;
  before(async () => {
    browser = await openBrowser({ headless: true });
  });
  after(async () => {
    await browser?.close().catch(() => {});
  });

  const audit = async (body, opts = {}) => {
    const { srv, url } = await serve(body);
    const dir = await mkdtemp(path.join(tmpdir(), 'ayna-focus-'));
    try {
      const result = await auditPage({
        browser,
        url,
        viewports: [{ name: 'desktop', width: 1200, height: 800 }],
        outDir: dir,
        ...opts,
      });
      return { result, finding: result.findings[0] };
    } finally {
      srv.close();
      await rm(dir, { recursive: true, force: true });
    }
  };

  test('a control with its outline removed is reported', async () => {
    const { finding } = await audit(PAGE);
    assert.deepEqual(
      finding.noFocusIndicator.map((f) => f.element),
      ['button.stripped'],
      'only the control with nothing put back should be reported',
    );
  });

  test('a `:focus-visible` ring counts, which needs keyboard modality', async () => {
    /*
      This is the test that matters most. `:focus-visible` does not match
      programmatic focus unless the browser already believes the user is on the
      keyboard, so without pressing Tab first every modern focus style in the
      world reads as missing — the check would report a page-wide failure on a
      page that is entirely correct.
    */
    const { finding } = await audit(PAGE);
    const flagged = finding.noFocusIndicator.map((f) => f.element);
    assert.ok(!flagged.includes('button.modern'), 'a :focus-visible ring is a real indicator');
  });

  test('a box-shadow ring counts too — an outline is not the only way', async () => {
    const { finding } = await audit(PAGE);
    const flagged = finding.noFocusIndicator.map((f) => f.element);
    assert.ok(!flagged.includes('button.shadow'));
  });

  test('an indicator too faint to see is reported separately', async () => {
    const { finding } = await audit(PAGE);
    const faint = finding.faintFocusIndicator.find((f) => f.element === 'button.faint');
    assert.ok(faint, 'a near-white ring on white is not an indicator anyone can use');
    assert.ok(faint.ratio < 3, `expected under 3:1, got ${faint.ratio}`);

    // Present-but-faint is a different, lesser problem than absent, and the two
    // must not be merged: one is invisible, the other is merely poor.
    assert.ok(!finding.noFocusIndicator.some((f) => f.element === 'button.faint'));
  });

  test('both are counted, so a fixing loop can finish them', async () => {
    const { result } = await audit(PAGE);
    assert.equal(result.counts.noFocusIndicator, 1);
    assert.equal(result.counts.faintFocusIndicator, 1);
    assert.equal(SEVERITY.find(([k]) => k === 'noFocusIndicator')[1], 'major');
    assert.equal(SEVERITY.find(([k]) => k === 'faintFocusIndicator')[1], 'minor');
  });

  test('the live review window cannot run this, by construction', async () => {
    /*
      Tabbing through a window somebody is reviewing in would fire the app's focus
      handlers, open menus and move the caret out from under them. The protection
      is structural, not a flag: annotate's live audit evaluates CHECKS, and
      FOCUS_CHECKS is deliberately not part of it.

      Gating on a supplied `context` was the first attempt and was wrong — a
      context is usually the saved login profile ayna opened itself, so that rule
      switched focus checking off for every app behind a sign-in. Asserting on the
      structure keeps that mistake from coming back.
    */
    assert.ok(!CHECKS.includes('noFocusIndicator'), 'the live-window script must not measure focus');
    assert.ok(FOCUS_CHECKS.includes('noFocusIndicator'), 'and the audit-only script must');
  });

  test('it still runs for an app behind a login, where a context is supplied', async () => {
    const { srv, url } = await serve(PAGE);
    const context = await browser.newContext({ viewport: { width: 1200, height: 800 } });
    const dir = await mkdtemp(path.join(tmpdir(), 'ayna-focus-ctx-'));
    try {
      const result = await auditPage({
        browser,
        context,
        url,
        viewports: [{ name: 'desktop', width: 1200, height: 800 }],
        outDir: dir,
      });
      assert.equal(result.counts.noFocusIndicator, 1, 'a saved profile must not disable the check');
    } finally {
      await context.close().catch(() => {});
      srv.close();
      await rm(dir, { recursive: true, force: true });
    }
  });
});
