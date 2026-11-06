/*
  Which browser ayna drives.

  The bug this exists for: a user with Brave installed and no Chrome ran
  `ayna annotate` and got "could not start chrome". Brave is Chromium-based and
  speaks CDP perfectly well — Playwright just does not have a `brave` channel,
  so it has to be reached by executable path instead.

  So the resolution has three outcomes and each one has to be right:
  a Playwright channel, an executable path, or an error that says what IS
  installed rather than "install one".
*/
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';

import {
  BROWSERS,
  PLAYWRIGHT_CHANNELS,
  browserKey,
  channelFor,
  chromiumOnPath,
  findBrowser,
  installedBrowsers,
  looksLikePath,
  pathsFor,
} from '../src/browser-paths.mjs';
import { resolveBrowser, chromeChannel } from '../src/browser.mjs';

describe('knowing the browsers', () => {
  test('every browser has somewhere to look on this platform', () => {
    for (const [key, spec] of Object.entries(BROWSERS)) {
      const paths = spec.paths[process.platform] ?? [];
      assert.ok(Array.isArray(paths), `${key} has no path list for ${process.platform}`);
      for (const p of paths) {
        assert.ok(path.isAbsolute(p), `${key}: "${p}" should be absolute`);
      }
    }
  });

  test('brave is known, and is NOT a Playwright channel', () => {
    /*
      This is the whole reason the code has two shapes. If Playwright ever adds
      a brave channel, the executablePath route becomes unnecessary — but the
      path route still works, so nothing breaks either way.
    */
    assert.ok(BROWSERS.brave, 'brave should be a known browser');
    assert.equal(PLAYWRIGHT_CHANNELS.has('brave'), false);
    assert.ok(pathsFor('brave').length > 0 || process.platform === 'win32');
  });

  test('the names people type all land on a browser', () => {
    for (const [typed, expected] of [
      ['brave', 'brave'],
      ['Brave', 'brave'],
      ['BRAVE', 'brave'],
      ['chrome', 'chrome'],
      ['Google Chrome', 'chrome'],
      ['google-chrome', 'chrome'],
      ['chromium', 'chromium'],
      ['edge', 'edge'],
      ['msedge', 'edge'],
      ['Microsoft Edge', 'edge'],
      ['vivaldi', 'vivaldi'],
    ]) {
      assert.equal(browserKey(typed), expected, `"${typed}" should resolve to ${expected}`);
    }
    assert.equal(browserKey('firefox'), null);
    assert.equal(browserKey(''), null);
    assert.equal(browserKey(null), null);
  });

  test('a path is a path, and a name is not', () => {
    assert.equal(looksLikePath('/Applications/Brave Browser.app/Contents/MacOS/Brave Browser'), true);
    assert.equal(looksLikePath('C:\\Program Files\\Brave\\brave.exe'), true);
    assert.equal(looksLikePath('brave'), false);
    assert.equal(looksLikePath('chrome'), false);
    assert.equal(looksLikePath(''), false);
  });

  test('the survey only reports browsers that are actually there', () => {
    for (const b of installedBrowsers()) {
      assert.ok(existsSync(b.path), `${b.label} was reported but ${b.path} does not exist`);
      assert.ok(BROWSERS[b.key], `${b.key} is not a known browser`);
    }
  });

  test('findBrowser returns a path that exists, or nothing', () => {
    for (const key of Object.keys(BROWSERS)) {
      const found = findBrowser(key);
      if (found) assert.ok(existsSync(found));
    }
  });

  test('chromium is found on $PATH, but only on Linux', () => {
    /*
      A container image can install chromium anywhere on $PATH. The canonical
      paths are not enough there, so chromium is the one browser that is also
      searched for — but only on Linux, and only as a fallback behind the
      canonical paths.

      The scan is exercised directly so the test is not vacuous on a machine
      that is not Linux; the platform rule is asserted through findBrowser.
    */
    const before = process.env.PATH;
    const dir = mkdtempSync(path.join(tmpdir(), 'ayna-path-'));
    try {
      const binary = path.join(dir, 'chromium');
      writeFileSync(binary, '', { mode: 0o755 });
      process.env.PATH = dir;

      assert.equal(chromiumOnPath(), binary, 'chromium on $PATH should be found');

      // chromium-browser is the other name it goes by.
      const dir2 = mkdtempSync(path.join(tmpdir(), 'ayna-path-'));
      try {
        const binary2 = path.join(dir2, 'chromium-browser');
        writeFileSync(binary2, '', { mode: 0o755 });
        process.env.PATH = dir2;
        assert.equal(chromiumOnPath(), binary2);
      } finally {
        process.env.PATH = dir;
        rmSync(dir2, { recursive: true, force: true });
      }

      // The platform rule: only Linux consults $PATH for chromium.
      process.env.PATH = dir;
      const found = findBrowser('chromium');
      if (process.platform === 'linux') {
        assert.equal(found, binary, 'chromium on $PATH should be found on linux');
      } else {
        // Elsewhere the search does not run. The canonical paths decide, so
        // the answer is either a canonical path or nothing — never ours.
        assert.notEqual(found, binary, 'the $PATH search is linux-only');
        if (found) assert.ok(pathsFor('chromium').includes(found));
      }
    } finally {
      process.env.PATH = before;
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('choosing one', () => {
  test('a Playwright channel is passed through as a channel', () => {
    const r = resolveBrowser('chrome-beta');
    assert.equal(r.channel, 'chrome-beta');
    assert.equal(r.executablePath, undefined);
  });

  test('a browser Playwright does not know becomes an executable path', () => {
    /*
      Brave, most likely. If it is installed, the resolution must be a PATH —
      handing Playwright `channel: 'brave'` gets `Unsupported chromium
      channel "brave"`, which is a worse error than the one it replaced.
    */
    const r = resolveBrowser('brave');
    if (r.channel) {
      // Brave is not installed here and there is no channel for it, so this
      // branch should not be reachable; assert it anyway so a future Playwright
      // channel shows up as an explicit change rather than a silent one.
      assert.equal(r.channel, 'brave');
    } else {
      assert.ok(r.executablePath, 'brave should resolve to an executable path');
      assert.ok(existsSync(r.executablePath));
      assert.match(r.executablePath, /brave/i);
    }
  });

  test('an explicit path is used exactly as given', () => {
    const p = process.execPath; // node — a real executable, and a path
    const r = resolveBrowser(p);
    assert.equal(r.executablePath, p);
    assert.equal(r.channel, undefined);
  });

  test('a path that is not there says so, and does not fall back silently', () => {
    assert.throws(
      () => resolveBrowser('/definitely/not/a/browser/binary'),
      /no browser executable/i,
    );
  });

  test('an unknown name is not treated as a path', () => {
    assert.throws(() => resolveBrowser('not-a-browser'), /not a browser ayna knows/i);
  });

  test('the default resolves to something that can actually be launched', () => {
    /*
      Whatever the machine has, the default has to work. On a machine with only
      Brave, the default must be Brave — not "chrome", which would fail with
      the exact error this whole change exists to remove.
    */
    const r = resolveBrowser(undefined);
    assert.ok(r.channel || r.executablePath, 'the default must resolve to something');
    if (r.executablePath) assert.ok(existsSync(r.executablePath));
  });

  test('the env var is still the way to choose from outside', () => {
    const before = process.env.AYNA_CHROME_CHANNEL;
    try {
      delete process.env.AYNA_CHROME_CHANNEL;
      // Unset is NOT "chrome" — it means "resolve against what is installed",
      // which is how a machine with only Brave gets Brave.
      assert.equal(chromeChannel(), undefined);
      process.env.AYNA_CHROME_CHANNEL = 'brave';
      assert.equal(chromeChannel(), 'brave');
    } finally {
      if (before === undefined) delete process.env.AYNA_CHROME_CHANNEL;
      else process.env.AYNA_CHROME_CHANNEL = before;
    }
  });
});
