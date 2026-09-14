---
description: Turn a written test case into a runnable flow, then run it
argument-hint: "<the test case, in plain words>"
---

Write an ayna flow that proves: **$ARGUMENTS**

**Do not write the JSON from memory of the page.** Almost every broken generated
flow is a guessed selector. Read the page first.

1. **Get the vocabulary and the page in one go:**

   ```bash
   node "${CLAUDE_PLUGIN_ROOT:-$HOME/.claude/skills/ayna}/bin/ayna.mjs" flow --draft "$ARGUMENTS"
   ```

   It returns the step schema plus every actionable element on the page with a
   stable selector, its visible text, and flags. Obey the flags: `ambiguous: N`
   means that selector matches N elements and needs an `nth`; `fragile: true`
   means it is a class guess that a refactor will break — prefer an id or a
   `data-testid` if the element has one.

   If the test case is about a state behind a click, add `--selector <sel>` to
   get there before the page is read.

2. **Write it** to `ayna-flows/<short-name>.json`. Name it the way I said it —
   *"A signed-out visitor can reach pricing"* — because that name is what a
   failing CI run shows me.

   - At least one `expect`, or the test cannot fail and proves nothing.
   - `{"do":"wait","for":"<selector>"}`, never a bare `ms` — a timing guess is
     how a suite becomes flaky.
   - Assert absence where it matters: `{"do":"expect","absent":"undefined"}`. A
     panel rendering "No data" or "NaN" is still a panel, and a presence-only
     check passes it.
   - Keep `"assert": {"noLayoutFaults": ["covered","offscreen"]}` — that is what
     catches a journey whose steps all pass while a control slid under a panel.

3. **Check it before running it** — this needs no browser and fails in
   milliseconds with the reason:

   ```bash
   node "${CLAUDE_PLUGIN_ROOT:-$HOME/.claude/skills/ayna}/bin/ayna.mjs" flow --check ayna-flows/<name>.json
   ```

4. **Run it**, then read the step screenshots before telling me it passed:

   ```bash
   node "${CLAUDE_PLUGIN_ROOT:-$HOME/.claude/skills/ayna}/bin/ayna.mjs" flow --flow ayna-flows/<name>.json
   ```

5. Tell me what it proves and what it does not. If a step passed for a reason
   other than the one intended — an `expect` matching text that was already on
   the page before the click — say so; that is a test that will never fail.
