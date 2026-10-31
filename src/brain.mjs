import { spawn } from 'node:child_process';

/*
  One headless turn from whichever CLI ayna is driving.

  Claude Code and puku-cli share a surface: -p, --output-format json,
  --permission-mode, --allowedTools, --json-schema, and the opus/sonnet/haiku
  family aliases. They do not share every historical flag — so the argv is
  built in one place where those differences can be named, rather than
  sprinkled through callers.
*/

const BINARIES = {
  claude: () => process.env.AYNA_CLAUDE_BIN ?? 'claude',
  puku: () => process.env.AYNA_PUKU_BIN ?? 'puku-cli',
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
  const args = ['-p', '--output-format', 'json'];
  if (model) args.push('--model', model);
  args.push('--permission-mode', 'acceptEdits', '--allowedTools', tools.join(','));
  if (schema) args.push('--json-schema', JSON.stringify(schema));
  return args;
}

/**
 * Run one headless turn and normalise the envelope.
 *
 * Claude reads the prompt on stdin; puku-cli documents a positional prompt.
 * Passing it positionally for puku avoids depending on stdin behaviour that is
 * not in its help.
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
