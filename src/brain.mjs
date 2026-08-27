import { spawn } from 'node:child_process';

/*
  The "brain" is whichever AI CLI ayna is driving this session. Puku is the
  default; Claude Code is supported as well. Each agent has its own CLI surface,
  so this module is the one place that knows how to talk to either. Everything
  else picks an agent name and calls the dispatchers below.
*/

const CLAUDE_BIN = process.env.AYNA_CLAUDE_BIN ?? 'claude';
const PUKU_BIN = process.env.AYNA_PUKU_BIN ?? 'puku';

/** Which agents ayna knows how to drive. */
export const KNOWN_AGENTS = ['claude', 'puku'];

/** Resolve which agent to use for this run. `requested` wins, then env, then config, then puku. */
export function resolveAgent(requested, cfg) {
  const fromArgs = typeof requested === 'string' ? requested : null;
  const fromEnv = process.env.AYNA_AGENT ?? null;
  const fromCfg = cfg?.agent ?? cfg?.brain ?? null;
  const chosen = fromArgs ?? fromEnv ?? fromCfg ?? 'puku';
  if (!KNOWN_AGENTS.includes(chosen)) {
    throw new Error(
      `unknown agent "${chosen}" — known: ${KNOWN_AGENTS.join(', ')} (set --agent, AYNA_AGENT, or "agent" in ayna.config.json)`,
    );
  }
  return chosen;
}

/** Build the argv that drives a one-shot agent turn. */
function buildArgs(agent, { model, tools, schema, prompt }) {
  if (agent === 'puku') {
    /*
      Puku's CLI surface is assumed to mirror Claude's for the headless turn:
      read a prompt from stdin, return JSON, restricted tool set, optional
      schema. The exact flags are configurable via env so ayna can adapt
      without code changes if Puku's CLI shifts.
    */
    const args = ['-p', '--output-format', 'json', '--model', model];
    const mode = process.env.AYNA_PUKU_PERMISSION_MODE;
    if (mode) args.push('--permission-mode', mode);
    const toolsFlag = process.env.AYNA_PUKU_TOOLS_FLAG ?? '--allowedTools';
    args.push(toolsFlag, tools.join(','));
    const schemaFlag = process.env.AYNA_PUKU_SCHEMA_FLAG ?? '--json-schema';
    if (schema) args.push(schemaFlag, JSON.stringify(schema));
    args.push('--prompt-stdin-length', String(Buffer.byteLength(prompt, 'utf8')));
    return args;
  }
  const args = [
    '-p',
    '--output-format',
    'json',
    '--model',
    model,
    '--permission-mode',
    'acceptEdits',
    '--allowedTools',
    tools.join(','),
  ];
  if (schema) args.push('--json-schema', JSON.stringify(schema));
  return args;
}

/** Spawn the chosen agent and resolve with a normalised envelope. */
export function runAgent({
  agent,
  prompt,
  cwd,
  tools = ['Read', 'Glob', 'Grep'],
  model = 'opus',
  schema = null,
  timeoutMs = 15 * 60 * 1000,
  onStderr = null,
}) {
  const binary = agent === 'puku' ? PUKU_BIN : CLAUDE_BIN;
  const args = buildArgs(agent, { model, tools, schema, prompt });

  return new Promise((resolve, reject) => {
    const child = spawn(binary, args, {
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

    child.stdin.write(prompt);
    child.stdin.end();
  });
}

/** Legacy name kept so explicit Claude callers still work. */
export function runClaude(opts) {
  return runAgent({ ...opts, agent: 'claude' });
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

/** Does the chosen agent's CLI exist on PATH? */
export function ensureAgent(agent) {
  const binary = agent === 'puku' ? PUKU_BIN : CLAUDE_BIN;
  return new Promise((resolve) => {
    const child = spawn(binary, ['--version'], { stdio: ['ignore', 'pipe', 'ignore'] });
    let out = '';
    child.stdout.on('data', (d) => {
      out += d;
    });
    child.on('error', () => resolve({ ok: false, agent, binary }));
    child.on('close', (code) => resolve({ ok: code === 0, agent, binary, version: out.trim() }));
  });
}

/** Legacy name — explicit Claude availability probe. */
export function ensureClaudeAvailable() {
  return ensureAgent('claude');
}
