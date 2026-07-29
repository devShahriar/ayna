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
      await page.goto(url, { waitUntil: 'networkidle', timeout: 30_000 });
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

/** Compact, model-readable summary of a capture. */
export function summarize(cap) {
  const lines = [];
  for (const s of cap.shots) {
    const m = s.metrics ?? {};
    lines.push(
      `- ${s.viewport} (${s.width}x${s.height}): ${s.file}` +
        (s.loadError ? ` — LOAD ERROR: ${s.loadError}` : '') +
        (m.horizontalOverflow ? ` — horizontal overflow (${m.scrollWidth}px > ${m.clientWidth}px)` : '') +
        (m.tinyTextNodes ? ` — ${m.tinyTextNodes} element(s) with font-size < 12px` : ''),
    );
  }
  if (cap.consoleErrors.length) lines.push(`- console errors: ${cap.consoleErrors.join(' | ')}`);
  if (cap.pageErrors.length) lines.push(`- page errors: ${cap.pageErrors.join(' | ')}`);
  return lines.join('\n');
}
