import { spawn } from 'node:child_process';
import { mkdir, rm, readdir, stat, readFile, writeFile } from 'node:fs/promises';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';

/**
 * State machine states for a Prison sandbox instance.
 */
export const SandboxState = Object.freeze({
  PENDING: 'PENDING',
  RUNNING: 'RUNNING',
  STOPPED: 'STOPPED',
  DESTROYED: 'DESTROYED',
});

/**
 * Represents an isolated sandbox execution environment for an AI agent.
 */
export class PrisonSandbox {
  /**
   * @param {Object} options
   * @param {string} options.id - Unique identifier for the sandbox
   * @param {string} options.baseDir - Base storage path for all sandboxes
   * @param {Object} [options.limits] - Configurable resource quotas
   * @param {number} [options.limits.timeoutMs=30000] - Default command execution timeout
   * @param {number} [options.limits.maxMemoryMb=512] - Memory quota in MB
   * @param {Object} [options.env={}] - Initial environment variables
   */
  constructor({ id, baseDir, limits = {}, env = {} }) {
    if (!id || typeof id !== 'string') {
      throw new Error('Sandbox ID must be a non-empty string');
    }
    this.id = id;
    this.baseDir = baseDir;
    this.sandboxDir = path.join(baseDir, id);
    this.workspaceDir = path.join(this.sandboxDir, 'workspace');
    this.skillsDir = path.join(this.sandboxDir, 'skills');
    this.limits = {
      timeoutMs: limits.timeoutMs ?? 30_000,
      maxMemoryMb: limits.maxMemoryMb ?? 512,
      ...limits,
    };
    this.env = { ...process.env, ...env, PRISON_SANDBOX_ID: id };
    this.state = SandboxState.PENDING;
    this.createdAt = Date.now();
    this.startedAt = null;
    this.stoppedAt = null;
    this.activeProcesses = new Set();
  }

  /**
   * Initializes and starts the isolated sandbox workspace.
   */
  async start() {
    if (this.state === SandboxState.DESTROYED) {
      throw new Error(`Cannot start destroyed sandbox "${this.id}"`);
    }
    if (this.state === SandboxState.RUNNING) {
      return this;
    }

    await mkdir(this.workspaceDir, { recursive: true });
    await mkdir(this.skillsDir, { recursive: true });

    // Write sandbox metadata file
    const meta = {
      id: this.id,
      state: SandboxState.RUNNING,
      createdAt: this.createdAt,
      startedAt: Date.now(),
      limits: this.limits,
    };
    await writeFile(path.join(this.sandboxDir, 'sandbox.json'), JSON.stringify(meta, null, 2));

    this.state = SandboxState.RUNNING;
    this.startedAt = meta.startedAt;
    return this;
  }

  /**
   * Executes a command within the sandbox workspace.
   *
   * @param {string} command - Shell command to execute
   * @param {Object} [options]
   * @param {string} [options.cwd] - Relative subdirectory inside the workspace
   * @param {Object} [options.env] - Additional environment variables
   * @param {number} [options.timeoutMs] - Override timeout in milliseconds
   * @returns {Promise<{ exitCode: number, stdout: string, stderr: string, durationMs: number }>}
   */
  async exec(command, { cwd = '', env = {}, timeoutMs = this.limits.timeoutMs } = {}) {
    if (this.state !== SandboxState.RUNNING) {
      throw new Error(`Cannot exec in sandbox "${this.id}" with state "${this.state}"`);
    }

    const workingDir = path.resolve(this.workspaceDir, cwd);
    // Path traversal check: must stay within workspaceDir
    if (!workingDir.startsWith(this.workspaceDir)) {
      throw new Error(`Permission denied: Execution path outside sandbox workspace`);
    }

    const start = Date.now();
    return new Promise((resolve, reject) => {
      const child = spawn('sh', ['-c', command], {
        cwd: workingDir,
        env: {
          ...this.env,
          ...env,
          PWD: workingDir,
          WORKSPACE: this.workspaceDir,
          PRISON_SKILLS_DIR: this.skillsDir,
        },
        detached: true,
      });

      this.activeProcesses.add(child);

      let stdout = '';
      let stderr = '';

      child.stdout?.on('data', (chunk) => {
        stdout += chunk.toString();
      });

      child.stderr?.on('data', (chunk) => {
        stderr += chunk.toString();
      });

      let timer = null;
      if (timeoutMs > 0) {
        timer = setTimeout(() => {
          if (child.pid) {
            try {
              process.kill(-child.pid, 'SIGKILL');
            } catch {
              // ignore ESRCH
            }
          }
          this.activeProcesses.delete(child);
          reject(new Error(`Command timed out after ${timeoutMs}ms: "${command}"`));
        }, timeoutMs);
      }

      child.on('error', (err) => {
        if (timer) clearTimeout(timer);
        this.activeProcesses.delete(child);
        reject(err);
      });

      child.on('close', (exitCode) => {
        if (timer) clearTimeout(timer);
        this.activeProcesses.delete(child);
        resolve({
          exitCode: exitCode ?? 0,
          stdout,
          stderr,
          durationMs: Date.now() - start,
        });
      });
    });
  }

  /**
   * Resolves a safe path within the sandbox workspace.
   * Throws if path attempts to escape the sandbox.
   *
   * @param {string} relativePath
   * @returns {string} Absolute resolved path
   */
  resolvePath(relativePath = '') {
    const target = path.resolve(this.workspaceDir, relativePath);
    if (!target.startsWith(this.workspaceDir)) {
      throw new Error(`Security Violation: Path traversal outside sandbox boundary: "${relativePath}"`);
    }
    return target;
  }

  /**
   * Reads a file from the sandbox workspace.
   */
  async readFile(relativePath, encoding = 'utf8') {
    const fullPath = this.resolvePath(relativePath);
    return await readFile(fullPath, encoding);
  }

  /**
   * Writes a file to the sandbox workspace.
   */
  async writeFile(relativePath, content) {
    const fullPath = this.resolvePath(relativePath);
    await mkdir(path.dirname(fullPath), { recursive: true });
    await writeFile(fullPath, content);
  }

  /**
   * Lists files within a directory in the sandbox workspace.
   */
  async listFiles(relativePath = '') {
    const fullPath = this.resolvePath(relativePath);
    if (!existsSync(fullPath)) return [];
    const entries = await readdir(fullPath, { withFileTypes: true });
    return entries.map((e) => ({
      name: e.name,
      isDirectory: e.isDirectory(),
      isFile: e.isFile(),
    }));
  }

  /**
   * Stops the sandbox and terminates any active processes.
   */
  async stop() {
    if (this.state === SandboxState.DESTROYED || this.state === SandboxState.STOPPED) {
      return;
    }

    for (const child of this.activeProcesses) {
      if (child.pid) {
        try {
          process.kill(-child.pid, 'SIGTERM');
        } catch {
          // Process might have already exited
        }
      }
    }
    this.activeProcesses.clear();

    this.state = SandboxState.STOPPED;
    this.stoppedAt = Date.now();

    const metaFile = path.join(this.sandboxDir, 'sandbox.json');
    if (existsSync(metaFile)) {
      try {
        const meta = JSON.parse(await readFile(metaFile, 'utf8'));
        meta.state = SandboxState.STOPPED;
        meta.stoppedAt = this.stoppedAt;
        await writeFile(metaFile, JSON.stringify(meta, null, 2));
      } catch {
        // non-fatal
      }
    }
  }

  /**
   * Restarts the sandbox.
   */
  async restart() {
    await this.stop();
    await this.start();
    return this;
  }

  /**
   * Completely destroys the sandbox and purges isolated workspace files.
   */
  async destroy() {
    await this.stop();
    this.state = SandboxState.DESTROYED;
    if (existsSync(this.sandboxDir)) {
      await rm(this.sandboxDir, { recursive: true, force: true });
    }
  }

  /**
   * Status and telemetry snapshot of the sandbox.
   */
  status() {
    return {
      id: this.id,
      state: this.state,
      createdAt: this.createdAt,
      startedAt: this.startedAt,
      stoppedAt: this.stoppedAt,
      uptimeMs: this.startedAt && this.state === SandboxState.RUNNING ? Date.now() - this.startedAt : 0,
      limits: this.limits,
      activeProcesses: this.activeProcesses.size,
      workspace: this.workspaceDir,
    };
  }
}

/**
 * Factory and registry managing sandbox runtimes.
 */
export class PrisonRuntimeManager {
  /**
   * @param {string} [storageDir] - Default storage directory for sandboxes
   */
  constructor(storageDir) {
    this.storageDir = storageDir || path.join(process.cwd(), '.ayna', 'prison', 'sandboxes');
    this.sandboxes = new Map();
  }

  /**
   * Creates a new isolated sandbox.
   */
  async createSandbox(id, options = {}) {
    if (this.sandboxes.has(id)) {
      throw new Error(`Sandbox with ID "${id}" already exists`);
    }
    const sandbox = new PrisonSandbox({
      id,
      baseDir: this.storageDir,
      ...options,
    });
    await sandbox.start();
    this.sandboxes.set(id, sandbox);
    return sandbox;
  }

  /**
   * Gets an existing sandbox by ID, restoring from disk if previously persisted.
   */
  getSandbox(id) {
    if (this.sandboxes.has(id)) {
      return this.sandboxes.get(id);
    }
    const metaFile = path.join(this.storageDir, id, 'sandbox.json');
    if (existsSync(metaFile)) {
      try {
        const raw = readFileSync(metaFile, 'utf8');
        const meta = JSON.parse(raw);
        const sandbox = new PrisonSandbox({
          id,
          baseDir: this.storageDir,
          limits: meta.limits,
        });
        sandbox.state = meta.state || SandboxState.RUNNING;
        sandbox.createdAt = meta.createdAt || Date.now();
        sandbox.startedAt = meta.startedAt || null;
        sandbox.stoppedAt = meta.stoppedAt || null;
        this.sandboxes.set(id, sandbox);
        return sandbox;
      } catch {
        return null;
      }
    }
    return null;
  }

  /**
   * Lists all tracked sandboxes from memory and persistent disk.
   */
  listSandboxes() {
    if (existsSync(this.storageDir)) {
      try {
        const dirs = readdirSync(this.storageDir, { withFileTypes: true });
        for (const d of dirs) {
          if (d.isDirectory()) {
            this.getSandbox(d.name);
          }
        }
      } catch {
        // non-fatal
      }
    }
    return Array.from(this.sandboxes.values()).map((s) => s.status());
  }

  /**
   * Destroys a sandbox by ID.
   */
  async destroySandbox(id) {
    let sandbox = this.sandboxes.get(id);
    if (!sandbox) {
      sandbox = this.getSandbox(id);
    }
    if (!sandbox) {
      const dir = path.join(this.storageDir, id);
      if (existsSync(dir)) {
        await rm(dir, { recursive: true, force: true });
        return true;
      }
      return false;
    }
    await sandbox.destroy();
    this.sandboxes.delete(id);
    return true;
  }

  /**
   * Stops and destroys all active sandboxes.
   */
  async destroyAll() {
    for (const [id, sandbox] of this.sandboxes.entries()) {
      await sandbox.destroy().catch(() => {});
    }
    this.sandboxes.clear();
  }
}
