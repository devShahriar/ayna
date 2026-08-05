import { gotoSettled, settle } from './browser.mjs';
import { CHECKS } from './audit.mjs';

/**
 * Does this task still apply?
 *
 * The question came from watching somebody fix something themselves and then be
 * asked about it anyway. A list that nags about solved problems stops being read,
 * and once it stops being read the unsolved ones go with it.
 *
 * The answer divides cleanly, and the division is the whole design:
 *
 * A measured fault either reproduces or it does not. If the button is no longer
 * covered, there is nothing left to do and nobody needs to read it — that closes
 * itself, with the evidence attached.
 *
 * Anything asked for in words cannot be settled that way. "Make the logo bigger"
 * has no measurement, and an element that changed is not the same as a wish that
 * was granted — restyling a logo is not making it bigger. Those only ever earn a
 * question, never a closure.
 */

/** What a task claims, in a form that can be checked again later. */
export function checkKindOf(task) {
  if (task.checkKind) return task.checkKind;
  // Proposals ayna raised itself name the fault they found in their own text.
  const text = `${task.kind ?? ''} ${task.comment ?? ''}`.toLowerCase();
  for (const kind of ['covered', 'offscreen', 'clipped', 'overlaps', 'lowcontrast', 'nofocusindicator']) {
    if (text.includes(kind)) return kind === 'lowcontrast' ? 'lowContrast' : kind === 'nofocusindicator' ? 'noFocusIndicator' : kind;
  }
  return null;
}

/** A cheap description of the thing a comment was about. */
export const FINGERPRINT = `((selector) => {
  const el = selector ? document.querySelector(selector) : null;
  if (!el) return { missing: true };
  const st = getComputedStyle(el);
  const r = el.getBoundingClientRect();
  return {
    missing: false,
    html: (el.outerHTML || '').length,
    text: (el.textContent || '').trim().slice(0, 160),
    box: [Math.round(r.width), Math.round(r.height)],
    style: [st.fontSize, st.fontWeight, st.color, st.backgroundColor, st.display, st.padding].join('|'),
  };
})`;

const sameLook = (a, b) =>
  !!a && !!b && !a.missing && !b.missing &&
  a.style === b.style && a.text === b.text &&
  Math.abs(a.box[0] - b.box[0]) < 3 && Math.abs(a.box[1] - b.box[1]) < 3;

/**
 * Re-check `tasks` against the live page.
 *
 * Returns a verdict per task and never writes: the caller decides what to do
 * with an opinion about somebody else's work.
 */
export async function verifyTasks({ browser, context, url, tasks, viewport }) {
  const ctx =
    context ??
    (await browser.newContext({
      viewport: viewport ?? { width: 1440, height: 900 },
      deviceScaleFactor: 1,
    }));
  const page = ctx.pages()[0] ?? (await ctx.newPage());

  const verdicts = [];
  try {
    await gotoSettled(page, url, { settleMs: 2000 }).catch(() => {});
    await settle(page, 1500);

    const measured = await page.evaluate(CHECKS).catch((e) => ({ unavailable: e.message.split('\n')[0] }));

    for (const task of tasks) {
      const kind = checkKindOf(task);

      if (measured.unavailable) {
        // The page could not be measured, so nothing is known about any of them.
        verdicts.push({ id: task.id, verdict: 'unknown', why: measured.unavailable });
        continue;
      }

      if (kind && Array.isArray(measured[kind])) {
        const still = measured[kind].some(
          (f) => !task.selector || f.element === task.selector || (f.element && task.selector.endsWith(f.element)),
        );
        verdicts.push(
          still
            ? { id: task.id, verdict: 'reproduces', kind }
            : {
                id: task.id,
                verdict: 'gone',
                kind,
                why: `no ${kind} fault reported here any more`,
              },
        );
        continue;
      }

      /*
        Subjective. The most that can be said is whether the thing it was about
        still looks the way it did — and that is a reason to ask, not to close.
      */
      const now = await page.evaluate(FINGERPRINT, task.selector ?? null).catch(() => null);
      const before = task.fingerprint ?? null;

      if (now?.missing) {
        verdicts.push({ id: task.id, verdict: 'element-gone', why: 'the element it was about is no longer on the page' });
      } else if (!before) {
        // Nothing to compare against; recording one now makes the next run useful.
        verdicts.push({ id: task.id, verdict: 'unknown', fingerprint: now, why: 'nothing recorded to compare with' });
      } else if (sameLook(before, now)) {
        verdicts.push({ id: task.id, verdict: 'unchanged' });
      } else {
        verdicts.push({ id: task.id, verdict: 'changed', fingerprint: now, why: 'it has changed since you wrote this' });
      }
    }
  } finally {
    if (!context) await ctx.close().catch(() => {});
  }
  return verdicts;
}

/**
 * Apply verdicts to the store.
 *
 * Only `gone` closes anything, and only because a measurement said so. Everything
 * else is annotation: `changed` asks the user, `unknown` says nothing at all.
 */
export async function applyVerdicts(store, verdicts) {
  const done = { obsolete: 0, asked: 0, untouched: 0 };
  for (const v of verdicts) {
    if (v.verdict === 'gone') {
      await store.update(v.id, { status: 'obsolete', verdict: v }, v.why);
      done.obsolete += 1;
    } else if (v.verdict === 'changed' || v.verdict === 'element-gone') {
      await store.update(
        v.id,
        { status: 'needs_confirmation', verdict: v, ...(v.fingerprint ? { fingerprint: v.fingerprint } : {}) },
        v.why,
      );
      done.asked += 1;
    } else {
      if (v.fingerprint) await store.update(v.id, { fingerprint: v.fingerprint });
      done.untouched += 1;
    }
  }
  return done;
}
