/*
  What puku-cli actually gives a child process.

  puku-cli does not export PUKU_CLI_SESSION_ID to tools in a normal install; it
  exports PUKU_CLI=1.  The npm-installed binary is a node script, so `ps` calls
  the process `node` even though its command line names puku-cli.  Identity has
  to survive both facts, or every command opens its own window.
*/
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import { identify, findAgentProcess } from '../src/agent.mjs';

const ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url)));

describe('finding puku-cli by what the process is, not only what it is called', () => {
  test('an npm-installed puku-cli is found through its command line', () => {
    const describeProcess = (pid) =>
      pid === 10
        ? {
            pid: 10,
            name: 'node',
            command: 'node /repo/node_modules/@puku/puku-cli/dist/cli.mjs --print',
            parent: 1,
          }
        : null;

    const found = findAgentProcess(10, { steps: 1, describe: describeProcess });
    assert.equal(found.tool, 'puku');
    assert.equal(found.pid, 10);
  });

  test('a node process that is not an agent is not mistaken for one', () => {
    const describeProcess = (pid) =>
      pid === 11 ? { pid: 11, name: 'node', command: 'node /repo/bin/ayna.mjs shot', parent: 1 } : null;

    assert.equal(findAgentProcess(11, { steps: 1, describe: describeProcess }), null);
  });

  test('a shell that merely mentions puku-cli is not the agent', () => {
    const describeProcess = (pid) =>
      pid === 12
        ? { pid: 12, name: 'bash', command: 'bash -c "puku-cli --version"', parent: 1 }
        : null;

    assert.equal(findAgentProcess(12, { steps: 1, describe: describeProcess }), null);
  });

  test('PUKU_CLI=1 identifies a puku session even without a session id', () => {
    const id = identify({ env: { PUKU_CLI: '1' }, probeProcess: false, pid: 4242 });
    assert.equal(id.tool, 'puku');
    assert.equal(id.how, 'env:PUKU_CLI');
    assert.match(id.agentId, /^puku:pid-\d+$/);
  });

  test('a session id wins over the marker when puku supplies one', () => {
    const id = identify({
      env: { PUKU_CLI: '1', PUKU_CLI_SESSION_ID: 'uuid-9' },
      probeProcess: false,
    });
    assert.equal(id.tool, 'puku');
    assert.equal(id.agentId, 'puku:uuid-9');
    assert.equal(id.how, 'env:PUKU_CLI_SESSION_ID');
  });
});

describe('what the published package ships', () => {
  test('the puku plugin travels with the package', async () => {
    const pkg = JSON.parse(await readFile(path.join(ROOT, 'package.json'), 'utf8'));
    assert.ok(pkg.files.includes('.puku-plugin'), 'otherwise npm users have no plugin manifest');
  });

  test('the plugin manifest is the same ayna', async () => {
    const pkg = JSON.parse(await readFile(path.join(ROOT, 'package.json'), 'utf8'));
    const plugin = JSON.parse(await readFile(path.join(ROOT, '.puku-plugin', 'plugin.json'), 'utf8'));
    assert.equal(plugin.name, pkg.name);
    assert.equal(plugin.version, pkg.version);
  });
});
