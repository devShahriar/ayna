/*
  The bugs you only find by using it.

  Each of these was reported as "it lags" or "the window jumps" — descriptions that
  point at no line of code. They were found by driving the real overlay and
  measuring, and they are pinned here because every one of them is invisible in a
  screenshot and silent in a normal test.
*/
import { test, describe, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { openBrowser, gotoSettled } from '../src/browser.mjs';
import { runAnnotate } from '../src/annotate.mjs';
import { openStore } from '../src/tasks.mjs';
import { pending as pendingWork, since as pendingEvents } from '../src/events.mjs';
import { hasBrowser, press, launchBrowser } from './helpers.mjs';

/** A server that behaves like a real dev server: it never stops talking. */
function pollingServer(bodyHtml, { doctype = true } = {}) {
  const srv = http.createServer((req, res) => {
    if (req.url.startsWith('/poll')) {
      // Long-poll: headers withheld, so the request stays in flight forever.
      setTimeout(() => {
        res.writeHead(200);
        res.end('{}');
      }, 25_000).unref();
      return;
    }
    if (req.url.startsWith('/api')) {
      res.writeHead(200);
      res.end('{}');
      return;
    }
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end(
      (doctype ? '<!doctype html>' : '') +
        `<body style="margin:0">${bodyHtml}
         <script>fetch('/poll'); setInterval(() => fetch('/api'), 400);</script></body>`,
    );
  });
  return new Promise((resolve) =>
    srv.listen(0, () => resolve({ srv, url: `http://127.0.0.1:${srv.address().port}/` })),
  );
}

const cards = (n) =>
  Array.from({ length: n }, (_, i) => `<div class="card" id="c${i}"><h3>Card ${i}</h3><button>Go ${i}</button></div>`).join('');
const CARD_CSS = '<style>.card{border:1px solid #ccc;padding:10px;margin:6px}</style>';

describe('the console in the window', { skip: !hasBrowser && 'AYNA_SKIP_BROWSER set' }, () => {
  let browser;
  beforeEach(async () => {
    browser = await launchBrowser();
  });
  afterEach(async () => {
    await browser?.close().catch(() => {});
  });

  /*
    The event stream went to stdout, so following a review meant watching a
    window and a terminal at once and the person who wanted to stay on the page
    kept having to leave it. Same stream, on the page, both directions.
  */
  async function withConsole(run, { store = true } = {}) {
    const { srv, url } = await pollingServer('<h1 class="t">Hello</h1><div style="height:1200px"></div>');
    const dir = await mkdtemp(path.join(tmpdir(), 'ayna-console-'));
    try {
      await runAnnotate({
        browser,
        url,
        outDir: path.join(dir, 'out'),
        projectDir: dir,
        store: store ? await openStore(dir) : undefined,
        /*
          Opened by Claude, said outright. Left to identify(), this was Claude
          only when the tests themselves ran inside Claude Code; on CI nothing
          was attached, the window rightly showed no "claude" chip, and the
          tests that read it failed there and nowhere else.
        */
        agent: { tool: 'claude', agentId: 'claude:test', agentPid: process.pid, how: 'env:CLAUDE_CODE_SESSION_ID' },
        viewport: { width: 1200, height: 800 },
        onReady: async (page) => {
          await page.waitForTimeout(900);
          await run(page, dir);
          await page.close();
        },
      });
    } finally {
      srv.close();
      await rm(dir, { recursive: true, force: true });
    }
  }

  // The console is a rail down the left now, so the edge that can be covered is
  // the page's left one, not its bottom.
  const overlap = (page) =>
    page.evaluate(() => {
      const c = document.querySelector('.ayna-ov-console').getBoundingClientRect();
      const b = document.body.getBoundingClientRect();
      return Math.max(0, Math.round(c.right - b.left));
    });

  // One note on the page's heading.
  const note = async (page, text) => {
    await page.click('.t');
    await page.waitForSelector('.ayna-ov-pop textarea');
    await page.fill('.ayna-ov-pop textarea', text);
    await page.click('.ayna-ov-save');
    await page.waitForTimeout(400);
  };

  // Send what is noted, have it land, and approve it: round 1, settled.
  const approvedRound = async (page, dir) => {
    await page.click('[data-act=send]');
    await page.waitForTimeout(600);
    await writeFile(path.join(dir, 'out', 'applied'), '1');
    await page.waitForFunction(() => document.querySelector('[data-act=close]') !== null, null, { timeout: 20000 });
    await page.evaluate(() => window.__aynaResolve(1, 'approved'));
  };

  // The newest round card, as someone reading it sees it.
  const lastCard = (page) =>
    page.evaluate(() => {
      const c = [...document.querySelectorAll('.ayna-ov-round')].at(-1);
      return c && {
        title: c.querySelector('.ayna-ov-round-head b').textContent,
        pill: c.querySelector('.ayna-ov-pill').textContent,
        lines: [...c.querySelectorAll('.ayna-ov-item')].map(
          (n) => n.querySelector('b').textContent + ': ' + n.querySelector('span').textContent,
        ),
        cards: document.querySelectorAll('.ayna-ov-round').length,
      };
    });

  test('carries both sides of the conversation', async () => {
    const lines = [];
    await withConsole(async (page, dir) => {
      const { appendEvent, openDb } = await import('../src/db.mjs');
      appendEvent(await openDb(dir), { event: 'message', from: 'claude', text: 'starting on the nav now' });
      await page.waitForTimeout(1500);

      await page.fill('.ayna-ov-console input', 'make it wider too');
      await page.click('[data-act=say]');
      await page.waitForTimeout(1300);

      lines.push(...(await page.evaluate(() =>
        [...document.querySelectorAll('.ayna-ov-line')].map((n) => n.dataset.kind + ':' + n.querySelector('span').textContent),
      )));
    });
    assert.ok(
      lines.includes('message:starting on the nav now'),
      `Claude's line never reached the window: ${lines.join(' | ')}`,
    );
    assert.ok(lines.includes('you:make it wider too'), 'the reply typed on the page was lost');
  });

  test('a round is one card that says whose move it is', async () => {
    const seen = [];
    let brand = null;
    let head = null;
    await withConsole(async (page, dir) => {
      const card = () => lastCard(page);

      // innerText, not textContent: it is the name as drawn, after any CSS case change.
      brand = await page.evaluate(() => document.querySelector('.ayna-ov-brand').innerText);
      await page.click('.t');
      await page.waitForSelector('.ayna-ov-pop textarea');
      await page.fill('.ayna-ov-pop textarea', 'make it bigger');
      await page.click('.ayna-ov-save');
      await page.waitForTimeout(1300);
      seen.push(await card());

      await page.click('[data-act=send]');
      await page.waitForTimeout(1300);
      seen.push(await card());
      // With "claude working" showing, the fold stays on the title's line; the chips wrap below.
      await page.waitForSelector('.ayna-ov-agent', { timeout: 5000 });
      head = await page.evaluate(() => {
        const mid = (s) => {
          const r = document.querySelector(s).getBoundingClientRect();
          return Math.round(r.top + r.height / 2);
        };
        return { fold: mid('.ayna-ov-console [data-act=fold]') === mid('.ayna-ov-console-title'), chipBelow: mid('.ayna-ov-agent') > mid('.ayna-ov-console-title') };
      });

      await writeFile(path.join(dir, 'out', 'applied'), '1');
      await page.waitForFunction(() => document.querySelector('[data-act=close]') !== null, null, { timeout: 20000 });
      await page.waitForTimeout(1500);
      seen.push(await card());

      await page.evaluate(() => window.__aynaResolve(1, 'approved'));
      await page.waitForTimeout(1300);
      seen.push(await card());
    });

    const [drafting, sent, landed, judged] = seen;
    assert.equal(brand, 'Ayna', 'the bar shows the name capitalised');
    assert.deepEqual(head, { fold: true, chipBelow: true });
    // The note sits under its round from the start, not above a header drawn later.
    assert.deepEqual(drafting, { title: 'Next round', pill: 'Not sent yet', lines: ['You: make it bigger'], cards: 1 });
    assert.equal(sent.title, 'Round 1');
    assert.equal(sent.pill, 'Claude is working');
    assert.equal(sent.cards, 1, 'sending turns the draft into the round, it does not add a second card');
    assert.equal(landed.pill, 'Your turn');
    assert.ok(landed.lines.includes('Claude: Finished'), landed.lines.join(' | '));
    assert.ok(landed.lines.some((l) => l.startsWith('Ayna: ')), 'the check is signed by Ayna, not by Claude');
    assert.equal(judged.pill, 'Approved');
    assert.equal(judged.lines.at(-1), 'You: Approved');
    // Nothing speaks in ids or code names.
    assert.doesNotMatch(judged.lines.join(' '), /task-\d|lowContrast|smallTargets/);
  });

  test('a window with no task store still draws its notes and settles its round', async () => {
    let judged = null;
    await withConsole(
      async (page, dir) => {
        await note(page, 'make it bigger');
        await approvedRound(page, dir);
        await page.waitForTimeout(1300);
        judged = await lastCard(page);
      },
      { store: false },
    );
    assert.equal(judged.pill, 'Approved', 'the last approval settles the round without a store too');
    assert.ok(judged.lines.includes('You: make it bigger'), judged.lines.join(' | '));
  });

  test('a finished round folds when the next one starts, opens again on a click, and folds no message away', async () => {
    const seen = {};
    await withConsole(async (page, dir) => {
      const rounds = () =>
        page.evaluate(() =>
          [...document.querySelectorAll('.ayna-ov-round')].map((c) => ({
            title: c.querySelector('.ayna-ov-round-head b').textContent,
            folded: c.hasAttribute('data-folded'),
            expanded: c.querySelector('.ayna-ov-round-head').getAttribute('aria-expanded'),
            sum: c.querySelector('.ayna-ov-round-sum').textContent,
          })),
        );

      await note(page, 'make it bigger');
      await approvedRound(page, dir);
      // Said to the window, not to the round: these must not fold away with it.
      const { appendEvent, openDb } = await import('../src/db.mjs');
      appendEvent(await openDb(dir), { event: 'message', from: 'claude', text: 'tidied the spacing too' });
      await (await openStore(dir)).create({ status: 'proposed', kind: 'proposal', comment: 'try a darker blue', source: 'claude', url: null });
      await page.waitForTimeout(1500);
      seen.judged = await rounds();

      // The next round begins: the approved one gets out of the way.
      await press(page, 'more');
      await page.waitForTimeout(400);
      await note(page, 'and bolder');
      await page.waitForTimeout(1300);
      seen.next = await rounds();
      seen.loose = await page.evaluate(() => {
        const shown = (el) => Boolean(el && !el.closest('.ayna-ov-round') && el.getClientRects().length);
        return {
          message: shown([...document.querySelectorAll('.ayna-ov-line')].find((n) => n.textContent.includes('tidied the spacing too'))),
          suggestion: shown([...document.querySelectorAll('.ayna-ov-item')].find((n) => n.textContent.includes('try a darker blue'))),
        };
      });

      await page.click('.ayna-ov-round-head');
      seen.clicked = (await rounds())[0];
      await page.focus('.ayna-ov-round-head');
      await page.keyboard.press('Enter');
      seen.keyed = (await rounds())[0];

      // Opened by hand, it stays open through a reload.
      await page.click('.ayna-ov-round-head');
      await page.reload();
      await page.waitForSelector('.ayna-ov-round', { timeout: 10000 });
      await page.waitForTimeout(1500);
      seen.reloaded = (await rounds())[0];
    });

    assert.equal(seen.judged.length, 1);
    assert.equal(seen.judged[0].folded, false, 'the only round is never folded away');
    assert.deepEqual(
      seen.next.map((r) => [r.title, r.folded]),
      [['Round 1', true], ['Next round', false]],
    );
    assert.equal(seen.next[0].sum, '1 note', 'folded, it still says what it held');
    assert.deepEqual(seen.loose, { message: true, suggestion: true }, 'a message or suggestion stays in view, outside the folded card');
    assert.equal(seen.next[0].expanded, 'false');
    assert.equal(seen.clicked.folded, false);
    assert.equal(seen.keyed.folded, true, 'Enter on the header folds it, like a click');
    assert.equal(seen.reloaded.folded, false);
  });

  test('never covers the app, open or minimised', async () => {
    /*
      A panel that sits on top of the thing you are reviewing is not a panel.
      Across the bottom this needed a correction pass, because a first child's
      top margin collapses out through body and the box ended lower than the
      arithmetic said. Down the left there is no equivalent, but the assertion
      stays: whatever ayna draws over an app, the app gets that much less room
      rather than being covered.
    */
    const seen = {};
    const fold = (page) =>
      page.evaluate(() => {
        const b = document.querySelector('[data-act=fold]');
        return `${b.getAttribute('aria-label')}|${b.textContent.trim()}|${Boolean(b.querySelector('svg'))}`;
      });
    await withConsole(async (page) => {
      seen.open = await overlap(page);
      seen.foldOpen = await fold(page);
      await page.click('[data-act=fold]');
      await page.waitForTimeout(800);
      seen.minimised = await overlap(page);
      seen.foldMin = await fold(page);
      // Folded, the live dot sits beside the icon on one line, as in "● Activity".
      seen.spine = await page.evaluate(() => {
        const d = document.querySelector('.ayna-ov-dotlive').getBoundingClientRect();
        const b = document.querySelector('[data-act=fold]').getBoundingClientRect();
        return d.right <= b.left && Math.abs((d.top + d.bottom) / 2 - (b.top + b.bottom) / 2) <= 1 ? 'side by side' : 'stacked';
      });
      await page.click('[data-act=fold]');
      await page.waitForTimeout(800);
      seen.reopened = await overlap(page);
    });
    // The fold is the Activity icon in both states, with which way it goes in its label.
    assert.deepEqual(seen, {
      open: 0, minimised: 0, reopened: 0,
      foldOpen: 'Hide activity||true', foldMin: 'Show activity||true', spine: 'side by side',
    });
  });

  test('the rail starts on one edge, and the task list hangs under the bar and closes like a menu', async () => {
    const seen = {};
    await withConsole(async (page) => {
      // Measured first, while the rail still shows its empty state.
      seen.edges = await page.evaluate(() => {
        const rail = document.querySelector('.ayna-ov-console').getBoundingClientRect().left;
        const at = (sel) => Math.round(document.querySelector(sel).getBoundingClientRect().left - rail);
        return { header: at('.ayna-ov-dotlive'), empty: at('.ayna-ov-empty-lead'), say: at('.ayna-ov-say-box') };
      });

      const open = () => page.evaluate(() => Boolean(document.querySelector('.ayna-ov-panel')));
      await page.click('[data-act=tasks]');
      await page.waitForSelector('.ayna-ov-panel');
      seen.gap = await page.evaluate(
        () =>
          Math.round(document.querySelector('.ayna-ov-panel').getBoundingClientRect().top) -
          Math.round(document.querySelector('.ayna-ov-bar').getBoundingClientRect().bottom),
      );
      await page.mouse.click(700, 600); // the page, away from the list
      seen.outside = await open();
      await page.click('[data-act=tasks]');
      await page.waitForSelector('.ayna-ov-panel');
      await page.click('.ayna-ov-panel .ayna-ov-panel-head');
      seen.inside = await open();
      await page.keyboard.press('Escape');
      seen.escape = await open();
      await page.click('[data-act=tasks]');
      await page.waitForSelector('.ayna-ov-panel');
      await page.click('[data-act=tasks]');
      seen.toggled = await open();
    });
    // The task panel's empty state shares a class with the rail's, and its
    // padding once leaked in and pushed the rail's 14px further in than the rest.
    const { header } = seen.edges;
    assert.deepEqual(seen.edges, { header, empty: header, say: header });
    assert.deepEqual(
      { gap: seen.gap, outside: seen.outside, inside: seen.inside, escape: seen.escape, toggled: seen.toggled },
      { gap: 6, outside: false, inside: true, escape: false, toggled: false },
    );
  });

  test('typing in it does not reach the page underneath', async () => {
    // The page is in comment mode, where keystrokes are shortcuts.
    let comments = null;
    await withConsole(async (page) => {
      await page.fill('.ayna-ov-console input', 'escape and arrows and all');
      await page.press('.ayna-ov-console input', 'Escape');
      await page.press('.ayna-ov-console input', 'ArrowUp');
      await page.waitForTimeout(300);
      comments = await page.evaluate(() => document.querySelectorAll('.ayna-ov-pop').length);
    });
    assert.equal(comments, 0, 'typing in the console disturbed the review');
  });
});
