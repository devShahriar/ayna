# `.puku-cli/` — ayna integration for puku-cli

This directory wires ayna's "see the UI it builds" workflow into puku-cli through
both [skills](https://puku.sh/docs/puku-cli/skills) and
[hooks](https://puku.sh/docs/puku-cli/hooks). Skills are how the user invokes the
workflow (`/ayna-fix`, `/ayna-look`, …); hooks are how ayna keeps the session in
sync with the review window without being asked.

## What's here

```
.puku-cli/
├── settings.json        # hook manifest, committed to the repo
├── skills/              # one subdir per skill, SKILL.md inside
│   ├── SKILL.md          # /ayna        — main auto-invoked skill
│   ├── ayna-look/SKILL.md  # /ayna-look   — screenshot + critique, no edits
│   ├── ayna-loop/SKILL.md  # /ayna-loop   — shoot → critique → fix → verify
│   ├── ayna-review/SKILL.md # /ayna-review — click-and-comment overlay
│   └── ayna-fix/SKILL.md   # /ayna-fix    — audit, propose, apply, verify
└── scripts/             # hook scripts (one per hook event + a shared _lib)
    ├── session-init.sh    # SessionStart
    ├── prompt-inject.sh   # UserPromptSubmit
    ├── pre-tool-gate.sh   # PreToolUse (Bash)
    ├── post-tool-audit.sh # PostToolUse (FileEdit|FileWrite)
    ├── stop-announce.sh   # Stop
    └── _lib.sh            # shared helpers (path resolution, jq)
```

The slash command is taken from the `name:` field in each SKILL.md. After
`npm run setup`, puku-cli sees them as `/ayna`, `/ayna-look`, `/ayna-loop`,
`/ayna-review`, and `/ayna-fix` — five separate skills at the top level of the
user's `/skills` menu.

## Install

```bash
npm run setup -- --agent=puku
# or, for both agents:
npm run setup
```

`setup` does two things in `~/.puku-cli/`:

1. **Symlink the skills.** One symlink per skill directory under
   `~/.puku-cli/skills/`, each pointing at the matching source dir in this
   checkout. This makes `/ayna`, `/ayna-look`, `/ayna-loop`, `/ayna-review`,
   `/ayna-fix` appear in every puku-cli session on the machine.

2. **Merge the hooks into `~/.puku-cli/settings.json`.** Each ayna hook entry is
   tagged `_ayna: true` so `npm run uninstall` can remove only ours and never
   touch the user's other settings.

The committed `.puku-cli/settings.json` keeps `${AYNA_PLUGIN_ROOT}` as a
placeholder; `setup` rewrites it to the absolute checkout path so the project
file stays portable.

## Hook behaviour

| hook event | script | effect |
|---|---|---|
| `SessionStart`                    | `session-init.sh`    | injects ayna bin path, open review status, pending task count as `additionalContext` |
| `UserPromptSubmit`                | `prompt-inject.sh`   | attaches pending tasks + review phase to every user prompt |
| `PreToolUse` (matcher: `Bash`)    | `pre-tool-gate.sh`   | blocks `rm` / `mv` / `cp` against the resolved `target.root` (exit 2 + JSON reason) |
| `PostToolUse` (matcher: `FileEdit|FileWrite`) | `post-tool-audit.sh` | nudges the agent to run `ayna applied` after editing while a review is awaiting |
| `Stop`                            | `stop-announce.sh`   | writes a "turn finished" line into the review window's console |

## Path placeholders

The committed `settings.json` uses `${AYNA_PLUGIN_ROOT}`. Hook scripts resolve
the ayna bin in this order:

1. `$AYNA_BIN` — set by the user-level settings on install
2. `$AYNA_PLUGIN_ROOT` — set by setup.mjs at install time
3. Walking up from the script's own location looking for `package.json` with `name: "ayna"`

## Customising

- **Skills.** Edit any `.puku-cli/skills/<name>/SKILL.md` in this repo. The
  symlinks already point at the source, so changes are picked up on the next
  puku-cli start.
- **Hooks.** Edit `.puku-cli/settings.json` here. Locally-added entries are
  preserved across `npm run setup`; ayna re-merges its five events each time.
- **Disable a single hook.** Open `~/.puku-cli/settings.json`, find the entry
  with `_ayna: true`, and delete it. Nothing else needs to change.

## Removing

```bash
npm run uninstall -- --agent=puku
```

Removes only what ayna created: the five skill symlinks (`/ayna`, `/ayna-look`,
`/ayna-loop`, `/ayna-review`, `/ayna-fix`) and the hook entries tagged
`_ayna: true` in `~/.puku-cli/settings.json`. Anything else is left alone.