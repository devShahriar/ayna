import { gotoSettled, settle } from './browser.mjs';
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
  // innerWidth/innerHeight are the viewport in both standards and quirks mode;
  // documentElement.clientHeight returns the *content* height without a doctype,
  // which made every off-screen and covered check silently pass on such a page.
  const vw = Math.round(window.visualViewport ? window.visualViewport.width : window.innerWidth);
  const vh = Math.round(window.visualViewport ? window.visualViewport.height : window.innerHeight);

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

  /*
    6. Text nobody can read.

    Contrast is the one piece of visual taste that is not taste: WCAG puts a
    number on it, and the page can prove whether it meets it. 4.5:1 for body
    text, 3:1 for large text (24px, or 18.66px when bold).

    Two deliberate refusals to guess. A translucent foreground is composited over
    whatever is behind it, and a background image or gradient has no single
    colour to compare against — in both cases the honest answer is that this
    cannot be measured here, so the element is skipped rather than reported on a
    number that was invented.
  */
  /*
    Built from strings, for the same reason AUTH_PATH above is.

    This whole script lives in a template literal, which eats a backslash before
    it ever reaches the browser. Written as regex literals these matched nothing,
    every colour parsed as null, and the contrast check reported zero problems on
    a page of grey-on-white text — a perfect score because it never ran. Escaping
    harder just moves the problem: the fix is to need no backslashes at all, so
    [(] rather than \\(, and an explicit separator class rather than \\s.
  */
  const RGB = new RegExp('rgba?[(]([^)]+)[)]');
  const SEP = new RegExp('[ ,/]+');

  const parseRGB = (value) => {
    const m = RGB.exec(value || '');
    if (!m) return null;
    const parts = m[1].split(SEP).filter(Boolean).map(Number);
    if (parts.length < 3 || parts.some(Number.isNaN)) return null;
    return { r: parts[0], g: parts[1], b: parts[2], a: parts.length > 3 ? parts[3] : 1 };
  };

  const luminance = (c) => {
    const chan = (v) => {
      const x = v / 255;
      return x <= 0.03928 ? x / 12.92 : Math.pow((x + 0.055) / 1.055, 2.4);
    };
    return 0.2126 * chan(c.r) + 0.7152 * chan(c.g) + 0.0722 * chan(c.b);
  };

  const ratio = (a, b) => {
    const la = luminance(a);
    const lb = luminance(b);
    return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
  };

  /** The first ancestor that actually paints something behind this text. */
  const backdrop = (el) => {
    for (let n = el; n && n.nodeType === 1; n = n.parentElement) {
      const st = getComputedStyle(n);
      if (st.backgroundImage && st.backgroundImage !== 'none') return null; // unmeasurable
      const bg = parseRGB(st.backgroundColor);
      if (bg && bg.a === 1) return bg;
      if (bg && bg.a > 0) return null; // partly transparent: composited, so skip
    }
    const body = parseRGB(getComputedStyle(document.body).backgroundColor);
    return body && body.a === 1 ? body : { r: 255, g: 255, b: 255 };
  };

  const lowContrast = [];
  for (const el of all) {
    if (lowContrast.length >= 30) break;
    if (!ownText(el)) continue;
    const st = getComputedStyle(el);
    const fg = parseRGB(st.color);
    if (!fg || fg.a < 1) continue;
    const bg = backdrop(el);
    if (!bg) continue;

    const size = parseFloat(st.fontSize) || 16;
    const weight = Number(st.fontWeight) || 400;
    const large = size >= 24 || (size >= 18.66 && weight >= 700);
    const need = large ? 3 : 4.5;
    const got = ratio(fg, bg);
    if (got >= need) continue;

    lowContrast.push({
      element: describe(el),
      label: label(el),
      ratio: Math.round(got * 100) / 100,
      needs: need,
      size: Math.round(size),
      color: st.color,
      background: 'rgb(' + bg.r + ', ' + bg.g + ', ' + bg.b + ')',
    });
  }

  /*
    A sign-in wall is not a layout report.

    Auditing a login screen produces findings about a login screen — technically
    true, useless, and it hides that the thing you asked about was never reached.
    Say so instead, so the caller can get past it rather than acting on the wrong
    page.
  */
  // Built from a string, not a literal: this whole script lives in a template
  // literal, which eats the backslash in an escaped slash and leaves a regex that
  // terminates early.
  const AUTH_PATH = new RegExp('(^|/)(sign-?in|log-?in|auth|sso|oauth)(/|$)', 'i');
  const signIn = !!document.querySelector('input[type=password]') || AUTH_PATH.test(location.pathname);

  return {
    viewport: { width: vw, height: vh },
    blocked: signIn ? 'authentication' : null,
    horizontalOverflow: document.documentElement.scrollWidth > vw + 1,
    covered,
    offscreen,
    overlaps,
    clipped,
    tinyText,
    smallTargets,
    unlabelled,
    lowContrast,
  };
})()`;

/**
 * Can you see where you are, if you are using a keyboard?
 *
 * A control with `outline: none` and nothing put back is invisible to anyone
 * tabbing through the page — they are somewhere, and there is no way to know
 * where. It is one of the most common failures in AI-written CSS, because
 * removing the default outline tidies up a screenshot and the cost only shows up
 * when you stop using a mouse.
 *
 * This is deliberately NOT part of CHECKS, and that is the whole design.
 * Measuring a focus indicator means moving focus, and moving focus in a window
 * somebody is using is exactly the sort of thing this tool has spent its life
 * fixing: it fires the app's own focus handlers, opens menus, and puts the caret
 * somewhere the user did not ask for. So it runs only where ayna owns the page,
 * and the live-window audit does without it.
 *
 * `:focus-visible` only matches when the browser thinks focus arrived by
 * keyboard, so the caller presses Tab once first to establish that; programmatic
 * focus after that matches, and styles written the modern way are seen.
 */
export const FOCUS_CHECKS = `(() => {
  const RGB = new RegExp('rgba?[(]([^)]+)[)]');
  const SEP = new RegExp('[ ,/]+');
  const parseRGB = (value) => {
    const m = RGB.exec(value || '');
    if (!m) return null;
    const parts = m[1].split(SEP).filter(Boolean).map(Number);
    if (parts.length < 3 || parts.some(Number.isNaN)) return null;
    return { r: parts[0], g: parts[1], b: parts[2], a: parts.length > 3 ? parts[3] : 1 };
  };
  const luminance = (c) => {
    const chan = (v) => {
      const x = v / 255;
      return x <= 0.03928 ? x / 12.92 : Math.pow((x + 0.055) / 1.055, 2.4);
    };
    return 0.2126 * chan(c.r) + 0.7152 * chan(c.g) + 0.0722 * chan(c.b);
  };
  const ratio = (a, b) => {
    const la = luminance(a), lb = luminance(b);
    return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
  };

  const describe = (el) => {
    if (el.id) return el.tagName.toLowerCase() + '#' + el.id;
    const cls = [...el.classList].filter((c) => c.indexOf('ayna-ov') !== 0).slice(0, 2);
    return el.tagName.toLowerCase() + (cls.length ? '.' + cls.join('.') : '');
  };
  const ours = (el) => !!(el.closest && el.closest('[data-ayna]'));
  const visible = (el) => {
    const st = getComputedStyle(el);
    if (st.display === 'none' || st.visibility === 'hidden' || Number(st.opacity) === 0) return false;
    const r = el.getBoundingClientRect();
    return r.width > 1 && r.height > 1;
  };

  /* Everything that could distinguish focused from not. */
  const snap = (el) => {
    const st = getComputedStyle(el);
    return {
      outlineStyle: st.outlineStyle,
      outlineWidth: st.outlineWidth,
      outlineColor: st.outlineColor,
      outlineOffset: st.outlineOffset,
      boxShadow: st.boxShadow,
      border: st.borderTopWidth + st.borderTopColor + st.borderTopStyle,
      background: st.backgroundColor,
      backgroundImage: st.backgroundImage,
      color: st.color,
      textDecoration: st.textDecorationLine + st.textDecorationColor,
      filter: st.filter,
      transform: st.transform,
    };
  };

  const SELECTOR = 'a[href], button, input, select, textarea, [tabindex], [role=button], [contenteditable=true]';
  const candidates = [...document.querySelectorAll(SELECTOR)]
    .filter((el) => !ours(el) && visible(el) && !el.disabled && el.tabIndex > -1)
    .slice(0, 60);

  const restore = document.activeElement;
  const invisible = [];
  const faint = [];

  for (const el of candidates) {
    const before = snap(el);
    try {
      el.focus({ preventScroll: true });
    } catch {
      continue;
    }
    if (document.activeElement !== el) continue; // it refused focus; not a finding
    const after = snap(el);
    try {
      el.blur();
    } catch {
      /* nothing to do; the next focus replaces it anyway */
    }

    const changed = Object.keys(after).filter((k) => after[k] !== before[k]);
    const outlined = after.outlineStyle !== 'none' && parseFloat(after.outlineWidth) > 0;

    if (!changed.length && !outlined) {
      invisible.push({ element: describe(el), label: (el.innerText || el.value || el.getAttribute('aria-label') || '').trim().slice(0, 40) });
      continue;
    }

    /*
      An indicator that exists but cannot be seen is barely better than none.
      Only judged when the outline is a solid colour over a solid background —
      a shadow, a gradient or a translucent ring has no single pair of colours to
      compare, and a made-up number is worse than silence.
    */
    if (outlined && changed.length && !after.backgroundImage.includes('gradient')) {
      const ring = parseRGB(after.outlineColor);
      const behind = parseRGB(after.background);
      if (ring && ring.a === 1 && behind && behind.a === 1) {
        const got = ratio(ring, behind);
        if (got < 3) {
          faint.push({
            element: describe(el),
            ratio: Math.round(got * 100) / 100,
            needs: 3,
            outline: after.outlineColor,
            against: after.background,
          });
        }
      }
    }
  }

  if (restore && restore.focus) {
    try {
      restore.focus({ preventScroll: true });
    } catch {
      /* the element may have gone; nothing depends on this succeeding */
    }
  }

  return { noFocusIndicator: invisible, faintFocusIndicator: faint, focusChecked: candidates.length };
})()`;

/** Faults worth stopping the loop for, in the order they should be fixed. */
export const SEVERITY = [
  ['covered', 'critical', 'a control is behind something else and cannot be clicked'],
  ['offscreen', 'critical', 'content is cut off by the window edge'],
  ['overlaps', 'major', 'two elements are drawn on top of each other'],
  ['clipped', 'major', 'text is cut off by its container'],
  ['lowContrast', 'major', 'text does not meet the WCAG contrast minimum'],
  ['noFocusIndicator', 'major', 'a keyboard user cannot see where they are'],
  ['faintFocusIndicator', 'minor', 'the focus ring is under 3:1 against its background'],
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
    /*
      Do not touch the size of a window someone handed us.

      The comment here used to say resizing the user's review out from under them
      would be rude, and the line under it did exactly that. It was worse than
      rude: `setViewportSize` on a window-following page converts it to a fixed
      viewport, so the window stopped tracking the OS window for the rest of the
      session — the bug we had already fixed once, reintroduced by whichever audit
      ran next. An audit of a live window measures the size it is actually being
      used at, and reports that size rather than the one that was asked for.
    */

    const page = ctx.pages()[0] ?? (await ctx.newPage());
    await gotoSettled(page, url, { settleMs: 2500 }).catch(() => {});
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
    await settle(page, 2500);

    const result = await page.evaluate(CHECKS).catch((e) => ({ unavailable: e.message.split('\n')[0] }));

    /*
      Focus is measured here and nowhere else.

      Finding out whether a focus ring exists means putting focus on things, which
      fires the app's own handlers, opens menus and moves the caret. That is fine
      on a page ayna has just navigated for the purpose, and unacceptable in a
      window somebody is reviewing in — the same class of rudeness as resizing it.

      The separation is structural rather than conditional: FOCUS_CHECKS is not
      part of CHECKS, and the live-window audit in annotate evaluates CHECKS
      directly, so it cannot run this even by accident. Gating on `context` was
      the first attempt and was wrong — a context here is usually the saved login
      profile that ayna opened itself, so that rule quietly switched the check off
      for every app behind a sign-in.

      The Tab press is not decoration: `:focus-visible` matches only when the
      browser believes focus arrived from the keyboard, so without it every page
      that styles focus the modern way reads as having no indicator at all.
    */
    let focus = {};
    if (!result.blocked) {
      await page.keyboard.press('Tab').catch(() => {});
      focus = await page
        .evaluate(FOCUS_CHECKS)
        .catch((e) => ({ unavailable: e.message.split('\n')[0] }));
    }
    Object.assign(result, focus);
    const shot = path.join(outDir, `audit-${vp.name}.png`);
    await page.screenshot({ path: shot }).catch(() => {});

    // The size we asked for and the size it ran at are the same thing only when we
    // opened the window ourselves. Report what was measured, or a finding gets
    // filed against a width the page never had.
    const ran = await page.evaluate(() => `${innerWidth}x${innerHeight}`).catch(() => null);
    findings.push({
      ...result,
      viewport: vp.name,
      size: ran ?? `${vp.width}x${vp.height}`,
      screenshot: shot,
      reached,
    });
    if (!context) await ctx.close().catch(() => {});
  }

  const counted = {};
  for (const [key] of SEVERITY) counted[key] = findings.reduce((a, f) => a + (f[key]?.length ?? 0), 0);
  const blocked = findings.find((f) => f.blocked)?.blocked ?? null;
  /*
    An audit that could not run is not an audit that found nothing.

    Every count came back zero because nothing was measured, and zero faults reads
    as a clean page — so a broken check reported the same result as a healthy UI.
    Anything that failed to measure has to be louder than anything it might have
    found.
  */
  const unmeasured = findings.filter((f) => f.unavailable);
  const report = {
    url,
    ranAt: outDir,
    // Nothing measured here is worth acting on until this is dealt with.
    blocked,
    unmeasured: unmeasured.map((f) => ({ viewport: f.viewport, error: f.unavailable })),
    counts: counted,
    clean:
      !blocked &&
      unmeasured.length === 0 &&
      SEVERITY.filter(([, sev]) => sev !== 'minor').every(([key]) => counted[key] === 0),
    findings,
  };
  await writeFile(path.join(outDir, 'audit.json'), JSON.stringify(report, null, 2));
  return report;
}

export function summarizeAudit(report) {
  const lines = [];
  for (const f of report.unmeasured ?? []) {
    lines.push(`COULD NOT MEASURE ${f.viewport}: ${f.error}`);
    lines.push('Treat this as unknown, not as clean.');
    lines.push('');
  }
  if (report.blocked === 'authentication') {
    lines.push('Stopped at a sign-in screen — nothing past it has been measured.');
    lines.push('Run `ayna login` and sign in yourself; the session is remembered afterwards.');
    lines.push('');
  }
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
  const blocked = findings.find((f) => f.blocked)?.blocked ?? null;
  const unmeasured = findings.filter((f) => f.unavailable);
  return {
    url,
    blocked,
    unmeasured: unmeasured.map((f) => ({ viewport: f.viewport, error: f.unavailable })),
    counts,
    // Same rule as auditPage: unknown is not clean.
    clean:
      !blocked &&
      unmeasured.length === 0 &&
      SEVERITY.filter(([, sev]) => sev !== 'minor').every(([key]) => counts[key] === 0),
    findings,
  };
}
