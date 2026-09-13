import { settle } from './browser.mjs';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

/**
 * Drive a UI flow and measure it.
 *
 * A screenshot of each screen tells you what it looks like. A flow tells you what
 * it is like to *use*: whether a step acknowledges the click, whether the page
 * settles before you can act, whether content jumps under the cursor, whether
 * focus survives a navigation. Those are the things a person feels and cannot
 * point at, so they are measured here and handed to the reviewer alongside the
 * pictures.
 */

/*
  Injected before anything else on the page. Layout shift can only be observed as
  it happens, so the observer has to exist before the step does — measuring after
  the fact would always read zero.
*/
const PROBE = `
(() => {
  if (window.__aynaProbe) return;
  window.__aynaProbe = { shift: 0, longTasks: 0 };
  try {
    new PerformanceObserver((list) => {
      for (const e of list.getEntries()) {
        if (!e.hadRecentInput) window.__aynaProbe.shift += e.value;
      }
    }).observe({ type: 'layout-shift', buffered: true });
  } catch {}
  try {
    new PerformanceObserver((list) => {
      window.__aynaProbe.longTasks += list.getEntries().length;
    }).observe({ type: 'longtask', buffered: true });
  } catch {}
  window.__aynaProbeReset = () => {
    window.__aynaProbe.shift = 0;
    window.__aynaProbe.longTasks = 0;
  };
})();
`;

/*
  What the page can tell us about itself right after a step.

  An immediately-invoked expression, not an arrow function: page.evaluate() treats
  a string as an expression to evaluate, so a bare `() => {...}` evaluates to a
  function object, fails to serialise, and — with a catch around it — silently
  reports no metrics at all.
*/
const SNAPSHOT = `(() => {
  const doc = document.documentElement;
  const active = document.activeElement;
  const describe = (el) => {
    if (!el || el === document.body) return null;
    let s = el.tagName.toLowerCase();
    if (el.id) return s + '#' + el.id;
    const c = [...el.classList][0];
    return c ? s + '.' + c : s;
  };

  const interactive = [...document.querySelectorAll('button, a[href], [role=button], input, select, textarea')];
  const unlabelled = interactive.filter((el) => {
    if (el.getAttribute('aria-label') || el.getAttribute('title')) return false;
    if (el.labels && el.labels.length) return false;
    return !(el.innerText || '').trim() && !el.getAttribute('placeholder');
  }).length;

  const tiny = [...document.querySelectorAll('body *')].filter((el) => {
    const fs = parseFloat(getComputedStyle(el).fontSize);
    return el.textContent?.trim() && fs > 0 && fs < 12;
  }).length;

  return {
    title: document.title,
    url: location.href,
    textLength: (document.body?.innerText || '').trim().length,
    horizontalOverflow: doc.scrollWidth > doc.clientWidth + 1,
    tinyTextNodes: tiny,
    unlabelledControls: unlabelled,
    // Focus dumped on <body> after a navigation strands keyboard users.
    focus: describe(active),
    focusLost: !active || active === document.body,
    layoutShift: Number(((window.__aynaProbe && window.__aynaProbe.shift) || 0).toFixed(4)),
    longTasks: (window.__aynaProbe && window.__aynaProbe.longTasks) || 0,
  };
})()`;

/** One action. Returns a note for the record, or throws to fail the step. */
export async function perform(page, step, baseUrl) {
  // WHICH ONE. `.first()` is the right default and the wrong answer when the
  // point is the thing that was just made: a canvas that already holds twenty
  // cards answers "is there a card?" with one from last week. `nth: -1` is the
  // newest, `nth: 2` the third, and the default stays first.
  const pick = (sel, nth) => {
    const loc = page.locator(sel);
    if (nth == null) return loc.first();
    return nth < 0 ? loc.last() : loc.nth(nth);
  };

  // THE ONE THE APP JUST TOOK YOU TO.
  //
  // On a canvas, neither "first" nor "last" means "the card that was just made":
  // DOM order is creation order across the whole board's history, so a canvas
  // holding twenty older cards answers every question with one of them. What IS
  // reliable is the viewport — the agent calls focus_canvas and the thing it
  // wants you to see ends up in the middle of the screen. So: the match nearest
  // the centre of the window.
  const nearestToCentre = async (sel) => {
    const n = await page.locator(sel).count();
    if (!n) throw new Error(`nothing matches ${sel}`);
    const vp = page.viewportSize() ?? { width: 1440, height: 900 };
    const cx = vp.width / 2, cy = vp.height / 2;
    let best = 0, bestD = Infinity;
    for (let i = 0; i < n; i++) {
      const box = await page.locator(sel).nth(i).boundingBox();
      if (!box) continue;
      const dx = box.x + box.width / 2 - cx, dy = box.y + box.height / 2 - cy;
      const d = dx * dx + dy * dy;
      if (d < bestD) { bestD = d; best = i; }
    }
    return page.locator(sel).nth(best);
  };

  switch (step.do) {
    case 'goto': {
      const url = new URL(step.url, baseUrl).toString();
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30_000 });
      return `went to ${step.url}`;
    }
    case 'click': {
      const el = step.nearest === 'center' || step.nearest === 'centre'
        ? await nearestToCentre(step.on)
        : pick(step.on, step.nth);
      await el.waitFor({ state: 'visible', timeout: step.timeout ?? 10_000 });
      const box = await el.boundingBox();
      await el.click({ timeout: step.timeout ?? 10_000 });
      return { note: `clicked ${step.on}`, target: box && { w: Math.round(box.width), h: Math.round(box.height) } };
    }
    case 'type': {
      if (step.on) {
        const el = pick(step.on, step.nth);
        await el.waitFor({ state: 'visible', timeout: 10_000 });
        await el.fill(step.text ?? '');
      } else {
        await page.keyboard.type(step.text ?? '', { delay: 20 });
      }
      // Never echo what was typed: a flow may carry a password.
      return `typed ${String(step.text ?? '').length} characters`;
    }
    case 'press':
      await page.keyboard.press(step.key);
      return `pressed ${step.key}`;
    case 'hover':
      await pick(step.on, step.nth).hover({ timeout: 10_000 });
      return `hovered ${step.on}`;
    case 'scroll':
      if (step.to === 'bottom') await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
      else if (step.to === 'top') await page.evaluate(() => window.scrollTo(0, 0));
      else await page.locator(step.to).first().scrollIntoViewIfNeeded();
      return `scrolled to ${step.to}`;
    case 'wait':
      if (step.for) await page.locator(step.for).first().waitFor({ state: 'visible', timeout: step.timeout ?? 15_000 });
      else await page.waitForTimeout(step.ms ?? 500);
      return step.for ? `waited for ${step.for}` : `waited ${step.ms ?? 500}ms`;
    case 'expect': {
      // ABSENCE IS AN ASSERTION. A card that renders the wrong thing is still a
      // card: "no data" on a chart, "Unsupported component", an error string in
      // a panel. Only a positive check existed, so every one of those passed a
      // flow that asked whether the title was on screen — which it was.
      //
      // Deliberately not a waitForFunction: you cannot wait for something to
      // stop being true without deciding how long "never" is. It settles, then
      // looks once, which is what a human reviewer does.
      const gone = step.absent ?? step.missing;
      if (gone != null) {
        await page.waitForTimeout(step.settle ?? 400);
        const seen = await page.evaluate(
          (t) => (document.body?.innerText || '').includes(t), String(gone));
        if (seen) throw new Error(`expected "${gone}" to be absent — the page is showing it`);
        return `absent "${gone}"`;
      }
      if (step.absentSelector) {
        // WITH A TIMEOUT THIS WAITS FOR SOMETHING TO GO AWAY, which is how you
        // wait for work to FINISH: an agent run shows a thinking state, and the
        // run is over when that state is gone. Without a timeout it settles and
        // looks once, which is the "this must not be on screen" assertion.
        if (step.timeout) {
          const deadline = Date.now() + step.timeout;
          for (;;) {
            const n = await page.locator(step.absentSelector).count();
            if (n === 0) return `gone: ${step.absentSelector}`;
            if (Date.now() > deadline) {
              throw new Error(`${step.absentSelector} was still on the page after ${step.timeout}ms (${n} of them)`);
            }
            await page.waitForTimeout(1000);
          }
        }
        await page.waitForTimeout(step.settle ?? 400);
        if (await page.locator(step.absentSelector).count()) {
          throw new Error(`expected no ${step.absentSelector} — the page has one`);
        }
        return `absent ${step.absentSelector}`;
      }
      if (step.selector) {
        // HOW MANY, when the point is that several things landed. A flow that
        // asks for three cards and checks that one exists is a flow that passes
        // for the bug it was written to catch — the run that delivers only the
        // last of three looks identical to the run that delivers all three.
        const want = step.count ?? step.minCount;
        if (want != null) {
          const exact = step.count != null;
          const deadline = Date.now() + (step.timeout ?? 10_000);
          let n = 0;
          for (;;) {
            n = await page.locator(step.selector).count();
            if (exact ? n === want : n >= want) break;
            if (Date.now() > deadline) {
              throw new Error(`expected ${exact ? '' : 'at least '}${want} × ${step.selector}, found ${n}`);
            }
            await page.waitForTimeout(500);
          }
          return `saw ${n} × ${step.selector}`;
        }
        await pick(step.selector, step.nth).waitFor({ state: 'visible', timeout: step.timeout ?? 10_000 });
        return `saw ${step.selector}`;
      }
      const needle = step.text ?? '';
      await page.waitForFunction(
        (t) => (document.body?.innerText || '').includes(t),
        needle,
        { timeout: step.timeout ?? 10_000 },
      );
      return `saw "${needle}"`;
    }
    default:
      throw new Error(`unknown step "${step.do}"`);
  }
}

export async function runFlow({ browser, context: providedContext, baseUrl, flow, outDir, viewport }) {
  await mkdir(outDir, { recursive: true });

  const ownsContext = !providedContext;
  const context =
    providedContext ??
    (await browser.newContext({ viewport: viewport ?? { width: 1440, height: 900 }, deviceScaleFactor: 1 }));

  await context.addInitScript(PROBE);
  const page = context.pages()[0] ?? (await context.newPage());

  const consoleErrors = [];
  const pageErrors = [];
  // KEEP THE SOURCE. The URL is right here at capture time and was being dropped
  // one line before it was needed, so a console error could not be attributed.
  //
  // That matters for any app that HOSTS third-party code. kormo renders
  // agent-authored artifacts in sandboxed iframes: a d3 call inside one of those
  // throwing "negative value is not valid" is a defect in generated content, not
  // a regression in the app under test — but with the source discarded, the two
  // are indistinguishable and the gate fails on the wrong thing. Appended in
  // parentheses so existing substring matching on the message still works.
  page.on('console', (m) => {
    const from = m.location()?.url ?? '';
    if (m.type() !== 'error') return;
    if (/favicon\.ico/.test(`${m.text()} ${from}`)) return;
    consoleErrors.push(from ? `${m.text()}  (${from})` : m.text());
  });
  page.on('pageerror', (e) => pageErrors.push(e.message));

  const start = new URL(flow.start ?? '/', baseUrl).toString();
  await page.goto(start, { waitUntil: 'domcontentloaded', timeout: 30_000 }).catch(() => {});
  await page.waitForTimeout(400);

  const results = [];
  let failed = null;

  for (const [i, step] of (flow.steps ?? []).entries()) {
    const n = i + 1;
    const seenConsole = consoleErrors.length;
    const seenPage = pageErrors.length;
    await page.evaluate(() => window.__aynaProbeReset && window.__aynaProbeReset()).catch(() => {});

    const began = Date.now();
    let note = null;
    let target = null;
    let error = null;

    try {
      const out = await perform(page, step, baseUrl);
      if (out && typeof out === 'object') {
        note = out.note;
        target = out.target;
      } else {
        note = out;
      }
    } catch (err) {
      error = err.message.split('\n')[0];
    }

    // How long until the step is actually usable, not merely triggered.
    await settle(page, 2500);
    const settleMs = Date.now() - began;
    await page.waitForTimeout(150);

    let metrics = null;
    try {
      metrics = await page.evaluate(SNAPSHOT);
    } catch (err) {
      // Say so rather than reporting a clean run with no numbers in it.
      metrics = { unavailable: err.message.split('\n')[0] };
    }
    const file = path.join(outDir, `step-${String(n).padStart(2, '0')}.png`);
    await page.screenshot({ path: file }).catch(() => {});

    results.push({
      n,
      /*
        Redact what was typed before it is written down. The note already said only
        how many characters there were, but the step itself was stored verbatim —
        so a flow carrying a password wrote it into flow.json, where it would be
        read by anyone reviewing the run and committed by anyone versioning it.
      */
      step: step.do === 'type' ? { ...step, text: `«${String(step.text ?? '').length} characters»` } : step,
      note,
      ok: !error,
      error,
      settleMs,
      file,
      clickTarget: target,
      // A 44px minimum is the usual touch-target floor.
      smallTarget: target ? target.w < 44 || target.h < 44 : null,
      newConsoleErrors: consoleErrors.slice(seenConsole),
      newPageErrors: pageErrors.slice(seenPage),
      metrics,
    });

    if (error) {
      failed = { n, error };
      if (!step.optional) break;
    }
  }

  if (ownsContext) await context.close().catch(() => {});

  const record = {
    name: flow.name ?? 'flow',
    start,
    ranAt: outDir,
    completed: !failed,
    failedAt: failed,
    steps: results,
    totals: {
      steps: results.length,
      durationMs: results.reduce((a, r) => a + r.settleMs, 0),
      consoleErrors: consoleErrors.length,
      pageErrors: pageErrors.length,
      layoutShift: Number(results.reduce((a, r) => a + (r.metrics?.layoutShift ?? 0), 0).toFixed(4)),
    },
  };
  await writeFile(path.join(outDir, 'flow.json'), JSON.stringify(record, null, 2));
  return record;
}

/** Terse, model-readable rundown of a flow run. */
export function summarizeFlow(record) {
  const lines = [`${record.name} — ${record.steps.length} steps, ${record.completed ? 'completed' : 'FAILED'}`];
  for (const r of record.steps) {
    const m = r.metrics ?? {};
    const flags = [
      !r.ok && `FAILED: ${r.error}`,
      r.settleMs > 2000 && `slow to settle (${r.settleMs}ms)`,
      (m.layoutShift ?? 0) > 0.1 && `layout shifted ${m.layoutShift}`,
      m.focusLost && 'focus dropped to body',
      r.smallTarget && `target ${r.clickTarget.w}x${r.clickTarget.h}px (<44)`,
      m.horizontalOverflow && 'horizontal overflow',
      m.unlabelledControls > 0 && `${m.unlabelledControls} unlabelled control(s)`,
      r.newConsoleErrors.length && `${r.newConsoleErrors.length} new console error(s)`,
    ].filter(Boolean);
    lines.push(`  ${r.n}. ${r.note ?? r.step.do}${flags.length ? ' — ' + flags.join('; ') : ''}`);
    lines.push(`     ${r.file}`);
  }
  return lines.join('\n');
}
