import { summarize } from './browser.mjs';

export const CRITIQUE_SCHEMA = {
  type: 'object',
  properties: {
    score: { type: 'number', description: 'Overall visual quality, 0-10.' },
    verdict: { type: 'string', description: 'One sentence on how the UI reads right now.' },
    issues: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          severity: { type: 'string', enum: ['critical', 'major', 'minor'] },
          area: { type: 'string', description: 'e.g. typography, spacing, color, hierarchy, responsive' },
          problem: { type: 'string', description: 'What is wrong, stated visually.' },
          fix: { type: 'string', description: 'The concrete change to make.' },
        },
        required: ['id', 'severity', 'area', 'problem', 'fix'],
      },
    },
  },
  required: ['score', 'verdict', 'issues'],
};

export const VERIFY_SCHEMA = {
  type: 'object',
  properties: {
    improved: { type: 'boolean', description: 'Is the after-state visually better than the before-state?' },
    regressions: { type: 'array', items: { type: 'string' } },
    notes: { type: 'string' },
  },
  required: ['improved', 'regressions', 'notes'],
};

const RUBRIC = `Judge it the way a senior product designer would, on what the screenshots actually show:
- Typography: is there a real typeface and type scale, or browser defaults? Line-height, measure, weight contrast.
- Spacing: is there a consistent rhythm, or arbitrary margins? Does anything crowd or float?
- Color: is there a system (surface / text / accent) with adequate contrast, or unrelated hues?
- Hierarchy: does the eye land on the right thing first? Do sections read as sections?
- Layout: alignment, max-width for readability, sensible use of the viewport.
- Responsive: does the mobile shot hold up, or is it the desktop layout squeezed?
- Detail: interactive affordances, borders, radii, shadows — consistent or ad hoc?`;

export function critiquePrompt({ cfg, capture, iteration }) {
  return `You are the design critic in an automated UI improvement loop (iteration ${iteration}).

The UI under review lives in \`${cfg.target.root}/\` and is served at ${capture.url}.

GOAL FOR THIS UI:
${cfg.goal}

I have rendered the live page in Chrome and screenshotted it. Read these images with the Read tool — they are the actual current state, and your critique must be grounded in what you see in them, not in what the source code suggests:
${capture.shots.map((s) => `- ${s.viewport} (${s.width}x${s.height}): ${s.file}`).join('\n')}

Measured diagnostics from the live page:
${summarize(capture) || '- none'}

Also read the source files under \`${cfg.target.root}/\` so your fixes are specific to the real markup and styles.

${RUBRIC}

Return the ranked issues, worst first. Be specific and visual — "the hero headline is the same weight and size as the body copy, so nothing anchors the page" beats "improve typography". Cap it at the 6 issues that would most change how the page reads. Score honestly: 10 means you would ship it as a flagship marketing page.`;
}

export function improvePrompt({ cfg, capture, critique, iteration }) {
  const issues = critique.issues
    .map((i, n) => `${n + 1}. [${i.severity}] (${i.area}) ${i.problem}\n   Fix: ${i.fix}`)
    .join('\n');

  return `You are the implementer in an automated UI improvement loop (iteration ${iteration}).

A design critic just reviewed the live page and scored it ${critique.score}/10: "${critique.verdict}"

ISSUES TO FIX, worst first:
${issues}

Current screenshots of the live page — read them first so you are editing what you can see:
${capture.shots.map((s) => `- ${s.viewport}: ${s.file}`).join('\n')}

GOAL FOR THIS UI:
${cfg.goal}

RULES:
- Edit ONLY files under \`${cfg.target.root}/\`. Touch nothing else in this repo — the tool that runs you lives here too.
- Keep the page's content and meaning. This is a visual pass, not a rewrite of the copy.
- No new dependencies, no build step, no external asset URLs. The page is served as static files and must render offline. Inline any SVG you need; use system font stacks or CSS-only typographic treatments.
- Prefer editing CSS over restructuring HTML, but change the markup where the structure is genuinely the problem.
- Work through the issues in order and actually apply the edits with Edit/Write.

When you are done, reply with a short plain-text list of the changes you made — one line per change.`;
}

export function verifyPrompt({ before, after, critique }) {
  return `You are the verifier in an automated UI improvement loop.

An implementer just tried to fix these issues:
${critique.issues.map((i) => `- [${i.severity}] ${i.problem}`).join('\n')}

Compare the page before and after, using the Read tool on both sets of screenshots:

BEFORE:
${before.shots.map((s) => `- ${s.viewport}: ${s.file}`).join('\n')}

AFTER:
${after.shots.map((s) => `- ${s.viewport}: ${s.file}`).join('\n')}

Diagnostics after the edits:
${summarize(after) || '- none'}

Did the page actually get better? List any regression you can see — content that disappeared, layout that broke, contrast that got worse, mobile that degraded. Be skeptical: if the after-shot is not clearly better, say so.`;
}
