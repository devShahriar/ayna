import { readdir, readFile, writeFile, rm, mkdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';

/**
 * What a round changed in the project, and the way back.
 *
 * A round used to end with "Changes landed" and nothing else. Which files, what
 * in them, and how to take it back were all somewhere else — the terminal, git,
 * the agent's own memory of what it did. The user is the one judging the round,
 * and they were being asked to do it without the diff.
 *
 * The project's text files are read when the round is sent, before anyone has
 * touched them, and compared afterwards against whatever the watcher saw move.
 * Kept in memory rather than on disk: it only has to outlive the window that
 * offers the undo, and a copy of someone's source tree is not something to
 * leave lying in their project. It does not assume git — plenty of what ayna
 * reviews is not a repository, and a working tree with uncommitted edits is
 * exactly when git's own idea of "before" is wrong.
 */

const posix = (rel) => rel.split(path.sep).join('/');
const hash = (buf) => (buf === null ? null : createHash('sha1').update(buf).digest('hex'));

/**
 * Read every text file under `root`, within a budget.
 *
 * `complete` is false when the budget ran out. A file the snapshot never reached
 * has no known "before", which is different from a file that did not exist —
 * so a new file is only called new when the snapshot saw everything. The same
 * goes for a file or folder that was there but could not be read: those are
 * kept in `unread`, because calling one new would let an undo delete it.
 */
export async function snapshotProject(root, { skipDirs = [], textExt = new Set(), maxFiles = 4000, maxBytes = 40 * 1024 * 1024 } = {}) {
  const files = new Map();
  const unread = new Set();
  let complete = true;

  // Listed first and read after: the listing is cheap, and the reads can then
  // run side by side instead of one at a time while Send waits on them.
  const found = [];
  const walk = async (dir) => {
    // Over budget, the rest of the tree is not worth listing.
    if (!complete) return;
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      if (dir === root) complete = false;
      else unread.add(posix(path.relative(root, dir)));
      return;
    }
    for (const entry of entries) {
      if (!complete) return;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!skipDirs.includes(entry.name)) await walk(full);
      } else if (entry.isFile() && textExt.has(path.extname(entry.name).toLowerCase())) {
        if (found.length >= maxFiles) {
          complete = false;
          return;
        }
        found.push(full);
      }
    }
  };
  await walk(root);

  /*
    A walk that hit the file cap has already said `complete = false`, and the
    files it did find are still worth reading. Only running out of bytes stops
    the reads.
  */
  let bytes = 0;
  let full = false;
  for (let i = 0; i < found.length && !full; i += 32) {
    const batch = found.slice(i, i + 32);
    const bufs = await Promise.all(batch.map((full) => readFile(full).catch(() => null)));
    for (const [k, full] of batch.entries()) {
      const rel = posix(path.relative(root, full));
      if (bufs[k] === null) {
        unread.add(rel);
        continue;
      }
      if (bytes + bufs[k].length > maxBytes) {
        complete = false;
        full = true;
        break;
      }
      files.set(rel, bufs[k]);
      bytes += bufs[k].length;
    }
  }
  return { root, files, unread, complete };
}

/**
 * Line diff, as a list of operations: ' ' kept, '-' removed, '+' added.
 *
 * Edits from a round are small and local, so the common head and tail are
 * trimmed first and the longest-common-subsequence table only covers the part
 * that moved. A middle too large for that table is reported as replaced
 * wholesale — the counts stay honest and nothing hangs the window.
 */
export function diffLines(a, b) {
  // A final newline ends the last line; it does not start an empty one.
  const lines = (text) => (text === '' ? [] : text.replace(/\n$/, '').split('\n'));
  const x = lines(a);
  const y = lines(b);
  let head = 0;
  while (head < x.length && head < y.length && x[head] === y[head]) head += 1;
  let tail = 0;
  while (tail < x.length - head && tail < y.length - head && x[x.length - 1 - tail] === y[y.length - 1 - tail]) tail += 1;

  const xm = x.slice(head, x.length - tail);
  const ym = y.slice(head, y.length - tail);
  const ops = x.slice(0, head).map((s) => ({ t: ' ', s }));

  if (xm.length * ym.length > 4_000_000) {
    for (const s of xm) ops.push({ t: '-', s });
    for (const s of ym) ops.push({ t: '+', s });
  } else {
    // lcs[i][j]: length of the common subsequence of xm[i..] and ym[j..].
    const lcs = Array.from({ length: xm.length + 1 }, () => new Uint32Array(ym.length + 1));
    for (let i = xm.length - 1; i >= 0; i--) {
      for (let j = ym.length - 1; j >= 0; j--) {
        lcs[i][j] = xm[i] === ym[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
      }
    }
    let i = 0;
    let j = 0;
    while (i < xm.length && j < ym.length) {
      if (xm[i] === ym[j]) {
        ops.push({ t: ' ', s: xm[i] });
        i += 1;
        j += 1;
      } else if (lcs[i + 1][j] >= lcs[i][j + 1]) {
        ops.push({ t: '-', s: xm[i++] });
      } else {
        ops.push({ t: '+', s: ym[j++] });
      }
    }
    while (i < xm.length) ops.push({ t: '-', s: xm[i++] });
    while (j < ym.length) ops.push({ t: '+', s: ym[j++] });
  }

  for (const s of x.slice(x.length - tail)) ops.push({ t: ' ', s });
  return ops;
}

/**
 * The changed lines with a little context, for a narrow panel.
 *
 * Unchanged runs collapse to a single '…' line, and the whole thing stops at
 * `max` lines with a count of what was left out, because a rail is somewhere to
 * see what happened, not to review a refactor.
 */
export function hunks(ops, { context = 1, max = 40 } = {}) {
  const keep = new Set();
  ops.forEach((op, i) => {
    if (op.t === ' ') return;
    for (let k = Math.max(0, i - context); k <= Math.min(ops.length - 1, i + context); k++) keep.add(k);
  });
  const out = [];
  let skipped = false;
  ops.forEach((op, i) => {
    if (!keep.has(i)) {
      skipped = true;
      return;
    }
    if (skipped && out.length) out.push({ t: '…', s: '' });
    skipped = false;
    out.push(op);
  });
  if (out.length > max) {
    const rest = out.length - max;
    return [...out.slice(0, max), { t: '…', s: `${rest} more line${rest === 1 ? '' : 's'}` }];
  }
  return out;
}

const isText = (buf) => buf === null || !buf.subarray(0, 8000).includes(0);

/**
 * What changed between the snapshot and now, among the files the watcher saw.
 *
 * Only `candidates` are compared: the watcher already knows which files were
 * touched, and re-reading the whole tree to find them again would be the slow
 * way to the same answer. A touched file that ended up identical is not a
 * change.
 */
export async function roundChanges(snapshot, candidates) {
  const unread = [...snapshot.unread];
  const seen = (rel) => snapshot.complete && !unread.some((u) => rel === u || rel.startsWith(`${u}/`));
  const changes = [];
  for (const rel of [...new Set([...candidates].map(posix))].sort()) {
    const after = await readFile(path.join(snapshot.root, rel)).catch(() => null);
    const known = snapshot.files.has(rel);
    const before = known ? snapshot.files.get(rel) : seen(rel) ? null : undefined;
    if (before === undefined) {
      // Never read, so there is nothing to compare with and nothing to restore.
      if (after !== null) changes.push({ file: rel, status: 'modified', added: 0, removed: 0, before: undefined, after, undoable: false });
      continue;
    }
    if (before === null && after === null) continue;
    if (before !== null && after !== null && before.equals(after)) continue;

    let added = 0;
    let removed = 0;
    let ops = null;
    if (isText(before) && isText(after)) {
      ops = diffLines(before?.toString('utf8') ?? '', after?.toString('utf8') ?? '');
      for (const op of ops) {
        if (op.t === '+') added += 1;
        else if (op.t === '-') removed += 1;
      }
    }
    changes.push({
      file: rel,
      status: before === null ? 'added' : after === null ? 'deleted' : 'modified',
      added,
      removed,
      before,
      after,
      ops,
      undoable: true,
    });
  }
  return changes;
}

/**
 * Put a round's files back the way they were before it.
 *
 * All or nothing, and only over files nobody has touched since. A file edited
 * again after the round — by a later round, by hand, by a formatter — would
 * lose that later work if it were simply overwritten, so the undo refuses and
 * names it instead. Reverting good work silently is the one thing an undo must
 * never do.
 */
export async function undoChanges(root, changes) {
  const blocked = changes.filter((c) => !c.undoable).map((c) => c.file);
  const conflicts = [];
  for (const c of changes) {
    if (!c.undoable) continue;
    const now = await readFile(path.join(root, c.file)).catch(() => null);
    if (hash(now) !== hash(c.after)) conflicts.push(c.file);
  }
  if (blocked.length || conflicts.length) return { ok: false, conflicts, unknown: blocked, restored: [] };

  const restored = [];
  for (const c of changes) {
    const full = path.join(root, c.file);
    if (c.before === null) {
      await rm(full, { force: true });
    } else {
      await mkdir(path.dirname(full), { recursive: true });
      await writeFile(full, c.before);
    }
    restored.push(c.file);
  }
  return { ok: true, conflicts: [], unknown: [], restored };
}
