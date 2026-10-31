import { execFileSync } from 'node:child_process';

/**
 * Who is asking.
 *
 * Every `ayna` command is its own short-lived process, so the only identity the
 * database had was a pid — which names an invocation, not an agent. A Claude
 * session that ran twenty commands looked like twenty unrelated participants:
 * twenty session rows, twenty tabs, nothing reused, and no way to ask "what is
 * this agent doing?" because nothing knew an agent was a thing that persisted.
 *
 * An agent is whatever holds one conversation: one Claude Code session, one
 * Cursor composer, one Codex run. It lives across many ayna processes and dies
 * once, and that is the unit worth tracking.
 *
 * Three ways to establish it, most trustworthy first:
 *
 *   1. The tool says so — AYNA_AGENT/AYNA_SESSION, the contract any tool can
 *      satisfy with one line of config, and the only one guaranteed to be right.
 *   2. The tool's own session variable, for tools known to export one.
 *   3. The process tree — walk up until something recognisable appears.
 *
 * Failing all three, the pid is used and behaviour is exactly what it was
 * before: correct, just not shared between invocations.
 */

/**
 * Tools that export a stable per-conversation id.
 *
 * `env` is the variable holding it. Two are verified against the installed
 * binary: CLAUDE_CODE_SESSION_ID, and PUKU_CLI_SESSION_ID — puku-cli is a
 * Claude-Code-shaped CLI and names everything the same way one prefix over
 * (PUKU_CLI_PLUGIN_ROOT, .puku-plugin, PUKU.md). The rest are the names those
 * tools use or would use; each is harmless when absent, and AYNA_SESSION
 * overrides all of them.
 *
 * `proc` matches the executable name when walking the process tree. `cmd` is
 * matched against the command line for tools whose executable name is not
 * distinctive: an npm-installed puku-cli runs as `node`, so only argv says
 * which agent it is. Both are how a tool with no session variable still gets
 * one identity per running agent rather than one per command.
 */
export const KNOWN_AGENTS = [
  { tool: 'claude', env: ['CLAUDE_CODE_SESSION_ID', 'CLAUDE_SESSION_ID'], proc: /^claude$/i },
  { tool: 'cursor', env: ['CURSOR_SESSION_ID', 'CURSOR_TRACE_ID'], proc: /^cursor/i, cmd: 'cursor-agent' },
  { tool: 'codex', env: ['CODEX_SESSION_ID', 'CODEX_THREAD_ID'], proc: /^codex/i },
  { tool: 'puku', env: ['PUKU_CLI_SESSION_ID'], proc: /^puku(-cli)?$/i, cmd: 'puku-cli' },
  { tool: 'antigravity', env: ['ANTIGRAVITY_SESSION_ID'], proc: /^antigravity/i },
  { tool: 'gemini', env: ['GEMINI_CLI_SESSION_ID'], proc: /^gemini$/i },
  { tool: 'aider', env: ['AIDER_SESSION_ID'], proc: /^aider$/i },
];

/**
 * One process: its own name, and who its parent is.
 *
 * `ps -o ppid=,comm= -p N` prints N's parent and N's *own* command, which is an
 * easy thing to read backwards — the returned `name` describes the pid asked
 * about, and `parent` is where to look next.
 */
function describeProcess(pid) {
  try {
    const out = execFileSync('ps', ['-o', 'ppid=,comm=,command=', '-p', String(pid)], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    if (!out) return null;
    const m = /^(\d+)\s+(\S+)\s*(.*)$/.exec(out);
    if (!m) return null;
    // comm is a full path for app bundles; the last segment is the executable.
    return {
      pid,
      name: m[2].trim().split('/').pop(),
      command: (m[3] ?? '').trim(),
      parent: Number(m[1]),
    };
  } catch {
    return null;
  }
}

/**
 * Walk up looking for a tool we recognise.
 *
 * Bounded because a process tree can be deep and this runs on every command; six
 * steps clears the shell and the terminal without becoming a cost.
 */
export function findAgentProcess(
  startPid = process.ppid,
  { steps = 6, describe = describeProcess, only = null } = {},
) {
  let pid = startPid;
  const candidates = only ? KNOWN_AGENTS.filter((a) => a.tool === only) : KNOWN_AGENTS;
  for (let i = 0; i < steps && pid && pid > 1; i++) {
    const proc = describe(pid);
    if (!proc) return null;
    const hit = candidates.find(
      (a) =>
        a.proc.test(proc.name ?? '') ||
        // Only a JS runtime can hide an agent behind its own name; a shell that
        // merely mentions the binary in an argument is not the agent.
        (a.cmd && /^(node|bun)$/i.test(proc.name ?? '') && (proc.command ?? '').includes(a.cmd)),
    );
    if (hit) return { tool: hit.tool, pid: proc.pid };
    pid = proc.parent;
  }
  return null;
}

/**
 * Identify the agent behind this process.
 *
 * `how` is reported so `ayna status` can say why it believes what it believes.
 * An identity guessed from the process tree is worth less than one the tool
 * declared, and a user debugging why two windows opened deserves to see which
 * they got.
 */
export function identify({ env = process.env, pid = process.pid, probeProcess = true } = {}) {
  // 1. Declared.
  if (env.AYNA_SESSION) {
    return {
      tool: env.AYNA_AGENT || 'agent',
      agentId: env.AYNA_SESSION,
      agentPid: Number(env.AYNA_AGENT_PID) || process.ppid || pid,
      how: 'declared',
    };
  }

  // 2. The tool's own variable.
  for (const a of KNOWN_AGENTS) {
    for (const name of a.env) {
      if (env[name]) {
        return {
          tool: env.AYNA_AGENT || a.tool,
          agentId: `${a.tool}:${env[name]}`,
          agentPid: Number(env.AYNA_AGENT_PID) || process.ppid || pid,
          how: `env:${name}`,
        };
      }
    }
  }

  /*
    2b. puku-cli marks every process it spawns with PUKU_CLI=1, but it does not
    export PUKU_CLI_SESSION_ID to tools in a normal install. The marker names
    the agent; the process walk supplies the pid that makes the identity stable
    across commands. Without this the pid fallback below would open a new
    window for every `ayna` invocation.
  */
  if (env.PUKU_CLI === '1') {
    const found = probeProcess ? findAgentProcess(process.ppid, { only: 'puku' }) : null;
    const fallbackPid = Number(env.AYNA_AGENT_PID) || process.ppid || pid;
    const agentPid = found?.pid ?? fallbackPid;
    return {
      tool: 'puku',
      agentId: `puku:pid-${agentPid}`,
      agentPid,
      how: 'env:PUKU_CLI',
    };
  }

  // 3. The process tree.
  if (probeProcess) {
    const found = findAgentProcess();
    if (found) {
      return {
        tool: env.AYNA_AGENT || found.tool,
        agentId: `${found.tool}:pid-${found.pid}`,
        agentPid: found.pid,
        how: 'process',
      };
    }
  }

  // 4. Nothing known. One identity per invocation, as it always was.
  return {
    tool: env.AYNA_AGENT || 'user',
    agentId: `local:pid-${pid}`,
    agentPid: pid,
    how: 'none',
  };
}

/** A short label for a terminal: "claude (env:CLAUDE_CODE_SESSION_ID)". */
export const describeAgent = (id) => `${id.tool} · ${id.agentId.slice(0, 40)} (${id.how})`;
