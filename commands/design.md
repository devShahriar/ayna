---
description: Review the design — fix what the page proves, offer the rest
argument-hint: "[url]"
---

Review the design of: **$ARGUMENTS**

```bash
node "${CLAUDE_PLUGIN_ROOT:-${PUKU_CLI_PLUGIN_ROOT:-$HOME/.claude/skills/ayna}}/bin/ayna.mjs" design --json
```

That returns one brief with two lists, and **the difference between them is the
whole point**:

| | what it is | what you do |
|---|---|---|
| `fix` | the page **proved** it — a control behind something, text cut off, 3.1:1 where 4.5:1 is needed | act on it |
| `propose` | a detector has an **opinion** about how it looks | offer it, never apply it |

Each entry carries `title` (what is wrong), `detail` (where, on screen),
`selector`, `fix` (what to do instead) and `sites` (`file:line` when the scan saw
source).

## Act on `fix`

1. **Read the screenshots the brief lists.** A fault you have not looked at is a
   fault you are guessing at.
2. Work worst-first — they arrive sorted, critical before minor.
3. Re-run `ayna design` when you are done. **An issue is fixed when the
   measurement says so**, not when the edit looks right to you.

## Offer `propose`

These are judgements about taste, and that judgement is mine, not yours. Do not
quietly restyle my page because a detector dislikes it.

Show me the change instead of describing it:

```bash
node "${CLAUDE_PLUGIN_ROOT:-${PUKU_CLI_PLUGIN_ROOT:-$HOME/.claude/skills/ayna}}/bin/ayna.mjs" preview \
  --selector ".feature .icon-tile" \
  --css "display:flex; align-items:center; gap:12px" --label "icon beside the heading" \
  --css "background:none; padding:0"                 --label "icon in flow, no tile"
```

Variants render in my browser; **nothing is written to source until I pick one**.
The command blocks and tells you which I kept — write only that one.

If I would rather see them as a list, `ayna design --propose` files each as a
task with status `proposed`, and I accept one with
`ayna task <id> --status open`.

## Rules

- Keep the copy. A visual pass restyles text; it does not rewrite it.
- One `propose` at a time. Three simultaneous opinions is a redesign I did not ask for.
- If impeccable is not installed the brief says so — report that plainly rather
  than telling me the page has no design faults.
