import { PrisonRuntimeManager, SandboxState } from './runtime.mjs';
import { PrisonGateway } from './gateway.mjs';
import { SkillsManager } from './skills.mjs';
import { PrisonDesktop } from './desktop.mjs';

/**
 * Prison Control Plane: Unified orchestrator coordinating Sandbox Runtimes,
 * Centralized Gateways, Skills Provisioning, and Desktop UI sessions.
 */
export class PrisonControlPlane {
  /**
   * @param {Object} [options]
   * @param {string} [options.storageDir] - Root storage directory for sandboxes
   * @param {string} [options.skillsRepoDir] - Directory for skills registry
   * @param {Object} [options.gatewayOptions] - Configuration options for the Gateway
   */
  constructor(options = {}) {
    this.runtimeManager = new PrisonRuntimeManager(options.storageDir);
    this.skillsManager = new SkillsManager(options.skillsRepoDir);
    this.gateway = new PrisonGateway(options.gatewayOptions);
    this.activeDesktops = new Map();
  }

  /**
   * Provisions a new agent sandbox with optional skills and resources.
   *
   * @param {string} id - Unique sandbox ID
   * @param {Object} [options]
   * @param {string[]} [options.skills=[]] - Skill names to provision
   * @param {Object} [options.limits] - Resource quotas
   * @param {Object} [options.env] - Environment variables
   * @returns {Promise<import('./runtime.mjs').PrisonSandbox>}
   */
  async provisionSandbox(id, { skills = [], limits = {}, env = {} } = {}) {
    const sandbox = await this.runtimeManager.createSandbox(id, { limits, env });

    if (skills && skills.length > 0) {
      await this.skillsManager.provisionIntoSandbox(sandbox, skills);
    }

    return sandbox;
  }

  /**
   * Starts a desktop UI server for an existing sandbox.
   *
   * @param {string} id
   * @param {Object} [desktopOptions]
   * @returns {Promise<{ url: string, port: number }>}
   */
  async startDesktop(id, desktopOptions = {}) {
    const sandbox = this.runtimeManager.getSandbox(id);
    if (!sandbox) {
      throw new Error(`Sandbox "${id}" not found`);
    }

    if (this.activeDesktops.has(id)) {
      const existing = this.activeDesktops.get(id);
      return { url: `http://127.0.0.1:${existing.actualPort}`, port: existing.actualPort };
    }

    const desktop = new PrisonDesktop({ sandbox, ...desktopOptions });
    const started = await desktop.start();
    this.activeDesktops.set(id, desktop);
    return started;
  }

  /**
   * Stops a desktop UI server for a sandbox.
   *
   * @param {string} id
   */
  async stopDesktop(id) {
    const desktop = this.activeDesktops.get(id);
    if (!desktop) return;
    await desktop.stop();
    this.activeDesktops.delete(id);
  }

  /**
   * Executes a command within a sandbox.
   */
  async exec(id, command, options = {}) {
    const sandbox = this.runtimeManager.getSandbox(id);
    if (!sandbox) {
      throw new Error(`Sandbox "${id}" not found`);
    }
    return await sandbox.exec(command, options);
  }

  /**
   * Forwards a request through the centralized Gateway on behalf of a sandbox.
   */
  async forwardGatewayRequest(reqOptions) {
    return await this.gateway.forward(reqOptions);
  }

  /**
   * Stops and destroys a sandbox, releasing all associated resources.
   */
  async destroySandbox(id) {
    await this.stopDesktop(id);
    return await this.runtimeManager.destroySandbox(id);
  }

  /**
   * Returns complete telemetry and status for all sandboxes and components.
   */
  status() {
    return {
      sandboxes: this.runtimeManager.listSandboxes(),
      skills: this.skillsManager.listSkills().map((s) => ({ name: s.name, version: s.version })),
      auditLogs: this.gateway.getAuditLogs({ limit: 10 }),
      desktops: Array.from(this.activeDesktops.keys()),
    };
  }

  /**
   * Shuts down all active sandboxes, desktops, and resources.
   */
  async shutdown() {
    for (const [id, desktop] of this.activeDesktops.entries()) {
      await desktop.stop().catch(() => {});
    }
    this.activeDesktops.clear();
    await this.runtimeManager.destroyAll();
  }
}
