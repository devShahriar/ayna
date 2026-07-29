---
description: Screenshot the UI and tell me what's wrong — change nothing
argument-hint: "[url]"
---

Screenshot and critique, **without editing anything**: **$ARGUMENTS**

1. Work out what to shoot: the URL I gave, else `ayna.config.json`, else a dev
   server already running. Start the dev server if it isn't up.
2. `node ${CLAUDE_PLUGIN_ROOT}/bin/ayna.mjs shot --json`
3. **Read every screenshot path it printed.** Critique what you see, not what the
   source implies.
4. Give me a 0–10 score and the issues worst-first — typography, spacing, color,
   hierarchy, layout, responsive, detail. Each one concrete and visual: *"the hero
   headline is the same weight as the body copy, so nothing anchors the page"*, not
   *"improve typography"*.

Do **not** edit any files. This is a read-only look. If I want the fixes applied,
I'll run `/ayna`.
