import { readFile, writeFile, access } from 'node:fs/promises';
import path from 'node:path';

export const DEFAULT_CONFIG = {
  target: {
    name: 'demo',
    // Directory that holds the UI source. Ayna serves this statically when `url` is null.
    root: 'demo',
    // Set to e.g. "http://localhost:5173" to point at your own dev server instead.
    url: null,
    // Optional command to boot that dev server (run from the repo root).
    startCommand: null,
    port: 4173,
    // Pages to capture, relative to the target URL. Add every route worth
    // reviewing — one shot of the landing page tells you nothing about /pricing.
    routes: ['/'],
    /*
      There is deliberately no `editGlobs` here. It used to exist and was never
      enforced, which is worse than not having it: a setting that looks like a
      sandbox but isn't. The real boundary is `root` — it's what gets snapshotted,
      what `restore` rolls back, and what the skill tells Claude it may touch.
      That is a convention plus an undo, not a security guarantee. Point `root`
      somewhere you are happy to have rewritten.
    */
  },
  viewports: [
    { name: 'desktop', width: 1440, height: 900 },
    { name: 'mobile', width: 390, height: 844 },
  ],
  loop: {
    iterations: 3,
    model: 'opus',
    // Headless by default: as a plugin this runs inside someone's session, and a
    // Chrome window stealing focus mid-task is worse than not seeing it. `--headed`
    // opts back in.
    headless: true,
    // Stop early once the critic scores the UI at or above this (0-10).
    targetScore: 8.5,
    // Re-screenshot after edits and ask the brain whether the fixes landed.
    verify: true,
    // Roll the iteration back if the page breaks (blank render / new console errors).
    autoRevert: true,
  },
  goal:
    'A modern, polished product landing page: confident typography, deliberate spacing ' +
    'rhythm, a coherent color system, clear visual hierarchy, and a layout that holds up ' +
    'on both desktop and mobile.',
};

function deepMerge(base, override) {
  if (Array.isArray(override)) return override;
  if (override === null || typeof override !== 'object') {
    return override === undefined ? base : override;
  }
  const out = { ...base };
  for (const [k, v] of Object.entries(override)) {
    out[k] = k in base ? deepMerge(base[k], v) : v;
  }
  return out;
}

export async function loadConfig(rootDir) {
  const file = path.join(rootDir, 'ayna.config.json');
  let user = {};
  try {
    await access(file);
    user = JSON.parse(await readFile(file, 'utf8'));
  } catch {
    // No config yet — defaults are fine.
  }
  const cfg = deepMerge(DEFAULT_CONFIG, user);
  cfg.rootDir = rootDir;
  cfg.targetDir = path.resolve(rootDir, cfg.target.root);
  cfg.runsDir = path.join(rootDir, '.ayna', 'runs');
  cfg.configFile = file;
  return cfg;
}

export async function writeConfig(rootDir, cfg = DEFAULT_CONFIG) {
  const file = path.join(rootDir, 'ayna.config.json');
  await writeFile(file, `${JSON.stringify(cfg, null, 2)}\n`);
  return file;
}
