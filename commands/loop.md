---
description: Screenshot the running UI and improve it from what's actually on screen
argument-hint: "[url or path] [iterations]"
---

Run the ayna look → critique → fix → verify loop on: **$ARGUMENTS**

If no target was given above, work out what to shoot: check `ayna.config.json`, then
for a dev server already running, then the project's start script. Ask only if you
genuinely cannot tell what to point at.

Follow the `ayna` skill. The essentials:

1. `node "${CLAUDE_PLUGIN_ROOT:-${PUKU_CLI_PLUGIN_ROOT:-$HOME/.claude/skills/ayna}}/bin/ayna.mjs" shot --json` — start the dev server first if it isn't up.
2. **Read every screenshot path it prints.** Critique what you see, not what the source implies.
3. `... snapshot --root <ui-dir>`, then fix the issues worst-first. Visual pass only — keep the copy.
4. Re-shoot, Read again, and check your own work skeptically. `... restore --root <ui-dir>` if it got worse.
5. Repeat until it's good or the user stops you. Report the score each round.

Default to 2 iterations unless a number was given. Show the user the before/after
screenshots and say plainly what changed and what still needs work.
