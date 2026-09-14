/**
 * What a flow is, in a form something else can write.
 *
 * The step vocabulary was only ever documented by `src/flow.mjs` itself, so
 * writing a flow meant reading the switch statement — fine for whoever wrote it,
 * useless for a QA engineer describing a test in a sentence, and worse than
 * useless for an agent, which will confidently invent `{"do":"assert"}` and find
 * out at run time.
 *
 * Two things fix that and neither of them is a model:
 *
 *   1. A schema to write against, and a validator that runs without a browser,
 *      so a wrong flow fails in milliseconds with the reason instead of after a
 *      Chrome launch with "nothing matches .login-btn".
 *   2. The page's actual selectors. Almost every bad generated flow is a guessed
 *      selector, and guessing is only necessary because nobody looked. `probe`
 *      looks.
 *
 * ayna does not call an LLM to do the conversion. The editor's agent already has
 * the codebase open and is a far better author than anything ayna could spawn;
 * it just needs the target and the page's real names. That is the same division
 * of labour as the rest of the tool: ayna measures, the agent decides.
 */

export const STEPS = {
  goto: {
    summary: 'Navigate. Relative to the target, so "/pricing" not a full URL.',
    fields: { url: 'string, required' },
    example: { do: 'goto', url: '/pricing' },
  },
  click: {
    summary: 'Click the first match, or pick one with nth / nearest.',
    fields: {
      on: 'selector, required',
      nth: 'number — 0 is first, -1 is last, omit for first',
      nearest: '"center" — the match closest to the middle of the window',
      timeout: 'ms, default 10000',
    },
    example: { do: 'click', on: 'button.signup' },
  },
  type: {
    summary: 'Fill a field, or type at the keyboard when `on` is omitted.',
    fields: { on: 'selector, optional', text: 'string', nth: 'number, optional' },
    example: { do: 'type', on: '#email', text: 'qa@example.com' },
  },
  press: { summary: 'A single key.', fields: { key: 'string, e.g. Enter or Escape' }, example: { do: 'press', key: 'Enter' } },
  hover: { summary: 'Hover, for menus and tooltips.', fields: { on: 'selector', nth: 'number, optional' }, example: { do: 'hover', on: '.nav-item' } },
  scroll: {
    summary: 'Scroll to an element, or to "top" / "bottom".',
    fields: { to: 'selector | "top" | "bottom"' },
    example: { do: 'scroll', to: '#pricing' },
  },
  wait: {
    summary: 'Wait for something to appear, or for a fixed time. Prefer `for`.',
    fields: { for: 'selector, optional', ms: 'number, used only without `for`', timeout: 'ms' },
    example: { do: 'wait', for: '.results' },
  },
  expect: {
    summary:
      'The assertion. `text` or `selector` must be present; `absent` must not be. ' +
      'Absence matters as much as presence — a panel reading "No data" is still a panel.',
    fields: {
      text: 'string — visible text anywhere on the page',
      selector: 'selector that must exist',
      absent: 'string that must NOT be visible, e.g. "Unsupported" or "NaN"',
      settle: 'ms to wait before looking, default 400',
    },
    example: { do: 'expect', text: 'Welcome back' },
  },
};

export const ASSERTIONS = {
  noConsoleErrors: 'boolean — fail if the page logged an error',
  maxSettleMs: 'number — fail if a step took longer than this to settle',
  noLayoutFaults: 'array of "covered" | "offscreen" | "clipped" | "overlaps" — fail on these',
};

/** The whole shape, as one object an agent can be handed. */
export const FLOW_SCHEMA = {
  name: 'string, required — what this proves, in the words a person would use',
  start: 'string, optional — the route to begin on, default "/"',
  viewport: '{ width, height }, optional',
  assert: ASSERTIONS,
  steps: 'array of steps, required — see `steps`',
  stepTypes: STEPS,
  example: {
    name: 'A signed-out visitor can reach the pricing table',
    start: '/',
    assert: { noConsoleErrors: true, noLayoutFaults: ['covered', 'offscreen'] },
    steps: [
      { do: 'click', on: 'a[href="#pricing"]' },
      { do: 'wait', for: '.plan-featured' },
      { do: 'expect', text: 'Most popular' },
      { do: 'expect', absent: 'undefined' },
    ],
  },
};

const SELECTOR_FIELDS = { click: 'on', hover: 'on', wait: 'for', scroll: 'to', type: 'on' };

/**
 * Check a flow without opening anything.
 *
 * Errors are what would make the run meaningless; warnings are what would make
 * it flaky. The distinction earns its keep on `wait: {ms}` — legal, common, and
 * the single most reliable way to write a test that passes on your machine and
 * fails in CI.
 */
export function validateFlow(flow, { name = 'flow' } = {}) {
  const errors = [];
  const warnings = [];
  const at = (i, msg) => `steps[${i}]: ${msg}`;

  if (!flow || typeof flow !== 'object') return { ok: false, errors: [`${name} is not an object`], warnings };
  if (!flow.name) warnings.push('no `name` — reports will call it by its filename');
  if (flow.start && !String(flow.start).startsWith('/') && !/^https?:/.test(flow.start)) {
    errors.push('`start` should be a route like "/pricing", or a full URL');
  }
  if (!Array.isArray(flow.steps)) return { ok: false, errors: [...errors, '`steps` must be an array'], warnings };
  if (!flow.steps.length) errors.push('`steps` is empty — a flow with no steps proves nothing');

  let asserts = 0;
  flow.steps.forEach((step, i) => {
    if (!step || typeof step !== 'object') return void errors.push(at(i, 'not an object'));
    if (!step.do) return void errors.push(at(i, 'missing `do`'));
    if (!STEPS[step.do]) {
      const known = Object.keys(STEPS).join(', ');
      return void errors.push(at(i, `unknown step "${step.do}" — the vocabulary is: ${known}`));
    }

    if (step.do === 'expect') {
      asserts += 1;
      // `absentSelector` is the fourth spelling and the validator did not know
      // it, while src/flow.mjs has always run it (see the branch at
      // "if (step.absentSelector)"). MEASURED 14 Sep 2026: every committed flow
      // that waits for the agent to finish uses it —
      //
      //   { "do": "expect", "absentSelector": "[data-state='thinking']" }
      //
      // — so `ayna flow --flow ayna-flows/16-…json` rejected a flow that the
      // same binary runs happily under `ayna qa --dir`. A validator stricter
      // than the runtime turns working tests into unrunnable ones, which is the
      // failure mode that matters: it rejects what works.
      if (step.text == null && step.selector == null && step.absent == null &&
          step.missing == null && step.absentSelector == null) {
        errors.push(at(i, 'expect needs one of `text`, `selector`, `absent` or `absentSelector`'));
      }
    }
    if (step.do === 'goto' && !step.url) errors.push(at(i, 'goto needs a `url`'));
    if (step.do === 'press' && !step.key) errors.push(at(i, 'press needs a `key`'));

    /*
      `type` can type at the keyboard with no target, and `wait` can wait on a
      duration, so neither is required to carry a selector. Checking them here
      reported "wait needs `for`" about a step that was already valid.
    */
    const field = SELECTOR_FIELDS[step.do];
    if (field && !['type', 'wait'].includes(step.do) && step[field] == null) {
      errors.push(at(i, `${step.do} needs \`${field}\``));
    }
    if (step.do === 'wait' && step.for == null && step.ms == null) {
      errors.push(at(i, 'wait needs `for` (preferred) or `ms`'));
    }
    if (step.do === 'wait' && step.for == null && step.ms != null) {
      warnings.push(at(i, `waiting ${step.ms}ms is a guess — \`{"do":"wait","for":"<selector>"}\` is not`));
    }
    if (step.do === 'type' && step.text == null) warnings.push(at(i, 'type with no `text` types nothing'));
  });

  if (!asserts) {
    errors.push('no `expect` step — a flow that asserts nothing cannot fail, so it proves nothing');
  }

  const faults = flow.assert?.noLayoutFaults;
  if (faults && !Array.isArray(faults)) errors.push('`assert.noLayoutFaults` must be an array');
  if (Array.isArray(faults)) {
    const ok = ['covered', 'offscreen', 'clipped', 'overlaps', 'tinyText'];
    for (const f of faults) if (!ok.includes(f)) errors.push(`assert.noLayoutFaults: "${f}" is not one of ${ok.join(', ')}`);
  }

  return { ok: errors.length === 0, errors, warnings };
}

/**
 * What is on this page that a flow could act on.
 *
 * Runs in the page and returns each interactive element with a selector that
 * will still match tomorrow, preferring the ones authors control (id, data-test,
 * name, aria-label) over the ones a CSS refactor invalidates. Text is included
 * because a person describing a test says "click Sign up", not "click
 * button.cta.nav-cta:nth-of-type(2)".
 */
export const PROBE = () => {
  const cssEscape = (s) => (window.CSS && CSS.escape ? CSS.escape(s) : String(s).replace(/[^\w-]/g, '\\$&'));

  const selectorFor = (el) => {
    // Most stable first. A test hook, if the app has one, beats everything.
    for (const attr of ['data-testid', 'data-test-id', 'data-test', 'data-cy', 'data-qa']) {
      const v = el.getAttribute(attr);
      if (v) return `[${attr}="${v}"]`;
    }
    if (el.id) return `#${cssEscape(el.id)}`;
    const name = el.getAttribute('name');
    if (name && /^(input|select|textarea)$/i.test(el.tagName)) return `${el.tagName.toLowerCase()}[name="${name}"]`;
    const aria = el.getAttribute('aria-label');
    if (aria) return `${el.tagName.toLowerCase()}[aria-label="${aria}"]`;
    const href = el.getAttribute('href');
    if (href && el.tagName === 'A') return `a[href="${href}"]`;

    // Fall back to a class path, which is what breaks — flagged as `fragile`.
    const cls = [...el.classList].filter((c) => !/^(is-|has-|active|open|hover)/.test(c)).slice(0, 2);
    if (cls.length) return `${el.tagName.toLowerCase()}.${cls.map(cssEscape).join('.')}`;
    return el.tagName.toLowerCase();
  };

  const seen = new Map();
  const out = [];
  const nodes = document.querySelectorAll(
    'a[href], button, input, select, textarea, [role="button"], [role="link"], [role="tab"], [onclick], [data-testid]',
  );

  for (const el of nodes) {
    const r = el.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) continue; // not on screen; not actionable
    const style = getComputedStyle(el);
    if (style.visibility === 'hidden' || style.display === 'none') continue;

    const sel = selectorFor(el);
    const count = (seen.get(sel) ?? 0) + 1;
    seen.set(sel, count);

    out.push({
      selector: sel,
      // A selector matching several things needs an nth, and the author has to
      // know that before the flow silently acts on the wrong one.
      ambiguous: count > 1 ? count : undefined,
      fragile: /^[a-z]+\.[\w.-]+$/.test(sel) || sel === el.tagName.toLowerCase() || undefined,
      tag: el.tagName.toLowerCase(),
      role: el.getAttribute('role') ?? undefined,
      type: el.getAttribute('type') ?? undefined,
      text: (el.innerText || el.value || el.getAttribute('placeholder') || '').trim().slice(0, 60) || undefined,
      at: { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) },
    });
  }

  // Headings give an agent the page's structure, which is how a described test
  // ("on the pricing page…") maps onto a route.
  const headings = [...document.querySelectorAll('h1,h2,h3')]
    .map((h) => (h.innerText || '').trim())
    .filter(Boolean)
    .slice(0, 30);

  return { title: document.title, url: location.href, headings, elements: out.slice(0, 200) };
};

/** A compact brief: everything an agent needs to write a correct flow, no guessing. */
export function briefFor(probe, description) {
  return {
    task: 'Write an ayna flow (JSON) that proves the test case below.',
    testCase: description ?? null,
    rules: [
      'Use only the step types in `schema.stepTypes` — anything else fails validation.',
      'Prefer selectors from `page.elements`; they were read off the live page.',
      'A selector marked `fragile` is a class guess — use a data-testid or an id if one exists.',
      'A selector marked `ambiguous` matches more than once — add `nth`.',
      'Every flow needs at least one `expect`, or it cannot fail.',
      'Prefer {"do":"wait","for":"<selector>"} over a fixed {"ms":…} — a timing guess is how a suite becomes flaky.',
      'Assert absence too where it matters: "No data", "undefined", "NaN", "Unsupported".',
    ],
    schema: FLOW_SCHEMA,
    page: probe,
    then: 'Write it to ayna-flows/<name>.json, then run: ayna flow --check ayna-flows/<name>.json',
  };
}
