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
import { symlink, mkdir, rm, lstat, readlink, chmod } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
/*
  Every host that reads SKILL.md gets a link.

  puku-cli is Claude Code shaped and loads skills from ~/.puku/skills, so ayna
  installs into both. A host that is not present costs nothing: the parent
  directory is only created when its config directory already exists, so this
  does not scatter empty folders for tools nobody has.
*/
const HOSTS = [
  { name: 'Claude Code', config: path.join(homedir(), '.claude'), skills: path.join(homedir(), '.claude', 'skills', 'ayna') },
  { name: 'puku-cli', config: path.join(homedir(), '.puku'), skills: path.join(homedir(), '.puku', 'skills', 'ayna') },
];
const SKILL_LINK = HOSTS[0].skills; // the documented fallback path
const BIN_DIR = path.join(homedir(), '.local', 'bin');
const BIN_LINK = path.join(BIN_DIR, 'ayna');

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
    console.log(`  ! ${label}: ${to} points at ${found.target} — leaving it alone`);
    return false;
  }
  await rm(to, { force: true });
  await symlink(from, to);
  console.log(`  ✓ ${label}: ${to}`);
  return true;
}

async function main() {
  if (uninstall) {
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

  console.log('');
  console.log(`  Start a new ${installed[0] ?? 'Claude'} session, then try:  /ayna:fix`);
  if (!(process.env.PATH ?? '').split(':').includes(BIN_DIR)) {
    console.log('');
    console.log(`  Note: ${BIN_DIR} is not on your PATH. Claude does not need it —`);
    console.log('  the skill uses the full path — but add it if you want to run `ayna` yourself:');
    console.log(`    export PATH="$HOME/.local/bin:$PATH"`);
  }
}

main().catch((err) => {
  console.error(err.message);
  process.exitCode = 1;
});
