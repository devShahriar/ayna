import { cp, rm, mkdir, readdir } from 'node:fs/promises';
import path from 'node:path';

/**
 * Copy the target UI aside before an iteration edits it. Cheap insurance that does
 * not assume the project is a git repo.
 */
export async function snapshot(targetDir, destDir) {
  await mkdir(path.dirname(destDir), { recursive: true });
  await rm(destDir, { recursive: true, force: true });
  await cp(targetDir, destDir, { recursive: true });
  return destDir;
}

/** Put the snapshot back, discarding whatever the iteration did. */
export async function restore(snapshotDir, targetDir) {
  await rm(targetDir, { recursive: true, force: true });
  await cp(snapshotDir, targetDir, { recursive: true });
}

/** Files that changed between the snapshot and the live target, for the report. */
export async function changedFiles(snapshotDir, targetDir) {
  const { readFile } = await import('node:fs/promises');
  const walk = async (dir, base = '') => {
    const out = [];
    for (const entry of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
      const rel = path.join(base, entry.name);
      if (entry.isDirectory()) out.push(...(await walk(path.join(dir, entry.name), rel)));
      else out.push(rel);
    }
    return out;
  };

  const [before, after] = await Promise.all([walk(snapshotDir), walk(targetDir)]);
  const all = new Set([...before, ...after]);
  const changes = [];

  for (const rel of all) {
    const b = await readFile(path.join(snapshotDir, rel), 'utf8').catch(() => null);
    const a = await readFile(path.join(targetDir, rel), 'utf8').catch(() => null);
    if (b === a) continue;
    if (b === null) changes.push({ file: rel, kind: 'added', lines: a.split('\n').length });
    else if (a === null) changes.push({ file: rel, kind: 'deleted', lines: b.split('\n').length });
    else
      changes.push({
        file: rel,
        kind: 'modified',
        lines: Math.abs(a.split('\n').length - b.split('\n').length),
      });
  }
  return changes;
}
