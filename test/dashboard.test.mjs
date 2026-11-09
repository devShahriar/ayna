/*
  The dashboard: what it reads out of the store, what it writes, what a person
  sees when they open it, and the live tab a review window opens beside itself.

  The browser half exists because a page assembled in the browser has to be
  looked at in one: the first version passed every unit check and still printed
  "[object HTMLElement]" down its side panel. It also holds the page to the
  standard ayna holds everyone else to — its own audit must come back clean, in
  both themes, on a desktop and on a phone.
*/
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { writeFile, readFile } from 'node:fs/promises';
import { existsSync, readdirSync, readlinkSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { openDb, appendEvent } from '../src/db.mjs';
import { openStore } from '../src/tasks.mjs';
import {
  gatherDashboard, renderDashboard, writeDashboard, describeEvent, attentionFor, pageOf, assetUrl,
  groupActivity, humanTime, dashboardPalettes,
} from '../src/dashboard.mjs';
import { contrast } from '../src/theme.mjs';
import { DEFAULT_THEME } from '../src/config.mjs';
import { tempDir, hasBrowser, fixtureSite } from './helpers.mjs';

const exec = promisify(execFile);

/*
  Close a database before its folder is deleted. Windows will not delete a file
  anything still holds: these tests were green on Linux while every temp-folder
  cleanup on Windows failed with EBUSY.
*/
const closeQuietly = (db) => {
  try {
    db?.close();
  } catch {
    // Already closed.
  }
};
const BIN = path.resolve(fileURLToPath(new URL('../bin/ayna.mjs', import.meta.url)));

// A real 1×1 PNG, so a crop is a loadable image rather than a broken one.
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

/** A project whose store has a task in most states, and a review window's log. */
async function seeded(dir) {
  const db = await openDb(dir);
  const store = await openStore(dir, { db });
  const crop = path.join(dir, 'crop.png');
  await writeFile(crop, PNG);

  const now = Date.now();
  db.prepare(
    'INSERT INTO sessions (id, tool, pid, project, started_at, heartbeat_at, ended_at, status) VALUES (?,?,?,?,?,?,?,?)',
  ).run('claude-session-1', 'claude', 1, dir, now - 7_200_000, now - 3_600_000, null, 'dead');
  db.prepare('INSERT INTO tabs (id, url, opened_at) VALUES (?,?,?)').run('tab-1', 'http://localhost:3000/pricing', now - 3_000_000);

  const make = async (comment, url, steps = [], extra = {}) => {
    const t = await store.create({ comment, url, selector: '.x', ...extra }, { regionScreenshot: crop });
    for (const status of steps) await store.update(t.id, { status }, status === 'rejected' ? 'still broken' : undefined);
    return t.id;
  };

  const ids = {
    open: await make('Price and unit sit on different baselines', 'http://localhost:3000/pricing'),
    applied: await make('Make the sign-up button the obvious next step', 'http://localhost:3000/', ['in_progress', 'applied']),
    proposed: await make('lowContrast: eyebrow is 3.1:1', 'http://localhost:3000/', [], { status: 'proposed', kind: 'proposal' }),
    rejected: await make('Badge overlaps the plan title', 'http://localhost:3000/pricing', [
      'in_progress', 'applied', 'rejected', 'in_progress', 'applied', 'rejected',
    ]),
    stuck: await make('Featured plan needs more separation', 'http://localhost:3000/pricing', ['in_progress']),
    approved: await make('Footer links are 11px', 'http://localhost:3000/#faq', ['in_progress', 'applied', 'approved']),
    obsolete: await make('smallTargets: icon links are 32px', 'http://localhost:3000/', ['obsolete']),
  };
  // A claim whose lease ran out: in progress on paper, abandoned in fact.
  await store.claim(ids.stuck, 'claude-session-1', { leaseMs: -60_000 });

  appendEvent(db, { event: 'round', tabId: 'tab-1', round: 1, comments: 2 });
  appendEvent(db, { event: 'applied', tabId: 'tab-1', round: 1, files: [{ file: 'src/pricing.css', status: 'modified' }] });
  appendEvent(db, { event: 'gate', tabId: 'tab-1', round: 1, clean: false, counts: { overlaps: 1 }, before: {}, added: { overlaps: 1 } });
  appendEvent(db, { event: 'message', from: 'user', text: 'can the badge sit inside the card?' });

  return { db, store, ids };
}

describe('dashboard: what it reads', () => {
  let tmp;
  let data;
  let ids;
  let seed;
  before(async () => {
    tmp = await tempDir('ayna-dash-');
    seed = await seeded(tmp.dir);
    ids = seed.ids;
    data = await gatherDashboard(tmp.dir, { db: seed.db });
  });
  after(async () => {
    closeQuietly(seed?.db);
    await tmp.dispose();
  });

  test('counts every state, and what is still owed', () => {
    assert.equal(data.counts.total, 7);
    assert.equal(data.counts.pending, 5, 'approved and obsolete are the only settled states');
    assert.equal(data.counts.waiting, 2, 'proposed + applied wait on the user');
    assert.equal(data.counts.done, 2);
    assert.equal(data.counts.in_progress, 1);
  });

  test('needs attention is ranked by who is blocked, and leaves healthy work out', () => {
    assert.deepEqual(data.attention.map((a) => a.id), [ids.applied, ids.rejected, ids.stuck, ids.proposed]);
    assert.match(data.attention.find((a) => a.id === ids.stuck).why, /claim expired/);
    assert.ok(!data.attention.some((a) => a.id === ids.open), 'an open task with nobody stuck is not an alarm');
    const later = Date.now() + 60_000;
    assert.equal(attentionFor({ status: 'in_progress', claimedBy: 'x', claimExpiresAt: later }), null, 'a live claim is not stuck');
  });

  test('pages group by path, so a #hash is the same page', () => {
    assert.deepEqual(data.pages.map((p) => p.label), ['/pricing', '/'], 'worst page first');
    assert.equal(data.pages.find((p) => p.label === '/').total, 4, 'the /#faq task belongs to /');
  });

  test('a task carries how often it was sent back', () => {
    assert.equal(data.tasks.find((t) => t.id === ids.rejected).rejections, 2);
    assert.deepEqual(data.sentBack, [{ id: ids.rejected, rejected: 2, applied: 2 }]);
  });

  test('agents include sessions that are gone, with what they claimed', () => {
    const s = data.agents.find((a) => a.id === 'claude-session-1');
    assert.equal(s.state, 'dead');
    assert.equal(s.claims, 1);
  });

  test('activity is boxes: a task’s whole history, and a review window’s rounds', () => {
    const task = data.boxes.find((b) => b.key === `task:${ids.rejected}`);
    assert.deepEqual(
      task.steps.map((s) => s.text),
      ['Raised', 'Picked up', 'Changed — waiting for your review', 'Sent back', 'Picked up', 'Changed — waiting for your review', 'Sent back'],
    );
    assert.equal(task.steps.at(-1).detail, 'still broken');

    const win = data.boxes.find((b) => b.kind === 'window');
    assert.equal(win.label, 'Review of /pricing', 'named by the page the window was opened on');
    assert.equal(win.sub, '1 round · 3 steps');
    assert.deepEqual(win.steps.map((s) => s.who), ['You', 'Claude', 'Ayna'], 'signed the way the rail signs');

    const outside = data.boxes.find((b) => b.kind === 'other');
    assert.equal(outside.label, 'Between reviews');
    assert.ok(!data.boxes.some((b) => b.steps.some((s) => /^task-\d+ /.test(s.text))), 'task events do not repeat the history');
  });

  test('version moves when the store does', async () => {
    const { dashboardVersion } = await import('../src/dashboard.mjs');
    const db = await openDb(tmp.dir);
    try {
      const before = dashboardVersion(db);
      appendEvent(db, { event: 'message', from: 'claude', text: 'hello' });
      assert.notEqual(dashboardVersion(db), before);
    } finally {
      closeQuietly(db);
    }
  });
});

describe('dashboard: words and colours', () => {
  test('times read the way a person says them', () => {
    const now = new Date(2026, 10, 9, 15, 0).getTime();
    const at = (...a) => new Date(...a).getTime();
    assert.equal(humanTime(now - 10_000, now), 'just now');
    assert.equal(humanTime(now - 60_000, now), '1 minute ago');
    assert.equal(humanTime(now - 5 * 60_000, now), '5 minutes ago');
    assert.equal(humanTime(now - 2 * 3_600_000, now), '2 hours ago');
    assert.equal(humanTime(at(2026, 10, 9, 6, 5), now), 'Today at 06:05');
    assert.equal(humanTime(at(2026, 10, 8, 9, 10), now), 'Yesterday at 09:10');
    assert.equal(humanTime(at(2026, 10, 5, 16, 20), now), 'Thursday at 16:20');
    assert.equal(humanTime(at(2026, 2, 3, 10, 5), now), '3 Mar at 10:05');
    assert.equal(humanTime(at(2025, 10, 3, 10, 5), now), '3 Nov 2025');
    assert.equal(humanTime(NaN, now), '');
  });

  test('events read as sentences, including ones it does not know', () => {
    assert.equal(describeEvent({ event: 'some-new-thing' }).text, 'some new thing');
    assert.equal(describeEvent({ event: 'gate', added: { smallTargets: 2 }, before: {} }).detail, '2 small tap targets');
    assert.equal(describeEvent({ event: 'gate', added: { overlaps: 0 }, before: { overlaps: 3 } }).text, 'No new faults');
    assert.equal(describeEvent({ event: 'applied', round: 2, files: [{ file: 'a/b/c.css' }] }).detail, '1 file · b/c.css');
    assert.equal(describeEvent({ event: 'message', from: 'user', text: 'hi' }).who, 'You');
    assert.equal(pageOf(null).label, 'No page recorded');
  });

  test('every ink in both palettes reads at 4.5:1 on what it sits on', () => {
    const check = (vars, name) => {
      const grounds = ['bg', 'top', 'side', 'raised', 'raised-2', 'sel'].map((k) => vars[k]);
      for (const ink of ['text', 'muted', 'dim', 'accent-text']) {
        for (const g of grounds) assert.ok(contrast(vars[ink], g) >= 4.5, `${name} ${ink} ${vars[ink]} on ${g}`);
      }
      for (const tone of ['neutral', 'accent', 'you', 'agent', 'ayna', 'live', 'good', 'warn', 'bad']) {
        for (const g of grounds) assert.ok(contrast(vars[`${tone}-fg`], g) >= 4.5, `${name} ${tone}-fg on ${g}`);
        assert.ok(contrast(vars[`${tone}-softfg`], vars[`${tone}-soft`]) >= 4.5, `${name} ${tone} tag`);
        assert.ok(contrast(vars[`${tone}-on`], vars[`${tone}-solid`]) >= 4.5, `${name} ${tone} badge`);
        if (vars[`${tone}-pbg`] !== 'transparent') assert.ok(contrast(vars[`${tone}-pfg`], vars[`${tone}-pbg`]) >= 4.5, `${name} ${tone} pill`);
      }
    };
    const own = dashboardPalettes(DEFAULT_THEME);
    check(own.ayna.vars, 'ayna');
    check(own.light.vars, 'light');
    // A project that themes ayna light still gets a readable "Ayna" theme.
    check(dashboardPalettes({ ...DEFAULT_THEME, surface: '#ffffff', bar: '#f6f6f6', panel: '#ffffff', text: '#1a1a1a', muted: 'rgba(0,0,0,.6)', dim: 'rgba(0,0,0,.5)' }).ayna.vars, 'light-ayna');
  });
});

describe('dashboard: the page it writes', () => {
  test('user text cannot break out of the page', async () => {
    const tmp = await tempDir('ayna-dash-');
    let store = null;
    try {
      store = await openStore(tmp.dir);
      const evil = '</script><img src=x onerror=alert(1)>';
      // Not a parseable URL, so it reaches the page — and the page's JSON — as raw text.
      await store.create({ comment: evil, url: 'see </script><b>here', selector: '<b>' });
      const outDir = path.join(tmp.dir, '.ayna', 'dashboard');
      const html = renderDashboard(await gatherDashboard(tmp.dir), { outDir });
      assert.ok(!html.includes('<img src=x'), 'markup in a comment is escaped, never rendered');
      assert.equal(html.split('</script>').length - 1, 3, 'only the three real script blocks end');
      assert.ok(html.includes('\\u003c/script>'), 'the embedded JSON escapes `<`');
    } finally {
      closeQuietly(store?.db);
      await tmp.dispose();
    }
  });

  test('an empty project renders, and says how to fill it', async () => {
    const tmp = await tempDir('ayna-dash-');
    try {
      const { file, data } = await writeDashboard(tmp.dir);
      assert.equal(data.counts.total, 0);
      const html = await readFile(file, 'utf8');
      assert.match(html, /No tasks yet/);
      assert.match(html, /Nothing is stuck/);
      assert.match(html, /<html lang="en" data-theme="ayna">/, 'opens in the review window’s own theme');
    } finally {
      await tmp.dispose();
    }
  });

  test('crops are linked relative to the page, with forward slashes', async () => {
    const tmp = await tempDir('ayna-dash-');
    try {
      closeQuietly((await seeded(tmp.dir)).db);
      const { file } = await writeDashboard(tmp.dir);
      const html = await readFile(file, 'utf8');
      assert.ok(html.includes('src="../tasks/task-0001/region.png"'), 'a crop resolves from .ayna/dashboard/');
      assert.equal(assetUrl(path.join('/p', 'my shots', 'a.png'), '/p/out'), '../my%20shots/a.png');
    } finally {
      await tmp.dispose();
    }
  });

  test('`ayna dashboard` works in a project with no config', async () => {
    const tmp = await tempDir('ayna-dash-');
    try {
      closeQuietly((await seeded(tmp.dir)).db);
      const { stdout } = await exec('node', [BIN, 'dashboard', '--json'], { cwd: tmp.dir, timeout: 60_000 });
      const out = JSON.parse(stdout);
      assert.ok(existsSync(out.file), 'the page is written');
      assert.equal(path.dirname(out.file), path.join(tmp.dir, '.ayna', 'dashboard'), 'into the project, not the plugin');
      assert.equal(out.counts.total, 7);
    } finally {
      await tmp.dispose();
    }
  });

  test('reading the store leaves none of its files open', { skip: process.platform !== 'linux' && 'counts open files through /proc' }, async () => {
    /*
      What Windows reported as EBUSY, measured where it can be measured: an open
      database is a file descriptor, and /proc lists them. gatherDashboard opened
      a connection of its own and never closed it.
    */
    const tmp = await tempDir('ayna-dash-');
    const held = () => {
      const file = path.join(realpathSync(tmp.dir), '.ayna', 'ayna.db');
      return readdirSync('/proc/self/fd')
        .map((fd) => {
          try {
            return readlinkSync(`/proc/self/fd/${fd}`);
          } catch {
            return '';
          }
        })
        .filter((target) => target.startsWith(file));
    };
    try {
      const s = await seeded(tmp.dir);
      assert.ok(held().length > 0, 'the count can see a store that is open');
      closeQuietly(s.db);
      assert.deepEqual(held(), []);
      await gatherDashboard(tmp.dir);
      await writeDashboard(tmp.dir);
      assert.deepEqual(held(), [], 'nothing it opened is still open');
    } finally {
      await tmp.dispose();
    }
  });
});

describe('dashboard: in a browser', { skip: !hasBrowser && 'AYNA_SKIP_BROWSER set' }, () => {
  let tmp;
  let browser;
  let url;
  before(async () => {
    const { openBrowser } = await import('../src/browser.mjs');
    tmp = await tempDir('ayna-dash-');
    closeQuietly((await seeded(tmp.dir)).db);
    const { file } = await writeDashboard(tmp.dir);
    url = pathToFileURL(file).href;
    browser = await openBrowser({ headless: true });
  });
  after(async () => {
    await browser?.close().catch(() => {});
    await tmp?.dispose();
  });

  test('passes ayna’s own audit in both themes, on a desktop and on a phone', async () => {
    const { auditPage } = await import('../src/audit.mjs');
    const found = [];
    for (const theme of ['ayna', 'light']) {
      for (const view of ['overview', 'tasks/task-0004', 'activity', 'agents']) {
        const report = await auditPage({
          browser,
          url: `${url}?theme=${theme}#${view}`,
          viewports: [
            { name: 'desktop', width: 1440, height: 900 },
            { name: 'mobile', width: 390, height: 844 },
          ],
          outDir: path.join(tmp.dir, 'audit', `${theme}-${view.replace('/', '-')}`),
        });
        assert.equal(report.unmeasured.length, 0, 'the audit actually ran');
        for (const [kind, n] of Object.entries(report.counts)) if (n) found.push(`${theme} #${view}: ${kind} ${n}`);
      }
    }
    assert.deepEqual(found, []);
  });

  test('a task opens to its properties and history, not object names', async () => {
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    try {
      await page.goto(`${url}#tasks/task-0004`);
      const detail = page.locator('[data-detail="task-0004"]');
      await detail.waitFor({ state: 'visible' });
      const text = await detail.innerText();
      assert.match(text, /Badge overlaps the plan title/);
      assert.match(text, /Status\s+Rejected/);
      assert.match(text, /Sent back 2×/);
      assert.match(text, /History[\s\S]*Raised[\s\S]*Sent back/);
      assert.doesNotMatch(text, /\[object|(^|\n)null(\n|$)|undefined/);
      assert.equal(await page.locator('[data-task-row][aria-current="true"]').getAttribute('data-id'), 'task-0004');
      assert.deepEqual(errors, []);
    } finally {
      await page.close();
    }
  });

  test('filters, search and a page filter only change what is shown', async () => {
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    try {
      await page.goto(`${url}#tasks`);
      const rows = page.locator('[data-task-row]:visible');
      assert.equal(await rows.count(), 5, 'Open shows what is still owed');
      await page.click('[data-filter="done"]');
      assert.equal(await rows.count(), 2);
      await page.click('[data-filter="all"]');
      assert.equal(await rows.count(), 7);
      await page.fill('[data-search-input]', 'badge');
      assert.equal(await rows.count(), 1);
      await page.fill('[data-search-input]', '');

      await page.goto(`${url}#pages`);
      await page.click('.page-row:has-text("/pricing")');
      await page.waitForFunction(() => location.hash.startsWith('#tasks'));
      assert.equal(await page.locator('[data-page-label]').innerText(), '/pricing');
      assert.ok((await rows.count()) > 0);
      for (const r of await rows.all()) assert.match(await r.innerText(), /\/pricing/);
      await page.click('[data-clear-page]');
      await page.waitForFunction(() => !document.querySelector('[data-page-filter]').checkVisibility());
    } finally {
      await page.close();
    }
  });

  test('the theme toggle is remembered, and ?theme= wins for one visit', async () => {
    const page = await browser.newPage();
    try {
      await page.goto(`${url}#overview`);
      assert.equal(await page.getAttribute('html', 'data-theme'), 'ayna');
      await page.click('[data-theme-set="light"]');
      assert.equal(await page.getAttribute('html', 'data-theme'), 'light');
      await page.reload();
      assert.equal(await page.getAttribute('html', 'data-theme'), 'light', 'remembered across a reload');
      await page.goto(`${url}?theme=ayna#overview`);
      assert.equal(await page.getAttribute('html', 'data-theme'), 'ayna');
    } finally {
      await page.close();
    }
  });

  test('a snapshot says so, and offers no button that cannot work', async () => {
    const page = await browser.newPage();
    try {
      await page.goto(url);
      assert.match(await page.locator('.stamp').innerText(), /Snapshot/);
      assert.equal(await page.locator('#refresh').isVisible(), false);
    } finally {
      await page.close();
    }
  });

  test('on a phone the list and the detail take turns', async () => {
    const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
    try {
      await page.goto(`${url}#tasks`);
      assert.equal(await page.locator('.detail-pane').isVisible(), false, 'nothing chosen yet, so just the list');
      await page.locator('[data-task-row]:visible').first().click();
      await page.locator('.detail:visible .back').waitFor();
      assert.equal(await page.locator('.list-pane').isVisible(), false);
      await page.locator('.detail:visible .back').click();
      await page.locator('.list-pane').waitFor({ state: 'visible' });
    } finally {
      await page.close();
    }
  });
});

describe('dashboard: beside a review window', { skip: !hasBrowser && 'AYNA_SKIP_BROWSER set' }, () => {
  test('the window opens it live in a tab, it refreshes itself, and the button reuses the tab', async () => {
    const { openBrowser } = await import('../src/browser.mjs');
    const { runAnnotate } = await import('../src/annotate.mjs');
    const { serveStatic } = await import('../src/server.mjs');
    const tmp = await tempDir('ayna-dash-live-');
    const browser = await openBrowser({ headless: true });
    const server = await serveStatic(await fixtureSite(path.join(tmp.dir, 'site')), 0);
    const seen = {};
    let store = null;
    try {
      store = await openStore(tmp.dir);
      await store.create({ comment: 'There before the dashboard opened', url: server.url, selector: 'h1' });
      await runAnnotate({
        browser,
        url: server.url,
        outDir: path.join(tmp.dir, 'out'),
        projectDir: tmp.dir,
        store,
        theme: DEFAULT_THEME,
        viewport: { width: 1440, height: 900 },
        agent: { tool: 'claude', agentId: 'dashboard-test', agentPid: process.pid },
        onReady: async (page) => {
          const ctx = page.context();
          await page.waitForSelector('.ayna-ov-console [data-act=dashboard]');
          const [dash] = await Promise.all([
            ctx.waitForEvent('page', { timeout: 15_000 }),
            page.click('.ayna-ov-console [data-act=dashboard]'),
          ]);
          await dash.waitForSelector('html[data-live]', { timeout: 15_000 });
          seen.overlay = await dash.evaluate(() => Boolean(document.querySelector('.ayna-ov-bar')));
          seen.refresh = await dash.locator('#refresh').isVisible();
          seen.first = await dash.locator('[data-task-row]').count();

          await dash.evaluate(() => { location.hash = '#tasks'; });
          await dash.click('[data-filter="all"]');
          await store.create({ comment: 'Raised while it was open', url: server.url, selector: 'p' });
          await dash.waitForFunction(() => document.querySelectorAll('[data-task-row]').length === 2, null, { timeout: 15_000 });
          seen.kept = await dash.evaluate(() => ({
            view: location.hash.split('/')[0],
            filter: document.querySelector('[data-filter][aria-selected="true"]').dataset.filter,
          }));

          await page.click('.ayna-ov-console [data-act=dashboard]');
          await page.waitForTimeout(800);
          seen.tabs = ctx.pages().length;

          await page.click('.ayna-ov-bar [data-act=tasks]');
          seen.panelLink = await page.locator('[data-act=panel-dashboard]').isVisible();
          await page.close();
        },
      });
      assert.equal(seen.overlay, false, 'the review overlay stays on the review page');
      assert.equal(seen.refresh, true, 'a live page offers Refresh');
      assert.equal(seen.first, 1);
      assert.deepEqual(seen.kept, { view: '#tasks', filter: 'all' }, 'a refresh comes back to where you were');
      assert.equal(seen.tabs, 2, 'pressing it again brings the same tab forward');
      assert.equal(seen.panelLink, true, 'the Tasks list links to it too');
    } finally {
      await browser.close().catch(() => {});
      await server.close().catch(() => {});
      closeQuietly(store?.db);
      await tmp.dispose();
    }
  });
});
