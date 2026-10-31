#!/usr/bin/env node
/*
  Put ayna where the skill expects to find it.

  Skills are read as text: `${CLAUDE_PLUGIN_ROOT}` is not expanded in a skill body
  and is not exported to the shell, so every documented command resolves through a
  fixed fallback path. If nothing is linked there, a session follows the
  instructions, gets "Cannot find module", and starts reading ayna's own source to
  work out where it lives — which is not a failure anyone can debug from the
  outside. So installing means making that path real.

  Usage: npm run setup [-- --uninstall]
*/
import { symlink, mkdir, rm, lstat, readlink, chmod, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
/*
  Every host that reads SKILL.md gets a link.

  Puku ships two products with two config directories, and they do not share
  skills: the CLI reads ~/.puku-cli/skills, the editor reads ~/.puku/skills.
  Writing only the editor path leaves puku-cli looking installed and unable to
  find anything. A host that is not present costs nothing: the parent directory
  is only created when its config directory already exists, so this does not
  scatter empty folders for tools nobody has.
*/
const HOSTS = [
  {
    name: 'Claude Code',
    config: path.join(homedir(), '.claude'),
    skills: path.join(homedir(), '.claude', 'skills', 'ayna'),
  },
  {
    name: 'Puku CLI',
    config: path.join(homedir(), '.puku-cli'),
    skills: path.join(homedir(), '.puku-cli', 'skills', 'ayna'),
  },
  {
    name: 'Puku Editor',
    config: path.join(homedir(), '.puku'),
    skills: path.join(homedir(), '.puku', 'skills', 'ayna'),
  },
];
const BIN_DIR = path.join(homedir(), '.local', 'bin');
const BIN_LINK = path.join(BIN_DIR, 'ayna');
const PUKU_CLI_SETTINGS = path.join(homedir(), '.puku-cli', 'settings.json');

const uninstall = process.argv.includes('--uninstall');

/** What is at `link`, if anything: a link of ours, someone else's, or nothing. */
async function inspect(link) {
  try {
    const st = await lstat(link);
    if (!st.isSymbolicLink()) return { exists: true, kind: 'not-a-link' };
    const target = await readlink(link);
    return { exists: true, kind: target === ROOT || target === path.join(ROOT, 'bin', 'ayna.mjs') ? 'ours' : 'other', target };
  } catch {
    return { exists: false };
  }
}

async function link(from, to, label) {
  const found = await inspect(to);
  if (found.exists && found.kind === 'not-a-link') {
    console.log(`  ! ${label}: ${to} exists and is not a link — leaving it alone`);
    return false;
  }
  if (found.exists && found.kind === 'other') {
    // A link to a checkout that has moved is not a choice worth preserving.
    // A link to a checkout that still exists is, even if it is not this one.
    const target = path.isAbsolute(found.target) ? found.target : path.resolve(path.dirname(to), found.target);
    if (existsSync(target)) {
      console.log(`  ! ${label}: ${to} points at ${found.target} — leaving it alone`);
      return false;
    }
    console.log(`  ! ${label}: ${to} points at a missing ${found.target} — replacing it`);
    await rm(to, { force: true });
    await symlink(from, to);
    console.log(`  ✓ ${label}: ${to}`);
    return true;
  }
  await rm(to, { force: true });
  await symlink(from, to);
  console.log(`  ✓ ${label}: ${to}`);
  return true;
}

/**
 * Remove hook entries an older ayna installed.
 *
 * Versions before the plugin rename registered five hooks tagged `_ayna` and
 * pointed them at an absolute checkout path. When that checkout moves, puku-cli
 * keeps firing commands that no longer exist. On install remove only the
 * dangling ones, so a live installation is untouched; on uninstall remove all
 * of ours. Anything a user wrote is never touched, and a settings file that
 * cannot be parsed is never rewritten.
 */
async function cleanAynaHooks({ all = false } = {}) {
  let raw;
  try {
    raw = await readFile(PUKU_CLI_SETTINGS, 'utf8');
  } catch {
    return;
  }
  let settings;
  try {
    settings = JSON.parse(raw);
  } catch {
    return;
  }
  if (!settings?.hooks) return;

  let removed = 0;
  for (const [event, entries] of Object.entries(settings.hooks)) {
    if (!Array.isArray(entries)) continue;
    const kept = [];
    for (const entry of entries) {
      const hooks = Array.isArray(entry?.hooks) ? entry.hooks : [];
      const ours = hooks.some((hook) => hook?._ayna);
      const remaining = hooks.filter((hook) => {
        if (!hook?._ayna) return true;
        const command = typeof hook.command === 'string' ? hook.command : '';
        const live = command && existsSync(path.isAbsolute(command) ? command : path.resolve(command));
        if (all || !live) {
          removed++;
          return false;
        }
        return true;
      });
      if (remaining.length) kept.push({ ...entry, hooks: remaining });
      else if (!ours) kept.push(entry);
    }
    if (kept.length) settings.hooks[event] = kept;
    else delete settings.hooks[event];
  }

  if (!removed) return;
  await writeFile(PUKU_CLI_SETTINGS, `${JSON.stringify(settings, null, 2)}\n`);
  console.log(`  ✓ Puku CLI: removed ${removed} ayna hook${removed === 1 ? '' : 's'}`);
}

async function main() {
  if (uninstall) {
    await cleanAynaHooks({ all: true });
    for (const [l, name] of [...HOSTS.map((h) => [h.skills, `${h.name} skill`]), [BIN_LINK, 'command']]) {
      const found = await inspect(l);
      if (found.exists && found.kind === 'ours') {
        await rm(l, { force: true });
        console.log(`  ✓ removed the ${name} link`);
      } else if (found.exists) {
        console.log(`  ! ${l} is not ours — leaving it alone`);
      }
    }
    return;
  }

  console.log(`installing ayna from ${ROOT}`);
  await mkdir(BIN_DIR, { recursive: true });
  await chmod(path.join(ROOT, 'bin', 'ayna.mjs'), 0o755).catch(() => {});

  const installed = [];
  for (const host of HOSTS) {
    // The first host is the documented fallback path, so it is always created.
    // The others only when that tool is actually on this machine.
    const present = host === HOSTS[0] || existsSync(host.config);
    if (!present) {
      console.log(`  · ${host.name}: not installed here — skipping`);
      continue;
    }
    await mkdir(path.dirname(host.skills), { recursive: true });
    if (await link(ROOT, host.skills, `${host.name} skill`)) installed.push(host.name);
  }
  await link(path.join(ROOT, 'bin', 'ayna.mjs'), BIN_LINK, 'command');
  await cleanAynaHooks();

  console.log('');
  console.log(`  Installed for: ${installed.join(', ')}`);
  console.log('  Start a new session, then try:  /ayna');
  if (installed.includes('Puku CLI')) {
    console.log(`  For the per-workflow commands:  puku-cli --plugin-dir ${ROOT}`);
  }
  if (!(process.env.PATH ?? '').split(':').includes(BIN_DIR)) {
    console.log('');
    console.log(`  Note: ${BIN_DIR} is not on your PATH. Neither host needs it —`);
    console.log('  the skill uses the full path — but add it if you want to run `ayna` yourself:');
    console.log(`    export PATH="$HOME/.local/bin:$PATH"`);
  }
}

main().catch((err) => {
  console.error(err.message);
  process.exitCode = 1;
});
