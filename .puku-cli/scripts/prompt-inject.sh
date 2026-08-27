#!/usr/bin/env bash
# UserPromptSubmit — fires each time the user submits a message.
#
# The agent already has its own context, but the things ayna knows live in
# `.ayna/` of the user's project and not in puku-cli's view. We attach:
#   - The current review phase, so the agent knows whether the window is
#     waiting for an edit (handle the user's "Sent" press) or just standing by.
#   - The pending task list, so work owed from a previous session is announced
#     the moment the user opens the chat, not after a manual `tasks` call.
#   - The most recent comments (when a review window is open), so the agent
#     picks them up without having to re-read the comments file.
#
# We deliberately don't Read screenshots here — puku-cli's prompt-injection
# fires on every keystroke and pulling 1MB of PNGs through stdin every time
# the user types is the kind of latency that makes hooks feel like malware.
# When the agent needs pixels, it calls `ayna shot --json` itself.

set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=_lib.sh
source "$SCRIPT_DIR/_lib.sh"

BIN="$(ayna_bin)"
ROOT="$(project_root)"
PROMPT="$(field '.user_prompt // ""')"

# Fast path: if the user isn't working on a UI right now and there's no open
# review, we don't need to enrich their prompt — let it go through untouched.
# Checking `tasks --json` is cheap and avoids a shell-out on every keystroke
# for sessions that don't need us.
if ! command -v jq >/dev/null 2>&1; then
  exit 0
fi

PHASE="$(cd "$ROOT" && node "$BIN" status --json 2>/dev/null | jq -r '.phase // "none"' 2>/dev/null || echo none)"
PENDING_COUNT="$(cd "$ROOT" && node "$BIN" tasks --json 2>/dev/null | jq -r '[.tasks[] | select(.status == "open")] | length' 2>/dev/null || echo 0)"

# Nothing to add: don't pad the prompt with "no review open, 0 tasks". The
# hook contract says empty additionalContext is fine.
if [[ "$PHASE" == "none" && "$PENDING_COUNT" -eq 0 ]]; then
  exit 0
fi

CTX="$(
  cd "$ROOT"
  {
    echo "ayna — open review phase: $PHASE"
    echo ""
    if [[ "$PENDING_COUNT" -gt 0 ]]; then
      echo "Tasks owed in this project: $PENDING_COUNT"
      echo ""
      # First five, scannable. The full list is one `ayna tasks --json` away.
      node "$BIN" tasks --json 2>/dev/null | jq -r '
        .tasks
        | map(select(.status == "open"))
        | .[0:5]
        | .[]
        | "  - \(.id)  \(.comment // "" | .[0:80])"
      ' 2>/dev/null || true
      echo ""
      echo "Read the full payload with \`$BIN tasks --json\`; start work with \`$BIN task <id> --status in_progress\`."
    fi
    # When a round is owed, the next action is the agent's: read comments,
    # edit, run `applied`. Spell that out so the agent doesn't have to guess
    # whether to act or wait.
    if [[ "$PHASE" == "awaiting-agent" || "$PHASE" == "awaiting-puku" || "$PHASE" == "awaiting-claude" ]]; then
      echo ""
      echo "Round owed: read with \`$BIN comments --json\`, edit the source, then run \`$BIN applied\`."
    fi
  }
)"

jq -n --arg ctx "$CTX" '{
  hookSpecificOutput: {
    hookEventName: "UserPromptSubmit",
    additionalContext: $ctx
  }
}'
