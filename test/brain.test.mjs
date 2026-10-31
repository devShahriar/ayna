/*
  The argv a headless turn actually gets.

  Claude Code and puku-cli share a CLI shape, but not every value crosses over:
  `opus` is a Claude model name, and `--prompt-stdin-length` was an invention of
  an older integration that neither binary accepts.  A wrong flag is a failed
  turn, not a warning.
*/
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { agentCommand, agentArgs } from '../src/brain.mjs';
import { loopBrain } from '../src/loop.mjs';

describe('driving a headless agent', () => {
  test('puku-cli gets only the flags its help documents', () => {
    const args = agentArgs('puku', {
      model: 'opus',
      tools: ['Read', 'Grep'],
      schema: { type: 'object' },
    });

    assert.ok(args.includes('-p'));
    assert.equal(args[args.indexOf('--output-format') + 1], 'json');
    assert.ok(args.includes('--permission-mode'));
    assert.ok(args.includes('--allowedTools'));
    assert.ok(args.includes('--json-schema'));
    assert.ok(!args.includes('--prompt-stdin-length'), 'puku-cli has no such flag');
  });

  test('a model alias both CLIs accept is passed to puku-cli', () => {
    const args = agentArgs('puku', { model: 'opus', tools: ['Read'] });
    assert.equal(args[args.indexOf('--model') + 1], 'opus');
  });

  test('a puku model alias is passed through', () => {
    const args = agentArgs('puku', { model: 'puku-ai-2.7', tools: ['Read'] });
    assert.equal(args[args.indexOf('--model') + 1], 'puku-ai-2.7');
  });

  test('claude keeps its model argument', () => {
    const args = agentArgs('claude', { model: 'opus', tools: ['Read'] });
    assert.equal(args[args.indexOf('--model') + 1], 'opus');
  });

  test('the binary is the headless one, never the editor wrapper', () => {
    assert.equal(agentCommand('puku'), 'puku-cli');
    assert.equal(agentCommand('claude'), 'claude');
  });

  test('a brain the structured runner cannot shape is named, not guessed at', () => {
    assert.throws(() => agentCommand('cursor'), /structured turns support: claude, puku/);
  });
});

describe('the standalone loop uses the chosen brain', () => {
  test('it defaults to claude, and follows config and the flag', () => {
    assert.equal(loopBrain({}, undefined).name, 'claude');
    assert.equal(loopBrain({ brain: 'puku' }, undefined).name, 'puku');
    assert.equal(loopBrain({}, 'puku').cmd, 'puku-cli');
  });

  test('an editor is refused with its explanation', () => {
    assert.throws(() => loopBrain({}, 'antigravity'), /is an editor, not a headless brain/);
  });
});
