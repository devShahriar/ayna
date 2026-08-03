#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { readdir, mkdir, access, readFile, writeFile, rm, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadConfig, writeConfig } from '../src/config.mjs';
import { serveStatic } from '../src/server.mjs';
import { startTarget } from '../src/target.mjs';
import { openBrowser, capture, captureRoutes, openPersistentContext } from '../src/browser.mjs';
import { runClaude, ensureClaudeAvailable } from '../src/brain.mjs';
import { CRITIQUE_SCHEMA, critiquePrompt } from '../src/prompts.mjs';
import { runLoop } from '../src/loop.mjs';
import { snapshot, restore } from '../src/snapshot.mjs';
import { runAnnotate, loadComments } from '../src/annotate.mjs';
import { runFlow, summarizeFlow } from '../src/flow.mjs';
import { openStore, importLegacy, isPending, isProposal } from '../src/tasks.mjs';
import { auditPage, summarizeAudit } from '../src/audit.mjs';
import { loadFlows, runSuite, compareWithBaseline } from '../src/qa.mjs';
import { watchTasks } from '../src/watch.mjs';
import { waitForLogin } from '../src/login.mjs';
import { writeReport } from '../src/report.mjs';
import { banner, step, ok, info, warn, fail, dim, bold, cyan, green, yellow, red, openInDesktop } from '../src/log.mjs';

const ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url)));

const HELP = `
${bold('ayna')} — let Claude see the UI it builds

  Screenshots the running page in real Chrome, and lets you click, comment on and
  rearrange elements so Claude edits exactly what you meant.

${bold('USAGE')}
  ayna <command> [options]

${bold('TASKS')}
  tasks       Every comment ever made here and where it stands
  task        Show one, or move it: ayna task task-0003 --status in_progress
  propose     Put a change in front of the user before making it
  watch       Announce work as it appears; outlives any window (run under a monitor)

${bold('REVIEW')} — you point, Claude fixes
  annotate    Open the page so you can click, comment, attach images, reorder
  comments    What was marked up (--json for the full payload)
  status      Phase of the open review: commenting / awaiting-claude / reviewing
  wait        Block until the user sends a round, then exit (run in background)
  applied     Tell the open window the edits are in, so it reloads for approval

${bold('LOOK')}
  shot        Screenshot the target; --json prints paths + diagnostics to Read
  flow        Drive a described UI flow and measure every step
  audit       Find layout faults the page can prove: covered, cut off, overlapping
              (--flow steps.json to audit a state you have to click into)
  qa          Run every flow in ayna-flows/ and gate on the result (exit 1 on fail)
  clean       Drop old runs (--keep N, default 3); tasks and login are kept
  login       Open the app so you can sign in; the session is remembered
  serve       Serve the target UI and stay up (ctrl-c to stop)

${bold('SAFETY')}
  snapshot    Back up the UI directory before you edit it
  restore     Put it back if your edits made things worse

${bold('REPORT')}
  record      Log a round (--score, --note)
  report      Build the before/after HTML report

${bold('UNATTENDED')} — spawns its own Claude sessions, costs real money
  loop        The full look → critique → improve → verify cycle
  critique    Screenshot and critique once, without editing anything

${bold('SETUP')}
  init        Write ayna.config.json into the current project

${bold('OPTIONS')}
  -n, --iterations <n>   How many improvement rounds (default: config, 3)
  -m, --model <name>     opus | sonnet | haiku  (default: config, opus)
      --url <url>        The page to open — path, query and hash are honoured
      --routes <list>    Several pages at once, e.g. /,/pricing,/about
      --root <dir>       The UI directory to snapshot/restore
      --file <path>      A specific comments.json (comments)
      --json             Machine-readable output
      --events           Stream one JSON line per round/rejection/close (annotate)
      --flow <file>      Flow definition to run (flow)
      --dir <dir>        Where the flows live (qa, default ayna-flows/)
      --baseline <file>  Previous qa.json to compare against (qa)
      --score <n>        Score for this round (record)
      --note <text>      What changed this round (record)
      --comment <text>   What you are proposing (propose)
      --fix <text>       How you would fix it (propose)
      --selector <sel>   What it applies to (propose)
      --headed           Show the Chrome window (default: headless)
      --fresh-profile    Start annotate logged out (default: reuse the profile)
      --open             Open the HTML report when done
  -h, --help             This

${bold('EXAMPLES')}
  ayna annotate --url http://localhost:3000/d/abc123   Review a specific page
  ayna shot --json --routes /,/pricing                 Shoot several pages
  ayna snapshot --root src && ayna restore --root src  Undo a bad round
  ayna loop -n 3 --open                                Unattended, several dollars
`;

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    iterations: { type: 'string', short: 'n' },
    model: { type: 'string', short: 'm' },
    headless: { type: 'boolean' },
    headed: { type: 'boolean' },
    url: { type: 'string' },
    open: { type: 'boolean' },
    json: { type: 'boolean' },
    root: { type: 'string' },
    routes: { type: 'string' },
    events: { type: 'boolean' },
    since: { type: 'string' },
    consumer: { type: 'string' },
    follow: { type: 'boolean' },
    ndjson: { type: 'boolean' },
    flow: { type: 'string' },
    dir: { type: 'string' },
    baseline: { type: 'string' },
    keep: { type: 'string' },
    status: { type: 'string' },
    comment: { type: 'string' },
    fix: { type: 'string' },
    selector: { type: 'string' },
    file: { type: 'string' },
    'fresh-profile': { type: 'boolean' },
    'no-wait': { type: 'boolean' },
    score: { type: 'string' },
    note: { type: 'string' },
    help: { type: 'boolean', short: 'h' },
  },
});

// Where the user is working. When ayna runs as a plugin, this is their project —
// not the plugin install dir — so screenshots and snapshots belong here.
const PROJECT = process.cwd();
const SESSION_DIR = path.join(PROJECT, '.ayna', 'session');
const JOURNAL = path.join(SESSION_DIR, 'journal.json');

const command = positionals[0] ?? 'help';

async function main() {
  if (values.help || command === 'help') {
    console.log(HELP);
    return;
  }

  // A config in the user's project wins over the plugin's own defaults.
  const localConfig = path.join(PROJECT, 'ayna.config.json');
  const hasLocalConfig = existsSync(localConfig);
  const cfg = await loadConfig(hasLocalConfig ? PROJECT : ROOT);

  /*
    Without this guard, running ayna from a project that has no ayna.config.json
    falls back to the plugin's own defaults — which point at the bundled demo. You
    would get pristine screenshots of a landing page you have never seen, with no
    hint that it isn't your app. Fail loudly instead.
  */
  const NEEDS_TARGET = new Set(['shot', 'critique', 'annotate', 'loop', 'serve']);
  if (NEEDS_TARGET.has(command) && !hasLocalConfig && !values.url && PROJECT !== ROOT) {
    throw new Error(
      `no target for ${path.basename(PROJECT)}/ — ayna does not know what to look at.\n` +
        '  Point it at a running app:  ayna ' + command + ' --url http://localhost:3000\n' +
        '  Or create ayna.config.json here:  ayna init\n' +
        '  (without one, ayna would have shown you its own bundled demo)',
    );
  }

  // Artifacts always land in the project being worked on.
  cfg.runsDir = path.join(PROJECT, '.ayna', 'runs');
  if (values.root) cfg.targetDir = path.resolve(PROJECT, values.root);
  /*
    Which pages to capture.

    --routes wins. Otherwise, if --url points at a specific page, that page IS the
    target: resolving a default route of '/' against it would quietly discard the
    path and screenshot the site root instead — you would get a pristine shot of
    the wrong page with nothing indicating it.
  */
  const routes = (() => {
    if (values.routes) return values.routes.split(',').map((r) => r.trim()).filter(Boolean);
    if (values.url) {
      try {
        const u = new URL(values.url);
        const deep = u.pathname + u.search + u.hash;
        if (deep && deep !== '/') return [deep];
      } catch {
        // Not a parseable URL — fall through to the config.
      }
    }
    return cfg.target.routes?.length ? cfg.target.routes : ['/'];
  })();
  if (values.url) {
    cfg.target.url = values.url;
    cfg.target.startCommand = null;
  }

  switch (command) {
    case 'init': {
      // PROJECT, not ROOT: `ayna init` is how you configure *your* project. Writing
      // to ROOT put the file in the plugin's own directory, clobbering its config
      // while leaving the project exactly as unconfigured as before.
      if (hasLocalConfig) {
        warn(`${path.relative(PROJECT, localConfig)} already exists — leaving it alone`);
        return;
      }
      const file = await writeConfig(PROJECT);
      ok(`wrote ${path.relative(PROJECT, file)} — set target.url or target.root, then run \`ayna shot\``);
      return;
    }

    case 'serve': {
      const server = await serveStatic(cfg.targetDir, cfg.target.port);
      banner('ayna serve');
      ok(`${cfg.target.root}/ → ${server.url}`);
      info('ctrl-c to stop');
      await new Promise(() => {});
      return;
    }

    case 'shot': {
      const { browser, url, close, outDir } = await prepare(cfg, 'shot');
      const cap = await captureRoutes({
        browser,
        baseUrl: url,
        routes,
        viewports: cfg.viewports,
        outDir,
        label: 'shot',
      });
      await close();

      // Remember this shot so `record` can pair it into the report later.
      await mkdir(SESSION_DIR, { recursive: true });
      const shots = cap.shots.map((s) => ({ viewport: s.viewport, file: s.file }));
      await writeFile(path.join(SESSION_DIR, 'last-shot.json'), JSON.stringify({ shots }, null, 2));

      if (values.json) {
        // The machine-readable form the skill consumes.
        console.log(
          JSON.stringify(
            {
              url,
              routes: cap.routes,
              shots: cap.shots.map((s) => ({
                route: s.route ?? '/',
                url: s.url ?? url,
                viewport: s.viewport,
                width: s.width,
                height: s.height,
                file: s.file,
                loadError: s.loadError,
                transportError: s.transportError,
                horizontalOverflow: s.metrics?.horizontalOverflow ?? null,
                tinyTextNodes: s.metrics?.tinyTextNodes ?? null,
                textLength: s.metrics?.textLength ?? null,
              })),
              consoleErrors: cap.consoleErrors,
              pageErrors: cap.pageErrors,
              blank: cap.blank,
              hint: 'Read each `file` with the Read tool — that is the page as the user sees it.',
            },
            null,
            2,
          ),
        );
        return;
      }

      for (const s of cap.shots) {
        ok(`${s.route ?? '/'} ${s.viewport} → ${path.relative(PROJECT, s.file)}`);
      }
      if (cap.consoleErrors.length) warn(`console errors: ${cap.consoleErrors.length}`);
      return;
    }

    case 'tasks': {
      const store = await openStore(PROJECT);
      // Adopt anything captured before the store existed, so no work is stranded.
      const adopted = await importLegacy(PROJECT, store);
      const all = await store.list();
      const stats = await store.stats();

      if (values.json) {
        console.log(
          JSON.stringify(
            {
              ...stats,
              imported: adopted.imported,
              tasks: all.map((t) => ({
                id: t.id,
                status: t.status,
                kind: t.kind,
                comment: t.comment,
                url: t.url,
                selector: t.selector,
                regionScreenshot: t.regionScreenshot,
                attachments: t.attachments,
                sourceCandidates: (t.sourceCandidates ?? []).slice(0, 3),
                updatedAt: t.updatedAt,
              })),
              hint: 'Act on anything not approved. Read regionScreenshot and attachments first.',
            },
            null,
            2,
          ),
        );
        return;
      }

      banner(`ayna tasks · ${path.basename(PROJECT)}`);
      if (adopted.imported) info(`adopted ${adopted.imported} comment(s) from earlier sessions`);
      if (!all.length) {
        info('no tasks yet');
        return;
      }
      const COLOUR = { open: yellow, in_progress: cyan, applied: cyan, approved: green, rejected: red };
      for (const t of all) {
        const paint = COLOUR[t.status] ?? dim;
        console.log(`  ${paint(t.status.padEnd(12))} ${bold(t.id)}  ${(t.comment ?? '').slice(0, 60)}`);
        console.log(`               ${dim(t.url ?? '')}`);
      }
      console.log('');
      ok(`${stats.pending} pending · ${stats.approved} approved · ${stats.total} total`);
      return;
    }

    case 'qa': {
      const flowsDir = path.resolve(PROJECT, values.dir ?? cfg.qa?.dir ?? 'ayna-flows');
      const flows = await loadFlows(flowsDir);
      if (!flows.length) {
        throw new Error(
          `no flows in ${path.relative(PROJECT, flowsDir)}/ — put one .json per journey there, or pass --dir`,
        );
      }

      const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
      const outDir = path.join(PROJECT, '.ayna', 'qa', stamp);
      const server = await startTarget(cfg);
      const profileDir = values['fresh-profile'] ? null : path.join(PROJECT, '.ayna', 'profile');
      const context = profileDir
        ? await openPersistentContext({ profileDir, headless: headlessMode(cfg), viewport: cfg.viewports[0] })
        : null;
      const browser = context ? null : await openBrowser({ headless: headlessMode(cfg) });

      const suite = await runSuite({
        browser,
        context,
        baseUrl: server.url,
        flows,
        outDir,
        viewports: cfg.viewports,
      });

      if (context) await context.close().catch(() => {});
      else await browser.close().catch(() => {});
      await server.close().catch(() => {});

      const baselineFile = values.baseline
        ? path.resolve(PROJECT, values.baseline)
        : path.join(PROJECT, '.ayna', 'qa', 'baseline.json');
      const changes = await compareWithBaseline(suite, baselineFile);

      if (values.json) {
        console.log(JSON.stringify({ ...suite, changes }, null, 2));
      } else {
        banner(`ayna qa · ${flows.length} flow(s)`);
        for (const r of suite.results) {
          const mark = r.passed ? green('  pass') : red('  FAIL');
          console.log(`${mark}  ${bold(r.name)}  ${dim(`${r.steps ?? 0} steps · ${Math.round((r.durationMs ?? 0) / 100) / 10}s`)}`);
          for (const f of r.failures) console.log(`        ${yellow(f.rule)} — ${f.detail}`);
        }
        if (changes?.length) {
          console.log('');
          info('since the baseline:');
          for (const c of changes) console.log(`    ${c.name}: ${c.change}${c.detail ? ` (${c.detail})` : ''}`);
        }
        console.log('');
        (suite.failed ? fail : ok)(`${suite.passed}/${suite.total} flows passed`);
        info(`${path.relative(PROJECT, outDir)}/qa-report.html`);
      }

      // A QA run has to be usable as a gate.
      if (suite.failed) process.exitCode = 1;
      return;
    }

    case 'login': {
      /*
        The user signs in; Claude never does. It opens the window, waits for the
        sign-in screen to go away, and remembers the session so this is asked once
        instead of at the start of every review.
      */
      const server = await startTarget(cfg);
      const target = values.url ?? new URL(routes[0] ?? '/', server.url).toString();
      const profileDir = path.join(PROJECT, '.ayna', 'profile');

      banner('ayna login');
      info(`opening ${target}`);
      const result = await waitForLogin({
        profileDir,
        url: target,
        viewport: cfg.viewports[0],
        onState: (e) => {
          if (e.state === 'waiting') info('sign in in the window — I will wait, and I never see what you type');
          if (e.state === 'already-signed-in') ok('already signed in');
        },
      });
      await server.close().catch(() => {});

      if (values.json) {
        console.log(JSON.stringify(result));
        if (!result.signedIn) process.exitCode = 1;
        return;
      }
      if (result.signedIn) {
        ok(result.alreadySignedIn ? 'session already valid — nothing to do' : 'signed in; the session is saved');
        info('audits and reviews will start from here now');
      } else {
        fail(result.closed ? 'window closed before the sign-in finished' : 'timed out waiting for the sign-in');
        process.exitCode = 1;
      }
      return;
    }

    case 'propose': {
      /*
        A change Claude wants to make, put in front of the user before anything is
        edited. It lands in the same window as their own comments, with the same
        controls, so approving a suggestion and answering a comment are one habit
        rather than two.
      */
      if (!values.comment) throw new Error('what are you proposing? --comment "…" [--fix "…"] [--selector "…"]');
      const store = await openStore(PROJECT);
      const task = await store.create({
        status: 'proposed',
        kind: 'proposal',
        comment: values.comment,
        fix: values.fix ?? null,
        selector: values.selector ?? null,
        url: values.url ?? cfg.target.url ?? null,
        source: 'claude',
      });
      if (values.json) console.log(JSON.stringify(task, null, 2));
      else ok(`proposed ${task.id} — waiting for the user`);
      return;
    }

    /*
      What happened while nobody was looking.

      `watch` announces changes from now on, which is useless to a session that
      starts after the fact — and that is the common case, because sessions end
      and reviews do not. This reads the log instead, so being late costs nothing.
    */
    case 'events': {
      const { since, drain, follow } = await import('../src/events.mjs');
      const consumer = values.consumer ?? null;

      if (values.follow) {
        const controller = new AbortController();
        for (const sig of ['SIGINT', 'SIGTERM']) {
          process.on(sig, () => {
            controller.abort();
            process.exit(0);
          });
        }
        await follow(PROJECT, {
          consumer,
          signal: controller.signal,
          onEvent: (e) => console.log(JSON.stringify(e)),
        });
        return;
      }

      const result = consumer
        ? await drain(PROJECT, consumer)
        : await since(PROJECT, { since: values.since ?? 0 });

      if (values.ndjson) {
        // One line per event, so `events` and `events --follow` pipe the same way.
        for (const e of result.events) console.log(JSON.stringify(e));
      } else {
        console.log(JSON.stringify({ ...result, count: result.events.length }, null, 2));
      }
      return;
    }

    case 'watch': {
      // Delivery that outlives any window: the store is the queue.
      const store = await openStore(PROJECT);
      await importLegacy(PROJECT, store);
      const controller = new AbortController();
      const { stop } = await watchTasks({
        projectDir: PROJECT,
        signal: controller.signal,
        onEvent: (e) => console.log(JSON.stringify(e)),
      });
      for (const sig of ['SIGINT', 'SIGTERM']) {
        process.on(sig, () => {
          stop();
          controller.abort();
          process.exit(0);
        });
      }
      await new Promise(() => {}); // watch until killed
      return;
    }

    case 'task': {
      const id = positionals[1];
      if (!id) throw new Error('which task? ayna task task-0003 --status in_progress');
      const store = await openStore(PROJECT);
      const wanted = values.status;
      if (!wanted) {
        const t = await store.get(id);
        if (!t) throw new Error(`no such task: ${id}`);
        console.log(JSON.stringify(t, null, 2));
        return;
      }
      const updated = await store.update(id, { status: wanted }, values.note);
      if (!updated) throw new Error(`no such task: ${id}`);
      ok(`${id} → ${wanted}`);
      return;
    }

    case 'clean': {
      /*
        .ayna grows with every shot, flow and audit. On a project used for a day it
        was already tens of megabytes, none of it needed once the run is read.
        Tasks, the database and the login profile are never touched — those are
        the parts you would miss. Only the named directories below are ever
        removed, so `ayna.db` sitting alongside them is safe by construction
        rather than by luck.
      */
      const keep = Number(values.keep ?? 3);
      const kinds = ['runs', 'flows', 'audits', 'qa', 'comments'];
      let freed = 0;
      let removed = 0;

      const sizeOf = async (dir) => {
        let total = 0;
        for (const e of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
          const full = path.join(dir, e.name);
          if (e.isDirectory()) total += await sizeOf(full);
          else total += (await stat(full).catch(() => ({ size: 0 }))).size;
        }
        return total;
      };

      for (const kind of kinds) {
        const base = path.join(PROJECT, '.ayna', kind);
        const entries = (await readdir(base, { withFileTypes: true }).catch(() => []))
          .filter((e) => e.isDirectory())
          .map((e) => e.name)
          .sort();
        // Newest last, so drop everything before the tail we are keeping.
        for (const name of entries.slice(0, Math.max(0, entries.length - keep))) {
          const dir = path.join(base, name);
          freed += await sizeOf(dir);
          await rm(dir, { recursive: true, force: true });
          removed += 1;
        }
      }

      ok(`removed ${removed} old run(s), freed ${(freed / 1024 / 1024).toFixed(1)} MB`);
      info(`kept the newest ${keep} of each · tasks and the login profile untouched`);
      return;
    }

    case 'audit': {
      /*
        If a review window is open, measure in it. Two Chromes cannot share a
        profile, so the alternative was closing the user's review to run an audit
        — and then measuring a freshly loaded page rather than the one they were
        looking at.
      */
      const live = await readSession();
      if (live?.live && !values['fresh-profile']) {
        const reqFile = path.join(live.dir, 'audit-request');
        const resFile = path.join(live.dir, 'audit-live.json');
        await rm(resFile, { force: true });
        await writeFile(reqFile, String(Date.now()));

        const deadline = Date.now() + 30_000;
        while (Date.now() < deadline && !existsSync(resFile)) {
          await new Promise((r) => setTimeout(r, 300));
        }
        if (!existsSync(resFile)) throw new Error('the open window did not answer — is it still there?');

        const report = JSON.parse(await readFile(resFile, 'utf8'));
        if (report.error) throw new Error(`the window could not measure itself: ${report.error}`);
        if (values.json) {
          console.log(JSON.stringify({ ...report, measuredIn: 'the open review window' }, null, 2));
        } else {
          banner(`ayna audit · ${report.url} (live window)`);
          console.log(summarizeAudit(report));
          console.log('');
          (report.clean ? ok : fail)(
            report.clean
              ? 'no layout faults'
              : `${report.counts.covered} covered · ${report.counts.offscreen} cut off · ${report.counts.overlaps} overlapping`,
          );
        }
        return;
      }

      const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
      const outDir = path.join(PROJECT, '.ayna', 'audits', stamp);
      const server = await startTarget(cfg);
      const profileDir = values['fresh-profile'] ? null : path.join(PROJECT, '.ayna', 'profile');
      const context = profileDir
        ? await openPersistentContext({ profileDir, headless: headlessMode(cfg), viewport: cfg.viewports[0] })
        : null;
      const browser = context ? null : await openBrowser({ headless: headlessMode(cfg) });

      const target = new URL(routes[0] ?? '/', server.url).toString();
      // --flow reaches a state first, so what you have to click into gets audited too.
      const steps = values.flow
        ? (JSON.parse(await readFile(path.resolve(PROJECT, values.flow), 'utf8')).steps ?? [])
        : [];
      const report = await auditPage({ browser, context, url: target, viewports: cfg.viewports, outDir, steps });

      if (context) await context.close().catch(() => {});
      else await browser.close().catch(() => {});
      await server.close().catch(() => {});

      if (values.json) {
        console.log(
          JSON.stringify(
            { ...report, hint: 'Fix critical first, then re-run audit. Clean means no critical or major faults remain.' },
            null,
            2,
          ),
        );
        return;
      }
      banner(`ayna audit · ${target}`);
      console.log(summarizeAudit(report));
      console.log('');
      if (report.blocked === 'authentication') {
        fail('blocked at a sign-in screen — run `ayna login` first');
        process.exitCode = 2;
        return;
      }
      (report.clean ? ok : fail)(
        report.clean
          ? 'no layout faults'
          : `${report.counts.covered} covered · ${report.counts.offscreen} cut off · ${report.counts.overlaps} overlapping · ${report.counts.clipped} clipped`,
      );
      return;
    }

    case 'flow': {
      const spec = values.flow ?? values.file;
      if (!spec) throw new Error('give me a flow: ayna flow --flow steps.json');
      const flow = JSON.parse(await readFile(path.resolve(PROJECT, spec), 'utf8'));

      const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
      const outDir = path.join(PROJECT, '.ayna', 'flows', `${(flow.name ?? 'flow').replace(/[^\w-]+/g, '-').toLowerCase()}-${stamp}`);

      const server = await startTarget(cfg);
      // Reuse the saved profile, so a flow behind a login starts signed in.
      const profileDir = values['fresh-profile'] ? null : path.join(PROJECT, '.ayna', 'profile');
      const context = profileDir
        ? await openPersistentContext({ profileDir, headless: headlessMode(cfg), viewport: cfg.viewports[0] })
        : null;
      const browser = context ? null : await openBrowser({ headless: headlessMode(cfg) });

      const record = await runFlow({
        browser,
        context,
        baseUrl: server.url,
        flow,
        outDir,
        viewport: cfg.viewports[0],
      });

      if (context) await context.close().catch(() => {});
      else await browser.close().catch(() => {});
      await server.close().catch(() => {});

      if (values.json) {
        console.log(JSON.stringify({ ...record, hint: 'Read every step image in order — the filmstrip is the review.' }, null, 2));
        return;
      }
      banner(`ayna flow · ${record.name}`);
      console.log(summarizeFlow(record));
      console.log('');
      (record.completed ? ok : fail)(
        record.completed ? `all ${record.steps.length} steps completed` : `stopped at step ${record.failedAt.n}: ${record.failedAt.error}`,
      );
      info(`${path.relative(PROJECT, outDir)}/flow.json`);
      return;
    }

    case 'annotate': {
      const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
      const outDir = path.join(PROJECT, '.ayna', 'comments', stamp);

      const server = await startTarget(cfg);
      // Always headed — the whole point is that a human clicks things.
      // A persistent profile keeps you logged in between reviews; --fresh-profile
      // starts clean (useful for checking a signed-out view).
      const profileDir = values['fresh-profile'] ? null : path.join(PROJECT, '.ayna', 'profile');
      let context = profileDir
        ? await openPersistentContext({ profileDir, headless: false, viewport: cfg.viewports[0] })
        : null;
      const browser = context ? null : await openBrowser({ headless: false });
      if (!context) {
        // viewport null so the page follows the window the user resizes, rather
        // than staying the size it launched at with dead space around it.
        context = await browser.newContext({ viewport: null });
      }

      // With --json, stdout must be nothing but JSON — the status lines go to stderr
      // so a caller can still see progress while piping the result.
      const say = values.json
        ? (msg) => process.stderr.write(`  ${msg}\n`)
        : (msg) => info(msg);
      if (!values.json) banner('ayna annotate');
      if (values.json) say(`opened ${server.url}`);
      else ok(`opened ${server.url}`);
      say('click anything to comment · paste an image to attach a reference');
      say('press "Send to Claude" in the page when you are done');

      // Written before we block, so `ayna applied` and `ayna status` can find this
      // session while the window is still open.
      /*
        One pointer per process, not per project.

        A single last-comments.json meant a second review in the same repo
        overwrote the first, and commands then talked to whichever window wrote
        last — silently routing comments to the wrong one. Each session writes its
        own file; readers pick the newest live one.
      */
      await mkdir(SESSION_DIR, { recursive: true });
      const pointer = { file: path.join(outDir, 'comments.json'), pid: process.pid, startedAt: Date.now() };
      await writeFile(path.join(SESSION_DIR, `session-${process.pid}.json`), JSON.stringify(pointer));
      await writeFile(path.join(SESSION_DIR, 'last-comments.json'), JSON.stringify(pointer));

      /*
        The window writes into the store as comments are made.

        This argument was missing, and its absence was the whole bug: every
        `if (store)` branch in runAnnotate was dead, so a comment existed only
        inside the running process until the session ended and a later command
        scraped the finished manifest. Work was invisible for exactly as long as
        it was live, which is when somebody wants to see it.
      */
      const store = await openStore(PROJECT);

      const manifest = await runAnnotate({
        browser,
        context,
        store,
        // One line of JSON per thing worth waking up for. Run this under a
        // monitor and every round the user sends notifies you — no second
        // process, nothing to re-arm.
        onEvent: values.events ? (e) => console.log(JSON.stringify(e)) : undefined,
        url: server.url,
        outDir,
        projectDir: PROJECT,
        viewport: cfg.viewports[0],
      });

      if (context) await context.close().catch(() => {});
      else await browser.close().catch(() => {});
      await server.close().catch(() => {});

      if (values.events) return; // the stream was the output
      if (values.json) {
        console.log(JSON.stringify(manifest, null, 2));
        return;
      }
      ok(`${manifest.comments.length} comment(s) → ${path.relative(PROJECT, outDir)}`);
      for (const c of manifest.comments) {
        console.log(`  ${bold(`#${c.n}`)} ${c.selector}`);
        console.log(`     "${c.comment}"`);
        if (c.sourceCandidates?.length) {
          console.log(`     ${dim(`source: ${c.sourceCandidates[0].file}:${c.sourceCandidates[0].line}`)}`);
        }
      }
      return;
    }

    case 'applied': {
      // Tell the still-open annotate window that the edits are in. It reloads the
      // page and switches to the approve/comment-more bar. We never close it.
      const session = await readSession();
      if (!session) throw new Error('no annotate session — run `ayna annotate` first');
      if (!session.live) {
        throw new Error(
          'the annotate window is gone — nothing will read this. Start a new review with `ayna annotate`.',
        );
      }
      await writeFile(path.join(session.dir, 'applied'), String(Date.now()));
      ok('told the open window to refresh — waiting for the user to approve');

      /*
        Then stay on the line.

        `wait` fires once and exits, so after the first round somebody has to
        remember to arm it again. Nobody did, and rounds two and three of a real
        review sat unseen while the page said "Sent". Blocking here means the
        command that says "I'm done" is also the one that hears what happens next,
        so the loop cannot be dropped by forgetting a step.
      */
      if (values['no-wait']) return;
      await followSession(path.join(session.dir, 'status.json'), SESSION_DIR, { settle: true });
      return;
    }

    case 'wait':
    case 'follow': {
      // Blocks until the user sends a round (or closes the window), then exits.
      // Run this in the background so you are woken the moment they hit Send —
      // polling `status` by hand means the user sits there waiting on you.
      const session = await readSession();
      if (!session) throw new Error('no annotate session — run `ayna annotate` first');
      if (!session.live) {
        // Never block on a window that no longer exists.
        console.log(JSON.stringify({ phase: 'stale', done: true }));
        return;
      }
      await followSession(path.join(session.dir, 'status.json'), SESSION_DIR);
      return;
    }

    case 'status': {
      const session = await readSession();
      if (!session) {
        console.log(JSON.stringify({ phase: 'none' }));
        return;
      }
      if (!session.live) {
        console.log(
          JSON.stringify({
            phase: 'stale',
            hint: 'the window that owned this review is gone (the session that opened it ended). Start a new one with `ayna annotate`.',
            lastComments: session.file,
          }),
        );
        return;
      }
      const statusFile = path.join(session.dir, 'status.json');
      console.log(
        existsSync(statusFile) ? await readFile(statusFile, 'utf8') : JSON.stringify({ phase: 'none' }),
      );
      return;
    }

    case 'comments': {
      /*
        Read from the store, so comments outlive the window that captured them.
        Reading a session manifest meant that once the process was gone the work
        was unreachable — which is exactly how three rounds went missing.
      */
      if (!values.file) {
        const store = await openStore(PROJECT);
        await importLegacy(PROJECT, store);
        const tasks = await store.list();
        const payload = {
          total: tasks.length,
          pending: tasks.filter(isPending).length,
          comments: tasks.map((t, i) => ({
            n: i + 1,
            id: t.id,
            status: t.status,
            kind: t.kind,
            comment: t.comment,
            url: t.url,
            selector: t.selector,
            elements: t.elements ?? [],
            region: t.region ?? null,
            move: t.move ?? null,
            styles: t.styles ?? {},
            regionScreenshot: t.regionScreenshot,
            attachments: t.attachments,
            sourceCandidates: t.sourceCandidates ?? [],
          })),
          hint: 'Act on anything not approved. Read regionScreenshot and attachments first.',
        };
        if (values.json) {
          console.log(JSON.stringify(payload, null, 2));
        } else if (!tasks.length) {
          warn('no comments yet — run `ayna annotate`');
        } else {
          for (const c of payload.comments) {
            console.log(`${bold('#' + c.n)} [${c.status}] ${c.selector ?? ''}`);
            console.log(`   "${c.comment}"`);
          }
        }
        return;
      }

      const session = await readSession();
      // --root means "UI directory" everywhere else; don't overload it here.
      let file = values.file;
      if (!file && session) {
        file = session.file;
        if (!session.live && !values.json) {
          warn('this is from a finished review — the window that owned it is closed');
        }
      }
      if (!file || !existsSync(file)) {
        warn('no comments yet — run `ayna annotate` first');
        return;
      }
      const manifest = await loadComments(file);
      if (values.json) {
        console.log(
          JSON.stringify(
            {
              ...manifest,
              hint:
                'For each comment: Read `regionScreenshot` to see exactly what the user ' +
                'pointed at, Read any `attachments` for their reference image, and start ' +
                'from `sourceCandidates` to find the code.',
            },
            null,
            2,
          ),
        );
        return;
      }
      for (const c of manifest.comments) {
        console.log(`${bold(`#${c.n}`)} ${c.selector}\n   "${c.comment}"`);
      }
      return;
    }

    case 'snapshot': {
      const dest = path.join(SESSION_DIR, 'snapshot');
      await snapshot(cfg.targetDir, dest);
      ok(`snapshotted ${path.relative(PROJECT, cfg.targetDir)} — restore with \`ayna restore\``);
      return;
    }

    case 'restore': {
      const src = path.join(SESSION_DIR, 'snapshot');
      if (!existsSync(src)) throw new Error('no snapshot to restore — run `ayna snapshot` first');
      await restore(src, cfg.targetDir);
      ok(`restored ${path.relative(PROJECT, cfg.targetDir)}`);
      return;
    }

    case 'record': {
      await mkdir(SESSION_DIR, { recursive: true });
      const entries = existsSync(JOURNAL) ? JSON.parse(await readFile(JOURNAL, 'utf8')) : [];
      const last = existsSync(path.join(SESSION_DIR, 'last-shot.json'))
        ? JSON.parse(await readFile(path.join(SESSION_DIR, 'last-shot.json'), 'utf8'))
        : { shots: [] };
      entries.push({
        n: entries.length + 1,
        score: values.score ? Number(values.score) : null,
        note: values.note ?? '',
        shots: last.shots,
      });
      await writeFile(JOURNAL, JSON.stringify(entries, null, 2));
      ok(`recorded round ${entries.length}${values.score ? ` (${values.score}/10)` : ''}`);
      return;
    }

    case 'critique': {
      const claude = await ensureClaudeAvailable();
      if (!claude.ok) throw new Error('the `claude` CLI was not found on PATH');

      const { browser, url, close, outDir } = await prepare(cfg, 'critique');
      step('look', `screenshotting ${routes.length} route(s)`);
      const cap = await captureRoutes({
        browser,
        baseUrl: url,
        routes,
        viewports: cfg.viewports,
        outDir,
        label: 'before',
      });
      for (const s of cap.shots) {
        ok(`${s.route ?? '/'} ${s.viewport} → ${path.relative(process.cwd(), s.file)}`);
      }

      step('critique', 'asking the design critic what is wrong');
      const run = await runClaude({
        prompt: critiquePrompt({ cfg, capture: cap, iteration: 1 }),
        cwd: cfg.rootDir,
        tools: ['Read', 'Glob', 'Grep'],
        model: values.model ?? cfg.loop.model,
        schema: CRITIQUE_SCHEMA,
      });
      await close();

      const c = run.json;
      if (!c) {
        fail('no structured critique came back');
        console.log(run.text);
        return;
      }
      const col = c.score >= 8 ? green : c.score >= 5 ? yellow : red;
      banner(`score ${col(bold(`${c.score}/10`))}`);
      console.log(`  ${c.verdict}\n`);
      for (const i of c.issues) {
        const sev = i.severity === 'critical' ? red : i.severity === 'major' ? yellow : dim;
        console.log(`  ${sev(`[${i.severity}]`)} ${bold(i.area)} — ${i.problem}`);
        console.log(`    ${dim(`→ ${i.fix}`)}\n`);
      }
      return;
    }

    case 'report': {
      // An in-session loop journals its rounds; build the report from those first.
      if (existsSync(JOURNAL)) {
        const entries = JSON.parse(await readFile(JOURNAL, 'utf8'));
        if (entries.length < 2) {
          warn('need at least two recorded rounds to show a before/after — keep going');
          return;
        }
        const iterations = entries.slice(1).map((e, idx) => ({
          n: idx + 1,
          before: { shots: entries[idx].shots },
          after: { shots: e.shots },
          critique: { score: e.score ?? '—', verdict: e.note, issues: [] },
          changes: [],
        }));
        const file = await writeReport({
          cfg,
          runId: 'session',
          runDir: SESSION_DIR,
          iterations,
          stopReason: `${entries.length} round(s) in this session`,
          totalCost: 0,
        });
        ok(`report: ${path.relative(PROJECT, file)}`);
        if (values.open) openInDesktop(file);
        return;
      }

      const runs = await readdir(cfg.runsDir).catch(() => []);
      const latest = runs.filter((r) => !r.startsWith('.')).sort().pop();
      if (!latest) {
        warn('no runs yet — try `ayna loop`');
        return;
      }
      const file = path.join(cfg.runsDir, latest, 'report.html');
      await access(file).catch(() => {
        throw new Error(`no report in ${latest}`);
      });
      openInDesktop(file);
      ok(`opened ${path.relative(process.cwd(), file)}`);
      return;
    }

    case 'loop': {
      await runLoop(cfg, {
        iterations: values.iterations ? Number(values.iterations) : undefined,
        model: values.model,
        headless: headlessMode(cfg),
        open: values.open,
      });
      return;
    }

    default:
      fail(`unknown command: ${command}`);
      console.log(HELP);
      process.exitCode = 1;
  }
}

/**
 * The annotate session this project last opened, and whether it is still running.
 *
 * A resumed conversation inherits the pointer file but not the process: the browser
 * died with the session that opened it. Without this check `status` reports a phase
 * nobody is in, `applied` writes a marker nothing will read, and `wait` polls a
 * frozen file forever.
 */
async function readSession() {
  const alive = (pid) => {
    if (!pid) return false;
    try {
      process.kill(pid, 0); // signal 0 is a liveness probe; it sends nothing
      return true;
    } catch {
      return false;
    }
  };

  const candidates = [];
  for (const name of await readdir(SESSION_DIR).catch(() => [])) {
    if (!/^session-\d+\.json$/.test(name)) continue;
    const info = JSON.parse(await readFile(path.join(SESSION_DIR, name), 'utf8').catch(() => '{}'));
    if (info.file) candidates.push(info);
  }

  // Prefer a live session, newest first; fall back to the last one for context.
  const live = candidates.filter((c) => alive(c.pid)).sort((a, b) => (b.startedAt ?? 0) - (a.startedAt ?? 0));
  if (live.length) return { ...live[0], dir: path.dirname(live[0].file), live: true, others: live.length - 1 };

  // Nothing live in the new format — fall back to the single-pointer file a
  // session written before this change would have left, and still ask whether
  // its process is running rather than assuming it is not.
  const legacy = path.join(SESSION_DIR, 'last-comments.json');
  const fallback =
    candidates.sort((a, b) => (b.startedAt ?? 0) - (a.startedAt ?? 0))[0] ??
    (existsSync(legacy) ? JSON.parse(await readFile(legacy, 'utf8').catch(() => '{}')) : null);
  if (!fallback?.file) return null;
  return { ...fallback, dir: path.dirname(fallback.file), live: alive(fallback.pid) };
}

/**
 * Block until the user does something worth waking up for: sends another round,
 * rejects a change, approves, or closes the window. Prints one JSON line saying
 * which, then returns.
 *
 * `settle` skips over the state we are already in — right after `applied` the
 * phase is still `awaiting-claude` from the round just handled, and returning on
 * that would be answering our own question.
 */
async function followSession(statusFile, sessionDir, { settle = false } = {}) {
  const read = async () =>
    existsSync(statusFile) ? JSON.parse(await readFile(statusFile, 'utf8').catch(() => '{}')) : {};

  if (settle) {
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
      const s = await read();
      if (s.phase !== 'awaiting-claude') break;
      await new Promise((r) => setTimeout(r, 300));
    }
  }

  for (;;) {
    const s = await read();
    if (s.phase === 'awaiting-claude') {
      console.log(JSON.stringify({ phase: s.phase, round: s.round, comments: s.comments, action: 'read-comments' }));
      return;
    }
    // "Needs work" is also a call to action — otherwise the user would have to
    // press Send again just to tell you they rejected something.
    if (s.rejected > 0) {
      console.log(JSON.stringify({ phase: s.phase, rejected: s.rejected, action: 'retry-rejected' }));
      return;
    }
    if (s.phase === 'approved' || s.phase === 'closed') {
      console.log(JSON.stringify({ phase: s.phase, done: true }));
      return;
    }
    // They may simply close the window, or the session that owns it may end.
    const still = await readSession();
    if (!still || !still.live) {
      console.log(JSON.stringify({ phase: 'stale', done: true }));
      return;
    }
    await new Promise((r) => setTimeout(r, 500));
  }
}

/** `--headed` beats `--headless` beats the config default. */
function headlessMode(cfg) {
  if (values.headed) return false;
  return values.headless ?? cfg.loop.headless;
}

/** Shared setup for the one-shot commands: server up, browser open, output dir ready. */
async function prepare(cfg, kind) {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const outDir = path.join(cfg.runsDir, `${kind}-${stamp}`);
  await mkdir(outDir, { recursive: true });

  // Shared with `loop`, so a configured startCommand boots the dev server here
  // too. Previously only `loop` honored it and everything else silently served
  // target.root as static files instead.
  const server = await startTarget(cfg);
  const browser = await openBrowser({ headless: headlessMode(cfg) });

  return {
    browser,
    url: server.url,
    outDir,
    close: async () => {
      await browser.close().catch(() => {});
      await server.close().catch(() => {});
    },
  };
}

main().catch((err) => {
  fail(err.message);
  process.exitCode = 1;
});
