import { test } from 'node:test';
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { validateFlow } from '../src/flowspec.mjs';

// THE VALIDATOR MUST NOT BE STRICTER THAN THE RUNTIME.
//
// MEASURED 14 Sep 2026: `expect` accepted text/selector/absent/missing in
// src/flowspec.mjs, while src/flow.mjs has always ALSO run `absentSelector`.
// Every committed flow that waits for an agent to finish uses that spelling:
//
//   { "do": "expect", "absentSelector": "[data-state='thinking']" }
//
// so `ayna flow --flow ayna-flows/16-…json` refused to run a flow the same
// binary executes happily under `ayna qa --dir`. A validator that rejects what
// the runtime supports turns working tests into unrunnable ones — the failure
// direction that costs the most, because it looks like the test is wrong.
test('every expect spelling the runtime implements also validates', () => {
  const runtime = readFileSync(new URL('../src/flow.mjs', import.meta.url), 'utf8');
  const spellings = ['text', 'selector', 'absent', 'missing', 'absentSelector'];

  for (const key of spellings) {
    // The runtime really does read this key — if it stops, drop it from the list
    // deliberately rather than letting this test quietly guard nothing.
    assert.ok(
      runtime.includes(`step.${key}`),
      `src/flow.mjs no longer reads step.${key} — remove it here on purpose, not by accident`,
    );
    const { errors } = validateFlow({
      name: 'drift',
      steps: [{ do: 'goto', url: 'http://x' }, { do: 'expect', [key]: 'thing' }],
    });
    assert.deepEqual(
      errors, [],
      `the validator rejects \`${key}\`, which the runtime implements: ${errors.join('; ')}`,
    );
  }
});

// An expect with NO target is still an error — the fix must not have opened the
// gate so wide that a meaningless assertion passes.
test('an expect with nothing to assert is still refused', () => {
  const { errors } = validateFlow({
    name: 'empty',
    steps: [{ do: 'goto', url: 'http://x' }, { do: 'expect', timeout: 1000 }],
  });
  assert.ok(errors.length, 'an expect asserting nothing was accepted');
  assert.match(errors.join(' '), /absentSelector/, 'the message should name every spelling that works');
});
