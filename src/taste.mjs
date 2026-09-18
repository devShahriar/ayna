import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const exec = promisify(execFile);

/**
 * Borrow someone else's taste.
 *
 * ayna's limitation has always been written down honestly: it knows what it can
 * measure. "This control cannot be clicked" is a fact and it will chase it to
 * zero; "this looks generic" is not, so ayna says nothing and the judgement stays
 * with the user. That gap is real — a page can pass every layout check and still
 * look like every other page an LLM has produced.
 *
 * Impeccable (github.com/pbakaus/impeccable, Apache-2.0) is a set of detectors
 * for exactly that: the purple gradients, the icon-tile-above-heading feature
 * card, the hairline border with the wide shadow. It runs without a model or an
 * API key and it will scan a URL, which means it can look at the same rendered
 * page ayna is looking at rather than at the source that produced it.
 *
 * Two rules govern this, and both matter more than the feature:
 *
 * 1. It is spawned, never imported. ayna depends on playwright-core and nothing
 *    else, and that stays true. No impeccable installed means this is skipped and
 *    said out loud, not an error.
 * 2. Its findings never enter `counts` and never touch `clean`. Those exist so a
 *    fixing loop has a condition under which it is finished, and that condition
 *    has to be something the page can prove. Taste is unbounded — feed it into
 *    the termination test and the loop never terminates.
 */

/** Where to find it: an explicit override, then the PATH, then a local install. */
function candidates(override) {
  if (override) return [override.split(' ')];
  return [
    ['impeccable'],
    /*
      `npx --no-install` deliberately: plain npx would fetch the package from the
      network mid-review. Downloading and running code because someone asked for a
      screenshot critique is not a side effect to take on their behalf.
    */
    ['npx', '--no-install', 'impeccable'],
  ];
}

/**
 * Ask impeccable what it thinks of `target` (a URL or a directory).
 *
 * Never throws: a missing tool, a crash, or unparseable output all come back as a
 * result saying so. A taste pass failing must not take down a review.
 */
export async function judgeTaste(target, { command, cwd, timeoutMs = 120_000 } = {}) {
  const override = command ?? process.env.AYNA_IMPECCABLE;

  for (const argv of candidates(override)) {
    const [bin, ...prefix] = argv;
    try {
      const { stdout } = await exec(bin, [...prefix, 'detect', target, '--json'], {
        cwd,
        timeout: timeoutMs,
        maxBuffer: 8 * 1024 * 1024,
      });
      return parse(stdout, target);
    } catch (err) {
      // Findings are reported with exit code 2, which execFile treats as failure.
      // The output is still there and is the whole point of running it.
      if (err.stdout && String(err.stdout).trim().startsWith('[')) {
        return parse(err.stdout, target);
      }
      /*
        This candidate is not this machine's answer — try the next, or report it
        as absent. The reason lives in stderr, not in the message: execFile's
        message is only "Command failed: <argv>", so matching on that alone
        turned "impeccable is not installed" into "taste check failed", which
        reads as a broken tool rather than a missing optional one.
      */
      const why = `${err.message} ${err.stderr ?? ''}`;
      if (err.code === 'ENOENT' || /not found|could not determine|npm ERR|ENOENT/i.test(why)) continue;
      return { available: true, findings: [], error: err.message.split('\n')[0] };
    }
  }

  return {
    available: false,
    findings: [],
    hint: 'impeccable is not installed — `npm i -g impeccable` adds taste checks to this review',
  };
}

function parse(stdout, target) {
  let raw;
  try {
    raw = JSON.parse(stdout);
  } catch {
    return { available: true, findings: [], error: 'impeccable returned output that was not JSON' };
  }
  if (!Array.isArray(raw)) return { available: true, findings: [], error: 'unexpected output shape' };

  /*
    Collapse repeats before showing anyone.

    A rule that fires on four feature cards produced four identical paragraphs of
    explanation. The reader needs the rule once and the list of places it applies.
  */
  const byRule = new Map();
  for (const f of raw) {
    const key = f.antipattern ?? f.name ?? 'unknown';
    if (!byRule.has(key)) {
      byRule.set(key, {
        rule: key,
        title: f.name ?? key,
        note: f.description ?? '',
        severity: f.severity ?? 'warning',
        category: f.category ?? 'design',
        where: [],
        sites: [],
      });
    }
    const entry = byRule.get(key);
    if (f.snippet && entry.where.length < 8) entry.where.push(f.snippet);
    /*
      Keep where it lives, not just what it looked like.

      impeccable 4.x reports `file` and `line` with every finding and this
      parser dropped both, so a recommendation arrived as prose — "the icon tile
      above a heading is the universal AI feature-card template" — with nothing
      saying which of four cards, in which file. An agent then re-derives the
      location that was already in the payload, which is slow when it works and
      wrong when it does not. A finding worth acting on has to say where.
    */
    if (f.file && entry.sites.length < 8) {
      entry.sites.push({ file: f.file, line: f.line ?? null, snippet: f.snippet ?? null });
    }
  }

  const findings = [...byRule.values()].sort(
    (a, b) => rank(b.severity) - rank(a.severity) || b.where.length - a.where.length,
  );
  return { available: true, target, findings, total: raw.length };
}

const rank = (severity) => ({ error: 3, warning: 2, info: 1 }[severity] ?? 0);

/**
 * Turn taste findings into proposals.
 *
 * Proposals, not tasks: `proposed` already means "found by a tool, not yet
 * permitted", and that is exactly what an opinion about how a page looks is.
 * Nothing is edited until the user answers it.
 */
export async function proposeTaste(store, result, { url } = {}) {
  if (!result.available || !result.findings.length) return { proposed: 0 };

  const existing = new Set(
    (await store.list()).map((t) => t.tasteRule).filter(Boolean),
  );

  let proposed = 0;
  for (const f of result.findings) {
    if (existing.has(f.rule)) continue; // already raised; do not nag every run
    await store.create({
      status: 'proposed',
      kind: 'taste',
      source: 'impeccable',
      tasteRule: f.rule,
      url,
      comment: `${f.title}${f.where.length ? ` — ${f.where.length} place${f.where.length > 1 ? 's' : ''}` : ''}`,
      fix: f.note,
      elements: f.where.map((w) => ({ selector: w })),
    });
    proposed += 1;
  }
  return { proposed };
}

/** A short human summary; the long descriptions belong in the task, not a terminal. */
export function summarizeTaste(result) {
  if (!result.available) return result.hint ?? 'impeccable is not installed';
  if (result.error) return `taste check failed: ${result.error}`;
  if (!result.findings.length) return 'no design anti-patterns found';

  const lines = [`${result.findings.length} design notes (${result.total} occurrences)`, ''];
  for (const f of result.findings) {
    lines.push(`  ${f.severity === 'error' ? '✗' : '·'} ${f.title}${f.where.length > 1 ? ` ×${f.where.length}` : ''}`);
    if (f.where[0]) lines.push(`      ${f.where[0].slice(0, 96)}`);
  }
  lines.push('');
  lines.push('  These are opinions, not measurements — they never affect whether an audit is clean.');
  return lines.join('\n');
}
