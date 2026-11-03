/*
  Where ayna puts itself.

  Puku ships two products with two config directories: the editor reads
  ~/.puku/skills, and the CLI reads ~/.puku-cli/skills.  A link in the wrong one
  looks installed and is invisible to the tool it was meant for.
*/
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, readFile, readdir, readlink, symlink, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import { tempDir } from './helpers.mjs';

const ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const SETUP = path.join(ROOT, 'scripts', 'setup.mjs');

function runSetup(home, args = []) {
  return spawnSync(process.execPath, [SETUP, ...args], {
    cwd: ROOT,
    env: { ...process.env, HOME: home },
    encoding: 'utf8',
  });
}

async function linkedTo(link) {
  try {
    return await readlink(link);
  } catch {
    return null;
  }
}

describe('installing where each host actually looks', () => {
  test('puku-cli gets its skill in ~/.puku-cli, not the editor directory', async () => {
    const { dir, dispose } = await tempDir('ayna-setup-');
    try {
      await mkdir(path.join(dir, '.puku-cli'), { recursive: true });
      await mkdir(path.join(dir, '.puku'), { recursive: true });

      const run = runSetup(dir);
      assert.equal(run.status, 0, run.stderr);

      assert.equal(await linkedTo(path.join(dir, '.puku-cli', 'skills', 'ayna')), ROOT, 'the CLI path');
      assert.equal(await linkedTo(path.join(dir, '.puku', 'skills', 'ayna')), ROOT, 'the editor path');
    } finally {
      await dispose();
    }
  });

  test('the Puku CLI is skipped when only the editor is installed', async () => {
    const { dir, dispose } = await tempDir('ayna-setup-');
    try {
      await mkdir(path.join(dir, '.puku'), { recursive: true });

      const run = runSetup(dir);
      assert.equal(run.status, 0, run.stderr);

      assert.equal(await linkedTo(path.join(dir, '.puku', 'skills', 'ayna')), ROOT);
      assert.equal(existsSync(path.join(dir, '.puku-cli', 'skills', 'ayna')), false);
    } finally {
      await dispose();
    }
  });

  test('the editor is skipped when only the CLI is installed', async () => {
    const { dir, dispose } = await tempDir('ayna-setup-');
    try {
      await mkdir(path.join(dir, '.puku-cli'), { recursive: true });

      const run = runSetup(dir);
      assert.equal(run.status, 0, run.stderr);

      assert.equal(await linkedTo(path.join(dir, '.puku-cli', 'skills', 'ayna')), ROOT);
      assert.equal(existsSync(path.join(dir, '.puku', 'skills', 'ayna')), false);
    } finally {
      await dispose();
    }
  });

  test('codex gets its skill in ~/.codex/skills', async () => {
    const { dir, dispose } = await tempDir('ayna-setup-');
    try {
      await mkdir(path.join(dir, '.codex'), { recursive: true });

      const run = runSetup(dir);
      assert.equal(run.status, 0, run.stderr);

      assert.equal(await linkedTo(path.join(dir, '.codex', 'skills', 'ayna')), ROOT);
    } finally {
      await dispose();
    }
  });

  test('codex is skipped when it is not installed here', async () => {
    const { dir, dispose } = await tempDir('ayna-setup-');
    try {
      const run = runSetup(dir);
      assert.equal(run.status, 0, run.stderr);

      assert.equal(existsSync(path.join(dir, '.codex', 'skills', 'ayna')), false);
    } finally {
      await dispose();
    }
  });
});

describe('where the skill looks for ayna', () => {
  /*
    A skill body is text: ${CLAUDE_PLUGIN_ROOT} is not expanded when the skill
    is read, and it is not exported to the shell either. Every command the
    skill prints therefore carries its own fallback, and that fallback has to
    resolve for every host that loads the same SKILL.md — Claude Code,
    puku-cli and codex all do.

    A host with no fallback is a host where every command in the skill fails
    with "Cannot find module", which is not a failure anyone can debug from
    the outside. These pin the chain for all three.
  */

  /**
   * Expand the chain the way a shell would.
   *
   * It is nested, so it expands innermost-first: CODEX_HOME, then
   * PUKU_CLI_PLUGIN_ROOT, then CLAUDE_PLUGIN_ROOT.
   */
  function expand(env) {
    const codexHome = env.CODEX_HOME ?? `${env.HOME}/.codex`;
    const puku = env.PUKU_CLI_PLUGIN_ROOT ?? `${codexHome}/skills/ayna`;
    return env.CLAUDE_PLUGIN_ROOT ?? puku;
  }

  test('it resolves for a codex-only machine', () => {
    assert.equal(expand({ HOME: '/home/dev' }), '/home/dev/.codex/skills/ayna');
  });

  test('it honours CODEX_HOME when codex is installed elsewhere', () => {
    assert.equal(expand({ HOME: '/home/dev', CODEX_HOME: '/opt/codex' }), '/opt/codex/skills/ayna');
  });

  test('it still resolves for puku-cli', () => {
    assert.equal(expand({ HOME: '/home/dev', PUKU_CLI_PLUGIN_ROOT: '/opt/puku' }), '/opt/puku');
  });

  test('it still resolves for Claude Code', () => {
    assert.equal(expand({ HOME: '/home/dev', CLAUDE_PLUGIN_ROOT: '/opt/claude' }), '/opt/claude');
  });

  test('every command the skill prints carries the whole chain', async () => {
    const commands = path.join(ROOT, 'commands');
    const files = [path.join(ROOT, 'SKILL.md')];
    for (const name of await readdir(commands)) {
      if (name.endsWith('.md')) files.push(path.join(commands, name));
    }

    let checked = 0;
    for (const file of files) {
      const text = await readFile(file, 'utf8');
      for (const line of text.split('\n')) {
        if (!line.includes('/bin/ayna.mjs')) continue;
        assert.ok(
          line.includes('CLAUDE_PLUGIN_ROOT') &&
            line.includes('PUKU_CLI_PLUGIN_ROOT') &&
            line.includes('CODEX_HOME'),
          `${path.relative(ROOT, file)} has a command without the full fallback chain: ${line.trim()}`,
        );
        checked++;
      }
    }
    assert.ok(checked > 0, 'the chain should be used somewhere');
  });
});

describe('links a previous checkout left behind', () => {
  test('a dangling ayna link is replaced, so setup can repair a moved checkout', async () => {
    const { dir, dispose } = await tempDir('ayna-setup-');
    try {
      const skills = path.join(dir, '.puku-cli', 'skills');
      await mkdir(skills, { recursive: true });
      await symlink(path.join(dir, 'old-ayna'), path.join(skills, 'ayna'));

      const run = runSetup(dir);
      assert.equal(run.status, 0, run.stderr);

      assert.equal(await linkedTo(path.join(skills, 'ayna')), ROOT);
    } finally {
      await dispose();
    }
  });

  test('a working link to someone else is still left alone', async () => {
    const { dir, dispose } = await tempDir('ayna-setup-');
    try {
      const other = path.join(dir, 'other-ayna');
      await mkdir(other, { recursive: true });
      const skills = path.join(dir, '.puku-cli', 'skills');
      await mkdir(skills, { recursive: true });
      await symlink(other, path.join(skills, 'ayna'));

      const run = runSetup(dir);
      assert.equal(run.status, 0, run.stderr);

      assert.equal(await linkedTo(path.join(skills, 'ayna')), other);
    } finally {
      await dispose();
    }
  });
});

describe('hooks left by the old puku integration', () => {
  test('dangling ayna hooks are removed and everything else is kept', async () => {
    const { dir, dispose } = await tempDir('ayna-setup-');
    try {
      const settingsFile = path.join(dir, '.puku-cli', 'settings.json');
      await mkdir(path.dirname(settingsFile), { recursive: true });
      await writeFile(
        settingsFile,
        JSON.stringify({
          model: 'puku-ai-2.7',
          hooks: {
            SessionStart: [
              {
                hooks: [
                  { type: 'command', command: path.join(dir, 'old-ayna', 'session-init.sh'), _ayna: true },
                ],
              },
            ],
            PreToolUse: [
              { matcher: 'Bash', hooks: [{ type: 'command', command: '/usr/bin/true' }] },
            ],
            PostToolUse: [
              { hooks: [{ type: 'command', command: process.execPath, _ayna: true }] },
            ],
          },
        }),
      );

      const run = runSetup(dir);
      assert.equal(run.status, 0, run.stderr);

      const settings = JSON.parse(await readFile(settingsFile, 'utf8'));
      assert.equal(settings.model, 'puku-ai-2.7', 'unrelated settings survive');
      assert.equal(settings.hooks.SessionStart, undefined, 'the dangling ayna hook is gone');
      assert.equal(settings.hooks.PreToolUse[0].hooks[0].command, '/usr/bin/true', 'a user hook survives');
      assert.equal(settings.hooks.PostToolUse[0].hooks[0].command, process.execPath, 'a live ayna hook survives');
    } finally {
      await dispose();
    }
  });
});
