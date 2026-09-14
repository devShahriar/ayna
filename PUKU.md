# ayna

Everything in `CLAUDE.md` applies here — that file is the project's working notes
and it is not Claude-specific. Read it first.

This file exists because puku-cli reads `PUKU.md` for project memory, not
`CLAUDE.md`. It is a pointer, not a second copy: two files drifting apart is worse
than one file in the wrong place.

## What is different under puku-cli

puku-cli is Claude Code shaped, with the names one prefix over. Where the docs say
one, read the other:

| Claude Code | puku-cli |
|---|---|
| `CLAUDE.md` | `PUKU.md` |
| `.claude/` | `.puku-cli/` |
| `.claude-plugin/` | `.puku-plugin/` (it falls back to `.claude-plugin/`) |
| `CLAUDE_PLUGIN_ROOT` | `PUKU_CLI_PLUGIN_ROOT` |
| `CLAUDE_CODE_SESSION_ID` | `PUKU_CLI_SESSION_ID` |
| `claude -p` | `puku-cli -p` |

`SKILL.md` and `commands/` are read by both, and every command in them resolves
the plugin root as `${CLAUDE_PLUGIN_ROOT:-${PUKU_CLI_PLUGIN_ROOT:-…}}`, so one
copy works in either.

ayna identifies a puku session from `PUKU_CLI_SESSION_ID`, so your commands share
one window instead of opening a new one each time. `ayna agents` shows what it
decided.

## A mistake worth not repeating

`puku` and `puku-cli` are different programs. `puku` is a 23-line wrapper that
opens the editor; `puku-cli` is the headless agent, with `-p`, `--output-format
json` and `--permission-mode`. ayna judged the tool by the first binary on the
PATH and recorded that puku had no headless mode — wrong, and wrong in a way that
would have quietly excluded it from `ayna work`. `cursor` and `cursor-agent` are
the same trap. `detect` in `src/brains.mjs` names the binary that does the work,
never the one that shares the product's name.
