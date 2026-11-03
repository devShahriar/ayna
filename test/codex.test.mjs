/*
  What codex actually gives a child process, and what it gives back.

  Codex is not Claude with a different flag. Three things differ, and each one
  is a place where guessing wrong produces a failed turn rather than a
  warning:

    - it is `codex exec`, and its stdout is a JSONL *event stream*;
    - the reply is one event inside that stream, not the whole of stdout;
    - its schema flag is `--output-schema <FILE>`, a path.

  The event shapes below were taken from codex-rs/exec (exec_events.rs) and
  confirmed against the installed codex, not from a guess at what a
  Codex-shaped CLI would print.
*/
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { agentCommand, agentArgs, codexArgs, parseCodexEnvelope } from '../src/brain.mjs';
import { resolveBrain, surveyBrains } from '../src/brains.mjs';
import { identify, findAgentProcess } from '../src/agent.mjs';

/** A codex event stream in which the agent answered with `text`. */
function stream(text, extra = []) {
  return [
    JSON.stringify({ type: 'thread.started', thread_id: 'thread-1' }),
    JSON.stringify({ type: 'turn.started' }),
    ...extra,
    JSON.stringify({ type: 'item.completed', item: { id: 'item_0', type: 'agent_message', text } }),
    JSON.stringify({ type: 'turn.completed' }),
  ].join('\n');
}

describe("codex's argv", () => {
  test('it runs the non-interactive subcommand and asks for JSON', () => {
    const args = agentArgs('codex', { model: 'gpt-5' });

    assert.equal(args[0], 'exec', '`codex` alone opens the interactive TUI');
    assert.ok(args.includes('--json'), 'without --json the output is prose, not events');
    assert.equal(args[args.indexOf('--model') + 1], 'gpt-5');
  });

  test("it does not get Claude's flags", () => {
    const args = agentArgs('codex', { model: 'gpt-5', tools: ['Read'], schema: { type: 'object' } });

    assert.ok(!args.includes('-p'), 'codex has no -p');
    assert.ok(!args.includes('--output-format'), 'codex has no --output-format');
    assert.ok(!args.includes('--permission-mode'), 'codex has no --permission-mode');
    assert.ok(!args.includes('--allowedTools'), 'codex has no --allowedTools');
    assert.ok(!args.includes('--json-schema'), 'codex takes a schema as a file, not inline');
  });

  test('the schema is a file path, so it is not in the argv builder', () => {
    const args = codexArgs({ model: 'gpt-5' });
    assert.ok(!args.includes('--output-schema'));
  });

  test('a headless turn can edit files and asks nobody for approval', () => {
    const args = codexArgs({});
    assert.equal(args[args.indexOf('--sandbox') + 1], 'workspace-write');
    assert.ok(args.includes('--approve-for-me'), 'a headless turn has nobody to approve it');
  });

  test('the binary is codex itself', () => {
    assert.equal(agentCommand('codex'), 'codex');
  });
});

describe("codex's event stream", () => {
  test('the reply is the agent_message item, not the whole stdout', () => {
    const out = stream('the page looks fine', [
      JSON.stringify({ type: 'item.started', item: { id: 'item_0', type: 'reasoning' } }),
      JSON.stringify({ type: 'item.completed', item: { id: 'item_1', type: 'command_execution' } }),
    ]);

    const envelope = parseCodexEnvelope(out);
    assert.equal(envelope.text, 'the page looks fine');
    assert.equal(envelope.threadId, 'thread-1');
  });

  test('a structured reply arrives as JSON and is parsed', () => {
    const out = stream(JSON.stringify({ score: 7, issues: [{ area: 'nav' }] }));
    const envelope = parseCodexEnvelope(out);

    assert.equal(envelope.json.score, 7);
    assert.equal(envelope.json.issues.length, 1);
  });

  test('a failed turn says why, rather than reporting an empty reply', () => {
    const out = [
      JSON.stringify({ type: 'error', message: 'Reconnecting... 1/5 (401 Unauthorized)' }),
      JSON.stringify({ type: 'error', message: 'Reconnecting... 2/5 (401 Unauthorized)' }),
      JSON.stringify({ type: 'turn.failed', error: { message: '401 Unauthorized' } }),
    ].join('\n');

    assert.throws(() => parseCodexEnvelope(out), /401 Unauthorized/);
  });

  test('lines that are not JSON are ignored, not fatal', () => {
    const out = ['Reading additional input from stdin...', ...stream('ok').split('\n')].join('\n');
    assert.equal(parseCodexEnvelope(out).text, 'ok');
  });

  test('a stream with no agent message is an empty reply, not a crash', () => {
    const out = [
      JSON.stringify({ type: 'thread.started', thread_id: 't' }),
      JSON.stringify({ type: 'turn.started' }),
    ].join('\n');

    const envelope = parseCodexEnvelope(out);
    assert.equal(envelope.text, '');
    assert.equal(envelope.json, null);
  });
});

describe('codex as a brain', () => {
  test('it resolves like any other brain', () => {
    const brain = resolveBrain({}, 'codex');
    assert.equal(brain.cmd, 'codex');
    assert.deepEqual(brain.args, ['exec']);
  });

  test('it is surveyed alongside the others', async () => {
    const rows = await surveyBrains({});
    const codex = rows.find((r) => r.name === 'codex');
    assert.ok(codex, 'codex should appear in the survey');
    assert.equal(codex.cmd, 'codex');
  });
});

describe('recognising a codex session', () => {
  test('a session id names the session', () => {
    const id = identify({ env: { CODEX_SESSION_ID: 'sess-1' }, probeProcess: false });
    assert.equal(id.tool, 'codex');
    assert.equal(id.agentId, 'codex:sess-1');
  });

  test('a thread id names the session too', () => {
    const id = identify({ env: { CODEX_THREAD_ID: 'thread-1' }, probeProcess: false });
    assert.equal(id.tool, 'codex');
    assert.equal(id.agentId, 'codex:thread-1');
  });

  test('a codex process is found by what it is called', () => {
    // Codex exports CODEX_THREAD_ID to the tools it runs, not to itself, so
    // the process walk is what identifies the session a tool is running under.
    const describeProcess = (pid) =>
      pid === 20 ? { pid: 20, name: 'codex', command: 'codex exec', parent: 1 } : null;

    const found = findAgentProcess(20, { steps: 1, describe: describeProcess });
    assert.equal(found.tool, 'codex');
    assert.equal(found.pid, 20);
  });
});
