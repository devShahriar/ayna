---
description: Open the UI so I can click parts and comment, then fix exactly what I marked
argument-hint: "[url]"
---

Open the annotation overlay so I can point at what I mean: **$ARGUMENTS**

**The window is mine. Don't close it — only my approval does that.**

1. Start the dev server if it isn't up, then run this **under a monitor**, so its
   output lines notify you:
   `node "${CLAUDE_PLUGIN_ROOT:-$HOME/.claude/skills/ayna}/bin/ayna.mjs" annotate --events --url <the page>`
   Open the page the work is about — if I gave a URL use it verbatim, path and
   all; otherwise infer it from what you're changing. Don't default to the site
   root. It stays open for the whole review.

2. Every time I send, you get a `{"event":"round"}` line. Read my comments:
   `node "${CLAUDE_PLUGIN_ROOT:-$HOME/.claude/skills/ayna}/bin/ayna.mjs" comments --json`
   Don't poll, and don't wait to be told to check again — the stream tells you.

3. For **every** comment: Read its `regionScreenshot` to see the exact element I
   clicked, Read any `attachments` for the look I'm asking for, then open the file
   from `sourceCandidates` and make the change.

4. Run `node "${CLAUDE_PLUGIN_ROOT:-$HOME/.claude/skills/ayna}/bin/ayna.mjs" applied`. My window reloads in
   place so I can see the result, with **Approve & close** / **Comment more**.

5. If I click **Comment more**, a new round arrives — go back to step 2. If I
   approve, the background command exits on its own.

Work through my comments in order. If you can't do one, say so plainly rather than
quietly skipping it. Don't fix things I didn't mention.
