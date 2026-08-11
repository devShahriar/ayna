import { mkdir } from 'node:fs/promises';
import path from 'node:path';

import { openBrowser, gotoSettled, settle } from './browser.mjs';
import { CHECKS, SEVERITY } from './audit.mjs';

/**
 * Look at one part of a page, without a person and without a window.
 *
 * Everything else here assumes somebody is pointing: a review window, a click, a
 * dragged box. An agent has no hands. It can name a thing — `.diagram-toolbar`,
 * or a rectangle it worked out from a previous screenshot — and what it needs
 * back is the same two things a person gets from pointing at something: the
 * pixels, and what is measurably wrong inside them.
 *
 * The scoping is the point. `audit` on a large app returns findings from
 * everywhere, and an agent checking whether the toolbar it just changed is
 * still usable has to guess which of them are its business. Bounded to a
 * rectangle, the answer is about the thing it asked about.
 */

/** Does a finding's rect fall inside the region we were asked about? */
function inside(rect, box, slack = 4) {
  if (!box) return false;
  return (
    box.x + box.w > rect.x - slack &&
    box.x < rect.x + rect.width + slack &&
    box.y + box.h > rect.y - slack &&
    box.y < rect.y + rect.height + slack
  );
}

/**
 * The rect for whatever was named, in viewport coordinates.
 *
 * A selector is resolved in the page so a caller never has to know about scroll
 * or transforms; an explicit rectangle is taken as given, because an agent that
 * worked one out from a screenshot means precisely those pixels.
 */
/*
  A function, not a string.

  `page.evaluate` treats a string as an expression and ignores the argument, so
  passing this as source returned the arrow function itself and every selector
  came back unmatched — the same trap that once made flow metrics silently empty.
  Written as a function it is called with its argument, which is the entire
  difference between "no element matches .toolbar" and an answer.
*/
const LOCATE = (sel) => {
  const el = document.querySelector(sel);
  if (!el) return null;
  el.scrollIntoView({ block: 'center', behavior: 'instant' });
  const r = el.getBoundingClientRect();
  const st = getComputedStyle(el);
  const keep = [
    'display', 'position', 'width', 'height', 'padding', 'margin', 'fontSize', 'fontWeight',
    'lineHeight', 'color', 'backgroundColor', 'borderRadius', 'overflow', 'zIndex', 'opacity',
  ];
  const styles = {};
  for (const k of keep) styles[k] = st[k];
  return {
    rect: {
      x: Math.round(r.x),
      y: Math.round(r.y),
      width: Math.round(r.width),
      height: Math.round(r.height),
    },
    tag: el.tagName.toLowerCase(),
    text: (el.innerText || '').trim().slice(0, 300),
    html: el.outerHTML.slice(0, 1200),
    children: el.children.length,
    styles,
  };
};

/**
 * Inspect a region of `url` headlessly.
 *
 * `selector` or `region` says what to look at; everything else is the same
 * apparatus the rest of ayna uses, so a finding here means the same thing it
 * means anywhere else.
 */
export async function inspect({
  browser,
  url,
  selector = null,
  region = null,
  steps = [],
  viewport = { width: 1440, height: 900 },
  outDir,
  pad = 8,
  label = 'inspect',
} = {}) {
  if (!selector && !region) throw new Error('nothing to look at — pass a selector or a region');
  await mkdir(outDir, { recursive: true });

  const own = !browser;
  const chrome = browser ?? (await openBrowser({ headless: true }));
  const context = await chrome.newContext({ viewport, deviceScaleFactor: 1 });
  const page = await context.newPage();

  try {
    await gotoSettled(page, url, { settleMs: 2000 });

    // Anything only reachable by clicking is reached first, or the region being
    // asked about does not exist yet.
    const reached = [];
    for (const step of steps) {
      const { perform } = await import('./flow.mjs');
      try {
        reached.push(await perform(page, step, url));
        await page.waitForTimeout(step.settle ?? 600);
      } catch (err) {
        reached.push({ failed: step, error: err.message.split('\n')[0] });
        break; // measuring a state we failed to reach would be a lie
      }
    }
    await settle(page, 1500);

    const found = selector ? await page.evaluate(LOCATE, selector) : null;
    if (selector && !found) {
      return { url, selector, found: false, why: `no element matches ${selector}`, reached };
    }

    const rect = found?.rect ?? region;
    if (!rect || rect.width < 1 || rect.height < 1) {
      return { url, selector, region, found: false, why: 'the region has no area', reached };
    }

    /*
      Crop without the full-page path, which resizes the page and would change
      what is being measured. The clip is viewport-relative and the element was
      scrolled into view, so what comes back is what is on screen.
    */
    const clip = {
      x: Math.max(0, rect.x - pad),
      y: Math.max(0, rect.y - pad),
      width: Math.min(viewport.width, rect.width + pad * 2),
      height: Math.min(viewport.height, rect.height + pad * 2),
    };
    const file = path.join(outDir, `${label}.png`);
    await page.screenshot({ path: file, clip }).catch(() => {});

    const measured = await page.evaluate(CHECKS).catch((e) => ({ unavailable: e.message.split('\n')[0] }));

    /*
      Only what is wrong inside the region asked about.

      An audit of a large app answers with findings from everywhere, and an agent
      checking the toolbar it just changed then has to guess which of them are
      its business. Scoped, the answer is about the thing it named — and the page
      total comes too, so it can tell "nothing wrong here" from "nothing wrong
      anywhere".
    */
    const scoped = {};
    const totals = {};
    for (const [key] of SEVERITY) {
      const all = Array.isArray(measured[key]) ? measured[key] : [];
      totals[key] = all.length;
      scoped[key] = all.filter((f) => inside(rect, f.rect));
    }
    const counts = Object.fromEntries(Object.entries(scoped).map(([k, v]) => [k, v.length]));
    const serious = SEVERITY.filter(([, sev]) => sev !== 'minor').reduce((n, [k]) => n + counts[k], 0);

    return {
      url,
      selector,
      found: true,
      rect,
      screenshot: file,
      tag: found?.tag,
      text: found?.text,
      html: found?.html,
      styles: found?.styles,
      counts,
      pageCounts: totals,
      findings: scoped,
      clean: !measured.unavailable && serious === 0,
      unavailable: measured.unavailable ?? null,
      reached,
      hint: 'Read `screenshot` — the measurements say what is provably wrong, the image says what it looks like.',
    };
  } finally {
    await context.close().catch(() => {});
    if (own) await chrome.close().catch(() => {});
  }
}

/** A line an agent can act on without parsing anything. */
export function summarizeInspection(result) {
  if (!result.found) return `✗ ${result.why}`;
  if (result.unavailable) return `✗ could not measure the page — ${result.unavailable}`;

  const bad = Object.entries(result.counts).filter(([, n]) => n > 0);
  const size = `${result.rect.width}×${result.rect.height}`;
  if (!bad.length) {
    const elsewhere = Object.values(result.pageCounts).reduce((a, b) => a + b, 0);
    return `✓ ${result.selector ?? 'region'} (${size}) — nothing measurable wrong here` +
      (elsewhere ? ` (${elsewhere} elsewhere on the page)` : '');
  }
  return `✗ ${result.selector ?? 'region'} (${size}) — ${bad.map(([k, n]) => `${n} ${k}`).join(' · ')}`;
}
