/*
  Drives bin/ayna.mjs as a real process, from a real project directory.

  Everything here was previously untested, and the first pass through it found
  `ayna init` writing its config into the plugin directory instead of the user's
  project — which silently broke the one documented fix for "no target".
*/
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { writeFile, readFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { tempDir, fixtureSite } from './helpers.mjs';

const exec = promisify(execFile);
const BIN = path.resolve(fileURLToPath(new URL('../bin/ayna.mjs', import.meta.url)));

/** Run the CLI in `cwd`, never throwing so we can assert on failures too. */
async function ayna(cwd, args) {
  try {
    const { stdout, stderr } = await exec('node', [BIN, ...args], { cwd, timeout: 120_000 });
    return { code: 0, stdout, stderr };
  } catch (err) {
    return { code: err.code ?? 1, stdout: err.stdout ?? '', stderr: err.stderr ?? '' };
  }
}

describe('cli: configuration', () => {
  test('init writes into the project, not the plugin directory', async () => {
    const { dir, dispose } = await tempDir();
    try {
      const res = await ayna(dir, ['init']);
      assert.equal(res.code, 0, res.stderr);
      assert.ok(existsSync(path.join(dir, 'ayna.config.json')), 'config lands in the project');

      const cfg = JSON.parse(await readFile(path.join(dir, 'ayna.config.json'), 'utf8'));
      assert.ok(cfg.target, 'has a target block');
      assert.ok(Array.isArray(cfg.viewports));
    } finally {
      await dispose();
    }
  });

  test('init refuses to clobber an existing config', async () => {
    const { dir, dispose } = await tempDir();
    try {
      await writeFile(path.join(dir, 'ayna.config.json'), '{"target":{"name":"mine"}}');
      const res = await ayna(dir, ['init']);
      assert.equal(res.code, 0);
      const cfg = JSON.parse(await readFile(path.join(dir, 'ayna.config.json'), 'utf8'));
      assert.equal(cfg.target.name, 'mine', 'the existing config survives');
    } finally {
      await dispose();
    }
  });

  test('refuses to run with no config and no --url, naming both fixes', async () => {
    const { dir, dispose } = await tempDir();
    try {
      const res = await ayna(dir, ['shot']);
      assert.notEqual(res.code, 0, 'must fail rather than shoot the bundled demo');
      const out = res.stdout + res.stderr;
      assert.match(out, /--url/);
      assert.match(out, /ayna init/);
    } finally {
      await dispose();
    }
  });

  test('help works from anywhere and lists the commands', async () => {
    const { dir, dispose } = await tempDir();
    try {
      const res = await ayna(dir, ['--help']);
      assert.equal(res.code, 0);
      // Every command must be discoverable — the review workflow was missing
      // from help entirely, which is most of what ayna does.
      for (const cmd of [
        'shot', 'annotate', 'comments', 'status', 'wait', 'applied',
        'snapshot', 'restore', 'record', 'report', 'loop', 'critique', 'init', 'serve',
      ]) {
        assert.match(res.stdout, new RegExp(cmd));
      }
    } finally {
      await dispose();
    }
  });

  test('an unknown command fails loudly', async () => {
    const { dir, dispose } = await tempDir();
    try {
      const res = await ayna(dir, ['frobnicate']);
      assert.notEqual(res.code, 0);
      assert.match(res.stdout + res.stderr, /unknown command/i);
    } finally {
      await dispose();
    }
  });
});

describe('cli: snapshot and restore', () => {
  test('round-trips edits through the CLI', async () => {
    const { dir, dispose } = await tempDir();
    try {
      const ui = path.join(dir, 'ui');
      await fixtureSite(ui);
      await writeFile(
        path.join(dir, 'ayna.config.json'),
        JSON.stringify({ target: { name: 't', root: 'ui', url: 'http://127.0.0.1:1/' } }),
      );

      assert.equal((await ayna(dir, ['snapshot', '--root', 'ui'])).code, 0);
      await writeFile(path.join(ui, 'styles.css'), 'body{background:red}');
      assert.equal((await ayna(dir, ['restore', '--root', 'ui'])).code, 0);
      assert.match(await readFile(path.join(ui, 'styles.css'), 'utf8'), /system-ui/);
    } finally {
      await dispose();
    }
  });

  test('restore without a snapshot explains itself instead of throwing raw', async () => {
    const { dir, dispose } = await tempDir();
    try {
      const ui = path.join(dir, 'ui');
      await fixtureSite(ui);
      await writeFile(
        path.join(dir, 'ayna.config.json'),
        JSON.stringify({ target: { name: 't', root: 'ui', url: 'http://127.0.0.1:1/' } }),
      );
      const res = await ayna(dir, ['restore', '--root', 'ui']);
      assert.notEqual(res.code, 0);
      assert.match(res.stdout + res.stderr, /snapshot/i);
      assert.ok(existsSync(path.join(ui, 'index.html')), 'the target is left intact');
    } finally {
      await dispose();
    }
  });
});

describe('cli: session state', () => {
  test('status reports none when nothing has been opened', async () => {
    const { dir, dispose } = await tempDir();
    try {
      const res = await ayna(dir, ['status']);
      assert.equal(res.code, 0);
      assert.equal(JSON.parse(res.stdout.trim()).phase, 'none');
    } finally {
      await dispose();
    }
  });

  test('a pointer left by a dead session reports stale, and wait does not block', async () => {
    const { dir, dispose } = await tempDir();
    try {
      const session = path.join(dir, '.ayna', 'session');
      const old = path.join(dir, '.ayna', 'comments', 'old');
      await mkdir(session, { recursive: true });
      await mkdir(old, { recursive: true });
      await writeFile(path.join(old, 'comments.json'), JSON.stringify({ comments: [] }));
      // A phase that would otherwise make `wait` poll forever.
      await writeFile(path.join(old, 'status.json'), JSON.stringify({ phase: 'reviewing', rejected: 0 }));
      await writeFile(
        path.join(session, 'last-comments.json'),
        // A pid that cannot be running.
        JSON.stringify({ file: path.join(old, 'comments.json'), pid: 999999 }),
      );

      const status = await ayna(dir, ['status']);
      assert.equal(JSON.parse(status.stdout.trim()).phase, 'stale');

      const waited = await ayna(dir, ['wait']);
      assert.equal(waited.code, 0, 'wait must return rather than hang');
      assert.equal(JSON.parse(waited.stdout.trim()).phase, 'stale');

      const applied = await ayna(dir, ['applied']);
      assert.notEqual(applied.code, 0, 'applied must refuse a dead session');
    } finally {
      await dispose();
    }
  });

  test('report needs two rounds before it can show a before/after', async () => {
    const { dir, dispose } = await tempDir();
    try {
      const session = path.join(dir, '.ayna', 'session');
      await mkdir(session, { recursive: true });
      await writeFile(path.join(session, 'journal.json'), JSON.stringify([{ n: 1, score: 5, note: 'x', shots: [] }]));
      const res = await ayna(dir, ['report']);
      assert.equal(res.code, 0);
      assert.match(res.stdout + res.stderr, /two recorded rounds|keep going/i);
    } finally {
      await dispose();
    }
  });
});

describe('cli: concurrency and housekeeping', () => {
  test('two live sessions do not route to each other', async () => {
    const { dir, dispose } = await tempDir();
    try {
      const session = path.join(dir, '.ayna', 'session');
      await mkdir(session, { recursive: true });

      const mk = async (pid, name, phase) => {
        const out = path.join(dir, '.ayna', 'comments', name);
        await mkdir(out, { recursive: true });
        await writeFile(path.join(out, 'comments.json'), JSON.stringify({ comments: [] }));
        await writeFile(path.join(out, 'status.json'), JSON.stringify({ phase }));
        await writeFile(
          path.join(session, `session-${pid}.json`),
          JSON.stringify({ file: path.join(out, 'comments.json'), pid, startedAt: Date.now() }),
        );
      };

      // A dead session, then a live one started later.
      await mk(999999, 'dead', 'reviewing');
      await mk(process.pid, 'live', 'commenting');

      const res = await ayna(dir, ['status']);
      assert.equal(res.code, 0);
      assert.equal(
        JSON.parse(res.stdout.trim()).phase,
        'commenting',
        'the live session wins, not whichever wrote last',
      );
    } finally {
      await dispose();
    }
  });

  test('clean drops old runs but never tasks or the login profile', async () => {
    const { dir, dispose } = await tempDir();
    try {
      const make = async (rel, bytes = 'x'.repeat(500)) => {
        await mkdir(path.dirname(path.join(dir, rel)), { recursive: true });
        await writeFile(path.join(dir, rel), bytes);
      };
      for (const n of ['a', 'b', 'c', 'd', 'e']) await make(`.ayna/runs/${n}/shot.png`);
      await make('.ayna/tasks/task-0001/task.json', '{"id":"task-0001"}');
      await make('.ayna/profile/Default/Cookies', 'session');

      const res = await ayna(dir, ['clean', '--keep', '2']);
      assert.equal(res.code, 0, res.stderr);

      const left = await (await import('node:fs/promises')).readdir(path.join(dir, '.ayna', 'runs'));
      assert.deepEqual(left.sort(), ['d', 'e'], 'the newest two runs are kept');
      assert.ok(existsSync(path.join(dir, '.ayna', 'tasks', 'task-0001', 'task.json')), 'tasks survive');
      assert.ok(existsSync(path.join(dir, '.ayna', 'profile', 'Default', 'Cookies')), 'the login survives');
    } finally {
      await dispose();
    }
  });
});
