#!/usr/bin/env bash
# Stop — fires when the agent finishes a turn (or hits StopFailure).
#
# The review window's "console" pane is the one place the user is always
# looking. Anything we want them to know — "I edited your nav, run `ayna
# applied`" or "the page is fine, you can approve" — should land there the
# moment the agent's turn ends, not buried in the transcript they'd have to
# scroll back through.
#
# ayna already has a `say` subcommand that writes a message into the event log
# the review window subscribes to. This hook calls it at the natural moment
# to give the user a single one-line summary.
#
# We always try to write. An absent review window or a closed session is
# silent — `ayna say` swallows the lack of listeners. The hook itself never
# fails; failures are noise on a hook we don't control.

set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=_lib.sh
source "$SCRIPT_DIR/_lib.sh"

ROOT="$(project_root)"
BIN="$(ayna_bin)"
REASON="$(field '.stop_reason // "end of turn"')"

# Don't shout when the agent's turn ended because of an error. StopFailure
# fires separately for that; this hook is for clean stops.
HOOK_NAME="$(field '.hook_event_name // ""')"
if [[ "$HOOK_NAME" == "StopFailure" ]]; then
  exit 0
fi

# Best-effort message. If there's no review window listening, `ayna say`
# no-ops quietly — no error to surface, no UI to update.
cd "$ROOT"
node "$BIN" say "turn finished — ${REASON}" >/dev/null 2>&1 || true

exit 0
