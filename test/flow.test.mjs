/*
  Flow and QA drive a real Chrome, and until now were verified only by watching
  them run once. That is exactly how `npm test` stayed broken for hours earlier in
  this project's life, so they get the same treatment as everything else.
*/
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { writeFile, mkdir, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';

import { openBrowser } from '../src/browser.mjs';
import { serveStatic } from '../src/server.mjs';
import { runFlow, summarizeFlow } from '../src/flow.mjs';
import { loadFlows, runSuite, compareWithBaseline } from '../src/qa.mjs';
import { tempDir, hasBrowser } from './helpers.mjs';

/** A page with a slow control, a noisy one, and something that covers a button. */
async function appFixture(dir) {
  await mkdir(dir, { recursive: true });
  await writeFile(
    path.join(dir, 'index.html'),
    `<html><body style="margin:0;padding:24px;font-family:system-ui">
       <h1 class="title">Reports</h1>
       <input id="q" placeholder="filter">
       <button id="slow">Slow action</button>
       <button id="noisy">Noisy action</button>
       <button id="tiny" style="padding:0;width:30px;height:20px">x</button>
       <div id="panel" style="display:none;position:relative;height:120px">
         <p class="loaded">Panel is open</p>
         <button id="act" style="position:absolute;left:0;top:40px;width:120px;height:36px">Act</button>
         <!-- lands squarely on top of #act once the panel opens -->
         <div id="cover" style="position:absolute;left:0;top:36px;width:240px;height:48px;background:#333"></div>
       </div>
       <script>
         document.getElementById('slow').onclick = () => {
           setTimeout(() => { document.getElementById('panel').style.display = 'block'; }, 1200);
         };
         document.getElementById('noisy').onclick = () => { console.error('something went wrong'); };
       </script>
     </body></html>`,
  );
  return dir;
}

describe('flow', { skip: !hasBrowser && 'AYNA_SKIP_BROWSER set' }, () => {
  let browser;
  before(async () => {
    browser = await openBrowser({ headless: true });
  });
  after(async () => {
    await browser?.close();
  });

  test('runs the steps in order and records what each one did', async () => {
    const { dir, dispose } = await tempDir();
    try {
      const site = await appFixture(path.join(dir, 'site'));
      const server = await serveStatic(site, 4900);
      try {
        const record = await runFlow({
          browser,
          baseUrl: server.url,
          outDir: path.join(dir, 'out'),
          viewport: { width: 1000, height: 700 },
          flow: {
            name: 'filter and open',
            start: '/',
            steps: [
              { do: 'click', on: '#q' },
              { do: 'type', text: 'northwind' },
              { do: 'expect', text: 'Reports' },
            ],
          },
        });

        assert.equal(record.completed, true);
        assert.deepEqual(record.steps.map((s) => s.ok), [true, true, true]);
        assert.match(record.steps[0].note, /clicked #q/);
        assert.ok(record.steps.every((s) => existsSync(s.file)), 'a screenshot per step');
      } finally {
        await server.close();
      }
    } finally {
      await dispose();
    }
  });

  test('never echoes what was typed, in case a flow carries a password', async () => {
    const { dir, dispose } = await tempDir();
    try {
      const site = await appFixture(path.join(dir, 'site'));
      const server = await serveStatic(site, 4901);
      try {
        const record = await runFlow({
          browser,
          baseUrl: server.url,
          outDir: path.join(dir, 'out'),
          viewport: { width: 1000, height: 700 },
          flow: { start: '/', steps: [{ do: 'type', on: '#q', text: 'hunter2-secret' }] },
        });
        const dumped = JSON.stringify(record);
        assert.ok(!dumped.includes('hunter2-secret'), 'the typed value is not in the record');
        assert.match(record.steps[0].note, /14 characters/);
      } finally {
        await server.close();
      }
    } finally {
      await dispose();
    }
  });

  test('a failed step stops the run, unless it is marked optional', async () => {
    const { dir, dispose } = await tempDir();
    try {
      const site = await appFixture(path.join(dir, 'site'));
      const server = await serveStatic(site, 4902);
      try {
        const stopped = await runFlow({
          browser,
          baseUrl: server.url,
          outDir: path.join(dir, 'a'),
          viewport: { width: 1000, height: 700 },
          flow: {
            start: '/',
            steps: [
              { do: 'expect', text: 'Reports' },
              { do: 'expect', text: 'not on this page', timeout: 1500 },
              { do: 'expect', text: 'Reports' },
            ],
          },
        });
        assert.equal(stopped.completed, false);
        assert.equal(stopped.failedAt.n, 2);
        assert.equal(stopped.steps.length, 2, 'it does not carry on past a failure');

        const carriedOn = await runFlow({
          browser,
          baseUrl: server.url,
          outDir: path.join(dir, 'b'),
          viewport: { width: 1000, height: 700 },
          flow: {
            start: '/',
            steps: [
              { do: 'click', on: '#nothing-here', optional: true, timeout: 1200 },
              { do: 'expect', text: 'Reports' },
            ],
          },
        });
        assert.equal(carriedOn.steps.length, 2, 'an optional failure is not the end');
        assert.equal(carriedOn.steps[0].ok, false);
        assert.equal(carriedOn.steps[1].ok, true);
      } finally {
        await server.close();
      }
    } finally {
      await dispose();
    }
  });

  test('measures each step: settle time, focus, and the size of what was clicked', async () => {
    const { dir, dispose } = await tempDir();
    try {
      const site = await appFixture(path.join(dir, 'site'));
      const server = await serveStatic(site, 4903);
      try {
        const record = await runFlow({
          browser,
          baseUrl: server.url,
          outDir: path.join(dir, 'out'),
          viewport: { width: 1000, height: 700 },
          flow: {
            start: '/',
            steps: [
              { do: 'click', on: '#tiny' },
              { do: 'click', on: '#slow' },
              { do: 'wait', for: '.loaded' },
            ],
          },
        });

        const tiny = record.steps[0];
        assert.deepEqual(tiny.clickTarget, { w: 30, h: 20 });
        assert.equal(tiny.smallTarget, true, 'under the 44px floor');

        assert.ok(record.steps[2].settleMs > 800, 'the wait reflects how long it really took');
        assert.ok(record.steps[0].metrics, 'metrics are captured, not silently dropped');
        assert.equal(typeof record.steps[0].metrics.focusLost, 'boolean');
        assert.equal(typeof record.steps[0].metrics.layoutShift, 'number');
      } finally {
        await server.close();
      }
    } finally {
      await dispose();
    }
  });

  test('a console error is attributed to the step that caused it', async () => {
    const { dir, dispose } = await tempDir();
    try {
      const site = await appFixture(path.join(dir, 'site'));
      const server = await serveStatic(site, 4904);
      try {
        const record = await runFlow({
          browser,
          baseUrl: server.url,
          outDir: path.join(dir, 'out'),
          viewport: { width: 1000, height: 700 },
          flow: {
            start: '/',
            steps: [{ do: 'click', on: '#q' }, { do: 'click', on: '#noisy' }, { do: 'click', on: '#q' }],
          },
        });
        assert.deepEqual(
          record.steps.map((s) => s.newConsoleErrors.length),
          [0, 1, 0],
          'the noisy step owns the error, not the ones either side',
        );
        assert.match(summarizeFlow(record), /new console error/);
      } finally {
        await server.close();
      }
    } finally {
      await dispose();
    }
  });
});

describe('qa', { skip: !hasBrowser && 'AYNA_SKIP_BROWSER set' }, () => {
  let browser;
  before(async () => {
    browser = await openBrowser({ headless: true });
  });
  after(async () => {
    await browser?.close();
  });

  async function flowsDir(dir, flows) {
    const d = path.join(dir, 'ayna-flows');
    await mkdir(d, { recursive: true });
    for (const [name, body] of Object.entries(flows)) {
      await writeFile(path.join(d, name), typeof body === 'string' ? body : JSON.stringify(body));
    }
    return d;
  }

  test('loads flows in a stable order and survives a broken one', async () => {
    const { dir, dispose } = await tempDir();
    try {
      const d = await flowsDir(dir, {
        'b.json': { name: 'second', steps: [] },
        'a.json': { name: 'first', steps: [] },
        'bad.json': '{ not json',
      });
      const flows = await loadFlows(d);
      assert.deepEqual(flows.map((f) => f.file), ['a.json', 'b.json', 'bad.json']);
      assert.ok(flows[2].broken, 'the unreadable one is reported rather than throwing');
    } finally {
      await dispose();
    }
  });

  test('passes a healthy flow and fails one that breaks its own assertions', async () => {
    const { dir, dispose } = await tempDir();
    try {
      const site = await appFixture(path.join(dir, 'site'));
      const d = await flowsDir(dir, {
        'ok.json': {
          name: 'healthy',
          start: '/',
          assert: { noConsoleErrors: true, noLayoutFaults: [] },
          steps: [{ do: 'expect', text: 'Reports' }],
        },
        'noisy.json': {
          name: 'noisy',
          start: '/',
          assert: { noConsoleErrors: true, noLayoutFaults: [] },
          steps: [{ do: 'click', on: '#noisy' }],
        },
        'slow.json': {
          name: 'over budget',
          start: '/',
          assert: { maxSettleMs: 300, noLayoutFaults: [] },
          steps: [{ do: 'click', on: '#slow' }, { do: 'wait', for: '.loaded' }],
        },
      });

      const server = await serveStatic(site, 4905);
      try {
        const suite = await runSuite({
          browser,
          baseUrl: server.url,
          flows: await loadFlows(d),
          outDir: path.join(dir, 'qa'),
          viewports: [{ name: 'desktop', width: 1000, height: 700 }],
        });

        const by = Object.fromEntries(suite.results.map((r) => [r.name, r]));
        assert.equal(by.healthy.passed, true);
        assert.equal(by.noisy.passed, false);
        assert.match(by.noisy.failures[0].rule, /noConsoleErrors/);
        assert.equal(by['over budget'].passed, false);
        assert.match(by['over budget'].failures[0].rule, /maxSettleMs/);

        assert.equal(suite.passed, 1);
        assert.equal(suite.failed, 2);
        assert.ok(existsSync(path.join(dir, 'qa', 'qa.json')));
        assert.ok(existsSync(path.join(dir, 'qa', 'qa-report.html')), 'a report a human can read');
      } finally {
        await server.close();
      }
    } finally {
      await dispose();
    }
  });

  test('a flow whose steps all pass still fails if it left a control covered', async () => {
    const { dir, dispose } = await tempDir();
    try {
      const site = await appFixture(path.join(dir, 'site'));
      const d = await flowsDir(dir, {
        'reveal.json': {
          name: 'opens the panel',
          start: '/',
          // The panel is fine until it opens; then #cover lands on #act.
          assert: { noLayoutFaults: ['covered'] },
          steps: [{ do: 'click', on: '#slow' }, { do: 'wait', for: '.loaded' }],
        },
      });

      const server = await serveStatic(site, 4906);
      try {
        const suite = await runSuite({
          browser,
          baseUrl: server.url,
          flows: await loadFlows(d),
          outDir: path.join(dir, 'qa'),
          viewports: [{ name: 'desktop', width: 1000, height: 700 }],
        });

        const r = suite.results[0];
        assert.ok(
          r.record.steps.every((s) => s.ok),
          'every step succeeded — this is the case a step-based test would call green',
        );
        assert.equal(r.passed, false, 'but the state it left behind has a covered control');
        assert.match(r.failures[0].rule, /noLayoutFaults:covered/);
      } finally {
        await server.close();
      }
    } finally {
      await dispose();
    }
  });

  test('the baseline diff says what changed, not just what is', async () => {
    const { dir, dispose } = await tempDir();
    try {
      const baseline = path.join(dir, 'baseline.json');
      await writeFile(
        baseline,
        JSON.stringify({
          results: [
            { name: 'steady', passed: true, durationMs: 500, audit: { counts: { covered: 0 } } },
            { name: 'was broken', passed: false, durationMs: 400, audit: { counts: { covered: 0 } } },
            { name: 'gets slower', passed: true, durationMs: 500, audit: { counts: { covered: 0 } } },
            { name: 'gains a fault', passed: true, durationMs: 500, audit: { counts: { covered: 0 } } },
          ],
        }),
      );

      const changes = await compareWithBaseline(
        {
          results: [
            { name: 'steady', passed: true, durationMs: 520, audit: { counts: { covered: 0 } } },
            { name: 'was broken', passed: true, durationMs: 420, audit: { counts: { covered: 0 } } },
            { name: 'gets slower', passed: true, durationMs: 4200, audit: { counts: { covered: 0 } } },
            { name: 'gains a fault', passed: true, durationMs: 500, audit: { counts: { covered: 2 } } },
            { name: 'brand new', passed: true, durationMs: 100 },
          ],
        },
        baseline,
      );

      const by = Object.fromEntries(changes.map((c) => [c.name, c]));
      assert.equal(by['was broken'].change, 'fixed');
      assert.equal(by['gets slower'].change, 'slower');
      assert.equal(by['gains a fault'].change, 'new-layout-fault');
      assert.equal(by['brand new'].change, 'new');
      assert.ok(!by.steady, 'a flow that did not change is not mentioned');
    } finally {
      await dispose();
    }
  });

  test('no baseline is not an error', async () => {
    const { dir, dispose } = await tempDir();
    try {
      assert.equal(await compareWithBaseline({ results: [] }, path.join(dir, 'missing.json')), null);
    } finally {
      await dispose();
    }
  });
});
