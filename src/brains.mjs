import { access, constants } from 'node:fs/promises';
import path from 'node:path';

/**
 * The tools ayna can drive.
 *
 * Two different lists get confused constantly, so they are kept apart:
 *
 *   - an **agent** is something that *uses* ayna. It opens a review, reads a
 *     screenshot, edits files. Identifying one is `src/agent.mjs`, and the bar is
 *     low: anything with a terminal qualifies.
 *   - a **brain** is something ayna *drives*. `ayna work` hands it a prompt and
 *     waits for it to finish. The bar is much higher — it needs a non-interactive
 *     mode that takes a prompt, does the work and exits.
 *
 * The trap is that several tools ship both, under names one letter apart. `cursor`
 * opens the editor and `cursor-agent` is the headless one; `puku` opens the editor
 * and `puku-cli` is the headless one. Judging a tool by the first binary on the
 * PATH gets this exactly backwards — which is how puku-cli, a CLI with -p,
 * --output-format json and --permission-mode, was written off here as an editor
 * with no headless mode. `detect` names the binary that actually does the work.
 *
 * So: every entry here is a command that answers a prompt and exits, and a tool
 * absent from this list is not a tool that cannot work with ayna.
 */
export const BRAINS = {
  claude: {
    cmd: 'claude',
    args: ['-p'],
    detect: 'claude',
    note: 'Claude Code, headless. The default, and the one ayna is tested against.',
  },
  codex: {
    cmd: 'codex',
    args: ['exec'],
    detect: 'codex',
    note: 'OpenAI Codex CLI. `codex exec` is its non-interactive mode.',
  },
  cursor: {
    cmd: 'cursor-agent',
    args: ['-p'],
    detect: 'cursor-agent',
    note: "Cursor's CLI agent — the binary is `cursor-agent`, not `cursor` (that opens the editor).",
  },
  gemini: {
    cmd: 'gemini',
    args: ['-p'],
    detect: 'gemini',
    note: 'Gemini CLI.',
  },
  puku: {
    cmd: 'puku-cli',
    args: ['-p'],
    detect: 'puku-cli',
    note: "Puku CLI — the same shape as Claude Code: -p, --output-format json, --permission-mode. The binary is `puku-cli`; plain `puku` opens the editor.",
  },
  aider: {
    cmd: 'aider',
    args: ['--yes', '--message'],
    detect: 'aider',
    note: 'aider, non-interactive. --yes so it does not stop to ask.',
  },
};

/**
 * Editors that can drive ayna but cannot be driven by it.
 *
 * Named on purpose. "puku is not a brain" is a much more useful answer than "no
 * brain called puku", because the first tells you the thing still works — you
 * run the commands from inside it, and ayna tracks your session like any other.
 */
export const EDITORS = {
  antigravity: 'Antigravity — no documented headless prompt mode. Use ayna from its terminal.',
  cursor: 'the `cursor` binary opens the editor; the brain is `cursor-agent`.',
};

/**
 * Is this command actually on the PATH?
 *
 * By reading PATH rather than asking a shell. `command -v` needs `shell: true`,
 * which concatenates rather than escapes its arguments — a warning from Node and
 * a real hole, since the name being tested can come from a config file. And it
 * is no more accurate: this is the same lookup the shell would do.
 */
export async function available(cmd) {
  if (!cmd) return false;
  // An explicit path is checked as given, not searched for.
  if (cmd.includes('/')) return isExecutable(cmd);

  for (const dir of (process.env.PATH ?? '').split(path.delimiter).filter(Boolean)) {
    if (await isExecutable(path.join(dir, cmd))) return true;
  }
  return false;
}

async function isExecutable(file) {
  try {
    await access(file, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** Every brain, with whether this machine actually has it. */
export async function surveyBrains(cfg = {}) {
  const configured = cfg.brains ?? {};
  const names = new Set([...Object.keys(BRAINS), ...Object.keys(configured)]);

  const rows = [];
  for (const name of names) {
    const spec = { ...(BRAINS[name] ?? {}), ...(configured[name] ?? {}) };
    rows.push({
      name,
      cmd: spec.cmd ?? name,
      args: spec.args ?? [],
      note: spec.note ?? 'from ayna.config.json',
      custom: Boolean(configured[name]),
      installed: await available(spec.detect ?? spec.cmd ?? name),
    });
  }
  return rows.sort((a, b) => Number(b.installed) - Number(a.installed) || a.name.localeCompare(b.name));
}

/**
 * Resolve a brain by name, preferring the user's config over the built-in.
 *
 * The error matters as much as the success: somebody asking for a brain that is
 * really an editor should be told that, not told it does not exist.
 */
export function resolveBrain(cfg, name) {
  const chosen = name ?? cfg?.brain ?? 'claude';
  const spec = { ...(BRAINS[chosen] ?? {}), ...((cfg?.brains ?? {})[chosen] ?? {}) };

  if (!spec.cmd) {
    if (EDITORS[chosen]) {
      throw new Error(
        `"${chosen}" is an editor, not a headless brain — ${EDITORS[chosen]}\n` +
          `  Brains ayna can drive: ${Object.keys(BRAINS).join(', ')}`,
      );
    }
    throw new Error(
      `no brain called "${chosen}". Built in: ${Object.keys(BRAINS).join(', ')}.\n` +
        `  Add your own to ayna.config.json: {"brains":{"${chosen}":{"cmd":"…","args":["-p"]}}}`,
    );
  }
  return { name: chosen, cmd: spec.cmd, args: spec.args ?? [] };
}
