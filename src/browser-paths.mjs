import { existsSync } from 'node:fs';
import path from 'node:path';

/**
 * Where Chromium-family browsers live on each platform.
 *
 * WHY THIS EXISTS. Playwright's `channel` option is a fixed list — chrome,
 * chrome-beta, msedge, chromium — and Brave is not on it. There is no
 * `channel: 'brave'`, and setting one gets you `Unsupported chromium channel
 * "brave"` rather than a browser. The only way to drive Brave, Vivaldi or Arc is
 * `executablePath`, pointing at the binary.
 *
 * So ayna supports two shapes and has to know which one it is holding:
 *
 *   - a CHANNEL    — a name Playwright resolves itself ("chrome", "msedge")
 *   - a PATH       — an executable we point at ourselves ("/Applications/Brave
 *                    Browser.app/Contents/MacOS/Brave Browser")
 *
 * The paths below are the canonical install locations. They are checked with
 * existsSync, not searched for, so a browser in an unusual place is reachable
 * by path but never silently picked up.
 */
export const BROWSERS = {
  chrome: {
    label: 'Google Chrome',
    // Playwright knows these by name, so they are channels rather than paths.
    channels: ['chrome', 'chrome-beta', 'chrome-dev', 'chrome-canary'],
    paths: {
      darwin: [
        '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
        '/Applications/Google Chrome Beta.app/Contents/MacOS/Google Chrome Beta',
        '/Applications/Google Chrome Dev.app/Contents/MacOS/Google Chrome Dev',
        '/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary',
      ],
      linux: [
        '/usr/bin/google-chrome',
        '/usr/bin/google-chrome-stable',
        '/opt/google/chrome/chrome',
        '/usr/bin/chromium',
        '/usr/bin/chromium-browser',
        '/snap/bin/chromium',
      ],
      win32: [
        'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
        'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
      ],
    },
  },
  brave: {
    label: 'Brave',
    paths: {
      darwin: [
        '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',
        '/Applications/Brave Browser Beta.app/Contents/MacOS/Brave Browser Beta',
        '/Applications/Brave Browser Nightly.app/Contents/MacOS/Brave Browser Nightly',
      ],
      linux: [
        '/usr/bin/brave-browser',
        '/usr/bin/brave',
        '/opt/brave.com/brave/brave-browser',
        '/snap/bin/brave',
      ],
      win32: [
        'C:\\Program Files\\BraveSoftware\\Brave-Browser\\Application\\brave.exe',
        'C:\\Program Files (x86)\\BraveSoftware\\Brave-Browser\\Application\\brave.exe',
      ],
    },
  },
  edge: {
    label: 'Microsoft Edge',
    channels: ['msedge', 'msedge-beta', 'msedge-dev', 'msedge-canary'],
    paths: {
      darwin: [
        '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
        '/Applications/Microsoft Edge Beta.app/Contents/MacOS/Microsoft Edge Beta',
        '/Applications/Microsoft Edge Dev.app/Contents/MacOS/Microsoft Edge Dev',
        '/Applications/Microsoft Edge Canary.app/Contents/MacOS/Microsoft Edge Canary',
      ],
      linux: [
        '/usr/bin/microsoft-edge',
        '/usr/bin/microsoft-edge-stable',
        '/opt/microsoft/msedge/msedge',
      ],
      win32: [
        'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
        'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
      ],
    },
  },
  vivaldi: {
    label: 'Vivaldi',
    paths: {
      darwin: ['/Applications/Vivaldi.app/Contents/MacOS/Vivaldi'],
      linux: ['/usr/bin/vivaldi', '/usr/bin/vivaldi-stable'],
      win32: ['C:\\Program Files\\Vivaldi\\Application\\vivaldi.exe'],
    },
  },
  arc: {
    label: 'Arc',
    paths: {
      darwin: ['/Applications/Arc.app/Contents/MacOS/Arc'],
      linux: [],
      win32: [],
    },
  },
  chromium: {
    label: 'Chromium',
    channels: ['chromium', 'chromium-headless-shell'],
    paths: {
      darwin: ['/Applications/Chromium.app/Contents/MacOS/Chromium'],
      linux: ['/usr/bin/chromium', '/usr/bin/chromium-browser', '/snap/bin/chromium'],
      win32: ['C:\\Program Files\\Chromium\\Application\\chrome.exe'],
    },
  },
};

/**
 * Every channel name Playwright resolves on its own.
 *
 * Anything NOT in here has to be handed over as an executable path, because
 * Playwright would refuse it with `Unsupported chromium channel "<name>"`.
 */
export const PLAYWRIGHT_CHANNELS = new Set(
  Object.values(BROWSERS).flatMap((b) => b.channels ?? []),
);

/** Aliases people actually type, mapped to a canonical browser key. */
const ALIASES = {
  brave: 'brave',
  bravebrowser: 'brave',
  chrome: 'chrome',
  googlechrome: 'chrome',
  chromium: 'chromium',
  edge: 'edge',
  msedge: 'edge',
  microsoftedge: 'edge',
  vivaldi: 'vivaldi',
  arc: 'arc',
};

/**
 * Canonical key for a name, or null if it is not a browser we know.
 *
 * Spaces, dashes and underscores are all the same separator here, because
 * people type "Google Chrome", "google-chrome" and "googlechrome" and mean
 * one thing by all three.
 */
export function browserKey(name) {
  if (!name) return null;
  const key = String(name).trim().toLowerCase().replace(/[\s_-]+/g, '');
  return ALIASES[key] ?? null;
}

/** The Playwright channel for a browser key, if it has one. */
export function channelFor(name) {
  const key = browserKey(name);
  if (!key) return null;
  return BROWSERS[key].channels?.[0] ?? null;
}

/** Every executable path for a browser on this platform, in preference order. */
export function pathsFor(name) {
  const key = browserKey(name);
  if (!key) return [];
  return BROWSERS[key].paths[process.platform] ?? [];
}

/**
 * A chromium binary found on `$PATH`.
 *
 * WHY THIS ONE IS SEARCHED. The canonical paths above are checked with
 * existsSync, not searched for, so a browser in an unusual place is reachable
 * by path but never silently picked up. Chromium is the exception on Linux:
 * a container image can install it anywhere on `$PATH`, and a machine without
 * Chrome should still get a browser rather than an error telling it to
 * install one. It is only ever a fallback, and only for chromium — Chrome
 * stays on its canonical paths so a stray binary cannot take its place.
 *
 * The scan itself is platform-independent so it can be tested anywhere; the
 * Linux-only rule lives in `findBrowser`, where it belongs.
 */
export function chromiumOnPath() {
  const dirs = (process.env.PATH || '').split(path.delimiter).filter(Boolean);
  for (const dir of dirs) {
    for (const name of ['chromium', 'chromium-browser']) {
      const candidate = path.join(dir, name);
      if (existsSync(candidate)) return candidate;
    }
  }
  return null;
}

/** The first installed executable for a browser on this platform, or null. */
export function findBrowser(name) {
  for (const p of pathsFor(name)) {
    if (existsSync(p)) return p;
  }
  if (browserKey(name) === 'chromium' && process.platform === 'linux') return chromiumOnPath();
  return null;
}

/** Every browser installed on this machine, in a stable order. */
export function installedBrowsers() {
  const found = [];
  for (const [key, spec] of Object.entries(BROWSERS)) {
    const p = findBrowser(key);
    if (p) found.push({ key, label: spec.label, path: p });
  }
  return found;
}

/**
 * Does this look like a path to an executable rather than a browser name?
 *
 * A path can be absolute or relative, and on Windows it carries a drive
 * letter. The rule is deliberately generous — anything with a separator in it
 * is treated as a path — because the alternative (a browser called
 * "my/chrome") is not a thing.
 */
export function looksLikePath(value) {
  if (!value) return false;
  const s = String(value);
  return s.includes('/') || s.includes('\\') || path.isAbsolute(s);
}

/** Does an executable exist at this path? */
export function executableExists(p) {
  if (!p) return false;
  return existsSync(p);
}
