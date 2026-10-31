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
| `~/.claude/skills/` | `~/.puku-cli/skills/` |
| `.claude-plugin/` | `.puku-plugin/` (it falls back to `.claude-plugin/`) |
| `CLAUDE_PLUGIN_ROOT` | `PUKU_CLI_PLUGIN_ROOT` |
| `CLAUDE_CODE_SESSION_ID` | `PUKU_CLI_SESSION_ID` (when supplied; see below) |
| `claude -p` | `puku-cli -p` |

`npm run setup` links `SKILL.md` into `~/.puku-cli/skills/ayna` for puku-cli and
`~/.puku/skills/ayna` for the Puku editor. The `commands/` files are a plugin:
puku-cli gets `/ayna:look`, `/ayna:review`, `/ayna:fix`, `/ayna:design` and
`/ayna:qa` by loading the checkout for a session —
`puku-cli --plugin-dir <checkout>` — and every command resolves its plugin root
as `${CLAUDE_PLUGIN_ROOT:-${PUKU_CLI_PLUGIN_ROOT:-…}}`. The plain `/ayna` skill
does not need the plugin.

puku-cli marks every command it spawns with `PUKU_CLI=1`, and ayna uses that
marker plus the process tree, so your commands share one window instead of
opening a new one each time. This also covers npm installs, where the process is
called `node` and only its command line names `puku-cli`. When
`PUKU_CLI_SESSION_ID` is exported (some builds and hook setups do), it is
preferred. `ayna agents` shows what it decided.

Headless runs use the same binary: `ayna work --brain puku` and
`ayna loop --brain puku` drive `puku-cli -p`. The model is passed through —
puku understands `puku-ai-*` as well as the `opus`, `sonnet` and `haiku`
family aliases.

## A mistake worth not repeating

`puku` and `puku-cli` are different programs. `puku` is a 23-line wrapper that
opens the editor; `puku-cli` is the headless agent, with `-p`, `--output-format
json` and `--permission-mode`. ayna judged the tool by the first binary on the
PATH and recorded that puku had no headless mode — wrong, and wrong in a way that
would have quietly excluded it from `ayna work`. `cursor` and `cursor-agent` are
the same trap. `detect` in `src/brains.mjs` names the binary that does the work,
never the one that shares the product's name.
