import { spawn } from 'node:child_process';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

/*
  One headless turn from whichever CLI ayna is driving.

  Claude Code and puku-cli share a surface: -p, --output-format json,
  --permission-mode, --allowedTools, --json-schema, and the opus/sonnet/haiku
  family aliases. They do not share every historical flag — so the argv is
  built in one place where those differences can be named, rather than
  sprinkled through callers.

  Codex is a different shape again, and a different shape in three places at
  once, which is why it gets its own builders rather than a conditional or two:

    - it is invoked as `codex exec`, not as a bare binary with `-p`;
    - its structured output is a JSONL *event stream*, not one JSON envelope,
      and the reply rides on an `item.completed` whose item is an
      `agent_message`;
    - its schema flag is `--output-schema <FILE>`, a path — unlike Claude's
      inline `--json-schema`, codex refuses to take the schema as an argument.

  Everything below is taken from the installed codex's own help and from
  codex-rs/exec, not from a guess at what a Codex-shaped CLI would look like.
*/

const BINARIES = {
  claude: () => process.env.AYNA_CLAUDE_BIN ?? 'claude',
  puku: () => process.env.AYNA_PUKU_BIN ?? 'puku-cli',
  codex: () => process.env.AYNA_CODEX_BIN ?? 'codex',
};

/** The executable that does the headless work, never the editor wrapper. */
export function agentCommand(agent = 'claude') {
  const binary = BINARIES[agent];
  if (!binary) {
    throw new Error(
      `unknown agent "${agent}" — structured turns support: ${Object.keys(BINARIES).join(', ')}. ` +
        '`ayna work` accepts any brain; loop and critique need the Claude-shaped flags.',
    );
  }
  return binary();
}

/**
 * The argv both CLIs accept.
 *
 * Both accept the same family aliases (opus, sonnet, haiku) as well as
 * puku-ai-*. A model the agent does not know is left for it to reject with its
 * own message; silently dropping a configured model would run a different one
 * than the user asked for. `--prompt-stdin-length` is deliberately absent: it
 * does not exist in puku-cli's help, and an unknown flag is an error.
 */
export function agentArgs(agent = 'claude', { model, tools = ['Read', 'Glob', 'Grep'], schema = null } = {}) {
  if (agent === 'codex') return codexArgs({ model, schema });
  const args = ['-p', '--output-format', 'json'];
  if (model) args.push('--model', model);
  args.push('--permission-mode', 'acceptEdits', '--allowedTools', tools.join(','));
  if (schema) args.push('--json-schema', JSON.stringify(schema));
  return args;
}

/**
 * Codex's argv.
 *
 * `--json` makes it print a JSONL event stream, which is the only way to get
 * a reply back in a shape a machine can read. `--sandbox workspace-write` lets
 * the agent edit files, which is the whole point of the implementer turn;
 * `--approve-for-me` routes approval prompts away, because a headless turn has
 * nobody to ask. `--skip-git-repo-check` is there because a target project
 * need not be a git repo, and codex refuses to run outside one otherwise.
 *
 * The schema is not in here: codex's `--output-schema` takes a *file*, so it
 * cannot be built from the caller's schema object alone. `runCodex` writes
 * that file and passes its path.
 */
export function codexArgs({ model, sandbox = 'workspace-write' } = {}) {
  const args = ['exec', '--json', '--sandbox', sandbox, '--approve-for-me', '--skip-git-repo-check'];
  if (model) args.push('--model', model);
  return args;
}

/**
 * Run one headless turn and normalise the envelope.
 *
 * Claude reads the prompt on stdin; puku-cli documents a positional prompt.
 * Passing it positionally for puku avoids depending on stdin behaviour that is
 * not in its help.
 *
 * Codex takes a positional prompt too, but it also reads stdin when stdin is
 * piped, and appends what it finds as a `<stdin>` block. Piping an empty
 * stdin is not the same as leaving stdin alone — codex sees the pipe, not its
 * contents — so codex's stdin is inherited from the parent rather than
 * opened. That keeps the prompt exactly what the caller wrote.
 */
export function runAgent({
  agent = 'claude',
  prompt,
  cwd,
  tools = ['Read', 'Glob', 'Grep'],
  model = 'opus',
  schema = null,
  timeoutMs = 15 * 60 * 1000,
  onStderr = null,
}) {
  if (agent === 'codex') return runCodex({ prompt, cwd, model, schema, timeoutMs, onStderr });

  const binary = agentCommand(agent);
  const args = agentArgs(agent, { model, tools, schema });
  const promptOnStdin = agent === 'claude';

  return new Promise((resolve, reject) => {
    const child = spawn(binary, promptOnStdin ? args : [...args, prompt], {
      cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: process.env,
    });

    let out = '';
    let err = '';
    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      reject(new Error(`${agent} timed out after ${Math.round(timeoutMs / 1000)}s`));
    }, timeoutMs);

    child.stdout.on('data', (d) => {
      out += d;
    });
    child.stderr.on('data', (d) => {
      err += d;
      onStderr?.(String(d));
    });
    child.on('error', (e) => {
      clearTimeout(timer);
      reject(new Error(`could not run "${binary}": ${e.message}`));
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        reject(new Error(`${agent} exited ${code}: ${err.trim() || out.trim() || 'no output'}`));
        return;
      }
      resolve(parseEnvelope(agent, out, err));
    });

    if (promptOnStdin) child.stdin.write(prompt);
    child.stdin.end();
  });
}

/**
 * One headless Codex turn.
 *
 * Codex is not Claude with a different flag: its stdout is a JSONL event
 * stream, its structured output is a schema *file*, and its reply is one
 * event among many rather than the whole of stdout. So this runs its own
 * child, collects its own events, and resolves with the same envelope shape
 * the rest of ayna already expects.
 */
function runCodex({ prompt, cwd, model, schema, timeoutMs, onStderr }) {
  const binary = agentCommand('codex');
  // The schema has to exist on disk before codex starts, and must outlive the
  // call only until codex has read it — so it lives in a temp dir that is
  // removed either way.
  let schemaFile = null;
  let schemaDir = null;

  return (async () => {
    const args = codexArgs({ model });
    if (schema) {
      schemaDir = await mkdtemp(path.join(tmpdir(), 'ayna-codex-'));
      schemaFile = path.join(schemaDir, 'schema.json');
      await writeFile(schemaFile, JSON.stringify(schema), 'utf8');
      args.push('--output-schema', schemaFile);
    }

    try {
      const { out, err, code } = await spawnCodex({ binary, args, prompt, cwd, timeoutMs, onStderr });
      // Codex can exit non-zero and still have printed a usable reply, so the
      // stream is parsed first: a turn that failed says so in the stream, and
      // that message is better than "exited 1". Only a non-zero exit with
      // nothing usable in the stream falls back to the exit code.
      if (code !== 0) {
        try {
          return parseCodexEnvelope(out, err);
        } catch {
          throw new Error(`codex exited ${code}: ${err.trim() || out.trim().slice(0, 400) || 'no output'}`);
        }
      }
      return parseCodexEnvelope(out, err);
    } finally {
      if (schemaDir) await rm(schemaDir, { recursive: true, force: true }).catch(() => {});
    }
  })();
}

/** Spawn `codex exec`, capture stdout and stderr, and never pipe stdin. */
function spawnCodex({ binary, args, prompt, cwd, timeoutMs, onStderr }) {
  return new Promise((resolve, reject) => {
    // stdin: 'ignore' — an inherited or piped stdin is read by codex and
    // appended to the prompt as a <stdin> block, which would change what the
    // agent was asked.
    const child = spawn(binary, [...args, prompt], {
      cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: process.env,
    });

    let out = '';
    let err = '';
    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      reject(new Error(`codex timed out after ${Math.round(timeoutMs / 1000)}s`));
    }, timeoutMs);

    child.stdout.on('data', (d) => {
      out += d;
    });
    child.stderr.on('data', (d) => {
      err += d;
      onStderr?.(String(d));
    });
    child.on('error', (e) => {
      clearTimeout(timer);
      reject(new Error(`could not run "${binary}": ${e.message}`));
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ out, err, code });
    });
  });
}

/**
 * Turn Codex's event stream into the envelope ayna already speaks.
 *
 * Codex emits one JSON object per line. The reply is the `item.completed`
 * event whose item is an `agent_message` — its `text` is either prose or,
 * when a schema was supplied, a JSON string. Everything else in the stream is
 * progress: reasoning, command executions, file changes.
 *
 * A failed turn is a `turn.failed` (or `thread.failed`) event carrying the
 * message, and codex also exits non-zero for it. Both are reported, because
 * codex's own retry loop prints a `type: "error"` event for every attempt
 * before the turn finally fails — those are transient and must not be mistaken
 * for the final error.
 */
export function parseCodexEnvelope(stdout, stderr = '') {
  const events = [];
  for (const line of String(stdout).split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      events.push(JSON.parse(trimmed));
    } catch {
      // Not every line is JSON — codex writes progress notes to stdout too.
    }
  }

  const message = [...events]
    .reverse()
    .find((e) => e.type === 'item.completed' && e.item?.type === 'agent_message');

  const failure = events.find((e) => e.type === 'turn.failed' || e.type === 'thread.failed');
  if (failure) {
    const detail = failure.error?.message ?? failure.message ?? String(failure.error ?? '');
    throw new Error(`codex turn failed: ${detail || stderr.trim() || 'no detail'}`);
  }

  const text = message?.item?.text ?? '';
  return {
    text,
    json: coerceJson(text),
    costUsd: null,
    durationMs: null,
    turns: null,
    isError: false,
    threadId: events.find((e) => e.type === 'thread.started')?.thread_id ?? null,
  };
}

/** Legacy name kept so explicit Claude callers still work. */
export function runClaude(opts) {
  return runAgent({ ...opts, agent: 'claude' });
}

/** Is the agent's CLI on this machine? */
export function ensureAgent(agent = 'claude') {
  const binary = agentCommand(agent);
  return new Promise((resolve) => {
    const child = spawn(binary, ['--version'], { stdio: ['ignore', 'pipe', 'ignore'] });
    let out = '';
    child.stdout.on('data', (d) => {
      out += d;
    });
    child.on('error', () => resolve({ ok: false }));
    child.on('close', (code) => resolve({ ok: code === 0, version: out.trim() }));
  });
}

/** Legacy name kept so explicit Claude callers still work. */
export function ensureClaudeAvailable() {
  return ensureAgent('claude');
}

function parseEnvelope(agent, stdout, stderr) {
  let envelope;
  try {
    envelope = JSON.parse(stdout);
  } catch {
    throw new Error(`unparseable ${agent} output: ${stdout.slice(0, 400) || stderr.slice(0, 400)}`);
  }
  const text = typeof envelope.result === 'string' ? envelope.result : JSON.stringify(envelope.result);
  return {
    text,
    json: coerceJson(envelope.result),
    costUsd: envelope.total_cost_usd ?? null,
    durationMs: envelope.duration_ms ?? null,
    turns: envelope.num_turns ?? null,
    isError: Boolean(envelope.is_error),
  };
}

/** Structured output usually arrives parsed; when it doesn't, dig the object out of the text. */
function coerceJson(result) {
  if (result && typeof result === 'object') return result;
  if (typeof result !== 'string') return null;
  try {
    return JSON.parse(result);
  } catch {
    // Fall through to fenced/embedded JSON.
  }
  const fenced = result.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidate = fenced?.[1] ?? result.slice(result.indexOf('{'), result.lastIndexOf('}') + 1);
  try {
    return JSON.parse(candidate);
  } catch {
    return null;
  }
}
