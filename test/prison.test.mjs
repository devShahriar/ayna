import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { tempDir } from './helpers.mjs';
import {
  PrisonSandbox,
  PrisonRuntimeManager,
  SandboxState,
  PrisonGateway,
  SkillsManager,
  PrisonDesktop,
  PrisonDesktopSDK,
  PrisonControlPlane,
} from '../src/prison/index.mjs';

describe('Prison: Isolated Sandbox Runtime', () => {
  test('sandbox lifecycle transitions correctly through states', async () => {
    const { dir, dispose } = await tempDir();
    try {
      const sandbox = new PrisonSandbox({ id: 'test-agent-1', baseDir: dir });
      assert.equal(sandbox.state, SandboxState.PENDING);

      await sandbox.start();
      assert.equal(sandbox.state, SandboxState.RUNNING);
      assert.ok(sandbox.startedAt > 0);

      const status = sandbox.status();
      assert.equal(status.id, 'test-agent-1');
      assert.equal(status.state, SandboxState.RUNNING);

      await sandbox.stop();
      assert.equal(sandbox.state, SandboxState.STOPPED);
      assert.ok(sandbox.stoppedAt > 0);

      await sandbox.destroy();
      assert.equal(sandbox.state, SandboxState.DESTROYED);
    } finally {
      await dispose();
    }
  });

  test('executes shell commands isolated within the workspace directory', async () => {
    const { dir, dispose } = await tempDir();
    try {
      const sandbox = new PrisonSandbox({ id: 'exec-box', baseDir: dir });
      await sandbox.start();

      const res = await sandbox.exec('echo "Agent Execution Test" && pwd');
      assert.equal(res.exitCode, 0);
      assert.match(res.stdout, /Agent Execution Test/);
      assert.ok(res.stdout.includes(sandbox.workspaceDir));

      await sandbox.destroy();
    } finally {
      await dispose();
    }
  });

  test('prevents path traversal violations outside workspace', async () => {
    const { dir, dispose } = await tempDir();
    try {
      const sandbox = new PrisonSandbox({ id: 'sec-box', baseDir: dir });
      await sandbox.start();

      await assert.rejects(
        () => sandbox.readFile('../../../etc/passwd'),
        /Path traversal outside sandbox boundary/,
      );

      await assert.rejects(
        () => sandbox.writeFile('../../evil.sh', 'rm -rf /'),
        /Path traversal outside sandbox boundary/,
      );

      await sandbox.destroy();
    } finally {
      await dispose();
    }
  });

  test('enforces execution timeout quota', async () => {
    const { dir, dispose } = await tempDir();
    try {
      const sandbox = new PrisonSandbox({
        id: 'timeout-box',
        baseDir: dir,
        limits: { timeoutMs: 300 },
      });
      await sandbox.start();

      await assert.rejects(
        () => sandbox.exec('sleep 2'),
        /Command timed out after 300ms/,
      );

      await sandbox.destroy();
    } finally {
      await dispose();
    }
  });
});

describe('Prison: Centralized Gateway', () => {
  test('blocks unauthorized requests when secret token is required', async () => {
    const gateway = new PrisonGateway({ secretToken: 'secure-token-123' });
    const res = await gateway.forward({
      sandboxId: 'box-1',
      url: 'https://api.github.com',
      authToken: 'wrong-token',
    });
    assert.equal(res.statusCode, 401);
    assert.match(res.body, /Unauthorized/);
  });

  test('enforces host allowlists and denylists', async () => {
    const gateway = new PrisonGateway({
      allowedHosts: ['api.example.com', '*.approved.org'],
      deniedHosts: ['localhost', '127.0.0.1'],
    });

    assert.equal(gateway.isHostPermitted('api.example.com'), true);
    assert.equal(gateway.isHostPermitted('sub.approved.org'), true);
    assert.equal(gateway.isHostPermitted('forbidden.com'), false);
    assert.equal(gateway.isHostPermitted('localhost'), false);

    const res = await gateway.forward({
      sandboxId: 'box-1',
      url: 'http://forbidden.com/v1',
    });
    assert.equal(res.statusCode, 403);
    assert.match(res.body, /Forbidden.*forbidden\.com/);
  });

  test('records audit logs with telemetry', async () => {
    const gateway = new PrisonGateway();
    await gateway.forward({
      sandboxId: 'telemetry-box',
      url: 'http://127.0.0.1/test',
    });

    const logs = gateway.getAuditLogs({ sandboxId: 'telemetry-box' });
    assert.ok(logs.length > 0);
    assert.equal(logs[0].sandboxId, 'telemetry-box');
    assert.equal(logs[0].statusCode, 403);
    assert.ok(logs[0].timestamp);
  });
});

describe('Prison: Automatic Skills Provisioning', () => {
  test('registers and provisions skills into sandbox environment', async () => {
    const { dir, dispose } = await tempDir();
    try {
      const skillsManager = new SkillsManager(path.join(dir, 'skills-repo'));
      await skillsManager.registerSkill({
        name: 'test-runner',
        version: '1.2.0',
        description: 'Automated test runner skill',
        content: '# Test Runner Skill\nExecute node --test',
      });

      const sandbox = new PrisonSandbox({ id: 'skill-sandbox', baseDir: dir });
      await sandbox.start();

      const provisioned = await skillsManager.provisionIntoSandbox(sandbox, ['test-runner@1.2.0']);
      assert.equal(provisioned.length, 1);
      assert.equal(provisioned[0].name, 'test-runner');
      assert.equal(provisioned[0].version, '1.2.0');

      const { existsSync } = await import('node:fs');
      assert.equal(existsSync(path.join(sandbox.skillsDir, 'test-runner', 'manifest.json')), true);

      await sandbox.destroy();
    } finally {
      await dispose();
    }
  });
});

describe('Prison: Desktop Interface & Embedding SDK', () => {
  test('serves desktop interface and handles file & exec APIs', async () => {
    const { dir, dispose } = await tempDir();
    try {
      const sandbox = new PrisonSandbox({ id: 'desktop-box', baseDir: dir });
      await sandbox.start();
      await sandbox.writeFile('notes.txt', 'Prison desktop initialized');

      const desktop = new PrisonDesktop({ sandbox, port: 0 });
      const { url } = await desktop.start();
      assert.ok(url.startsWith('http://127.0.0.1:'));

      // Check root desktop page
      const pageRes = await fetch(`${url}/`);
      assert.equal(pageRes.status, 200);
      const html = await pageRes.text();
      assert.match(html, /Prison Sandbox Desktop/);
      assert.match(html, /desktop-box/);

      // Check files API
      const filesRes = await fetch(`${url}/api/files`);
      assert.equal(filesRes.status, 200);
      const filesJson = await filesRes.json();
      assert.ok(filesJson.files.some((f) => f.name === 'notes.txt'));

      // Check read file API
      const fileRes = await fetch(`${url}/api/file?path=notes.txt`);
      assert.equal(fileRes.status, 200);
      const fileContent = await fileRes.text();
      assert.equal(fileContent, 'Prison desktop initialized');

      // Check exec API
      const execRes = await fetch(`${url}/api/exec`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ command: 'echo "Desktop Exec OK"' }),
      });
      assert.equal(execRes.status, 200);
      const execJson = await execRes.json();
      assert.match(execJson.stdout, /Desktop Exec OK/);

      await desktop.stop();
      await sandbox.destroy();
    } finally {
      await dispose();
    }
  });

  test('generates valid iframe embedding snippets via SDK', () => {
    const snippet = PrisonDesktopSDK.createEmbedSnippet({
      sandboxId: 'embed-box',
      serverUrl: 'https://prison.ayna.internal',
      token: 'jwt-token-xyz',
      width: '100%',
      height: '800px',
    });
    assert.match(snippet, /<iframe src="https:\/\/prison\.ayna\.internal\/embed\?token=jwt-token-xyz"/);
    assert.match(snippet, /height="800px"/);
  });
});

describe('Prison: Control Plane Orchestration', () => {
  test('orchestrates full sandbox lifecycle with skills and gateway', async () => {
    const { dir, dispose } = await tempDir();
    try {
      const cp = new PrisonControlPlane({
        storageDir: path.join(dir, 'sandboxes'),
        skillsRepoDir: path.join(dir, 'skills'),
      });

      await cp.skillsManager.registerSkill({
        name: 'ayna-probe',
        version: '1.0.0',
        description: 'Probing skill',
        content: 'echo probe',
      });

      const sandbox = await cp.provisionSandbox('agent-alpha', {
        skills: ['ayna-probe'],
      });
      assert.equal(sandbox.id, 'agent-alpha');
      assert.equal(sandbox.state, SandboxState.RUNNING);

      const execOut = await cp.exec('agent-alpha', 'echo "Control Plane Test"');
      assert.match(execOut.stdout, /Control Plane Test/);

      const desktop = await cp.startDesktop('agent-alpha', { port: 0 });
      assert.ok(desktop.url);

      const status = cp.status();
      assert.equal(status.sandboxes.length, 1);
      assert.equal(status.desktops.length, 1);

      await cp.shutdown();
      assert.equal(cp.status().sandboxes.length, 0);
    } finally {
      await dispose();
    }
  });
});
