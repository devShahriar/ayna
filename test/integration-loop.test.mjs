/*
  These drive a real Chrome. They are the tests that actually protect the product:
  the capture diagnostics and the annotate round-trip are where the bugs have been.

  Set AYNA_SKIP_BROWSER=1 to skip them (e.g. on a machine with no Chrome).
*/
import { test, describe, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { writeFile, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { openBrowser, capture, captureRoutes, routeSlug } from '../src/browser.mjs';
import { serveStatic } from '../src/server.mjs';
import { runAnnotate, cropRegion } from '../src/annotate.mjs';
import { tempDir, fixtureSite, hasBrowser, press, launchBrowser } from './helpers.mjs';

describe('the loop keeps itself going', { skip: !hasBrowser && 'AYNA_SKIP_BROWSER set' }, () => {
  let browser;
  beforeEach(async () => {
    browser = await launchBrowser();
  });
  afterEach(async () => {
    await browser?.close().catch(() => {});
  });

  test('applied catches the next round with nothing re-armed by hand', async () => {
    const { dir, dispose } = await tempDir();
    try {
      const { execFile } = await import('node:child_process');
      const { mkdir } = await import('node:fs/promises');
      const site = path.join(dir, 'site');
      await fixtureSite(site);
      const out = path.join(dir, '.ayna', 'comments', 's1');
      await mkdir(path.join(dir, '.ayna', 'session'), { recursive: true });
      await mkdir(out, { recursive: true });
      await writeFile(
        path.join(dir, 'ayna.config.json'),
        JSON.stringify({ target: { name: 'c', root: 'site', url: 'http://127.0.0.1:4730/' } }),
      );
      await writeFile(
        path.join(dir, '.ayna', 'session', 'last-comments.json'),
        JSON.stringify({ file: path.join(out, 'comments.json'), pid: process.pid }),
      );

      const bin = path.resolve(fileURLToPath(new URL('../bin/ayna.mjs', import.meta.url)));
      const applied = () =>
        new Promise((res) => {
          execFile('node', [bin, 'applied'], { cwd: dir, timeout: 120_000 }, (e, so) =>
            res(((so || '').trim().split('\n').pop()) || ''),
          );
        });

      const server = await serveStatic(site, 4730);
      let returned = '';
      try {
        await runAnnotate({
          browser,
          url: server.url,
          outDir: out,
          projectDir: dir,
          viewport: { width: 1100, height: 700 },
          onReady: async (page) => {
            const add = async (sel, txt) => {
              await page.click(sel);
              await page.waitForSelector('.ayna-ov-pop textarea');
              await page.fill('.ayna-ov-pop textarea', txt);
              await page.click('.ayna-ov-save');
              await page.waitForTimeout(400);
            };

            await add('.title', 'round one');
            await page.click('[data-act=send]');
            await page.waitForTimeout(400);

            // The only waiting command an agent runs after finishing its edits.
            const pending = applied();
            await page.waitForFunction(() => document.querySelector('[data-act=close]') !== null, {
              timeout: 20000,
            });
            await page.waitForTimeout(500);

            // A second round, with nothing re-armed in between.
            await press(page, 'more');
            await page.waitForTimeout(400);
            await add('.lede', 'round two');
            await page.click('[data-act=send]');
            await page.waitForTimeout(700);

            returned = await pending;
            await page.close();
          },
        });

        const payload = JSON.parse(returned);
        assert.equal(payload.round, 2, 'applied returned when the second round arrived');
        assert.equal(payload.action, 'read-comments');
      } finally {
        await server.close();
      }
    } finally {
      await dispose();
    }
  });

  test('every round and rejection is emitted, with nothing re-armed', async () => {
    const { dir, dispose } = await tempDir();
    try {
      const site = path.join(dir, 'site');
      await fixtureSite(site);
      const out = path.join(dir, 'out');
      const server = await serveStatic(site, 4732);
      const events = [];
      try {
        await runAnnotate({
          browser,
          url: server.url,
          outDir: out,
          projectDir: site,
          viewport: { width: 1100, height: 700 },
          onEvent: (e) => events.push(e),
          onReady: async (page) => {
            const add = async (sel, txt) => {
              await page.click(sel);
              await page.waitForSelector('.ayna-ov-pop textarea');
              await page.fill('.ayna-ov-pop textarea', txt);
              await page.click('.ayna-ov-save');
              await page.waitForTimeout(400);
            };

            await add('.title', 'round one');
            await page.click('[data-act=send]');
            await page.waitForTimeout(500);

            await writeFile(path.join(out, 'applied'), '1');
            await page.waitForFunction(() => document.querySelector('[data-act=close]') !== null, {
              timeout: 20000,
            });
            await page.waitForTimeout(400);

            await page.click('.ayna-ov-revbar >> nth=0 >> .ayna-ov-no');
            await page.waitForTimeout(400);

            await press(page, 'more');
            await page.waitForTimeout(400);
            await add('.lede', 'round two');
            await page.click('[data-act=send]');
            await page.waitForTimeout(600);
            await page.close();
          },
        });

        const kinds = events.map((e) => e.event);
        // `applied` reports that the window left the waiting phase, and says which
        // of the three signals ended it — the marker, a file change, or the user.
        /*
          `gate` follows `applied`: the measurable checks run the moment changes
          land, so the user is told whether the fault is actually gone before
          being asked to judge it. "Done" is a prediction until something looks.
        */
        assert.deepEqual(
          kinds,
          ['round', 'applied', 'gate', 'rejected', 'round', 'closed'],
          kinds.join(','),
        );
        assert.equal(typeof events.find((e) => e.event === 'gate').clean, 'boolean');
        assert.equal(events.find((e) => e.event === 'applied').via, 'marker');
        assert.deepEqual(
          events.filter((e) => e.event === 'round').map((e) => e.round),
          [1, 2],
          'the second round is announced without anything being re-armed',
        );
        // By name, not by index: an added event should not break this.
        assert.equal(events.find((e) => e.event === 'round').action, 'read-comments');
        assert.equal(events.find((e) => e.event === 'rejected').action, 'retry-rejected');
      } finally {
        await server.close();
      }
    } finally {
      await dispose();
    }
  });

  test('each thing is announced once, and filed under the window it happened in', async () => {
    const { dir, dispose } = await tempDir();
    try {
      const { openStore } = await import('../src/tasks.mjs');
      const { eventsSince } = await import('../src/db.mjs');
      const site = path.join(dir, 'site');
      await fixtureSite(site);
      const out = path.join(dir, 'out');
      const server = await serveStatic(site, 4742);
      const store = await openStore(dir);
      const events = [];
      try {
        await runAnnotate({
          browser,
          store,
          url: server.url,
          outDir: out,
          projectDir: site,
          viewport: { width: 1100, height: 700 },
          onEvent: (e) => events.push(e),
          onReady: async (page) => {
            await page.click('.title');
            await page.waitForSelector('.ayna-ov-pop textarea');
            await page.fill('.ayna-ov-pop textarea', 'tighten this');
            await page.click('.ayna-ov-save');
            await page.waitForTimeout(400);
            await page.click('[data-act=send]');
            await page.waitForTimeout(500);

            // A dev server's hot reload: the page restyles itself before ayna looks.
            await page.evaluate(() => {
              const s = document.createElement('style');
              s.textContent = '.title { letter-spacing: -0.02em }';
              document.head.append(s);
            });
            await writeFile(path.join(out, 'applied'), '1');
            await page.waitForFunction(() => document.querySelector('[data-act=close]') !== null, {
              timeout: 20000,
            });
            await page.waitForTimeout(400);

            // "Needs work", then "Needs work" again on the same note.
            await page.evaluate(() => window.__aynaResolve(1, 'rejected'));
            await page.evaluate(() => window.__aynaResolve(1, 'rejected'));
            await page.waitForTimeout(300);
            await page.close();
          },
        });

        const applied = events.filter((e) => e.event === 'applied');
        assert.equal(applied.length, 1, 'a hot-reloaded page was announced as applied twice');
        assert.equal(applied[0].reloaded, false, 'and the one announcement says it was not reloaded');
        assert.equal(events.filter((e) => e.event === 'rejected').length, 1, 'the same verdict twice is one verdict');

        const logged = eventsSince(store.db);
        const tab = logged.find((e) => e.event === 'tab-opened').tabId;
        for (const kind of ['task', 'round', 'applied', 'gate', 'rejected', 'closed']) {
          const rows = logged.filter((e) => e.event === kind);
          assert.ok(rows.length, `${kind} reached the log`);
          assert.ok(rows.every((e) => e.tabId === tab), `${kind} is filed under this window`);
        }
      } finally {
        await server.close();
      }
    } finally {
      await dispose();
    }
  });

  test("a new window's activity starts with this window, and one line for the past", async () => {
    const { dir, dispose } = await tempDir();
    try {
      const { openStore } = await import('../src/tasks.mjs');
      const site = path.join(dir, 'site');
      await fixtureSite(site);
      const server = await serveStatic(site, 4743);
      const store = await openStore(dir);
      const open = (outDir, onReady) =>
        runAnnotate({
          browser,
          store,
          url: server.url,
          outDir,
          projectDir: site,
          viewport: { width: 1100, height: 700 },
          onReady,
        });
      try {
        // Yesterday: one note, sent, and the window closed with it still open.
        await open(path.join(dir, 'out-1'), async (page) => {
          await page.click('.title');
          await page.waitForSelector('.ayna-ov-pop textarea');
          await page.fill('.ayna-ov-pop textarea', 'tighten this');
          await page.click('.ayna-ov-save');
          await page.waitForTimeout(400);
          await page.click('[data-act=send]');
          await page.waitForTimeout(500);
          await page.close();
        });

        let seen = null;
        await open(path.join(dir, 'out-2'), async (page) => {
          await page.waitForFunction(() => !document.querySelector('.ayna-ov-earlier')?.hidden, null, { timeout: 10000 });
          await page.waitForTimeout(1200); // a couple of feed polls
          seen = await page.evaluate(() => ({
            earlier: document.querySelector('.ayna-ov-earlier span').textContent,
            log: document.querySelector('.ayna-ov-console-lines').textContent,
          }));
          await page.click('[data-act=earlier]');
          await page.waitForSelector('.ayna-ov-panel', { timeout: 5000 });
          seen.panel = await page.evaluate(() => document.querySelector('.ayna-ov-panel').textContent);
          await page.close();
        });

        assert.equal(seen.earlier, 'Earlier · 1 window · 1 note still open');
        assert.doesNotMatch(seen.log, /Window closed|Sent to Claude/, `yesterday's rows leaked in: ${seen.log}`);
        assert.match(seen.panel, /tighten this/, 'Show opens the task list with the open note in it');
      } finally {
        await server.close();
      }
    } finally {
      await dispose();
    }
  });

  test('the check after a round tells what the round added from what was already there', async () => {
    const { dir, dispose } = await tempDir();
    try {
      const { openStore } = await import('../src/tasks.mjs');
      const site = path.join(dir, 'site');
      // The page starts with one fault of its own: a 9px line of legal text.
      await fixtureSite(site, { tinyText: true });
      const out = path.join(dir, 'out');
      const server = await serveStatic(site, 4744);
      const events = [];
      const said = [];
      try {
        await runAnnotate({
          browser,
          store: await openStore(dir),
          url: server.url,
          outDir: out,
          projectDir: site,
          viewport: { width: 1100, height: 700 },
          onEvent: (e) => events.push(e),
          onReady: async (page) => {
            const send = async (sel, txt) => {
              await page.click(sel);
              await page.waitForSelector('.ayna-ov-pop textarea');
              await page.fill('.ayna-ov-pop textarea', txt);
              await page.click('.ayna-ov-save');
              await page.waitForTimeout(400);
              await page.click('[data-act=send]');
              await page.waitForTimeout(600);
            };
            const checkLine = async (n) => {
              await page.waitForFunction(
                (n) => document.querySelectorAll('.ayna-ov-round')[n - 1]?.querySelector('[data-lane=ayna] span'),
                n,
                { timeout: 20000 },
              );
              return page.evaluate((n) => {
                const row = document.querySelectorAll('.ayna-ov-round')[n - 1].querySelector('[data-lane=ayna]');
                return row.querySelector('span').textContent + ' | ' + (row.querySelector('small')?.textContent ?? '');
              }, n);
            };

            // Round 1 changes nothing measurable.
            await send('.title', 'tighten this');
            await writeFile(path.join(out, 'applied'), '1');
            said.push(await checkLine(1));

            // Round 2 brings a second line of tiny text with it.
            await press(page, 'more');
            await page.waitForTimeout(400);
            await send('.lede', 'add a disclaimer');
            const html = path.join(site, 'index.html');
            const page2 = (await readFile(html, 'utf8')).replace(
              '</main>',
              '<small style="font-size:9px">terms apply</small></main>',
            );
            await writeFile(html, page2);
            await writeFile(path.join(out, 'applied'), '1');
            said.push(await checkLine(2));
            await page.close();
          },
        });

        const [first, second] = events.filter((e) => e.event === 'gate');
        assert.equal(first.before.tinyText, 1, 'the baseline is taken when the round is sent');
        assert.equal(first.added.tinyText, 0, 'a fault that was already there is not the round\'s');
        assert.equal(second.added.tinyText, 1, 'the one the round brought is');
        // The fixture has a fault or two besides the tiny text; whatever it has was there first.
        const total = (counts) => Object.values(counts).reduce((a, b) => a + b, 0);
        assert.equal(said[0], `No new faults | ${total(first.counts)} already there`);
        assert.equal(
          said[1],
          `1 new fault since this round | 1 text under 12px · ${total(second.counts) - 1} already there`,
        );
      } finally {
        await server.close();
      }
    } finally {
      await dispose();
    }
  });

  test('a round lists the files it changed, opens each to its diff, and can be undone, but not over later work', async () => {
    const { dir, dispose } = await tempDir();
    try {
      const { openStore } = await import('../src/tasks.mjs');
      const site = path.join(dir, 'site');
      await fixtureSite(site);
      const css = path.join(site, 'styles.css');
      const original = await readFile(css, 'utf8');
      const out = path.join(dir, 'out');
      const server = await serveStatic(site, 4745);
      const store = await openStore(dir);
      const events = [];
      const seen = {};
      try {
        await runAnnotate({
          browser,
          store,
          url: server.url,
          outDir: out,
          projectDir: site,
          viewport: { width: 1100, height: 700 },
          onEvent: (e) => events.push(e),
          onReady: async (page) => {
            await page.click('.title');
            await page.waitForSelector('.ayna-ov-pop textarea');
            await page.fill('.ayna-ov-pop textarea', 'tighten the headline');
            await page.click('.ayna-ov-save');
            await page.waitForTimeout(400);
            await page.click('[data-act=send]');
            await page.waitForTimeout(600);

            // Claude's edit, and a file it saved without changing.
            await writeFile(css, original + '.title{letter-spacing:-0.02em}\n');
            await writeFile(path.join(site, 'index.html'), await readFile(path.join(site, 'index.html'), 'utf8'));
            await writeFile(path.join(out, 'applied'), '1');

            await page.waitForSelector('.ayna-ov-round .ayna-ov-file', { timeout: 20000 });
            await page.click('.ayna-ov-round .ayna-ov-file');
            await page.waitForSelector('.ayna-ov-diff', { timeout: 5000 });
            seen.shown = await page.evaluate(() => ({
              finished: [...document.querySelectorAll('.ayna-ov-round .ayna-ov-item[data-lane=claude] > span')].map((s) => s.textContent),
              files: [...document.querySelectorAll('.ayna-ov-file')].map((f) => f.textContent),
              diff: [...document.querySelectorAll('.ayna-ov-diff div')].map((d) => d.dataset.t + d.textContent),
            }));

            await page.waitForSelector('.ayna-ov-round [data-act=undo]', { timeout: 20000 });
            await page.evaluate(() => window.__aynaResolve(1, 'approved'));
            // A card left over from another process asks with that process's key.
            seen.stale = await page.evaluate(() => window.__aynaUndo('abcdef.1'));

            // Someone edits the same file again before the undo.
            await writeFile(css, original + '.title{letter-spacing:-0.03em}\n');
            await page.click('.ayna-ov-round [data-act=undo]');
            await page.click('.ayna-ov-round [data-act=undo-confirm]');
            await page.waitForFunction(() => document.querySelector('.ayna-ov-round-acts span')?.textContent, null, {
              timeout: 5000,
            });
            seen.refused = await page.evaluate(() => document.querySelector('.ayna-ov-round-acts span').textContent);
            seen.afterRefusal = await readFile(css, 'utf8');

            // Put the round's version back, and the undo goes through.
            await writeFile(css, original + '.title{letter-spacing:-0.02em}\n');
            await page.click('.ayna-ov-round [data-act=undo]');
            await page.click('.ayna-ov-round [data-act=undo-confirm]');
            await page.waitForFunction(
              () => document.querySelector('.ayna-ov-round')?.dataset.state === 'undone',
              null,
              { timeout: 10000 },
            );
            seen.card = await page.evaluate(() => ({
              pill: document.querySelector('.ayna-ov-pill').textContent,
              undoLeft: Boolean(document.querySelector('.ayna-ov-round [data-act=undo]')),
            }));
            seen.phase = await page.evaluate(() => window.__aynaState().then((s) => s.phase));
            await page.close();
          },
        });

        const applied = events.find((e) => e.event === 'applied');
        assert.deepEqual(applied.files, [{ file: 'styles.css', status: 'modified', added: 1, removed: 0 }]);
        assert.deepEqual(seen.shown.finished, ['Finished · 1 file']);
        assert.deepEqual(seen.shown.files, ['styles.css+1']);
        assert.ok(seen.shown.diff.includes('++ .title{letter-spacing:-0.02em}'), seen.shown.diff.join('\n'));

        assert.deepEqual(seen.stale, { ok: false, reason: 'that round was in an earlier window' });
        assert.equal(seen.refused, 'Not undone: styles.css changed after this round');
        assert.equal(seen.afterRefusal, original + '.title{letter-spacing:-0.03em}\n', 'the later edit was left alone');
        assert.equal(await readFile(css, 'utf8'), original, 'the stylesheet is back to before the round');
        assert.deepEqual(seen.card, { pill: 'Undone', undoLeft: false });
        assert.equal(seen.phase, 'commenting', 'with nothing left to judge, the window goes back to commenting');

        const undone = events.find((e) => e.event === 'undone');
        assert.deepEqual(undone.files, ['styles.css']);
        assert.equal(undone.action, 'files-reverted');
        const [task] = await store.list();
        assert.equal(task.status, 'open', 'an approved note is owed again once its change is gone');
      } finally {
        await server.close();
      }
    } finally {
      await dispose();
    }
  });

  test("a round is approved only when every note it carried is, and outside notes are not drafts", async () => {
    const { dir, dispose } = await tempDir();
    try {
      const { openStore } = await import('../src/tasks.mjs');
      const site = path.join(dir, 'site');
      await fixtureSite(site);
      const out = path.join(dir, 'out');
      const server = await serveStatic(site, 4747);
      const store = await openStore(dir);
      // Left open by an earlier window; this one picks it up and sends it along.
      await store.create({ comment: 'carried from yesterday', url: server.url, selector: '.lede' });
      const seen = {};
      try {
        await runAnnotate({
          browser,
          store,
          url: server.url,
          outDir: out,
          projectDir: site,
          viewport: { width: 1100, height: 700 },
          onReady: async (page) => {
            const card = () =>
              page.evaluate(() => ({
                cards: document.querySelectorAll('.ayna-ov-round').length,
                pill: document.querySelector('.ayna-ov-round .ayna-ov-pill')?.textContent,
                carried: document.querySelector('.ayna-ov-round-note')?.textContent ?? null,
              }));
            await page.click('.title');
            await page.waitForSelector('.ayna-ov-pop textarea');
            await page.fill('.ayna-ov-pop textarea', 'written here');
            await page.click('.ayna-ov-save');
            await page.waitForTimeout(400);
            await page.click('[data-act=send]');
            await page.waitForTimeout(600);
            await writeFile(path.join(out, 'applied'), '1');
            await page.waitForFunction(() => document.querySelector('[data-act=close]') !== null, null, { timeout: 20000 });

            // A note filed from outside the window while this one is open.
            await store.create({ comment: 'filed by the CLI', url: server.url });
            await page.waitForTimeout(1500);
            seen.outside = await page.evaluate(() =>
              [...document.querySelectorAll('.ayna-ov-item')]
                .map((n) => n.querySelector('span').textContent + ' | ' + (n.querySelector('small')?.textContent ?? ''))
                .find((l) => l.startsWith('filed by the CLI')),
            );
            seen.outsideBy = await page.evaluate(() =>
              [...document.querySelectorAll('.ayna-ov-item')]
                .find((n) => n.querySelector('span').textContent === 'filed by the CLI')
                ?.querySelector('b').textContent,
            );

            // Only the note written here is judged: the carried one still waits.
            await page.evaluate(() => window.__aynaResolve(2, 'approved'));
            await page.waitForTimeout(1300);
            seen.half = await card();
            await page.evaluate(() => window.__aynaResolve(1, 'approved'));
            await page.waitForTimeout(1300);
            seen.all = await card();
            await page.close();
          },
        });

        assert.equal(seen.outside, 'filed by the CLI | filed outside this window · in Tasks');
        assert.equal(seen.outsideBy, 'You', "the user's own note is not signed by the checker");
        assert.deepEqual(seen.half, { cards: 1, pill: 'Your turn', carried: 'Also sends 1 earlier note' });
        assert.equal(seen.all.pill, 'Approved');
      } finally {
        await server.close();
      }
    } finally {
      await dispose();
    }
  });

  test("a note's crop is the element, not ayna's chrome drawn over it", async () => {
    const { dir, dispose } = await tempDir();
    try {
      const site = path.join(dir, 'site');
      await fixtureSite(site);
      const out = path.join(dir, 'out');
      const server = await serveStatic(site, 4748);
      let orange = null;
      try {
        await runAnnotate({
          browser,
          url: server.url,
          outDir: out,
          projectDir: site,
          viewport: { width: 1100, height: 700 },
          onReady: async (page) => {
            await page.click('.title');
            await page.waitForSelector('.ayna-ov-pop textarea');
            await page.fill('.ayna-ov-pop textarea', 'tighten this');
            await page.click('.ayna-ov-save');
            await page.waitForTimeout(500);
            const png = await readFile(path.join(out, 'comment-01', 'region.png'));
            // Count pixels in ayna's accent orange — the selection box, its label
            // and the numbered pin. The fixture's headline is dark text on white.
            orange = await page.evaluate(async (src) => {
              const img = new Image();
              img.src = src;
              await img.decode();
              const c = document.createElement('canvas');
              c.width = img.width;
              c.height = img.height;
              const ctx = c.getContext('2d');
              ctx.drawImage(img, 0, 0);
              const { data } = ctx.getImageData(0, 0, c.width, c.height);
              let n = 0;
              for (let i = 0; i < data.length; i += 4) {
                const [r, g, b] = [data[i], data[i + 1], data[i + 2]];
                if (r > 180 && g > 100 && g < 190 && b < 120) n += 1;
              }
              return n;
            }, 'data:image/png;base64,' + png.toString('base64'));
            await page.close();
          },
        });
        assert.equal(orange, 0, `the crop has ${orange} pixels of ayna's own chrome in it`);
      } finally {
        await server.close();
      }
    } finally {
      await dispose();
    }
  });

  test('the comment box never hides under the mode bar', async () => {
    const { dir, dispose } = await tempDir();
    try {
      const site = path.join(dir, 'site');
      const { mkdir } = await import('node:fs/promises');
      await mkdir(site, { recursive: true });
      await writeFile(
        path.join(site, 'index.html'),
        `<html><body style="margin:0;height:100vh">
           <p class="bottom" style="position:absolute;bottom:8px;left:20px">Right at the bottom edge</p>
         </body></html>`,
      );
      const server = await serveStatic(site, 4731);
      try {
        await runAnnotate({
          browser,
          url: server.url,
          outDir: path.join(dir, 'out'),
          projectDir: site,
          viewport: { width: 900, height: 600 },
          onReady: async (page) => {
            await page.click('.bottom');
            await page.waitForSelector('.ayna-ov-pop');
            const clear = await page.evaluate(() => {
              const pop = document.querySelector('.ayna-ov-pop').getBoundingClientRect();
              const bar = document.querySelector('.ayna-ov-bar').getBoundingClientRect();
              return pop.bottom <= bar.top || pop.top >= bar.bottom;
            });
            assert.ok(clear, 'the box does not overlap the bar, so its buttons are clickable');
            // and it is genuinely clickable
            await page.fill('.ayna-ov-pop textarea', 'reachable');
            await page.click('.ayna-ov-save');
            await page.waitForTimeout(400);
            assert.equal(await page.evaluate(() => document.querySelectorAll('.ayna-ov-pin').length), 1);
            await page.close();
          },
        });
      } finally {
        await server.close();
      }
    } finally {
      await dispose();
    }
  });
  test('the window says whether anyone will hear a round, and when Claude has it', async () => {
    /*
      "Waiting for Claude" was said to every round, and "Claude working" shown
      with it, whether or not any Claude was there. A window started from a
      plain terminal waited for minutes on a round nothing would ever read.
    */
    const { dir, dispose } = await tempDir();
    try {
      const { execFile } = await import('node:child_process');
      const { openStore } = await import('../src/tasks.mjs');
      const site = path.join(dir, 'site');
      await fixtureSite(site);
      await writeFile(
        path.join(dir, 'ayna.config.json'),
        JSON.stringify({ target: { name: 'c', root: 'site', url: 'http://127.0.0.1:4749/' } }),
      );
      const bin = path.resolve(fileURLToPath(new URL('../bin/ayna.mjs', import.meta.url)));
      const ayna = (...args) =>
        new Promise((res) => {
          execFile('node', [bin, ...args], { cwd: dir, timeout: 60_000 }, (e, so) => res((so || '').trim()));
        });

      const server = await serveStatic(site, 4749);
      const seen = {};
      try {
        await runAnnotate({
          browser,
          url: server.url,
          outDir: path.join(dir, 'out'),
          projectDir: dir,
          store: await openStore(dir),
          // Started from a plain terminal: no agent opened this window.
          agent: { tool: 'user', agentId: `local:pid-${process.pid}`, agentPid: process.pid, how: 'none' },
          viewport: { width: 1100, height: 700 },
          onReady: async (page) => {
            const bar = () =>
              page.evaluate(() => ({
                says: document.querySelector('.ayna-ov-waiting')?.textContent ?? '',
                chips: [...document.querySelectorAll('.ayna-ov-agent')].map((c) => c.textContent),
              }));
            await page.click('.title');
            await page.waitForSelector('.ayna-ov-pop textarea');
            await page.fill('.ayna-ov-pop textarea', 'tighten this');
            await page.click('.ayna-ov-save');
            await page.waitForTimeout(400);
            await page.click('[data-act=send]');
            await page.waitForTimeout(2600);
            seen.nobody = await bar();

            // Claude starts listening: `ayna wait` hears the round, and its heartbeat says so.
            seen.wait = await ayna('wait');
            await page.waitForTimeout(2600);
            seen.listening = await bar();

            // Reading the round's notes is picking it up.
            await ayna('comments', '--json');
            await page.waitForTimeout(2600);
            seen.pickedUp = await bar();
            await page.close();
          },
        });
      } finally {
        await server.close();
      }

      assert.match(seen.nobody.says, /no Claude session is listening/);
      assert.deepEqual(seen.nobody.chips, [], 'nothing may look busy when nothing is there');
      assert.match(seen.wait, /read-comments/);
      assert.match(seen.listening.says, /waiting for Claude to pick this up/);
      assert.deepEqual(seen.listening.chips, ['claudelistening']);
      assert.match(seen.pickedUp.says, /Claude has picked this up/);
      assert.deepEqual(seen.pickedUp.chips, ['claudeworking']);
    } finally {
      await dispose();
    }
  });
});
