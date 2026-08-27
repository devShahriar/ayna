#!/usr/bin/env node
/*
  Put ayna where the running agent expects to find it.

  Skills are read as text: indirection like `${CLAUDE_PLUGIN_ROOT}` is not
  expanded inside a skill body and is not exported to the shell, so every
  documented command resolves through a fixed fallback path. If nothing is linked
  there, a session follows the instructions, gets "Cannot find module", and
  starts reading ayna's own source to work out where it lives — which is not a
  failure anyone can debug from the outside. So installing means making that
  path real.

  Claude Code and puku-cli share the same idea (a skill is a SKILL.md with
  YAML frontmatter) but expose it differently:

    Claude Code reads `~/.claude/skills/<name>` and resolves
    `${CLAUDE_PLUGIN_ROOT}` against a symlink to the checkout. We install with
    one symlink: `~/.claude/skills/ayna → <repo>`.

    puku-cli reads `~/.puku-cli/skills/<name>` and `~/.puku-cli/settings.json`.
    ayna ships four sub-skills (`look`, `loop`, `review`, `fix`) so they appear
    as `/ayna:look`, `/ayna:loop`, `/ayna:review`, `/ayna:fix` via puku-cli's
    colon-namespaced rule. We install with one symlink
    (`~/.puku-cli/skills/ayna → <repo>/.puku-cli/skills/ayna`) and merge our
    hooks into `~/.puku-cli/settings.json`, plus rewrite
    `${AYNA_PLUGIN_ROOT}` placeholders in the committed project settings.

  Usage:
    npm run setup                              install for Claude and puku-cli
    npm run setup -- --agent=claude            install only for Claude
    npm run setup -- --agent=puku              install only for puku-cli
    npm run setup -- --uninstall               remove links/settings we made
*/
import { symlink, mkdir, rm, lstat, readlink, writeFile, readFile, chmod } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const BIN_DIR = path.join(homedir(), '.local', 'bin');
const BIN_LINK = path.join(BIN_DIR, 'ayna');

/*
  Where Claude Code looks for the ayna skill. Symlinking the project root makes
  `${CLAUDE_PLUGIN_ROOT}` resolve when a session expands it, and exposes both
  `commands/` and `SKILL.md` exactly the way Claude expects.
*/
const CLAUDE_TARGET = path.join(homedir(), '.claude', 'skills', 'ayna');

/*
  puku-cli loads skills from `~/.puku-cli/skills/<name>/SKILL.md`, where the
  slash command is the `name:` field in SKILL.md frontmatter. The ayna source
  ships one SKILL.md per skill directory — `ayna/`, `ayna-look/`, `ayna-loop/`,
  `ayna-review/`, `ayna-fix/` — so each appears as a top-level `/ayna*` slash
  command.

  The main `ayna` skill symlink points at the **repo root** (matching Claude's
  `${CLAUDE_PLUGIN_ROOT}` pattern) so that `$HOME/.puku-cli/skills/ayna/bin/ayna.mjs`
  resolves to the real binary. The four sub-skill symlinks point at the
  matching source dir in this checkout.
*/
const PUKU_SKILLS_DIR = path.join(homedir(), '.puku-cli', 'skills');
const PUKU_MAIN_SKILL_SOURCE = ROOT;
const PUKU_MAIN_SKILL_TARGET = path.join(PUKU_SKILLS_DIR, 'ayna');
const PUKU_SUB_SKILL_NAMES = ['ayna-look', 'ayna-loop', 'ayna-review', 'ayna-fix'];

/*
  puku-cli reads three settings files in order: user-level, project-level, and
  a local-override. We register hooks at the user level so a single install
  covers every project the user opens. The project-level settings live inside
  this repo at `.puku-cli/settings.json`; we rewrite its `${AYNA_PLUGIN_ROOT}`
  placeholders to the absolute checkout path so puku-cli can find the scripts.
*/
const PUKU_USER_SETTINGS = path.join(homedir(), '.puku-cli', 'settings.json');
const PUKU_PROJECT_SETTINGS = path.join(ROOT, '.puku-cli', 'settings.json');
const PUKU_HOOK_EVENTS = ['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'Stop'];

const argv = process.argv.slice(2);
const uninstall = argv.includes('--uninstall');
const agentFlag = (() => {
  const found = argv.find((a) => a.startsWith('--agent='));
  if (!found) return null;
  const value = found.slice('--agent='.length).trim().toLowerCase();
  if (value === 'claude' || value === 'puku') return value;
  console.error(`  ! unknown --agent value: ${value} (expected: claude, puku)`);
  process.exit(1);
})();

/** What is at `link`, if anything: a link of ours, someone else's, or nothing. */
async function inspect(link) {
  try {
    const st = await lstat(link);
    if (!st.isSymbolicLink()) return { exists: true, kind: 'not-a-link' };
    const target = await readlink(link);
    const ourTargets = new Set([
      ROOT,
      path.join(ROOT, 'bin', 'ayna.mjs'),
      PUKU_MAIN_SKILL_SOURCE,
      ...PUKU_SUB_SKILL_NAMES.map((n) => path.join(ROOT, '.puku-cli', 'skills', n)),
    ]);
    return {
      exists: true,
      kind: ourTargets.has(target) ? 'ours' : 'other',
      target,
    };
  } catch {
    return { exists: false };
  }
}

async function link(from, to, label, opts = {}) {
  const { force = false } = opts;
  const found = await inspect(to);
  if (found.exists && found.kind === 'not-a-link') {
    console.log(`  ! ${label}: ${to} exists and is not a link — leaving it alone`);
    return false;
  }
  if (found.exists && found.kind === 'other') {
    // `force` is for the upgrade case: same project, but an older install
    // pointed the symlink at a different sub-path (e.g. an old nested
    // skills/ayna that no longer matches today's layout). We only rewrite
    // when the existing target sits inside this checkout — never when it
    // points at an unrelated ayna install belonging to someone else.
    const inside = (found.target ?? '').startsWith(ROOT + path.sep) || found.target === ROOT;
    if (!force || !inside) {
      console.log(`  ! ${label}: ${to} points at ${found.target} — leaving it alone`);
      return false;
    }
    console.log(`  ↻ ${label}: replacing stale link → ${from}`);
  }
  await rm(to, { force: true });
  await symlink(from, to);
  console.log(`  ✓ ${label}: ${to}`);
  return true;
}

async function installClaude() {
  await mkdir(path.dirname(CLAUDE_TARGET), { recursive: true });
  await link(ROOT, CLAUDE_TARGET, 'claude skill');
}

async function uninstallClaude() {
  const found = await inspect(CLAUDE_TARGET);
  if (found.exists && found.kind === 'ours') {
    await rm(CLAUDE_TARGET, { force: true });
    console.log('  ✓ removed the claude skill link');
  } else if (found.exists) {
    console.log(`  ! ${CLAUDE_TARGET} is not ours — leaving it alone`);
  }
}

/*
  puku-cli's user-level settings.json is a single object. Multiple sources of
  hooks can register — `Settings hooks: captured N matcher(s) across M event(s)`
  — so ayna's entries are merged in alongside anything the user has already.

  The merge is shallow within `hooks`: ayna adds entries to its five hook
  events, and never removes anything the user wrote. Each hook entry is tagged
  with a hidden `_ayna` marker so `npm run uninstall` can find and remove only
  ours.
*/
async function readJsonSafe(file, fallback) {
  try {
    return JSON.parse(await readFile(file, 'utf8'));
  } catch {
    return fallback;
  }
}

async function writeJsonPretty(file, obj) {
  await writeFile(file, `${JSON.stringify(obj, null, 2)}\n`);
}

/*
  Rewrite the project's `.puku-cli/settings.json`: turn `${AYNA_PLUGIN_ROOT}`
  into the absolute checkout path. Done as a string replace because the file
  is committed and we want the rewritten version to keep its key order and
  any extra hooks the user added locally.
*/
async function rewriteProjectSettings() {
  let src;
  try {
    src = await readFile(PUKU_PROJECT_SETTINGS, 'utf8');
  } catch {
    return;
  }
  const rewritten = src.replace(/\$\{AYNA_PLUGIN_ROOT\}/g, ROOT);
  if (rewritten !== src) {
    await writeFile(PUKU_PROJECT_SETTINGS, rewritten);
    console.log(`  ✓ rewrote placeholders in ${PUKU_PROJECT_SETTINGS}`);
  }
}

async function installPuku() {
  await rewriteProjectSettings();
  await mkdir(PUKU_SKILLS_DIR, { recursive: true });
  // The main /ayna skill symlink points at the repo root so its sub-paths
  // (notably `bin/ayna.mjs`) resolve to the real binary, matching Claude's
  // `${CLAUDE_PLUGIN_ROOT}` convention. `force` lets the installer rewrite
  // stale nested-layout links from older ayna versions.
  await link(PUKU_MAIN_SKILL_SOURCE, PUKU_MAIN_SKILL_TARGET, 'puku skill /ayna (rooted at repo)', { force: true });
  for (const name of PUKU_SUB_SKILL_NAMES) {
    const src = path.join(ROOT, '.puku-cli', 'skills', name);
    const dst = path.join(PUKU_SKILLS_DIR, name);
    await link(src, dst, `puku skill /${name}`);
  }
  await mkdir(path.dirname(PUKU_USER_SETTINGS), { recursive: true });

  // Read the committed project's settings — that's our source of truth for
  // which scripts ayna ships. Anything the user has added locally is kept by
  // merging, not overwriting.
  const project = await readJsonSafe(PUKU_PROJECT_SETTINGS, { hooks: {} });
  const user = await readJsonSafe(PUKU_USER_SETTINGS, {});

  const hooks = user.hooks ?? {};
  for (const event of PUKU_HOOK_EVENTS) {
    const eventEntries = project.hooks?.[event] ?? [];
    const oursForEvent = eventEntries.map((matcher) => ({
      ...matcher,
      hooks: (matcher.hooks ?? []).map((h) => ({ ...h, _ayna: true })),
    }));
    const theirs = (hooks[event] ?? []).filter((m) =>
      !(m.hooks ?? []).some((h) => h._ayna),
    );
    hooks[event] = [...theirs, ...oursForEvent];
  }

  user.hooks = hooks;
  await writeJsonPretty(PUKU_USER_SETTINGS, user);
  console.log(`  ✓ puku-cli: wrote ${PUKU_USER_SETTINGS}`);
}

async function uninstallPuku() {
  const user = await readJsonSafe(PUKU_USER_SETTINGS, null);
  let changed = false;
  if (user) {
    for (const event of PUKU_HOOK_EVENTS) {
      const entries = user.hooks?.[event];
      if (!Array.isArray(entries)) continue;
      const kept = entries.filter((m) => !(m.hooks ?? []).some((h) => h._ayna));
      if (kept.length !== entries.length) {
        user.hooks[event] = kept;
        changed = true;
      }
    }
  }
  if (changed) {
    await writeJsonPretty(PUKU_USER_SETTINGS, user);
    console.log('  ✓ puku-cli: removed ayna hook entries from user settings');
  } else {
    console.log('  ✓ puku-cli: no ayna entries to remove');
  }

  for (const name of [path.basename(PUKU_MAIN_SKILL_TARGET), ...PUKU_SUB_SKILL_NAMES]) {
    const dst = path.join(PUKU_SKILLS_DIR, name);
    const found = await inspect(dst);
    if (found.exists && found.kind === 'ours') {
      await rm(dst, { force: true });
      console.log(`  ✓ removed the puku skill link /${name}`);
    } else if (found.exists) {
      console.log(`  ! ${dst} is not ours — leaving it alone`);
    }
  }
}

async function maybeRemoveBin() {
  const found = await inspect(BIN_LINK);
  if (found.exists && found.kind === 'ours') {
    await rm(BIN_LINK, { force: true });
    console.log('  ✓ removed the bin link');
  } else if (found.exists) {
    console.log(`  ! ${BIN_LINK} is not ours — leaving it alone`);
  }
}

async function main() {
  const agents = agentFlag ? [agentFlag] : ['claude', 'puku'];

  if (uninstall) {
    if (agents.includes('claude')) await uninstallClaude();
    if (agents.includes('puku')) await uninstallPuku();
    await maybeRemoveBin();
    return;
  }

  console.log(`installing ayna from ${ROOT} for: ${agents.join(', ')}`);
  await mkdir(BIN_DIR, { recursive: true });
  await chmod(path.join(ROOT, 'bin', 'ayna.mjs'), 0o755).catch(() => {});

  if (agents.includes('claude')) await installClaude();
  if (agents.includes('puku')) await installPuku();
  await link(path.join(ROOT, 'bin', 'ayna.mjs'), BIN_LINK, 'bin');

  console.log('');
  if (agents.includes('claude')) {
    console.log('  Start a new Claude session, then try:  /ayna:fix');
  }
  if (agents.includes('puku')) {
    console.log('  Start a new puku-cli session in any project, then try:  /ayna-fix');
    console.log('  Also available: /ayna, /ayna-look, /ayna-loop, /ayna-review');
    console.log('  Hooks are wired automatically via ~/.puku-cli/settings.json.');
  }
  if (!(process.env.PATH ?? '').split(':').includes(BIN_DIR)) {
    console.log('');
    console.log(`  Note: ${BIN_DIR} is not on your PATH. The agent does not need it —`);
    console.log('  the skill uses the full path — but add it if you want to run `ayna` yourself:');
    console.log(`    export PATH="$HOME/.local/bin:$PATH"`);
  }
}

main().catch((err) => {
  console.error(err.message);
  process.exitCode = 1;
});
