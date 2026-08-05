import { spawn } from 'node:child_process';
import path from 'node:path';

import { openStore } from './tasks.mjs';
import { appendEvent } from './db.mjs';

/**
 * Do the work, without needing a particular agent to be watching.
 *
 * Everything until now assumed a Claude session was sitting there with the event
 * stream in front of it. That is a fine way to work and a poor thing to depend
 * on: sessions end, people close terminals, and the queue outlives both. This
 * takes tasks off the same store any tool reads and runs them.
 *
 * Three rules it does not bend:
 *
 * It claims before it works. The claim is a conditional UPDATE, so if a Claude
 * session took the task a second earlier this one is told and moves on rather
 * than doing it twice.
 *
 * It never touches a proposal. `proposed` means found by a tool and not yet
 * permitted, and a worker deciding for itself that its own suggestion is
 * approved would empty that word of meaning.
 *
 * It checks before and after. A task that no longer reproduces is closed without
 * anyone spending a model call on it, and a fix that did not work says so rather
 * than being reported as done.
 */

/** Which command is the brain, and how to hand it a prompt. */
export function brainFor(cfg, name) {
  const brains = cfg?.brains ?? {};
  const chosen = name ?? cfg?.brain ?? 'claude';
  const spec = brains[chosen] ?? (chosen === 'claude' ? { cmd: 'claude', args: ['-p'] } : null);
  if (!spec) throw new Error(`no brain called "${chosen}" — add it to ayna.config.json under "brains"`);
  return { name: chosen, ...spec };
}

/** Run the brain on one prompt. Its stdout is the record of what it did. */
export function runBrain(brain, prompt, { cwd, timeoutMs = 15 * 60 * 1000 } = {}) {
  return new Promise((resolve) => {
    const child = spawn(brain.cmd, [...(brain.args ?? []), prompt], {
      cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: process.env,
    });

    let out = '';
    let err = '';
    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      resolve({ ok: false, error: `${brain.name} timed out`, out, err });
    }, timeoutMs);

    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (err += d));
    child.on('error', (e) => {
      clearTimeout(timer);
      // A missing brain is a setup problem, not a failed task.
      resolve({ ok: false, error: e.code === 'ENOENT' ? `${brain.cmd} is not installed` : e.message, out, err });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ ok: code === 0, code, out: out.trim(), err: err.trim() });
    });
  });
}

/** Everything the brain needs to act, and nothing it has to guess. */
export function promptFor(task, { url }) {
  const lines = [
    'A user marked up a page and asked for this change. Make it, in this repository.',
    '',
    `What they said: ${task.comment ?? '(no text)'}`,
  ];
  if (url || task.url) lines.push(`Page: ${task.url ?? url}`);
  if (task.selector) lines.push(`Element: ${task.selector}`);
  if (task.styles && Object.keys(task.styles).length) {
    const shown = Object.entries(task.styles).slice(0, 10).map(([k, v]) => `${k}: ${v}`);
    lines.push(`Its computed styles: ${shown.join('; ')}`);
  }
  if (task.sourceCandidates?.length) {
    lines.push('', 'Likely source:');
    for (const c of task.sourceCandidates.slice(0, 4)) lines.push(`  ${c.file}:${c.line}  ${c.preview ?? ''}`);
  }
  if (task.regionScreenshot) lines.push('', `A crop of what they marked: ${task.regionScreenshot}`);
  if (task.fix) lines.push('', `Suggested fix: ${task.fix}`);
  lines.push(
    '',
    'Change the source, not the rendered page. Keep the copy; restyle rather than rewrite.',
    'Do not add dependencies. When you are done, say briefly what you changed.',
  );
  return lines.join('\n');
}

/**
 * Take tasks and work them until there are none left, or `limit` are done.
 *
 * `verify` is injected so the caller owns the browser: a worker that opened its
 * own Chrome for every task would spend more time launching than working, and
 * would fight the review window for the same profile.
 */
export async function work({
  projectDir,
  cfg,
  brain,
  limit = Infinity,
  owner = `worker-${process.pid}`,
  verify = null,
  onEvent = () => {},
  signal,
} = {}) {
  const store = await openStore(projectDir);
  const done = [];
  /*
    What this pass has already tried.

    A brain that fails puts its task back on the pile, which is right — it should
    be picked up again later, by someone, once whatever went wrong is dealt with.
    It is not right to pick it up again immediately: the worker failed the same
    task, returned it, found it waiting and failed it again, forever. Returning
    work to the queue and retrying it in the same breath are different decisions.
  */
  const tried = new Set();

  while (done.length < limit && !signal?.aborted) {
    /*
      Only what is actually waiting for someone.

      "Pending" was the first filter and it loops forever: `applied` is pending —
      it means done but not yet approved — so the worker finished a task,
      released it, found it pending again and did it a second time, and a third.
      Waiting for work and waiting for a verdict are different states, and only
      the first belongs to a worker.
    */
    const open = (await store.list()).filter(
      (t) => (t.status === 'open' || t.status === 'rejected') && !t.claimedBy && !tried.has(t.id),
    );
    if (!open.length) break;

    const task = open[0];
    tried.add(task.id);
    const claimed = await store.claim(task.id, owner);
    if (!claimed) {
      // Somebody else got there first. That is the mechanism working.
      onEvent({ event: 'skipped', taskId: task.id, why: 'claimed by someone else' });
      continue;
    }

    try {
      if (verify) {
        const [verdict] = await verify([claimed]);
        if (verdict?.verdict === 'gone') {
          await store.update(task.id, { status: 'obsolete', verdict }, verdict.why);
          onEvent({ event: 'task', taskId: task.id, status: 'obsolete', why: verdict.why });
          done.push({ id: task.id, outcome: 'already-fixed' });
          continue;
        }
      }

      await store.update(task.id, { status: 'in_progress' }, `${owner} picked it up`);
      onEvent({ event: 'working', taskId: task.id, by: owner, comment: claimed.comment });

      const result = await runBrain(brain, promptFor(claimed, { url: claimed.url }), { cwd: projectDir });

      if (!result.ok) {
        // Back to the pile, with the reason, rather than stuck as in_progress.
        await store.update(task.id, { status: 'open' }, `${brain.name}: ${result.error ?? 'failed'}`);
        onEvent({ event: 'failed', taskId: task.id, why: result.error ?? `exit ${result.code}` });
        done.push({ id: task.id, outcome: 'failed', why: result.error });
        continue;
      }

      let outcome = 'applied';
      let note = result.out.split('\n').slice(-4).join(' ').slice(0, 300);

      if (verify) {
        const [after] = await verify([await store.get(task.id)]);
        if (after?.verdict === 'reproduces') {
          // The claim is that it is fixed; the page says otherwise. Say so.
          outcome = 'still-broken';
          note = `${brain.name} finished but the fault still reproduces`;
        }
      }

      await store.update(task.id, { status: 'applied' }, note);
      onEvent({ event: 'applied', taskId: task.id, by: owner, outcome, note });
      done.push({ id: task.id, outcome, note });
    } finally {
      await store.release(task.id).catch(() => {});
      if (store.db) {
        try {
          appendEvent(store.db, { event: 'released', taskId: task.id, by: owner });
        } catch {
          // The task is released either way; the log line is a nicety.
        }
      }
    }
  }

  return { worked: done.length, tasks: done };
}
