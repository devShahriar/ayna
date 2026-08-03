import { chromium } from 'playwright-core';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';

/**
 * Launches the Chrome already installed on this machine (playwright-core does not
 * download its own browser). Headed by default so you can watch the loop work.
 */
export async function openBrowser({ headless = false } = {}) {
  const args = ['--hide-scrollbars', '--force-color-profile=srgb'];
  // CI runners are frequently root inside a container, where the sandbox refuses
  // to start, and their /dev/shm is too small for Chrome's default use.
  if (process.env.CI) args.push('--no-sandbox', '--disable-dev-shm-usage');

  return chromium.launch({ channel: 'chrome', headless, args });
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
 */
export async function capture({ browser, url, viewports, outDir, label }) {
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
export async function openPersistentContext({ profileDir, headless = false, viewport }) {
  await mkdir(profileDir, { recursive: true });
  const args = ['--hide-scrollbars', '--force-color-profile=srgb'];
  if (process.env.CI) args.push('--no-sandbox', '--disable-dev-shm-usage');

  const size = viewport ?? { width: 1440, height: 900 };
  if (!headless) args.push(`--window-size=${size.width},${size.height}`);

  return chromium.launchPersistentContext(profileDir, {
    channel: 'chrome',
    headless,
    /*
      A headed window must follow the window.

      A fixed viewport is pinned at launch, so going full screen left the page
      rendering at its original size with dead space around it — the app never
      learns it got bigger. null lets the page track the real window, which is
      what a person resizing it expects. Headless keeps a fixed viewport, because
      a screenshot has to be the same size every time to be comparable.
    */
    viewport: headless ? size : null,
    // Playwright refuses deviceScaleFactor alongside a null viewport, and a null
    // viewport is the whole point of a window the user can resize — so it only
    // applies to the fixed-size headless case.
    ...(headless ? { deviceScaleFactor: 1 } : {}),
    args,
  });
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
export async function captureRoutes({ browser, baseUrl, routes = ['/'], viewports, outDir, label }) {
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
