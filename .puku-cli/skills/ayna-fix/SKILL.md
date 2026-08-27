---
name: ayna-fix
description: Find what's broken in my UI, propose fixes, and verify each one after I approve
argument-hint: "[url]"
---

Evaluate this UI and improve it: **$ARGUMENTS**

Work out the target from what I gave you, `ayna.config.json`, or a dev server
already running. Start it if it isn't up.

**Never edit my project before I say yes.** Everything you find is a suggestion
until I answer it.

## The loop

0. **Check what is already owed.** `ayna verify` asks each open task whether it
   still applies and closes what somebody has since fixed. Proposing a problem I
   solved last week is how a list stops being read.

1. **Look.** If a review window is already open, `ayna audit` measures *that*
   window in its current state. Otherwise open one, or use `--flow` to reach the
   state worth measuring. Ask me if you're unsure which state matters — a page at
   rest often hides the worst of it.

2. **Group by root cause.** Seventeen covered controls in one toolbar is usually
   one stacking rule, not seventeen bugs. Report the causes, not the symptoms —
   4–6 real problems beats 30 findings I have to triage myself.

3. **Propose each one** with `ayna propose --comment "…" --fix "…" --selector "…"`,
   worst first. Say what's broken *and* what you'd do about it, so I'm judging
   something I can read.

4. **Wait.** I'll answer in the window: **Go ahead**, **Leave it**, or I'll type
   what I'd rather. If I redirect you, do what I said, not what you suggested.

5. **On a go-ahead:** claim it (`ayna task <id> --status in_progress`) so I can see
   which one you're on, snapshot the directory, make the change, then **check the
   thing you changed**:

   ```bash
   ayna inspect --selector "<the element>" --json
   ```

   Read the crop it returns and show me the count went to zero *in that region* —
   not "I fixed it", and not the whole page's total, which can improve for
   reasons that have nothing to do with you. If a review window is open, `ayna
   applied` puts the change in front of me and the `gate` event says what still
   reproduces.

6. **Repeat** until the audit is clean or the rest is subjective.

## What you cannot judge

Whether it matches a mockup, whether the hierarchy reads right, whether it looks
good. Those are mine. Don't propose taste as though it were a fault — if something
only *looks* off to you, say so as an observation, separately from the measured list.

Anything drawn inside a `<canvas>` has no DOM to measure. Say so rather than
guessing — and if I need to point at something in there, open a window and let me
draw round it.

`ayna taste` will tell you whether a page carries the tells of a generated one.
Those are opinions and never make an audit unclean; offer them separately, if at
all.

## When you're done

Tell me: what was found, what's fixed and verified, what I declined, and what's
left that needs my eye rather than a measurement.