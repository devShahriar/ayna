import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';

import { runFlow } from './flow.mjs';
import { auditPage } from './audit.mjs';

/**
 * Run every flow in a directory and decide, without argument, whether the UI is
 * still good.
 *
 * A flow on its own answers "does the journey still work". That misses the way UI
 * actually rots: the steps keep passing while a control slides behind a panel and
 * a heading starts overflowing. So each flow ends in a layout audit, and a run
 * fails on what the page can prove — not on anyone's reading of a screenshot.
 */

const DEFAULT_ASSERT = {
  allStepsPass: true,
  noConsoleErrors: true,
  noLayoutFaults: ['covered', 'offscreen'],
  maxSettleMs: null,
  maxTotalMs: null,
};

/** Flow files, in a stable order so a report can be compared to the last one. */
export async function loadFlows(dir) {
  if (!existsSync(dir)) return [];
  const files = (await readdir(dir)).filter((f) => f.endsWith('.json')).sort();
  const flows = [];
  for (const f of files) {
    try {
      const flow = JSON.parse(await readFile(path.join(dir, f), 'utf8'));
      flows.push({ file: f, ...flow, name: flow.name ?? path.basename(f, '.json') });
    } catch (err) {
      flows.push({ file: f, name: path.basename(f, '.json'), broken: err.message });
    }
  }
  return flows;
}

function judge(flow, record, audit) {
  const rules = { ...DEFAULT_ASSERT, ...(flow.assert ?? {}) };
  const failures = [];

  if (rules.allStepsPass && !record.completed) {
    failures.push({
      rule: 'allStepsPass',
      detail: `step ${record.failedAt.n} failed: ${record.failedAt.error}`,
    });
  }

  // noConsoleErrors may be `true`, `false`, or { ignore: [substring, …] } so an
  // app that hosts third-party code can say which sources are not its problem.
  // Switching the gate off entirely would be the easy answer and would also stop
  // it catching the app's OWN errors, which is the only thing it is for.
  const ignoreConsole = Array.isArray(rules.noConsoleErrors?.ignore) ? rules.noConsoleErrors.ignore : [];
  const consoleMine = (line) => !ignoreConsole.some((pat) => String(line).includes(pat));

  if (rules.noConsoleErrors) {
    const noisy = record.steps.filter((s) => s.newConsoleErrors.length);
    for (const s of noisy) {
      const mine = (s.newConsoleErrors ?? []).filter(consoleMine);
      if (!mine.length) continue;
      failures.push({ rule: 'noConsoleErrors', detail: `step ${s.n}: ${mine[0]}` });
    }
  }

  if (rules.maxSettleMs) {
    for (const s of record.steps.filter((s) => s.settleMs > rules.maxSettleMs)) {
      failures.push({
        rule: 'maxSettleMs',
        detail: `step ${s.n} took ${s.settleMs}ms (budget ${rules.maxSettleMs}ms)`,
      });
    }
  }

  if (rules.maxTotalMs && record.totals.durationMs > rules.maxTotalMs) {
    failures.push({
      rule: 'maxTotalMs',
      detail: `${record.totals.durationMs}ms total (budget ${rules.maxTotalMs}ms)`,
    });
  }

  // The check a passing flow would otherwise hide.
  for (const kind of rules.noLayoutFaults ?? []) {
    const n = audit?.counts?.[kind] ?? 0;
    if (n > 0) failures.push({ rule: `noLayoutFaults:${kind}`, detail: `${n} found at the end of the flow` });
  }

  return failures;
}

export async function runSuite({ browser, context, baseUrl, flows, outDir, viewports }) {
  await mkdir(outDir, { recursive: true });
  const results = [];

  for (const flow of flows) {
    if (flow.broken) {
      results.push({ name: flow.name, file: flow.file, passed: false, failures: [{ rule: 'parse', detail: flow.broken }] });
      continue;
    }

    const flowDir = path.join(outDir, flow.name.replace(/[^\w-]+/g, '-').toLowerCase());
    const record = await runFlow({ browser, context, baseUrl, flow, outDir: flowDir, viewport: viewports[0] });

    /*
      Audit where the flow left the app, which means walking it there again.

      Pointing the audit at the URL the flow ended on looked equivalent and was
      not: a fresh load throws away everything the steps did, so a panel the flow
      opened is closed again and every fault inside it invisible. The reason to
      audit after a flow is to see the state only the flow can reach, so the steps
      are replayed first. That costs a second run of the journey; measuring the
      wrong page costs more.
    */
    let audit = null;
    const wants = (flow.assert?.noLayoutFaults ?? DEFAULT_ASSERT.noLayoutFaults) ?? [];
    if (wants.length) {
      audit = await auditPage({
        browser,
        context,
        url: record.start,
        steps: flow.steps ?? [],
        viewports: [viewports[0]],
        outDir: path.join(flowDir, 'audit'),
      }).catch(() => null);
    }

    const failures = judge(flow, record, audit);
    results.push({
      name: flow.name,
      file: flow.file,
      passed: failures.length === 0,
      failures,
      steps: record.steps.length,
      durationMs: record.totals.durationMs,
      dir: flowDir,
      audit: audit && { counts: audit.counts, screenshot: audit.findings[0]?.screenshot },
      record,
    });
  }

  const suite = {
    ranAt: outDir,
    baseUrl,
    total: results.length,
    passed: results.filter((r) => r.passed).length,
    failed: results.filter((r) => !r.passed).length,
    results,
  };
  await writeFile(path.join(outDir, 'qa.json'), JSON.stringify(suite, null, 2));
  await writeFile(path.join(outDir, 'qa-report.html'), report(suite));
  return suite;
}

/** Compare with a previous run so a team sees what changed, not just what is. */
export async function compareWithBaseline(suite, baselineFile) {
  if (!existsSync(baselineFile)) return null;
  let base;
  try {
    base = JSON.parse(await readFile(baselineFile, 'utf8'));
  } catch {
    return null;
  }
  const byName = Object.fromEntries((base.results ?? []).map((r) => [r.name, r]));
  const changes = [];

  for (const r of suite.results) {
    const was = byName[r.name];
    if (!was) {
      changes.push({ name: r.name, change: 'new' });
      continue;
    }
    if (was.passed && !r.passed) changes.push({ name: r.name, change: 'broke', failures: r.failures });
    else if (!was.passed && r.passed) changes.push({ name: r.name, change: 'fixed' });

    // A flow that still passes but got materially slower is worth saying.
    if (was.durationMs && r.durationMs > was.durationMs * 1.5 && r.durationMs - was.durationMs > 1000) {
      changes.push({
        name: r.name,
        change: 'slower',
        detail: `${was.durationMs}ms → ${r.durationMs}ms`,
      });
    }
    const before = was.audit?.counts ?? {};
    const now = r.audit?.counts ?? {};
    for (const kind of ['covered', 'offscreen', 'overlaps', 'clipped']) {
      if ((now[kind] ?? 0) > (before[kind] ?? 0)) {
        changes.push({ name: r.name, change: 'new-layout-fault', detail: `${kind}: ${before[kind] ?? 0} → ${now[kind]}` });
      }
    }
  }
  return changes;
}

const esc = (s) =>
  String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

function report(suite) {
  const flow = (r) => `
    <section class="${r.passed ? 'pass' : 'fail'}">
      <header><h2>${esc(r.name)}</h2><span class="badge">${r.passed ? 'passed' : 'failed'}</span>
        <span class="meta">${r.steps ?? 0} steps · ${Math.round((r.durationMs ?? 0) / 100) / 10}s</span></header>
      ${
        r.failures.length
          ? `<ul class="failures">${r.failures.map((f) => `<li><code>${esc(f.rule)}</code> ${esc(f.detail)}</li>`).join('')}</ul>`
          : ''
      }
      ${
        r.record
          ? `<div class="strip">${r.record.steps
              .map(
                (s) => `<figure class="${s.ok ? '' : 'bad'}">
                   <img src="${esc(path.relative(suite.ranAt, s.file))}" loading="lazy">
                   <figcaption>${s.n}. ${esc(s.note ?? s.step.do)}${s.settleMs > 2000 ? ` · ${s.settleMs}ms` : ''}</figcaption>
                 </figure>`,
              )
              .join('')}</div>`
          : ''
      }
    </section>`;

  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>ayna qa</title><style>
:root{color-scheme:dark;--bg:#0c0d10;--panel:#14161b;--line:#242832;--ink:#e8eaf0;--mute:#8b93a7}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);
font:15px/1.6 ui-sans-serif,-apple-system,system-ui,sans-serif}
.wrap{max-width:1200px;margin:0 auto;padding:40px 24px 80px}
h1{font-size:26px;letter-spacing:-.02em;margin:0 0 6px}
.summary{color:var(--mute);margin-bottom:28px}
section{background:var(--panel);border:1px solid var(--line);border-radius:14px;padding:22px;margin-bottom:20px}
section.fail{border-color:#5c2b2b}
header{display:flex;align-items:center;gap:12px;margin-bottom:10px}
h2{font-size:17px;margin:0}
.badge{font-size:11px;text-transform:uppercase;letter-spacing:.08em;padding:2px 9px;border-radius:99px;
border:1px solid currentColor}
section.pass .badge{color:#69db7c}section.fail .badge{color:#ff8787}
.meta{color:var(--mute);font-size:13px;margin-left:auto}
.failures{margin:0 0 14px;padding-left:18px}.failures li{color:#ffa94d;font-size:14px}
.failures code{background:#1c1f27;padding:1px 6px;border-radius:5px;color:#ffd8a8}
.strip{display:flex;gap:10px;overflow-x:auto;padding-bottom:6px}
figure{margin:0;flex:0 0 210px}
figure img{width:100%;border:1px solid var(--line);border-radius:8px;display:block;background:#fff;
height:132px;object-fit:cover;object-position:top}
figure.bad img{border-color:#ff8787}
figcaption{font-size:11px;color:var(--mute);margin-top:5px}
</style></head><body><div class="wrap">
<h1>ayna qa</h1>
<div class="summary">${suite.passed} of ${suite.total} flows passed · ${esc(suite.baseUrl)}</div>
${suite.results.map(flow).join('')}
</div></body></html>`;
}
