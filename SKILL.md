---
name: ayna
description: Look at a UI and improve it from what is actually on screen. Invoked by the user via /ayna, /ayna-look, or /ayna-review — follow the procedure here when one of those runs. Also applies if the user directly asks to screenshot, see, review, critique, or improve how a page LOOKS. Do not start this on your own after editing UI files; the user decides when to look.
---

# ayna — look at what you built

Reading CSS tells you what you *intended*. A screenshot tells you what the user
*gets*. This skill closes that gap: it renders the live page in real Chrome, hands
you the image, and loops until the page actually looks right.

**You are the brain.** Do not shell out to `claude -p` — you are already running.
Read the screenshots with your own Read tool and edit with your own Edit tool. Your
context carries across iterations, which is what makes this cheap.

Set `AYNA=node ${CLAUDE_PLUGIN_ROOT}/bin/ayna.mjs` mentally for the commands below.

## The loop

### 1. Shoot

```bash
node ${CLAUDE_PLUGIN_ROOT}/bin/ayna.mjs shot --json --url <url>
```

Omit `--url` to use `ayna.config.json`. It prints JSON: screenshot paths per
route and viewport, plus diagnostics a screenshot can't show — console errors,
horizontal overflow, sub-12px text, blank renders.

**A site is more than its landing page.** Add `--routes /,/pricing,/settings` (or
set `target.routes` in the config) and every one gets captured. If the user asks
about "the app" rather than one screen, shoot the routes that matter — each shot
carries the `route` it came from.

If the app isn't running, start its dev server first (background it), then shoot.

### 2. Look

**Read every screenshot it printed.** This is the step that matters — do not skip
it and critique from the source instead. If you did not Read the PNG, you have not
seen the page.

### 3. Critique

Judge what's on screen, worst first. Be visual and specific: *"the hero headline is
the same weight and size as the body copy, so nothing anchors the page"* beats
*"improve typography"*.

- **Typography** — a real typeface and type scale, or browser defaults? Line-height, measure, weight contrast. Steps in the scale big enough to see?
- **Spacing** — a consistent rhythm, or arbitrary one-off margins? Does anything crowd or float?
- **Color** — a system (surface / text / accent) with adequate contrast, or unrelated hues?
- **Hierarchy** — does the eye land on the right thing first? Do sections announce themselves?
- **Layout** — alignment, a shared left edge, max-width for readability.
- **Responsive** — does the mobile shot hold up, or is it desktop squeezed?
- **Detail** — radii, borders, shadows, hover/focus affordances: consistent or ad hoc?

Score it 0–10. 10 means you'd ship it as a flagship page.

### 4. Snapshot, then fix

```bash
node ${CLAUDE_PLUGIN_ROOT}/bin/ayna.mjs snapshot --root <ui-dir>
```

Then edit. Work the issues in order, top-down.

**Rules:**
- Visual pass only — **keep the copy**. Restyle text, don't rewrite it.
- No new dependencies, no build step, no external asset URLs unless the project already uses them.
- Prefer CSS over restructuring markup; change structure when structure is the problem.
- Don't "fix" responsive by deleting content — a nav that vanishes on mobile is a worse bug than one that wraps.
- Don't introduce sub-12px text.

### 5. Re-shoot and verify

Shoot again and **Read the new screenshots**. Then be skeptical about your own work:

- Did each issue actually get fixed, or just move?
- What regressed? Content gone, contrast worse, mobile degraded, new overflow?
- Is a change real or cosmetic? *Adding a font-family the page never loads changes nothing* — compare the glyphs.

If it's worse, roll back and try differently:

```bash
node ${CLAUDE_PLUGIN_ROOT}/bin/ayna.mjs restore --root <ui-dir>
```

### 6. Repeat or stop

Loop back to step 1. Stop when the score clears ~8.5, when remaining issues are
genuinely subjective, or when the user says so. Tell the user the score each round
so they can call it.

## When the user wants to point at things

If the user says *"let me show you"*, *"I'll mark it up"*, *"I want to comment on
specific parts"*, or their feedback is hard to pin down in words — hand them the
mouse instead of guessing:

```bash
node ${CLAUDE_PLUGIN_ROOT}/bin/ayna.mjs annotate
```

**Run it in the background** — it stays open for the whole review, not just until
they send. The window is theirs; you never close it.

The overlay has three modes, cycled with one button: **comment** (click to
annotate), **move** (drag to reorder), **browse** (links work normally). Browse
mode is how they review more than one page — each comment records the `url` it was
made on, and `sourceCandidates` are ranked toward that route. If their notes span
several pages, check `comment.url` before deciding which file to edit.

The round-trip:

1. **They comment and press "Send to Claude".** The bar switches to "Claude is
   making your changes" and the window stays open. Poll for it:
   ```bash
   node ${CLAUDE_PLUGIN_ROOT}/bin/ayna.mjs status      # phase: awaiting-claude
   node ${CLAUDE_PLUGIN_ROOT}/bin/ayna.mjs comments --json
   ```
2. **You make the edits.**
3. **Tell the window you're done:**
   ```bash
   node ${CLAUDE_PLUGIN_ROOT}/bin/ayna.mjs applied
   ```
   It reloads the page in place so they see the result immediately, and offers
   **Approve & close** / **Comment more**.
4. **They judge each comment in place.** Every commented portion is re-highlighted
   on the changed page with its own **Looks right** / **Needs work** buttons
   attached to it. Judged comments collapse to a badge that still opens the
   original text. **Approve all & close** resolves anything they left untouched.
5. **`ayna wait` wakes you again when anything is rejected.** Re-read
   `comments --json`, fix only the comments whose `status` is `rejected` or `open`
   — **never touch a `resolved` one** — then run `applied` again. Rejected comments
   return to `open` for re-judging.
6. **If they click "Comment more"**, phase goes back to `commenting` and a new
   round arrives — repeat from 1.
7. **If they approve**, the background command exits and the window closes. Only
   their approval closes it.

`ayna status` reports the tally: `open`, `resolved`, `rejected`. Resolved comments
stay in the manifest permanently as the record of what changed this session — the
user can click any green marker to re-read it.

Do **not** kill the annotate process to "finish" a review, and don't close the
browser yourself. Waiting is the correct behavior.

**A resumed conversation does not inherit the window.** The browser died with the
session that opened it, so `status` reports `phase: "stale"` and `wait` returns
immediately rather than blocking on a review nobody is in. When you see `stale`,
say so and start a fresh `annotate` — don't try to resume the old one. Previous
comments are still on disk (`comments --json`) if you need to read what was asked.

Each comment gives you:

| field | what it's for |
|---|---|
| `status` | `open` (act on it), `rejected` (your last attempt missed — try differently), `resolved` (**done — do not touch it again**) |
| `kind` | `comment` (one element), `region` (a box they dragged), or `move` (a reorder) |
| `region` | present for `kind: "region"` — the exact rect they framed. `regionScreenshot` is that area, and `elements[]` are the elements inside it. Treat the crop as the subject: the comment is about the whole area, not one node. |
| `comment` | what they want changed |
| `regionScreenshot` | **a crop of exactly what they selected** — Read it |
| `attachments` | reference images they pasted — Read these too |
| `selector` | the precise DOM path, e.g. `#hero > div.container > h1` |
| `elements[]` | **every element this comment covers.** Shift-click means one comment can target several — each entry has its own `selector`, `styles` and `sourceCandidates`. Apply the change to all of them. |
| `sourceCandidates` | `file:line` matches — start editing here |
| `styles` | computed styles, so you can see what you're overriding |
| `element.outerHTML` | the markup as it actually rendered |

### Reorder comments (`kind: "move"`)

The user can switch the overlay to **Move mode** and drag an element among its
siblings. That arrives as a comment with `kind: "move"` and a `move` object:

| field | meaning |
|---|---|
| `movedSelector` | what they dragged |
| `referenceSelector` + `placeBefore` | where they dropped it |
| `fromIndex` → `toIndex` | its position among siblings, before and after |
| `siblingOrder` | the **final** order they want, labelled by text — the clearest signal |

They have already reordered it in the browser, so the page in front of them is the
target state. Reproduce that order **in the source** by moving the corresponding
block — do not fake it with CSS `order` or absolute positioning unless the layout
genuinely calls for it. `siblingOrder` is the thing to match.

**Read `regionScreenshot` for every comment before editing.** The crop is the point
— it's the difference between "the button looks off" and seeing the exact button.
If an attachment is present, that's the look they're asking for; match it.

Then fix each comment in order, re-shoot, and show them the result. Address every
comment or say explicitly which you skipped and why.

## Reporting

To produce the side-by-side HTML report:

```bash
node ${CLAUDE_PLUGIN_ROOT}/bin/ayna.mjs record --score 6.5 --note "fixed FAQ alignment"
node ${CLAUDE_PLUGIN_ROOT}/bin/ayna.mjs report --open
```

## Judging honestly

The failure mode of this skill is grading your own homework. You wrote the fix, so
you want it to have worked. Guard against it:

- Never report an issue fixed without looking at the new screenshot.
- A transport failure is not a UI regression. If the shot shows *"This site can't be reached"*, the server died — restart it and re-shoot. Do not roll back the edits and do not critique the error page.
- If the page barely changed, say so plainly instead of narrating improvements that aren't visible.

## Unattended mode

For CI or long runs with no human in the loop, the standalone loop spawns its own
critic/implementer/verifier as separate Claude sessions:

```bash
node ${CLAUDE_PLUGIN_ROOT}/bin/ayna.mjs loop -n 3 --open
```

This costs several dollars per iteration. **In an interactive session, use the loop
above instead** — same result, a fraction of the cost, because your context is
already warm.
