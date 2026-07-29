import { spawn } from 'node:child_process';

const CLAUDE_BIN = process.env.AYNA_CLAUDE_BIN ?? 'claude';

/**
 * One headless Claude Code turn. The prompt goes in on stdin (no argv escaping),
 * and the model works inside `cwd` with only the tools we hand it.
 *
 * This is the whole trick: Claude Code's Read tool accepts PNGs, so passing a
 * screenshot path is the same as showing it the rendered page.
 */
export function runClaude({
  prompt,
  cwd,
  tools = ['Read', 'Glob', 'Grep'],
  model = 'opus',
  schema = null,
  timeoutMs = 15 * 60 * 1000,
  onStderr = null,
}) {
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

  return new Promise((resolve, reject) => {
    const child = spawn(CLAUDE_BIN, args, {
      cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: process.env,
    });

    let out = '';
    let err = '';
    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      reject(new Error(`claude timed out after ${Math.round(timeoutMs / 1000)}s`));
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
      reject(new Error(`could not run "${CLAUDE_BIN}": ${e.message}`));
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        reject(new Error(`claude exited ${code}: ${err.trim() || out.trim() || 'no output'}`));
        return;
      }
      resolve(parseEnvelope(out, err));
    });

    child.stdin.write(prompt);
    child.stdin.end();
  });
}

function parseEnvelope(stdout, stderr) {
  let envelope;
  try {
    envelope = JSON.parse(stdout);
  } catch {
    throw new Error(`unparseable claude output: ${stdout.slice(0, 400) || stderr.slice(0, 400)}`);
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

export async function ensureClaudeAvailable() {
  return new Promise((resolve) => {
    const child = spawn(CLAUDE_BIN, ['--version'], { stdio: ['ignore', 'pipe', 'ignore'] });
    let out = '';
    child.stdout.on('data', (d) => {
      out += d;
    });
    child.on('error', () => resolve({ ok: false }));
    child.on('close', (code) => resolve({ ok: code === 0, version: out.trim() }));
  });
}
