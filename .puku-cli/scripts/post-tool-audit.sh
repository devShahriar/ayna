#!/usr/bin/env bash
# PostToolUse — fires after any tool succeeds.
#
# ayna's review loop has a single handshake: when the agent finishes an edit,
# the user's review window needs to know, so it reloads and the user can
# approve or send back. Without this hook the agent forgets the handshake and
# the window sits on a spinner over changes already on disk.
#
# We watch for tool calls that touch ayna's target.root and inject a reminder
# to run `ayna applied` — once, after the round of edits, not after every
# keystroke. We deliberately only fire when:
#   - the tool was a file edit / write / bash sed-rewrite inside target.root, AND
#   - there's an open review window (otherwise the reminder is noise).
#
# We do NOT fire on every Bash call: the user runs `ayna shot`, `ayna
# annotate`, etc. through this tool, and saying "tell ayna you edited" after
# every ayna command is a contradiction.

set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=_lib.sh
source "$SCRIPT_DIR/_lib.sh"

ROOT="$(project_root)"
BIN="$(ayna_bin)"
TOOL="$(field '.tool_name // ""')"

# Resolve the target.root the same way pre-tool-gate does. Same fall-through:
# no config, no gate.
TARGET_ROOT=""
if [[ -f "$ROOT/ayna.config.json" ]] && command -v jq >/dev/null 2>&1; then
  TARGET_ROOT="$(jq -r '.target.root // ""' "$ROOT/ayna.config.json" 2>/dev/null || true)"
fi
[[ -z "$TARGET_ROOT" ]] && exit 0
ABS_TARGET="$(cd "$ROOT" && cd "$TARGET_ROOT" 2>/dev/null && pwd || true)"
[[ -z "$ABS_TARGET" ]] && exit 0

# Did the tool call touch the target? For FileEdit/FileWrite the path is in
# tool_input.file_path; for Bash it's anywhere in tool_input.command.
TOUCHED=0
case "$TOOL" in
  FileEdit|FileWrite)
    FILE="$(field '.tool_input.file_path // ""')"
    if [[ "$FILE" == "$ABS_TARGET"* ]]; then TOUCHED=1; fi
    ;;
  Bash)
    CMD="$(field '.tool_input.command // ""')"
    if [[ "$CMD" == *"$ABS_TARGET"* ]]; then TOUCHED=1; fi
    ;;
esac
[[ "$TOUCHED" -eq 0 ]] && exit 0

# Is there an open review window waiting for the agent's reply? Skip the
# reminder entirely if not — there's no spinner to clear and no one to hear
# the "applied" command but ourselves.
PHASE="$(cd "$ROOT" && node "$BIN" status --json 2>/dev/null | jq -r '.phase // "none"' 2>/dev/null || echo none)"
if [[ "$PHASE" != "awaiting-agent" && "$PHASE" != "awaiting-puku" && "$PHASE" != "awaiting-claude" ]]; then
  exit 0
fi

jq -n '{
  hookSpecificOutput: {
    hookEventName: "PostToolUse",
    additionalContext: "ayna: you just edited \`target.root\`. The open review window is still showing \"waiting\". Run `ayna applied` so it reloads and the user can approve or send back."
  }
}'