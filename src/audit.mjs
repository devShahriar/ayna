import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

/**
 * Find layout faults the page can prove, rather than ones someone thinks they see.
 *
 * A screenshot review depends on noticing. Noticing is unreliable and it does not
 * tell you when to stop. These checks are measurements: a button whose centre
 * hit-tests to a different element is covered, full stop — and once it is not,
 * the fault is gone. That gives a self-healing loop something it otherwise lacks,
 * which is a condition under which it is finished.
 */

export const CHECKS = `(() => {
  const vw = document.documentElement.clientWidth;
  const vh = document.documentElement.clientHeight;

  const describe = (el) => {
    if (!el || !el.tagName) return null;
    if (el.id) return el.tagName.toLowerCase() + '#' + el.id;
    const cls = [...el.classList].filter((c) => c.indexOf('ayna-ov') !== 0).slice(0, 2);
    let s = el.tagName.toLowerCase() + (cls.length ? '.' + cls.join('.') : '');
    const parent = el.parentElement;
    if (parent) {
      const sibs = [...parent.children].filter((x) => x.tagName === el.tagName);
      if (sibs.length > 1) s += ':nth-of-type(' + (sibs.indexOf(el) + 1) + ')';
    }
    return s;
  };

  const label = (el) => (el.innerText || el.getAttribute('aria-label') || '').trim().slice(0, 40);
  const box = (el) => {
    const r = el.getBoundingClientRect();
    return { x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) };
  };
  const seen = (el) => {
    const st = getComputedStyle(el);
    if (st.display === 'none' || st.visibility === 'hidden' || Number(st.opacity) === 0) return false;
    const r = el.getBoundingClientRect();
    return r.width > 1 && r.height > 1;
  };
  const ours = (el) => !!(el.closest && el.closest('[data-ayna]'));
  /*
    Framework dev overlays sit on top of everything by design — Next.js's portal,
    Vite's error overlay, React Refresh. Reporting them as faults sends a fixing
    loop after the dev server instead of the app.
  */
  const DEV_CHROME = /nextjs-portal|vite-error-overlay|react-refresh|__next-build-watcher|nuxt-devtools/i;
  const devTool = (el) => {
    for (let n = el; n; n = n.parentElement || (n.getRootNode && n.getRootNode().host)) {
      if (n.tagName && DEV_CHROME.test(n.tagName)) return true;
      if (n.id && DEV_CHROME.test(n.id)) return true;
      if (n.className && typeof n.className === 'string' && DEV_CHROME.test(n.className)) return true;
    }
    return false;
  };

  /*
    Walk into shadow roots. querySelectorAll stops at the boundary, so a page built
    from web components looked completely clean — a 9px label and a 20px button
    inside a shadow root were simply not there as far as this was concerned.
  */
  const collect = (root, out) => {
    for (const el of root.querySelectorAll('*')) {
      out.push(el);
      if (el.shadowRoot) collect(el.shadowRoot, out);
    }
    return out;
  };
  const all = collect(document.body, []).filter((el) => !ours(el) && seen(el));
  const interactive = all.filter((el) =>
    /^(button|a|input|select|textarea)$/.test(el.tagName.toLowerCase()) || el.getAttribute('role') === 'button',
  );

  /* 1. Covered controls — something is sitting on top of a thing you must click. */
  const covered = [];
  for (const el of interactive) {
    const r = el.getBoundingClientRect();
    const cx = r.left + r.width / 2;
    const cy = r.top + r.height / 2;
    if (cx < 0 || cy < 0 || cx > vw || cy > vh) continue; // off screen is check 2's job
    /*
      elementFromPoint reports the host, not what is actually on top inside it, so
      a control covered by a sibling within the same component read as fine.
    */
    let hit = document.elementFromPoint(cx, cy);
    while (hit && hit.shadowRoot) {
      const deeper = hit.shadowRoot.elementFromPoint(cx, cy);
      if (!deeper || deeper === hit) break;
      hit = deeper;
    }
    if (!hit || hit === el || el.contains(hit) || hit.contains(el) || ours(hit) || devTool(hit)) continue;
    covered.push({ element: describe(el), label: label(el), coveredBy: describe(hit), rect: box(el) });
  }

  /* 2. Pushed outside the window — content you cannot reach by scrolling to it. */
  const offscreen = [];
  for (const el of all) {
    if (!el.innerText?.trim() && !interactive.includes(el)) continue;
    if (el.children.length > 6) continue; // containers, not the content itself
    const r = el.getBoundingClientRect();
    const cutRight = r.right > vw + 2 && r.left < vw;
    const cutLeft = r.left < -2 && r.right > 0;
    if (!cutRight && !cutLeft) continue;
    offscreen.push({
      element: describe(el),
      label: label(el),
      rect: box(el),
      cut: cutRight ? 'right' : 'left',
      by: Math.round(cutRight ? r.right - vw : -r.left),
    });
  }

  /*
    3. Overlapping content — two things drawn on top of each other.

    Only elements that own their text, and only partial collisions. Judging by
    innerText caught every container enclosing its own children ("header over
    ADMIN"), and full containment is nesting rather than a fault. Both filters are
    about keeping this list worth acting on: a loop that fixes what this reports
    must not be sent after things that were never wrong.
  */
  const ownText = (el) =>
    [...el.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim().length > 1);
  const candidates = all.filter((el) => {
    if (!ownText(el)) return false;
    const r = el.getBoundingClientRect();
    return r.width * r.height > 400;
  });
  const overlaps = [];
  for (let i = 0; i < candidates.length && overlaps.length < 40; i++) {
    const a = candidates[i];
    const ra = a.getBoundingClientRect();
    for (let j = i + 1; j < candidates.length; j++) {
      const b = candidates[j];
      if (a.contains(b) || b.contains(a)) continue;
      const rb = b.getBoundingClientRect();
      const w = Math.min(ra.right, rb.right) - Math.max(ra.left, rb.left);
      const h = Math.min(ra.bottom, rb.bottom) - Math.max(ra.top, rb.top);
      if (w <= 1 || h <= 1) continue;
      // One rect wholly inside the other is layout, not collision.
      const contains =
        (ra.left <= rb.left && ra.right >= rb.right && ra.top <= rb.top && ra.bottom >= rb.bottom) ||
        (rb.left <= ra.left && rb.right >= ra.right && rb.top <= ra.top && rb.bottom >= ra.bottom);
      if (contains) continue;
      const smaller = Math.min(ra.width * ra.height, rb.width * rb.height);
      const ratio = (w * h) / smaller;
      if (ratio < 0.3) continue;
      overlaps.push({
        a: describe(a),
        b: describe(b),
        labelA: label(a),
        labelB: label(b),
        overlap: Math.round(ratio * 100) + '%',
      });
      break; // one report per element is enough to act on
    }
  }

  /* 4. Text cut off by its own container. */
  const clipped = [];
  for (const el of all) {
    if (el.children.length > 2 || !(el.innerText || '').trim()) continue;
    const st = getComputedStyle(el);
    if (!/hidden|clip/.test(st.overflow + st.overflowX + st.overflowY)) continue;
    if (el.scrollWidth > el.clientWidth + 2 && st.textOverflow !== 'ellipsis') {
      clipped.push({ element: describe(el), label: label(el), by: el.scrollWidth - el.clientWidth });
    }
  }

  /* 5. The cheap accessibility floors. */
  const tinyText = all
    .filter((el) => (el.textContent || '').trim() && parseFloat(getComputedStyle(el).fontSize) < 12)
    .slice(0, 40)
    .map((el) => ({ element: describe(el), size: getComputedStyle(el).fontSize, label: label(el) }));

  const smallTargets = interactive
    .map((el) => ({ el, r: el.getBoundingClientRect() }))
    .filter(({ r }) => r.width < 44 || r.height < 44)
    .slice(0, 40)
    .map(({ el, r }) => ({ element: describe(el), label: label(el), size: Math.round(r.width) + 'x' + Math.round(r.height) }));

  const unlabelled = interactive
    .filter((el) => {
      if (el.getAttribute('aria-label') || el.getAttribute('title')) return false;
      if (el.labels && el.labels.length) return false;
      return !(el.innerText || '').trim() && !el.getAttribute('placeholder');
    })
    .slice(0, 20)
    .map((el) => ({ element: describe(el), rect: box(el) }));

  return {
    viewport: { width: vw, height: vh },
    horizontalOverflow: document.documentElement.scrollWidth > vw + 1,
    covered,
    offscreen,
    overlaps,
    clipped,
    tinyText,
    smallTargets,
    unlabelled,
  };
})()`;

/** Faults worth stopping the loop for, in the order they should be fixed. */
export const SEVERITY = [
  ['covered', 'critical', 'a control is behind something else and cannot be clicked'],
  ['offscreen', 'critical', 'content is cut off by the window edge'],
  ['overlaps', 'major', 'two elements are drawn on top of each other'],
  ['clipped', 'major', 'text is cut off by its container'],
  ['unlabelled', 'minor', 'an icon-only control has no accessible name'],
  ['smallTargets', 'minor', 'a hit target is under 44px'],
  ['tinyText', 'minor', 'text below 12px'],
];

/**
 * `steps` are performed before anything is measured.
 *
 * An audit of the page as it loads only ever sees the state it opens in. Anything
 * you have to click into — a Live view, an expanded panel, a menu — was never
 * looked at, and that is often exactly where things collide.
 */
export async function auditPage({ browser, context, url, viewports, outDir, steps = [] }) {
  await mkdir(outDir, { recursive: true });
  const findings = [];

  for (const vp of viewports) {
    const ctx =
      context ??
      (await browser.newContext({ viewport: { width: vp.width, height: vp.height }, deviceScaleFactor: 1 }));
    // A window that follows the OS window has no viewport to set — and resizing
    // the user's review out from under them would be rude anyway.
    if (context) {
      await context.pages()[0]?.setViewportSize({ width: vp.width, height: vp.height }).catch(() => {});
    }

    const page = ctx.pages()[0] ?? (await ctx.newPage());
    await page.goto(url, { waitUntil: 'networkidle', timeout: 30_000 }).catch(() => {});
    await page.waitForTimeout(700);

    const reached = [];
    for (const step of steps) {
      try {
        const { perform } = await import('./flow.mjs');
        reached.push(await perform(page, step, url));
        await page.waitForTimeout(step.settle ?? 800);
      } catch (err) {
        reached.push({ failed: step, error: err.message.split('\n')[0] });
        break; // measuring a state we failed to reach would be a lie
      }
    }
    await page.waitForLoadState('networkidle', { timeout: 8000 }).catch(() => {});

    const result = await page.evaluate(CHECKS).catch((e) => ({ unavailable: e.message }));
    const shot = path.join(outDir, `audit-${vp.name}.png`);
    await page.screenshot({ path: shot }).catch(() => {});

    findings.push({ ...result, viewport: vp.name, size: `${vp.width}x${vp.height}`, screenshot: shot, reached });
    if (!context) await ctx.close().catch(() => {});
  }

  const counted = {};
  for (const [key] of SEVERITY) counted[key] = findings.reduce((a, f) => a + (f[key]?.length ?? 0), 0);
  const report = {
    url,
    ranAt: outDir,
    counts: counted,
    clean: SEVERITY.filter(([, sev]) => sev !== 'minor').every(([key]) => counted[key] === 0),
    findings,
  };
  await writeFile(path.join(outDir, 'audit.json'), JSON.stringify(report, null, 2));
  return report;
}

export function summarizeAudit(report) {
  const lines = [];
  for (const f of report.findings) {
    lines.push(`${f.viewport} (${f.size})${f.horizontalOverflow ? ' — page scrolls sideways' : ''}`);
    for (const [key, sev, why] of SEVERITY) {
      const items = f[key] ?? [];
      if (!items.length) continue;
      lines.push(`  [${sev}] ${items.length} × ${why}`);
      for (const it of items.slice(0, 5)) {
        if (key === 'covered') lines.push(`      ${it.element} "${it.label}" is behind ${it.coveredBy}`);
        else if (key === 'offscreen') lines.push(`      ${it.element} "${it.label}" cut off ${it.cut} by ${it.by}px`);
        else if (key === 'overlaps') lines.push(`      ${it.a} "${it.labelA}" over ${it.b} "${it.labelB}" (${it.overlap})`);
        else if (key === 'clipped') lines.push(`      ${it.element} "${it.label}" clipped by ${it.by}px`);
        else lines.push(`      ${it.element}${it.size ? ' ' + it.size : ''} ${it.label ? '"' + it.label + '"' : ''}`);
      }
      if (items.length > 5) lines.push(`      …and ${items.length - 5} more`);
    }
    lines.push(`  ${f.screenshot}`);
  }
  return lines.join('\n');
}

/** Turn one raw CHECKS result into the same shape auditPage returns. */
export function scoreFindings(url, findings) {
  const counts = {};
  for (const [key] of SEVERITY) counts[key] = findings.reduce((a, f) => a + (f[key]?.length ?? 0), 0);
  return {
    url,
    counts,
    clean: SEVERITY.filter(([, sev]) => sev !== 'minor').every(([key]) => counts[key] === 0),
    findings,
  };
}
