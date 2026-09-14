# ayna — for any coding agent

**Never critique a UI from its source.** Reading CSS tells you what was intended;
the screenshot tells you what the user gets. If you have not read the PNG, you
have not seen the page.

This file is the editor-agnostic version of `SKILL.md`. Claude Code loads the
skill; Codex, Cursor, Gemini CLI, aider, Puku, Antigravity and anything else that
reads `AGENTS.md` can work from this. Everything here is a shell command and a
file path — there is nothing Claude-specific about any of it.

## Setup

```bash
ayna init                 # writes ayna.config.json, pointing at your app
ayna brains               # which agent CLIs on this machine can do work
ayna agents               # who is currently working in this project
```

If ayna is not on your PATH, run it as `node /path/to/ayna/bin/ayna.mjs`.

## Tell ayna who you are

ayna tracks one session and one browser tab per agent, so your commands share a
window instead of opening a new one each time, and two agents working in the same
project never take each other's tab.

It recognises Claude Code automatically (`CLAUDE_CODE_SESSION_ID`). For anything
else, export two variables once per session:

```bash
export AYNA_AGENT=codex              # or cursor, puku, antigravity, whatever you are
export AYNA_SESSION="$(uuidgen)"     # stable for this conversation
```

Without them ayna falls back to your process tree, which usually still gets it
right. `ayna agents` shows what it decided and why.

## Look at the page

```bash
ayna shot --json                      # screenshots + console errors + overflow
ayna shot --json --routes /,/pricing  # a site is more than its landing page
```

**Then open every `file` it printed.** That is the step that matters.

```bash
ayna audit            # layout faults the page can prove: covered, cut off, overlapping
ayna inspect --selector ".toolbar"    # one region, headless, with its measurements
```

`audit` and `inspect` report only what is measurable, so a clean result means
"nothing provably broken", not "looks good". The looking is still yours.

## Let the user point

```bash
ayna annotate            # opens the page; they click, comment, attach images
ayna comments --json     # what they marked, with a crop of each element
```

Read `regionScreenshot` for every comment before you edit anything.

## Show a change before you write it

```bash
ayna preview --selector ".hero h1" \
  --css "font-size: 34px" --label "bolder" \
  --css "font-size: 44px" --label "much bigger"
```

Variants render in their browser; your source is untouched until they pick one.
The command blocks until they answer, then tells you which to write.

## QA: turn a written test case into a flow

A flow is JSON that drives the UI and asserts on it. You do not have to guess the
schema or the selectors:

```bash
ayna flow --schema                    # the step vocabulary
ayna flow --draft "a signed-out visitor can reach pricing"
```

`--draft` opens the page and returns the schema plus every actionable element on
it, with a stable selector for each and a flag on the ones that are ambiguous or
fragile. Write the flow from that — no guessing — then:

```bash
ayna flow --check ayna-flows/pricing.json    # validates without a browser
ayna flow --flow  ayna-flows/pricing.json    # runs it, screenshotting each step
ayna qa                                      # every flow in ayna-flows/, exit 1 on failure
```

Rules that keep a suite from rotting:

- Every flow needs at least one `expect`, or it cannot fail.
- Prefer `{"do":"wait","for":"<selector>"}` over `{"ms": 3000}`. A timing guess is
  how a suite becomes flaky.
- Assert absence where it matters — `{"do":"expect","absent":"undefined"}`. A
  panel reading "No data" is still a panel.
- Use the selectors `--draft` gave you. A `fragile` one is a class guess.

## Working alongside other agents

```bash
ayna tasks                  # everything outstanding here
ayna verify                 # ask each open task whether it still applies
ayna work --once            # take a task and do it
ayna events --since 0       # everything that happened, whoever was watching
```

Tasks are claimed with an expiring lease, so two agents cannot do the same one,
and a crashed agent's work returns to the pool by itself. `ayna verify` closes
tasks whose fault no longer reproduces — including ones the user fixed by hand.

`ayna events` reads a durable log. A session that starts an hour late still gets
the whole story; when a reply says `"more": true`, call again from its `cursor`.

## The rules

- Never report an issue fixed without looking at the new screenshot.
- A transport failure is not a UI regression. `ERR_CONNECTION_REFUSED` means the
  server died — restart it and re-shoot. Do not revert your edits.
- If the page barely changed, say so, rather than narrating improvements that are
  not visible.
- Do not start any of this on your own after editing UI files. The user decides
  when to look.
