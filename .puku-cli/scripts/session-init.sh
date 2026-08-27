#!/usr/bin/env bash
# SessionStart — fires once when a new puku-cli session begins.
#
# The first thing the agent sees is whatever this hook injects. We use the
# opportunity to tell it:
#   1. ayna is installed in this project, with the absolute bin path it should
#      use for every subsequent command.
#   2. The shape of the review (open window, pending comments, latest
#      screenshot) so it knows where to look before the user says anything.
#   3. The current task queue, so work-in-flight from a previous session is
#      not stranded.
#
# Exit codes per the puku-cli hook contract:
#   0   — normal flow, anything on stdout is JSON the agent will see
#   2   — block session start (we don't; the user is allowed in regardless)

set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=_lib.sh
source "$SCRIPT_DIR/_lib.sh"

BIN="$(ayna_bin)"
SESSION_ID="$(field '.session_id // "unknown"')"
ROOT="$(project_root)"

# Build a short, scannable status block. We assemble it as a here-doc so the
# exact wording stays one place to read; the JSON envelope wraps it for the
# hook framework.
#
# `node "$BIN" ...` invocations run from $ROOT, the user's project — never
# from the plugin checkout — because ayna writes screenshots, tasks, and the
# database into `.ayna/` of the project the user is actually in.
STATUS="$(
  {
    echo "ayna is available at: \`$BIN\`"
    echo ""
    echo "Use it directly. Run \`$BIN --help\` for the full command list."
    echo "Common entry points: \`$BIN shot --json\`, \`$BIN annotate --events\`, \`$BIN comments --json\`."
    echo ""
    # Project-local status — what review window is open and what tasks are
    # owed. Best-effort: ayna might not be configured yet, or jq might fail;
    # in either case we still want the session to start.
    if command -v jq >/dev/null 2>&1; then
      PHASE="$(cd "$ROOT" && node "$BIN" status --json 2>/dev/null | jq -r '.phase // "none"' 2>/dev/null || echo none)"
      echo "Open review phase: $PHASE"
      PENDING="$(cd "$ROOT" && node "$BIN" tasks --json 2>/dev/null | jq -r '[.tasks[] | select(.status == "open")] | length' 2>/dev/null || echo 0)"
      echo "Pending tasks: $PENDING"
    fi
  }
)"

# JSON envelope per the puku-cli spec. `systemMessage` shows once on the
# transcript; `hookSpecificOutput.additionalContext` is the modern, structured
# way to inject context that survives compaction.
jq -n \
  --arg system "ayna session start (puku-cli session $SESSION_ID)" \
  --arg ctx "$STATUS" \
  '{
    systemMessage: $system,
    hookSpecificOutput: {
      hookEventName: "SessionStart",
      additionalContext: $ctx
    }
  }'
