#!/usr/bin/env bash
# PreToolUse — fires before any tool executes; can block.
#
# We don't try to police every tool call — that is the agent's job. We only
# intercept the one foot-gun ayna introduces: edits to the user's project that
# would invalidate ayna's snapshot or skip the `ayna applied` handshake.
#
# The pattern we look for:
#   - Bash: `rm`, `mv`, `cp`, or `>` redirects targeting a path inside
#     `target.root`. ayna's snapshot lives in `.ayna/session/snapshot` and a
#     direct shell delete/restore of `target.root` would silently lose the
#     round.
#
# We do NOT block the equivalent ayna commands (`ayna restore`, `ayna
# snapshot`) — those are the contract, and ayna itself gates them.
#
# Exit codes per the puku-cli hook contract:
#   0              — proceed, JSON stdout is shown to the agent only if it has a
#                    hookSpecificOutput envelope.
#   2              — block. Stderr is shown to the user. We also emit a JSON
#                    "continue": false so the agent sees the reason too.

set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=_lib.sh
source "$SCRIPT_DIR/_lib.sh"

TOOL="$(field '.tool_name // ""')"
ROOT="$(project_root)"

# Only the Bash tool has the destructive patterns we care about. File edit
# tools go through puku-cli's own permission system; we don't double-guard.
if [[ "$TOOL" != "Bash" ]]; then
  exit 0
fi

CMD="$(field '.tool_input.command // ""')"
[[ -z "$CMD" ]] && exit 0

# Locate the target.root from ayna.config.json. Empty when there's no config —
# in which case there's nothing for us to gate, so pass through. We read the
# config directly rather than shelling into `ayna config` because ayna has no
# `config` subcommand and the file is well-known.
TARGET_ROOT=""
if [[ -f "$ROOT/ayna.config.json" ]] && command -v jq >/dev/null 2>&1; then
  TARGET_ROOT="$(jq -r '.target.root // ""' "$ROOT/ayna.config.json" 2>/dev/null || true)"
fi
[[ -z "$TARGET_ROOT" ]] && exit 0

# Resolve to an absolute path. A `target.root: "demo"` is relative to the
# project; we want to compare against the resolved form.
ABS_TARGET="$(cd "$ROOT" && cd "$TARGET_ROOT" 2>/dev/null && pwd || true)"
[[ -z "$ABS_TARGET" ]] && exit 0

# Let the agent use ayna itself. `ayna restore` is the explicit undo path —
# we don't want to be the third gate on a command the user already approved.
# The heuristic: if the command mentions the literal ayna bin path resolved by
# _lib.sh, the agent is going through ayna; let it through. Anything else
# touching target.root is the foot-gun we exist to block.
if [[ -n "$BIN" ]] && echo "$CMD" | grep -qF "$BIN"; then
  exit 0
fi
# Bare `ayna` on PATH also counts. setup.mjs symlinks it to ~/.local/bin.
if echo "$CMD" | grep -qE "(^|[[:space:]])ayna([[:space:]]|$)"; then
  exit 0
fi

# Coarse pattern: anything in the destructive set whose argument is inside
# target.root. Path traversal (../) is folded by grepping for the literal
# resolved prefix.
if echo "$CMD" | grep -qE "\b(rm|mv|cp)\b.*${ABS_TARGET}" || \
   echo "$CMD" | grep -qE ">[[:space:]]+${ABS_TARGET}"; then
  cat <<EOF
{"continue": false, "stopReason": "ayna: this command touches \`${ABS_TARGET}\`, the directory ayna snapshots. Use \`ayna restore\` (the explicit undo) instead of bypassing it."}
EOF
  exit 2
fi

exit 0
