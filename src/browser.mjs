import { chromium } from 'playwright-core';
import { mkdir } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

/**
 * Launches the Chrome already installed on this machine (playwright-core does not
 * download its own browser). Headed by default so you can watch the loop work.
 */
/*
  Is this a container?

  The sandbox flags were gated on CI alone, which is true of a CI runner and of
  nothing else — so anyone running ayna in a container had to claim to be CI to
  get Chrome to start as root. That is a lie in an environment variable, and the
  sort that quietly changes other tools' behaviour too. Ask the machine instead.
*/
function inContainer() {
  if (process.env.AYNA_NO_SANDBOX === '1') return true;
  /*
    Linux only. The sandbox works fine for an ordinary user on macOS and Windows,
    and passing --no-sandbox there buys nothing while making Chrome show a yellow
    "unsupported command-line flag" bar across the top of the window — which is
    both alarming and, in a review window, a strip of the page you were trying to
    look at.
  */
  if (process.platform !== 'linux') return false;
  if (existsSync('/.dockerenv') || existsSync('/run/.containerenv')) return true;
  try {
    // The classic tell, and still the most portable one.
    return /docker|containerd|kubepods|lxc/.test(readFileSync('/proc/1/cgroup', 'utf8'));
  } catch {
    return false;
  }
}

/**
 * Which browser to drive.
 *
 * `chrome` means real Google Chrome, which is around 400MB of image for a
 * container that only needs to render a page. `chromium` is a tenth of that and
 * renders the same. Neither is right for everybody, so it is a setting.
 */
export const chromeChannel = () => process.env.AYNA_CHROME_CHANNEL || 'chrome';

export function launchArgs() {
  const args = ['--hide-scrollbars', '--force-color-profile=srgb'];
  /*
    Root inside a container cannot use Chrome's sandbox, and the default /dev/shm
    there is 64MB — far too small, which shows up as tabs dying at random rather
    than as anything that says "shared memory".
  */
  if (process.env.CI || inContainer()) args.push('--no-sandbox', '--disable-dev-shm-usage');
  return args;
}

/** Say which channel was missing, rather than reporting a generic launch failure. */
function launchFailed(err, channel) {
  if (/executable doesn't exist|Failed to launch|ENOENT|not found/i.test(err.message)) {
    return new Error(
      `could not start "${channel}". playwright-core downloads no browser — install one, ` +
        `or set AYNA_CHROME_CHANNEL (chrome, chromium, msedge).\n  ${err.message.split('\n')[0]}`,
    );
  }
  return err;
}

export async function openBrowser({ headless = false, channel = chromeChannel() } = {}) {
  try {
    return await chromium.launch({ channel, headless, args: launchArgs() });
  } catch (err) {
    throw launchFailed(err, channel);
  }
}

/*
  Wait for the page, not for the network to stop.

  Every load here used to wait for `networkidle`, which means 500ms with nothing in
  flight. Plenty of real apps never have that: anything that polls an endpoint, or
  holds a long-poll open for hot reload, keeps a request outstanding forever. On
  those, `networkidle` does not settle late — it never settles, so every load ran to
  the full 30s timeout. Measured against an app polling every 400ms: 30049ms with
  networkidle, 222ms without. That is the freeze people describe as the window
  hanging, and on the one call site with no `.catch()` it was a hard error at the
  end of the wait.

  So: wait for the document, then give the network a bounded chance to go quiet.
  A quiet page still gets its images and fonts; a busy one costs a fixed pause
  instead of half a minute.
*/
const SETTLE_MS = 1500;

export async function settle(page, ms = SETTLE_MS) {
  await page.waitForLoadState('networkidle', { timeout: ms }).catch(() => {});
}

/** `goto` that is fast on apps which never go idle. Throws what `goto` throws. */
export async function gotoSettled(page, url, { timeout = 30_000, settleMs = SETTLE_MS } = {}) {
  const res = await page.goto(url, { waitUntil: 'domcontentloaded', timeout });
  await settle(page, settleMs);
  return res;
}

/** `reload` with the same bounded wait. */
export async function reloadSettled(page, { timeout = 30_000, settleMs = SETTLE_MS } = {}) {
  const res = await page.reload({ waitUntil: 'domcontentloaded', timeout });
  await settle(page, settleMs);
  return res;
}

/**
 * Loads `url` at each viewport, screenshots it, and collects the diagnostics a
 * screenshot alone cannot show: console errors, horizontal overflow, blank renders.
 *
 * `watchMs` KEEPS WATCHING AFTER THE SHOT. A screenshot is one frame, so the
 * observation window is ~3.1s (settle 2500 + 600); anything that throws later is
 * invisible. MEASURED 14 Sep 2026: two agent-authored cards reached a live canvas
 * and threw on a LATE animation frame — a canvas gradient handed
 * `rgba(56,217,196,aa` to addColorStop, and a d3 tick referencing an undefined
 * `nRaw_x` at line 480 — inside a loop the card itself declared as 24 seconds
 * long. Both were reported to the agent as rendered. Pass a window that covers
 * the animation and the error lands in `consoleErrors`/`pageErrors` like any
 * other, because the handlers below stay attached for the life of the page.
 */
export async function capture({ browser, url, viewports, outDir, label, watchMs = 0 }) {
  await mkdir(outDir, { recursive: true });
  const shots = [];
  const consoleErrors = [];
  const pageErrors = [];

  for (const vp of viewports) {
    const context = await browser.newContext({
      viewport: { width: vp.width, height: vp.height },
      deviceScaleFactor: 2,
    });
    const page = await context.newPage();

    page.on('console', (msg) => {
      // A missing favicon is not a UI defect; it would just add noise to every run.
      // For network failures the URL is on location(), not in the message text.
      const text = msg.text();
      const from = msg.location()?.url ?? '';
      if (msg.type() === 'error' && !/favicon\.ico/.test(`${text} ${from}`)) {
        consoleErrors.push(`[${vp.name}] ${text}`);
      }
    });
    page.on('pageerror', (err) => pageErrors.push(`[${vp.name}] ${err.message}`));

    let loadError = null;
    let transportError = false;
    try {
      await gotoSettled(page, url, { settleMs: 2500 });
    } catch (err) {
      loadError = err.message;
      // The server being unreachable is our problem, not the page's. Callers must
      // not read this as "the edit broke the UI" — that would revert good work.
      transportError = /ERR_CONNECTION_REFUSED|ERR_CONNECTION_RESET|ERR_EMPTY_RESPONSE|ERR_NAME_NOT_RESOLVED|Timeout \d+ms exceeded/i.test(
        err.message,
      );
    }
    // Let fonts settle and any entrance animation finish before the shot.
    await page.waitForTimeout(600);

    const metrics = await page
      .evaluate(() => {
        const doc = document.documentElement;
        const text = document.body?.innerText ?? '';
        const tiny = [...document.querySelectorAll('body *')].filter((el) => {
          const fs = parseFloat(getComputedStyle(el).fontSize);
          return el.textContent?.trim() && fs > 0 && fs < 12;
        }).length;
        return {
          title: document.title,
          textLength: text.trim().length,
          elementCount: document.querySelectorAll('body *').length,
          scrollWidth: doc.scrollWidth,
          clientWidth: doc.clientWidth,
          horizontalOverflow: doc.scrollWidth > doc.clientWidth + 1,
          tinyTextNodes: tiny,
          hasCustomFont: !/^(Times|serif)/i.test(getComputedStyle(document.body).fontFamily),
        };
      })
      .catch(() => null);

    const file = path.join(outDir, `${label}-${vp.name}.png`);
    await page.screenshot({ path: file, fullPage: true });

    shots.push({
      viewport: vp.name,
      width: vp.width,
      height: vp.height,
      file,
      metrics,
      loadError,
      transportError,
    });
    // The dwell. Deliberately AFTER the screenshot and the metrics: this is only
    // about catching what a loop throws on a frame nobody photographed, and it
    // must not delay or alter the picture itself.
    if (watchMs > 0) {
      await page.waitForTimeout(Math.floor(watchMs / 2));

      // HIDE AND SHOW THE PAGE, because a viewer will.
      //
      // An animated card almost always pauses itself when the tab goes away and
      // resumes when it comes back — that handler is ordinary, and it is also
      // where a whole class of bug lives, because it runs on a path a passive
      // watcher never takes. MEASURED 14 Sep 2026: a card shipped with
      //
      //   document.addEventListener('visibilitychange', () => {
      //     if (document.hidden) { t.stop(); } else { t.restart(); }
      //   });
      //
      // and d3's timer.restart() REQUIRES a callback, so returning to the tab
      // threw `TypeError: callback is not a function`. The gate had watched the
      // card for seconds and seen nothing, because it never left and came back.
      // The person saw it immediately — switching tabs is the most ordinary
      // thing a viewer does.
      //
      // document.hidden is a read-only accessor on the prototype, so it is
      // overridden rather than assigned, and put back afterwards: a page left
      // believing it is hidden would stop animating for every later check.
      await page
        .evaluate(async () => {
          const proto = Object.getPrototypeOf(document);
          const real = Object.getOwnPropertyDescriptor(proto, 'hidden');
          const fake = (v) =>
            Object.defineProperty(document, 'hidden', { configurable: true, get: () => v });
          const settle = () => new Promise((r) => setTimeout(r, 150));

          fake(true);
          document.dispatchEvent(new Event('visibilitychange'));
          await settle();
          fake(false);
          document.dispatchEvent(new Event('visibilitychange'));
          await settle();

          // Hand `hidden` back to the browser.
          delete document.hidden;
          if (real && !Object.getOwnPropertyDescriptor(document, 'hidden')) {
            Object.defineProperty(proto, 'hidden', real);
          }
        })
        // A page that refuses to be poked is not a failing page. Whatever it
        // throws lands in pageErrors through the handler above, which is the
        // point; this catch only stops the harness itself from falling over.
        .catch(() => {});

      await page.waitForTimeout(Math.ceil(watchMs / 2));
    }

    await context.close();
  }

  return {
    label,
    url,
    shots,
    consoleErrors,
    pageErrors,
    // A page that renders almost nothing is broken, not minimal.
    blank: shots.every((s) => (s.metrics?.textLength ?? 0) < 20),
  };
}

/**
 * A Chrome that remembers. Reviews of anything behind a login are miserable if
 * every run starts logged out, so cookies live in `profileDir` between sessions —
 * exactly like a normal browser profile. Ayna never sees or stores the
 * credentials themselves; the user types them into their own app.
 */
export async function openPersistentContext({
  profileDir,
  headless = false,
  viewport,
  followWindow,
  maximized,
  channel = chromeChannel(),
} = {}) {
  await mkdir(profileDir, { recursive: true });
  const args = launchArgs();

  const size = viewport ?? { width: 1440, height: 900 };
  /*
    Open at the size of the screen, not at a guess.

    1440x900 was a default chosen when the window was a preview; as the place you
    actually work on your app it is a small box in the corner of a large display,
    and every session began by resizing it — which, before the reservation
    learned to re-measure, was also the moment the page stopped filling the
    window. Starting maximised removes both the resize and the reason for it.

    Not `--start-fullscreen`: that takes the whole screen and hides the tab strip
    and the address bar, and a review window with no visible browser chrome is
    disorienting and hard to get out of. Maximised fills the display and stays a
    window. AYNA_WINDOW=1440x900 pins a size for anyone who wants one.
  */
  /*
    Only a window that follows the window should be maximised. A context that
    measures pins its viewport on purpose (followWindow: false), and opening it
    at screen size would mean reporting numbers for a page rendered at one size
    inside a window of another — the confusion that once labelled a 1440px audit
    "mobile".
  */
  const follows = followWindow ?? !headless;
  const fill = maximized ?? follows;

  if (!headless) {
    const pinned = /^(\d+)x(\d+)$/.exec(process.env.AYNA_WINDOW ?? '');
    if (pinned) args.push(`--window-size=${pinned[1]},${pinned[2]}`);
    else if (fill) args.push('--start-maximized');
    else args.push(`--window-size=${size.width},${size.height}`);
  }

  try {
    return await chromium.launchPersistentContext(profileDir, {
      channel,
      headless,
      /*
        A headed window must follow the window.

        A fixed viewport is pinned at launch, so going full screen left the page
        rendering at its original size with dead space around it — the app never
        learns it got bigger. null lets the page track the real window, which is
        what a person resizing it expects. Headless keeps a fixed viewport, because
        a screenshot has to be the same size every time to be comparable.
      */
      /*
        A review window follows the OS window; a measurement does not.

        Following is right for annotate — the user resizes it and the page should
        keep up. It is wrong for anything that reports a number, because a
        window-following page cannot be set to a viewport, so a headed audit
        measured every viewport at whatever size the window happened to be and
        labelled the results "mobile" and "desktop" regardless. Callers that
        measure pass followWindow: false and get the size they asked for.
      */
      viewport: follows ? null : size,
      // Playwright refuses deviceScaleFactor alongside a null viewport, and a null
      // viewport is the whole point of a window the user can resize — so it only
      // applies to the fixed-size headless case.
      ...(follows ? {} : { deviceScaleFactor: 1 }),
      args,
    });
  } catch (err) {
    throw launchFailed(err, channel);
  }
}

/** "/" → home, "/pricing" → pricing, "/docs/intro" → docs-intro */
export function routeSlug(route) {
  const clean = String(route).split('?')[0].split('#')[0].replace(/^\/+|\/+$/g, '');
  return clean ? clean.replace(/[^\w-]+/g, '-').toLowerCase() : 'home';
}

/**
 * Capture several routes of the same site in one pass.
 *
 * A single screenshot of the landing page says nothing about the pricing table or
 * the settings screen. Every shot carries the `route` it came from so the caller
 * can tell them apart, and the result keeps the flat `shots` shape of `capture()`
 * so single-route callers see no difference.
 */
/**
 * renderPDF — the page as a PDF, printed the way a person would see it.
 *
 * WHY THIS EXISTS. kormo's deck export was a browser `window.print()` from the
 * canvas, which means the file lands in the person's Downloads and the agent
 * that just built the deck cannot attach it to anything. MEASURED 14 Sep 2026:
 * the whole chain "import a slide → edit → research → draft → email it" breaks
 * at exactly that step, with six of its eight parts already working.
 *
 * `printBackground: true` is the entire reason the exported PDF looked wrong.
 * Chrome drops background colours when printing unless it is asked not to, so a
 * dark deck came out as white paper with its light text still light — legible
 * as grey smudges, if at all. The canvas sets the background; the printer threw
 * it away.
 *
 * No margin and an explicit page size, because a slide is not a letter: the
 * caller states the geometry it composed for and gets that geometry back.
 */
/**
 * whyBlank — a rendered page that shows nothing, and the REASON.
 *
 * WHY THIS EXISTS. "The card is blank" is not actionable, and it is all any
 * checker here has ever said. MEASURED 14 Sep 2026 on a card a person watched an
 * agent fail to fix across several rounds:
 *
 *   - no JavaScript errors at all
 *   - 85 elements and 1,353 characters of text in the DOM
 *   - every row computed opacity:1, visibility:visible, a real bounding rect
 *   - and nothing painted
 *
 * The cause was three lines of CSS compounding: every row was position:absolute,
 * so the section had no in-flow content and computed to 1100x0; the wrapper was
 * height:100% of that zero, and overflow:hidden clipped the lot. The reveal
 * animation ran perfectly into a container with no height.
 *
 * NONE OF THAT IS VISIBLE IN THE SOURCE. An agent reading its own HTML sees a
 * correct document, concludes it is fixed, and says so — which is exactly what
 * happened, repeatedly. It needs a browser to compute the layout, and then it
 * needs to be TOLD the shape of the problem rather than handed a black square.
 *
 * Reports the first cause that explains the blankness, most specific first.
 */
export async function whyBlank(page) {
  return page.evaluate(() => {
    const reasons = [];
    const box = (e) => e.getBoundingClientRect();
    const vis = (e) => getComputedStyle(e);

    // A container that holds text but has no height clips everything inside it —
    // the single most common way a correct-looking document renders as nothing.
    const collapsed = [...document.querySelectorAll('body *')].filter((e) => {
      const r = box(e);
      const hasText = (e.textContent || '').trim().length > 20;
      return hasText && r.width > 50 && r.height < 2;
    });
    for (const e of collapsed.slice(0, 3)) {
      const c = vis(e);
      const kids = [...e.children];
      const allAbs = kids.length > 0 && kids.every((k) => {
        const p = vis(k).position;
        return p === 'absolute' || p === 'fixed';
      });
      reasons.push(
        `<${e.tagName.toLowerCase()}${e.className ? '.' + String(e.className).trim().split(/\s+/)[0] : ''}> holds text but computes to ` +
        `${Math.round(box(e).width)}x${Math.round(box(e).height)}` +
        (c.overflow === 'hidden' || c.overflowY === 'hidden' ? ', and overflow is hidden so its contents are clipped' : '') +
        (allAbs ? `. All ${kids.length} of its children are position:absolute, so nothing gives it height` : '') +
        (c.height === '100%' || c.height === '0px' ? `. Its height is ${c.height}, which needs an ancestor with a real height to resolve against` : '')
      );
    }

    // Everything faded out and left that way — an entrance animation that never
    // ran, or ran while the element was not being observed.
    const withText = [...document.querySelectorAll('body *')].filter((e) => (e.textContent || '').trim().length > 10);
    const faded = withText.filter((e) => Number(vis(e).opacity) === 0);
    if (faded.length && faded.length >= withText.length * 0.6) {
      reasons.push(`${faded.length} of ${withText.length} elements carrying text are opacity:0 — an entrance animation has not run`);
    }

    // Laid out somewhere nobody is looking.
    const off = withText.filter((e) => {
      const r = box(e);
      return r.width > 0 && r.height > 0 && (r.bottom < 0 || r.right < 0 || r.top > innerHeight * 3);
    });
    if (off.length && off.length >= withText.length * 0.6) {
      reasons.push(`${off.length} of ${withText.length} elements carrying text are positioned outside the viewport`);
    }

    // Ink the colour of the paper.
    const bg = vis(document.body).backgroundColor;
    const sameInk = withText.filter((e) => vis(e).color === bg && bg !== 'rgba(0, 0, 0, 0)');
    if (sameInk.length && sameInk.length >= withText.length * 0.6) {
      reasons.push(`${sameInk.length} elements draw their text in ${bg}, the same colour as the background`);
    }

    return {
      textLength: (document.body.innerText || '').trim().length,
      elementCount: document.querySelectorAll('body *').length,
      reasons,
    };
  });
}

export async function renderPDF({ browser, url, width = 1280, height = 720, settleMs = 2500, waitMs = 600 }) {
  const context = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: 2 });
  const page = await context.newPage();
  const consoleErrors = [];
  const pageErrors = [];
  page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text()); });
  page.on('pageerror', (e) => pageErrors.push(e.message));
  try {
    await gotoSettled(page, url, { settleMs });
    // Fonts and any entrance animation, exactly as the screenshot path waits.
    await page.waitForTimeout(waitMs);
    const buf = await page.pdf({
      printBackground: true,
      width: `${width}px`,
      height: `${height}px`,
      margin: { top: '0', right: '0', bottom: '0', left: '0' },
      pageRanges: '1',
    });
    return { ok: true, pdf: buf.toString('base64'), bytes: buf.length, consoleErrors, pageErrors };
  } catch (err) {
    // A page that would not load is the caller's problem to report, not ours to
    // paper over with an empty file that looks like a successful export.
    return { ok: false, error: err.message, consoleErrors, pageErrors };
  } finally {
    await context.close();
  }
}

export async function captureRoutes({ browser, baseUrl, routes = ['/'], viewports, outDir, label, watchMs = 0 }) {
  const shots = [];
  const consoleErrors = [];
  const pageErrors = [];
  const pages = [];

  for (const route of routes) {
    const url = new URL(route, baseUrl).toString();
    const cap = await capture({
      browser,
      url,
      viewports,
      outDir,
      watchMs,
      label: routes.length > 1 ? `${label}-${routeSlug(route)}` : label,
    });

    for (const shot of cap.shots) shots.push({ ...shot, route, url });
    consoleErrors.push(...cap.consoleErrors.map((e) => `${route} ${e}`));
    pageErrors.push(...cap.pageErrors.map((e) => `${route} ${e}`));
    pages.push({ route, url, blank: cap.blank });
  }

  return {
    label,
    url: baseUrl,
    routes,
    pages,
    shots,
    consoleErrors,
    pageErrors,
    blank: pages.every((p) => p.blank),
  };
}

/** Compact, model-readable summary of a capture. */
export function summarize(cap) {
  const lines = [];
  for (const s of cap.shots) {
    const m = s.metrics ?? {};
    lines.push(
      `- ${s.route ? `${s.route} ` : ''}${s.viewport} (${s.width}x${s.height}): ${s.file}` +
        (s.loadError ? ` — LOAD ERROR: ${s.loadError}` : '') +
        (m.horizontalOverflow ? ` — horizontal overflow (${m.scrollWidth}px > ${m.clientWidth}px)` : '') +
        (m.tinyTextNodes ? ` — ${m.tinyTextNodes} element(s) with font-size < 12px` : ''),
    );
  }
  if (cap.consoleErrors.length) lines.push(`- console errors: ${cap.consoleErrors.join(' | ')}`);
  if (cap.pageErrors.length) lines.push(`- page errors: ${cap.pageErrors.join(' | ')}`);
  return lines.join('\n');
}
