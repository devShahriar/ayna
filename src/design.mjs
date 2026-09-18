import path from 'node:path';

import { SEVERITY } from './audit.mjs';

/** [check, severity] — the audit's own table, so the two never disagree. */
const SEVERITY_PAIRS = SEVERITY.map(([key, sev]) => [key, sev]);

/**
 * One review, two kinds of truth.
 *
 * ayna has always been careful about the line between them, and right about it:
 * `audit` reports what the page can PROVE — a control covered, text cut off, a
 * contrast ratio under 4.5:1 — and those decide whether a run is clean, because
 * a loop needs a condition it can reach. Taste cannot be a gate; feed "this looks
 * generic" into a termination test and the loop never terminates.
 *
 * But the honest line was being drawn in the wrong place. Not a gate is not the
 * same as not actionable. `ayna taste` printed opinions in a terminal and stopped
 * there, so the agent reviewing a page got a measurement list it could act on and
 * a design list it could only read out. The judgement stayed with the user in the
 * sense of "nobody did anything about it".
 *
 * A recommendation is what closes that. Each one says the same four things
 * whether it came from a measurement or from taste:
 *
 *   what is wrong · where it lives · what to do instead · how sure we are
 *
 * `confidence` is the load-bearing field. `measured` means the page proved it and
 * an agent may fix it without asking. `judged` means a detector has an opinion,
 * and an opinion about how something LOOKS is the user's call — so those become
 * proposals, and a harness offers them rather than acting.
 */

/** Worst first, and measurements above opinions at equal severity. */
const RANK = { critical: 4, major: 3, warning: 2, minor: 1, info: 0 };
const weight = (r) => RANK[r.severity] ?? 1;

/*
  What a measurable fault means and what to do about it.

  The audit already names the fault; an agent still has to work out the fix, and
  "covered" does not say "raise the z-index or move it". These are the fixes that
  are actually true of each check rather than a paraphrase of its name.
*/
const MEASURED_ADVICE = {
  covered: {
    title: 'a control is behind something else and cannot be clicked',
    fix: 'Something is painted over an interactive element. Move the overlapping element or reserve the space instead of floating over it — raising z-index hides the symptom and leaves the control unreachable by touch.',
  },
  offscreen: {
    title: 'content is cut off by the window edge',
    fix: 'The element extends past the viewport. Let the row wrap, let the flexible child shrink (min-width: 0), or drop the least important item at this width.',
  },
  overlaps: {
    title: 'two elements are drawn on top of each other',
    fix: 'Usually a fixed height meeting longer copy, or a negative margin. Fix the sizing, not the stacking order.',
  },
  clipped: {
    title: 'text is cut off by its container',
    fix: 'The container is shorter than its content with overflow hidden. Let it grow, reduce the type, or shorten the copy — never just raise the overflow.',
  },
  lowContrast: {
    title: 'text does not meet the WCAG contrast minimum',
    fix: 'Body and placeholder text need 4.5:1, large text 3:1. On a coloured surface tint secondary text from that hue rather than reaching for grey.',
  },
  noFocusIndicator: {
    title: 'a keyboard user cannot see where they are',
    fix: 'Give :focus-visible a visible outline. If the design removed the default, it has to replace it — not delete it.',
  },
  faintFocusIndicator: {
    title: 'the focus ring is under 3:1 against its background',
    fix: 'Raise the ring to 3:1 against the surface behind it, and give it an offset so it reads against the control as well as the page.',
  },
  unlabelled: {
    title: 'an icon-only control has no accessible name',
    fix: 'Add aria-label, or visible text. A screen reader announces this as "button" and nothing else.',
  },
  smallTargets: {
    title: 'a hit target is under 44px',
    fix: 'Grow the tappable box to 44px with padding. The visible control can stay small; the target should not.',
  },
  tinyText: {
    title: 'text below 12px',
    fix: 'Raise it to at least 12px. If it is meant to read as secondary, use colour or weight for that, not a size nobody can read.',
  },
};

/**
 * A measurable finding, in the shape the harness reads.
 *
 * Each check spells its element differently — `covered` has `element` and
 * `coveredBy`, `overlaps` has `a` and `b` — so the detail line is built per
 * check rather than from a field that only some of them have.
 */
function fromAudit(kind, f, severity, viewport) {
  const advice = MEASURED_ADVICE[kind] ?? { title: kind, fix: 'See the audit output.' };

  const detail =
    kind === 'covered' ? `${f.element} "${f.label ?? ''}" is behind ${f.coveredBy}`
    : kind === 'offscreen' ? `${f.element} "${f.label ?? ''}" cut off ${f.cut} by ${f.by}px`
    : kind === 'overlaps' ? `${f.a} "${f.labelA ?? ''}" over ${f.b} "${f.labelB ?? ''}"`
    : kind === 'clipped' ? `${f.element} "${f.label ?? ''}" clipped by ${f.by}px`
    : `${f.element ?? ''}${f.size ? ' ' + f.size : ''}${f.label ? ` "${f.label}"` : ''}`.trim();

  const selector = f.element ?? f.a ?? null;
  return {
    id: `measured:${kind}:${viewport ?? ''}:${selector ?? detail}`.slice(0, 140),
    source: 'audit',
    confidence: 'measured',
    severity,
    rule: kind,
    viewport: viewport ?? null,
    title: advice.title,
    detail,
    fix: advice.fix,
    selector,
    rect: f.rect ?? null,
    sites: [],
    // A measurement is reproducible, so an agent may act on it directly.
    act: 'fix',
  };
}

/** A taste finding, in the same shape — and never promoted past a proposal. */
function fromTaste(f) {
  return {
    id: `taste:${f.rule}`,
    source: 'impeccable',
    confidence: 'judged',
    severity: f.severity === 'error' ? 'major' : f.severity ?? 'warning',
    rule: f.rule,
    title: f.title,
    detail: f.where?.[0] ?? '',
    // impeccable's description already carries the alternative, which is the
    // half an agent actually needs; passing only the complaint forward would
    // throw away the useful part of the finding.
    fix: f.note ?? '',
    selector: null,
    rect: null,
    sites: f.sites ?? [],
    occurrences: f.where?.length ?? 0,
    // An opinion about how something looks belongs to the user.
    act: 'propose',
  };
}

/**
 * Merge a measured audit and a taste pass into one ranked set.
 *
 * `audit` is the object `runAudit` returns; `taste` is `judgeTaste`'s result.
 * Either may be missing — a review with no impeccable installed is still a
 * review, and must say so rather than looking like a page with no design faults.
 */
export function recommend({ audit = null, taste = null } = {}) {
  const out = [];
  const seen = new Set();

  /*
    `audit.findings` is one entry per viewport, each carrying a list per check —
    not a map keyed by check. The same fault therefore appears at desktop and at
    mobile, and reporting it twice would have an agent fix it twice; `seen`
    collapses them while the first viewport it appeared at is kept, because
    "only on mobile" is part of the finding.
  */
  for (const perViewport of audit?.findings ?? []) {
    for (const [kind, severity] of SEVERITY_PAIRS) {
      const items = perViewport?.[kind];
      if (!Array.isArray(items)) continue;
      for (const f of items) {
        const rec = fromAudit(kind, f, severity, perViewport.viewport);
        const key = `${kind}:${rec.selector ?? rec.detail}`;
        if (seen.has(key)) continue;
        seen.add(key);
        out.push(rec);
      }
    }
  }

  for (const f of taste?.findings ?? []) out.push(fromTaste(f));

  out.sort((a, b) => {
    const s = weight(b) - weight(a);
    if (s) return s;
    // A thing the page proved outranks a thing a detector believes.
    if (a.confidence !== b.confidence) return a.confidence === 'measured' ? -1 : 1;
    return (b.occurrences ?? 0) - (a.occurrences ?? 0);
  });

  const measured = out.filter((r) => r.confidence === 'measured');
  const judged = out.filter((r) => r.confidence === 'judged');
  const serious = measured.filter((r) => r.severity !== 'minor');

  return {
    recommendations: out,
    counts: { measured: measured.length, judged: judged.length, total: out.length },
    /*
      Clean still means what it has always meant here: nothing serious that the
      page can prove. Taste is reported alongside and deliberately excluded,
      because a loop that waits for taste to reach zero never stops.
    */
    clean: serious.length === 0,
    tasteAvailable: Boolean(taste?.available),
    tasteHint: taste?.available ? null : (taste?.hint ?? 'impeccable is not installed — no design opinions in this review'),
  };
}

/**
 * The brief an agent acts on.
 *
 * Deliberately the same shape as `briefFor` in flowspec: a task, the rules, and
 * the findings — so a harness reads one kind of thing from ayna whether it is
 * writing a test or fixing a design.
 */
export function designBrief(result, { url, screenshots = [] } = {}) {
  const fix = result.recommendations.filter((r) => r.act === 'fix');
  const propose = result.recommendations.filter((r) => r.act === 'propose');

  return {
    task: 'Fix what the page proved is wrong. Offer the rest — do not silently restyle someone\'s design.',
    url,
    screenshots,
    rules: [
      'Read the screenshots before changing anything. A fault you have not seen is a fault you are guessing at.',
      'Act on `fix` items directly: each is reproducible, so the page can confirm the repair.',
      'Never apply a `propose` item without asking. It is an opinion about how the page looks, and that judgement is the user\'s.',
      'Offer proposals with `ayna preview --selector … --css …` so they see the change before anything is written to source.',
      'Re-run `ayna audit` afterwards. An issue is fixed when the measurement says so, not when the edit looks right.',
      'Keep the copy. A visual pass restyles text; it does not rewrite it.',
    ],
    fix,
    propose,
    counts: result.counts,
    ...(result.tasteAvailable ? {} : { note: result.tasteHint }),
  };
}

/** A short human summary; the detail belongs in the brief, not a terminal. */
export function summarizeDesign(result, { relativeTo } = {}) {
  const lines = [];
  /*
    A site is a file path when impeccable scanned a directory and a URL when it
    scanned a running page. Running path.relative over the URL turned
    "http://127.0.0.1:4173" into "http:/127.0.0.1:4173" — a string that is
    neither, and looks like a corrupted path.
  */
  const rel = (f) => {
    if (!f) return '';
    if (/^[a-z][a-z0-9+.-]*:\/\//i.test(f)) return f;
    return relativeTo ? path.relative(relativeTo, f) : f;
  };

  const fix = result.recommendations.filter((r) => r.act === 'fix');
  const propose = result.recommendations.filter((r) => r.act === 'propose');

  if (fix.length) {
    lines.push(`${fix.length} measured — the page proves these, fix them:`);
    for (const r of fix.slice(0, 12)) {
      lines.push(`  ✗ ${r.title}${r.selector ? ` — ${r.selector}` : ''}`);
      if (r.detail) lines.push(`      ${String(r.detail).slice(0, 96)}`);
    }
    lines.push('');
  } else {
    lines.push('nothing measurable is wrong');
    lines.push('');
  }

  if (propose.length) {
    lines.push(`${propose.length} judged — opinions, offer them rather than applying:`);
    for (const r of propose) {
      lines.push(`  · ${r.title}${r.occurrences > 1 ? ` ×${r.occurrences}` : ''}`);
      /*
        Show where it lives, or what it looked like — whichever actually helps.
        Scanning a URL makes every site the same page, so printing it under each
        finding is a column of identical text; the snippet is the useful half.
      */
      const site = r.sites?.find((x) => x.file && !/^[a-z][a-z0-9+.-]*:\/\//i.test(x.file));
      if (site) lines.push(`      ${rel(site.file)}${site.line ? `:${site.line}` : ''}`);
      else if (r.detail) lines.push(`      ${String(r.detail).slice(0, 96)}`);
    }
  } else if (!result.tasteAvailable) {
    lines.push(result.tasteHint);
  }

  return lines.join('\n');
}
