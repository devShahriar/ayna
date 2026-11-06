import { mkdir, readdir, readFile, writeFile, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';

/**
 * Manages skill definitions, packaging, versioning, and automatic provisioning
 * into isolated Prison sandboxes.
 */
export class SkillsManager {
  /**
   * @param {string} [skillsRepoDir] - Central directory where packaged skills reside
   */
  constructor(skillsRepoDir) {
    this.skillsRepoDir = skillsRepoDir || path.join(process.cwd(), '.ayna', 'prison', 'skills-repo');
    this.inMemorySkills = new Map();
  }

  /**
   * Registers an in-memory skill or persists a skill package.
   *
   * @param {Object} skill
   * @param {string} skill.name - Unique name of the skill
   * @param {string} [skill.version='1.0.0'] - Semantic version
   * @param {string} skill.description - Purpose of the skill
   * @param {string} [skill.content] - Executable script or instructions (e.g. SKILL.md content)
   * @param {Object} [skill.metadata] - Extra metadata (author, tags, compatibility)
   */
  async registerSkill({ name, version = '1.0.0', description = '', content = '', metadata = {} }) {
    if (!name || typeof name !== 'string') {
      throw new Error('Skill name must be a non-empty string');
    }
    const skillObj = {
      name,
      version,
      description,
      content,
      metadata: {
        registeredAt: Date.now(),
        ...metadata,
      },
    };

    this.inMemorySkills.set(`${name}@${version}`, skillObj);
    this.inMemorySkills.set(name, skillObj); // alias latest

    // Persist to skills repository directory if available
    try {
      const targetDir = path.join(this.skillsRepoDir, name, version);
      await mkdir(targetDir, { recursive: true });
      await writeFile(path.join(targetDir, 'manifest.json'), JSON.stringify(skillObj, null, 2));
      if (content) {
        await writeFile(path.join(targetDir, 'SKILL.md'), content);
      }
    } catch {
      // non-fatal if file persistence fails in ephemeral tests
    }

    return skillObj;
  }

  /**
   * Retrieves a skill by name and optional version.
   *
   * @param {string} name
   * @param {string} [version]
   * @returns {Object|null}
   */
  getSkill(name, version = null) {
    if (version) {
      return this.inMemorySkills.get(`${name}@${version}`) || null;
    }
    return this.inMemorySkills.get(name) || null;
  }

  /**
   * Lists all available skills.
   */
  listSkills() {
    const unique = new Map();
    for (const [key, skill] of this.inMemorySkills.entries()) {
      if (!key.includes('@')) {
        unique.set(skill.name, skill);
      }
    }
    return Array.from(unique.values());
  }

  /**
   * Automatically provisions a set of requested skills into a target sandbox instance.
   *
   * @param {import('./runtime.mjs').PrisonSandbox} sandbox - Sandbox instance to provision
   * @param {string[]} skillNames - Names of skills to provision (e.g. ['git-tools', 'browser-inspector@1.2.0'])
   * @returns {Promise<Array<{ name: string, version: string, path: string }>>}
   */
  async provisionIntoSandbox(sandbox, skillNames = []) {
    if (!sandbox || !sandbox.skillsDir) {
      throw new Error('Valid sandbox instance with skillsDir is required');
    }

    const provisioned = [];
    await mkdir(sandbox.skillsDir, { recursive: true });

    for (const spec of skillNames) {
      const [name, version] = spec.split('@');
      let skill = this.getSkill(name, version);

      // If not in-memory, attempt loading from disk
      if (!skill) {
        skill = await this._loadFromDisk(name, version);
      }

      if (!skill) {
        throw new Error(`Cannot provision missing skill: "${spec}"`);
      }

      const destSkillDir = path.join(sandbox.skillsDir, skill.name);
      await mkdir(destSkillDir, { recursive: true });

      // Write skill manifest and script
      await writeFile(path.join(destSkillDir, 'manifest.json'), JSON.stringify(skill, null, 2));
      if (skill.content) {
        await writeFile(path.join(destSkillDir, 'SKILL.md'), skill.content);
      }

      provisioned.push({
        name: skill.name,
        version: skill.version,
        path: destSkillDir,
      });
    }

    // Write index of provisioned skills in sandbox
    await writeFile(
      path.join(sandbox.skillsDir, 'provisioned.json'),
      JSON.stringify(
        {
          sandboxId: sandbox.id,
          provisionedAt: Date.now(),
          skills: provisioned,
        },
        null,
        2,
      ),
    );

    return provisioned;
  }

  /**
   * Helper to load a skill from repository disk storage.
   */
  async _loadFromDisk(name, version = null) {
    const base = path.join(this.skillsRepoDir, name);
    if (!existsSync(base)) return null;

    let targetVer = version;
    if (!targetVer) {
      const versions = await readdir(base).catch(() => []);
      if (!versions.length) return null;
      targetVer = versions.sort().reverse()[0]; // pick latest
    }

    const manifestFile = path.join(base, targetVer, 'manifest.json');
    if (!existsSync(manifestFile)) return null;

    try {
      const raw = await readFile(manifestFile, 'utf8');
      const parsed = JSON.parse(raw);
      this.inMemorySkills.set(`${parsed.name}@${parsed.version}`, parsed);
      this.inMemorySkills.set(parsed.name, parsed);
      return parsed;
    } catch {
      return null;
    }
  }
}
