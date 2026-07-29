#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { readdir, mkdir, access, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadConfig, writeConfig } from '../src/config.mjs';
import { serveStatic } from '../src/server.mjs';
import { startTarget } from '../src/target.mjs';
import { openBrowser, capture, captureRoutes } from '../src/browser.mjs';
import { runClaude, ensureClaudeAvailable } from '../src/brain.mjs';
import { CRITIQUE_SCHEMA, critiquePrompt } from '../src/prompts.mjs';
import { runLoop } from '../src/loop.mjs';
import { snapshot, restore } from '../src/snapshot.mjs';
import { runAnnotate, loadComments } from '../src/annotate.mjs';
import { writeReport } from '../src/report.mjs';
import { banner, step, ok, info, warn, fail, dim, bold, green, yellow, red, openInDesktop } from '../src/log.mjs';

const ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url)));

const HELP = `
${bold('ayna')} — a self-improving UI agent

  It opens your UI in Chrome, screenshots what is actually rendered, hands the
  image to Claude Code as a design critic, applies the fixes, and looks again.

${bold('USAGE')}
  ayna <command> [options]

${bold('COMMANDS')}
  ${bold('in-session')} (you are the brain — cheap, used by the ayna skill)
  shot        Screenshot the target; --json prints paths + diagnostics to Read
  snapshot    Back up the UI directory before you edit it
  restore     Put it back if your edits made things worse
  record      Log a round (--score, --note) for the report
  report      Build the before/after HTML report

  ${bold('standalone')} (spawns its own Claude sessions — costs real money)
  loop        Run the full look → critique → improve → verify cycle unattended
  critique    Screenshot and critique once, without editing anything

  serve       Serve the target UI and stay up (ctrl-c to stop)
  init        Write ayna.config.json with the defaults

${bold('OPTIONS')}
  -n, --iterations <n>   How many improvement rounds (default: config, 3)
  -m, --model <name>     opus | sonnet | haiku  (default: config, opus)
      --url <url>        Point at a URL instead of the configured target
      --root <dir>       The UI directory to snapshot/restore and edit
      --routes <list>    Comma-separated pages to capture, e.g. /,/pricing,/about
      --json             Machine-readable output (shot)
      --score <n>        Score for this round (record)
      --note <text>      What changed this round (record)
      --headed           Show the Chrome window (default: headless)
      --open             Open the HTML report when done
  -h, --help             This

${bold('EXAMPLES')}
  ayna shot --json --url http://localhost:5173    Shoot it, then Read the PNGs
  ayna snapshot --root src && ayna restore --root src
  ayna loop -n 3 --open                           Unattended, several dollars
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
      const file = await writeConfig(ROOT);
      ok(`wrote ${path.relative(process.cwd(), file)}`);
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

    case 'annotate': {
      const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
      const outDir = path.join(PROJECT, '.ayna', 'comments', stamp);

      const server = await startTarget(cfg);
      // Always headed — the whole point is that a human clicks things.
      const browser = await openBrowser({ headless: false });

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
      await mkdir(SESSION_DIR, { recursive: true });
      await writeFile(
        path.join(SESSION_DIR, 'last-comments.json'),
        // The pid lets later commands tell a live window from a dead one. Resuming
        // a conversation does not resurrect the browser the old session owned.
        JSON.stringify({ file: path.join(outDir, 'comments.json'), pid: process.pid }),
      );

      const manifest = await runAnnotate({
        browser,
        url: server.url,
        outDir,
        projectDir: PROJECT,
        viewport: cfg.viewports[0],
      });

      await browser.close().catch(() => {});
      await server.close().catch(() => {});

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
      return;
    }

    case 'wait': {
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
      const statusFile = path.join(session.dir, 'status.json');

      for (;;) {
        const s = existsSync(statusFile)
          ? JSON.parse(await readFile(statusFile, 'utf8').catch(() => '{}'))
          : {};
        if (s.phase === 'awaiting-claude') {
          console.log(JSON.stringify({ phase: s.phase, round: s.round, comments: s.comments }));
          return;
        }
        // "Needs work" on any comment is also a call to action — without this the
        // user would have to press Send again just to tell you they rejected one.
        if (s.rejected > 0) {
          console.log(JSON.stringify({ phase: s.phase, rejected: s.rejected, action: 'retry-rejected' }));
          return;
        }
        if (s.phase === 'approved' || s.phase === 'closed') {
          console.log(JSON.stringify({ phase: s.phase, done: true }));
          return;
        }
        // The user may just close the terminal or kill the window mid-review.
        const still = await readSession();
        if (!still || !still.live) {
          console.log(JSON.stringify({ phase: 'stale', done: true }));
          return;
        }
        await new Promise((r) => setTimeout(r, 500));
      }
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
      const session = await readSession();
      let file = values.root;
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
  const pointer = path.join(SESSION_DIR, 'last-comments.json');
  if (!existsSync(pointer)) return null;
  const info = JSON.parse(await readFile(pointer, 'utf8').catch(() => '{}'));
  if (!info.file) return null;

  let live = false;
  if (info.pid) {
    try {
      process.kill(info.pid, 0); // signal 0 = liveness probe, sends nothing
      live = true;
    } catch {
      live = false;
    }
  }
  return { ...info, dir: path.dirname(info.file), live };
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
