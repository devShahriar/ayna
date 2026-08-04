---
name: ayna
description: Look at a UI and improve it from what is actually on screen. Use when the user asks you to evaluate, audit, self-improve, self-review, or fix a UI yourself — "self improve the UI", "find and fix the UI issues", "check my UI for problems" — as well as via /ayna, /ayna:look, /ayna:review, or /ayna:fix — follow the procedure here when one of those runs. Also applies if the user directly asks to screenshot, see, review, critique, or improve how a page LOOKS. Do not start this on your own after editing UI files; the user decides when to look.
---

# ayna — look at what you built

Reading CSS tells you what you *intended*. A screenshot tells you what the user
*gets*. This skill closes that gap: it renders the live page in real Chrome, hands
you the image, and loops until the page actually looks right.

**You are the brain.** Do not shell out to `claude -p` — you are already running.
Read the screenshots with your own Read tool and edit with your own Edit tool. Your
context carries across iterations, which is what makes this cheap.

Set `AYNA=node "${CLAUDE_PLUGIN_ROOT:-$HOME/.claude/skills/ayna}/bin/ayna.mjs"` mentally for the commands below.

## The loop

### 1. Shoot

```bash
node "${CLAUDE_PLUGIN_ROOT:-$HOME/.claude/skills/ayna}/bin/ayna.mjs" shot --json --url <url>
```

Omit `--url` to use `ayna.config.json`. It prints JSON: screenshot paths per
route and viewport, plus diagnostics a screenshot can't show — console errors,
horizontal overflow, sub-12px text, blank renders.

**A site is more than its landing page.** Add `--routes /,/pricing,/settings` (or
set `target.routes` in the config) and every one gets captured. If the user asks
about "the app" rather than one screen, shoot the routes that matter — each shot
carries the `route` it came from.

**You usually do not need to start anything.** If `ayna.config.json` has
`target.url: null`, ayna serves `target.root` itself — just run the command. Start
a dev server only when the config points at one (`target.url`) and it is not up, or
when the user names a URL that is not responding. Never start a second server of
your own alongside ayna's.

**Open the page the work is actually about — not the site root.**

- If the user gave a URL, use it **verbatim**, including path, query and hash:
  `--url http://localhost:3031/d/d-835f8b1a49a73b39`. A deep link is the target.
- If they didn't, work it out from what you just changed: a route file, a
  component's usage, the router config. Editing `routes/dashboard/[id]` and then
  screenshotting `/` tells you nothing about your change.
- If the page needs state to reach (a specific record, a logged-in view), ask for
  the URL rather than guessing an id.
- `--routes /a,/b` captures several pages in one go.

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
node "${CLAUDE_PLUGIN_ROOT:-$HOME/.claude/skills/ayna}/bin/ayna.mjs" snapshot --root <ui-dir>
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
node "${CLAUDE_PLUGIN_ROOT:-$HOME/.claude/skills/ayna}/bin/ayna.mjs" restore --root <ui-dir>
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
node "${CLAUDE_PLUGIN_ROOT:-$HOME/.claude/skills/ayna}/bin/ayna.mjs" annotate
```

**Run it as an event stream, and let it notify you:**

```bash
node "${CLAUDE_PLUGIN_ROOT:-$HOME/.claude/skills/ayna}/bin/ayna.mjs" annotate --events --url <the page>
```

Run this under a **monitor** (a background process whose stdout lines become
notifications). It prints one JSON line every time the user does something:

```json
{"event":"round","round":1,"comments":2,"action":"read-comments"}
{"event":"applied","round":1,"via":"marker"}
{"event":"rejected","comment":"…","action":"retry-rejected"}
{"event":"closed","approved":true}
```

`applied` means the window has stopped waiting on you and the user is now judging
the result. `via` says what ended the wait: `marker` if you ran `applied`,
`file-change` if it saw your edits land, `user` if they pressed **Changes are in**
because it could not.

**This is the whole mechanism.** One process, push-based. There is nothing to
re-arm and nothing to poll, so a round cannot go unnoticed because you forgot a
step — which is exactly how comments used to sit unread while the page said
"Sent".

**If the app needs a login, they do it themselves in that window.** A page with a
password field opens in browse mode so the form works, and the profile persists
between reviews so it is usually a one-off. **Never type credentials for them and
never ask for them** — nothing they type is captured.

The overlay has three modes, cycled with one button: **comment** (click to
annotate), **move** (drag to reorder), **browse** (the app behaves normally).

**Browse mode means they can reach any page themselves** — clicking through the
app's own UI, following links, or typing a URL. Client-side routing works too.

Each comment records the `url` it was made on, and `sourceCandidates` are ranked
toward that route. **If their notes span several pages, check `comment.url` before
deciding which file to edit.**

## On each `round` event

1. `node "${CLAUDE_PLUGIN_ROOT:-$HOME/.claude/skills/ayna}/bin/ayna.mjs" comments --json`
2. Act on every comment whose `status` is `open` or `rejected`. **Never touch a
   `resolved` one.**
3. `node "${CLAUDE_PLUGIN_ROOT:-$HOME/.claude/skills/ayna}/bin/ayna.mjs" applied` — reloads their page in place
   so each change is highlighted where it happened, with **Looks right** /
   **Needs work** on it. **Say this the moment you have finished editing.** The
   window is showing them "waiting for Claude" until you do, and a spinner over
   work that is already done reads as a hang.
4. Go back to waiting for the next event. The window stays open; only the user
   closes it. **Never kill the annotate process to "finish" a review.**

The window also watches the project and moves on by itself once your edits stop
arriving, and the user can press **Changes are in** — so forgetting step 3 no
longer strands them. Run it anyway: it is immediate, and it is the only one of
the three that knows the edits are finished rather than merely paused.

The overlay's **Tasks** button lists everything still owed across the project,
grouped by the page it was raised on, with the current page first. The user can
jump to a task on another route or judge it from the list — so work raised
somewhere they are not standing is not invisible.

`ayna status` reports the tally: `open`, `resolved`, `rejected`. Resolved comments
stay in the manifest as the record of what changed — the user can click any green
marker to re-read it. **Close** ends a review without judging anything; whatever
they did not approve stays pending.

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

### Canvas-rendered UIs

In a diagram editor, chart or map, everything drawn is **one `<canvas>`** — the
shapes inside are pixels, not elements. So `selector` will be something useless
like `canvas.excalidraw__canvas`, `elements[]` holds only the canvas, and
`sourceCandidates` will not point at the thing the user means.

**The crop is the whole message there.** Read `regionScreenshot`, work out which
component renders what it shows, and search the drawing code for it. Say which
component you think it is before editing, so the user can correct you cheaply.

**Read `regionScreenshot` for every comment before editing.** The crop is the point
— it's the difference between "the button looks off" and seeing the exact button.
If an attachment is present, that's the look they're asking for; match it.

Then fix each comment in order, re-shoot, and show them the result. Address every
comment or say explicitly which you skipped and why.

## Reporting

To produce the side-by-side HTML report:

```bash
node "${CLAUDE_PLUGIN_ROOT:-$HOME/.claude/skills/ayna}/bin/ayna.mjs" record --score 6.5 --note "fixed FAQ alignment"
node "${CLAUDE_PLUGIN_ROOT:-$HOME/.claude/skills/ayna}/bin/ayna.mjs" report --open
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
node "${CLAUDE_PLUGIN_ROOT:-$HOME/.claude/skills/ayna}/bin/ayna.mjs" loop -n 3 --open
```

This costs several dollars per iteration. **In an interactive session, use the loop
above instead** — same result, a fraction of the cost, because your context is
already warm.

## Reviewing a flow, not a page

When the user describes a journey — "log in, open a diagram, add a node" — turn it
into steps and run it:

```bash
node "${CLAUDE_PLUGIN_ROOT:-$HOME/.claude/skills/ayna}/bin/ayna.mjs" flow --flow steps.json --json
```

Steps: `goto`, `click`, `type`, `press`, `hover`, `scroll`, `wait`, `expect`.
Mark a step `"optional": true` if failing it should not stop the run. A flow reuses
the saved profile, so anything behind a login starts signed in.

**Read every step image in order.** The filmstrip is the review; the numbers tell
you where to look:

| signal | what it means |
|---|---|
| `settleMs` high | the step looked done long before it was usable |
| `layoutShift` > 0.1 | content moved under the user's cursor |
| `focusLost` | focus fell to `<body>` — keyboard users are stranded |
| `smallTarget` | the thing they clicked is under 44px |
| `newConsoleErrors` | that action broke something |
| `tinyTextNodes`, `unlabelledControls` | per screen, not per site |

Judge it as a flow: does every action acknowledge itself, can they get back from
each step, is the primary action obvious at each point, what happens on the error
path, is the whole thing reachable from the keyboard. **Never put a real password
in a flow** — use the saved profile, and test the failure path with a wrong one.

## Automated QA

Flows kept in `ayna-flows/*.json` are a test suite. Run them all:

```bash
node "${CLAUDE_PLUGIN_ROOT:-$HOME/.claude/skills/ayna}/bin/ayna.mjs" qa --json
```

Each flow declares what must hold:

```json
"assert": {
  "noConsoleErrors": true,
  "maxSettleMs": 4000,
  "noLayoutFaults": ["covered", "offscreen"]
}
```

`noLayoutFaults` is the one that earns its keep: every flow ends with a layout
audit where it left the app, so a journey whose steps all pass but which now hides
a control behind a panel **fails**. That is how UI actually rots.

Exits non-zero when anything fails, so it works as a CI gate, and compares against
`.ayna/qa/baseline.json` to report what *changed* — broke, fixed, slower, or new
layout faults — rather than only what is.

When the user asks for a flow to be tested, write it into `ayna-flows/` so it
becomes a permanent check rather than a one-off run.

## Work that outlives the window

```bash
node "${CLAUDE_PLUGIN_ROOT:-$HOME/.claude/skills/ayna}/bin/ayna.mjs" watch
```

Run this under a monitor **at the start of any session touching a project with
ayna in it**. It watches the task store rather than a window, so a task raised in
a session that has since ended is still announced to this one. Its first line says
what is already owed:

```json
{"event":"ready","pending":2,"tasks":[…]}
{"event":"task","id":"task-0004","status":"open","action":"act-on-it"}
{"event":"task","id":"task-0002","status":"rejected","action":"try-again"}
```

**Claim a task before working on it** so the user can see which one you are on —
their marker turns blue and reads "Claude is on this":

```bash
node "${CLAUDE_PLUGIN_ROOT:-$HOME/.claude/skills/ayna}/bin/ayna.mjs" task task-0004 --status in_progress
```

Leave the verdict to them. Move a task to `approved` only when they say so.

## Auditing what they are looking at

If a review window is open, `audit` measures **inside it** — the same window, in
whatever state they have clicked into:

```bash
node "${CLAUDE_PLUGIN_ROOT:-$HOME/.claude/skills/ayna}/bin/ayna.mjs" audit --json
```

This matters more than it sounds. Two Chromes cannot share a profile, so the
alternative was closing their review to run an audit — and then measuring a
freshly loaded page rather than the one they were on. A fault that only appears
after they open a panel, switch to a live view or expand a node is invisible to a
page at rest.

So: **ask them to get the app into the state they care about, then audit.** When no
window is open, it opens its own and `--flow steps.json` can walk it into a state
first.

## Self-improvement, end to end

When the user asks you to evaluate or improve a UI yourself — "self improve",
"find and fix the UI issues", `/ayna:fix` — run this whole loop without being
prompted through it:

1. **Audit.** In their open window if there is one, so you measure the state they
   are actually in. Ask which state matters if it is not obvious; a page at rest
   hides the worst faults.
2. **Group by root cause.** Seventeen covered controls in one toolbar is one
   stacking rule. Propose causes, not symptoms — a list of thirty findings makes
   the user do the triage you were supposed to do.
3. **Propose, never edit.** `ayna propose` with the fix written out. Worst first.
4. **Wait for their answer** — go ahead, leave it, or their own instruction.
5. **On a go-ahead:** claim it `in_progress`, `snapshot` first, make the change,
   then **audit again and show the count went to zero.** Never report a fix you
   have not re-measured.
6. **Repeat** until clean, then say what is left that needs their judgement rather
   than a measurement.

**Do not propose taste as though it were a fault.** "This control cannot be
clicked" is measured; "this looks cramped" is an opinion. Keep them apart and say
which is which — the whole value of the audit is that its findings are not
arguable.

## When the app wants a login

An audit that lands on a sign-in screen reports `blocked: "authentication"` and
measures nothing. Do not try to get past it yourself:

```bash
node "${CLAUDE_PLUGIN_ROOT:-$HOME/.claude/skills/ayna}/bin/ayna.mjs" login --url <page>
```

That opens the app and waits for the user to sign in. Tell them it is open and
what it needs. It exits when the sign-in screen is gone, the session is saved in
the profile, and everything afterwards starts from there — so it is asked once,
not at the start of every review.

**Never type credentials, and never ask for them.** Not into the app, not into a
flow file, not "just for this run". The window is how a person signs in; that is
the whole arrangement.

## The part ayna cannot measure

Layout faults are provable and `audit` chases them to zero. Whether a page looks
like every other page a model has produced is not provable, and ayna will not
tell you. [Impeccable](https://github.com/pbakaus/impeccable) detects exactly
that — the icon-tile feature card, the hairline border with the wide shadow, the
font every generator picks — with no model and no API key:

```bash
node "${CLAUDE_PLUGIN_ROOT:-$HOME/.claude/skills/ayna}/bin/ayna.mjs" taste --url <page> --propose
```

It is optional. Not installed means the check is skipped and said so, never an
error. `--propose` files each rule as a **proposal**, so nothing is edited until
the user answers it.

**Its findings never make an audit unclean.** `clean` means "nothing the page can
prove is wrong", which is what gives a fixing loop a condition under which it is
finished. Taste has no such condition. Report the two separately and never let one
stand in for the other.

## Fixing things you found yourself

When you find a fault the user did not ask about — from `audit`, or just from
looking — **do not edit their app.** Put it to them first:

```bash
node "${CLAUDE_PLUGIN_ROOT:-$HOME/.claude/skills/ayna}/bin/ayna.mjs" propose \
  --comment "The Run button is cut off at 390px" \
  --fix "let .shot-query wrap so the button drops to its own line" \
  --selector ".shot-query" --url "<page>"
```

It appears in their review window as a dashed purple marker reading **"Claude
suggests"**, alongside their own comments, with the fix you are proposing written
out. They answer it there:

| they choose | you get | what it means |
|---|---|---|
| **Go ahead** | `action: "go-ahead"`, status `open` | now you may make the change |
| **Leave it** | status `approved`, nothing to do | dropped |
| **types something instead** | `action: "do-this-instead"`, their words replace yours | do that, not what you suggested |

Approving a proposal authorises the work — it does not finish it. Make the change,
run `applied`, and let them judge the result like any other task.

**The rule: their comments are instructions, your findings are suggestions.** Never
edit their project off your own judgement without a yes.
