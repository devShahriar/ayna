#!/usr/bin/env bash
# Helpers shared by every ayna hook script.
#
# The hook scripts run under `puku-cli`, from any working directory. They cannot
# assume their own path is known or that `ayna` is on PATH. The same scripts
# must work whether invoked from a project-level `.puku-cli/settings.json`
# (committed to the repo) or from a user-level `~/.puku-cli/settings.json`
# written by `npm run setup`.
#
# Resolution order for the ayna bin:
#   1. $AYNA_BIN — absolute path to the `ayna` entrypoint, set by `npm run setup`
#      in the user-level settings.json so a single checkout serves every project.
#   2. AYNA_PLUGIN_ROOT — absolute path to the ayna checkout, used to resolve
#      `<root>/bin/ayna.mjs` for project-level (committed) configs.
#   3. Walking up from this script's own location, looking for `package.json`
#      with `name: ayna` — the fallback for an out-of-the-box clone.
#
# Everything else in the hook layer uses these helpers rather than re-inventing
# the lookup, so a future change (renaming the binary, nesting the scripts)
# happens in exactly one place.

set -euo pipefail

# Always read the full stdin. puku-cli writes the whole payload; doing this
# once per script means every hook sees consistent input handling.
read_stdin() {
  cat
}

# Resolve the absolute path to ayna's `node` entrypoint. Prints to stdout;
# callers should capture with $(ayna_bin).
#
# We deliberately resolve once at script start and cache in AYNA_BIN_RESOLVED
# so a hook that calls ayna multiple times (e.g. once for tasks, once for
# comments) doesn't re-walk the filesystem on every call.
ayna_bin() {
  if [[ -n "${AYNA_BIN:-}" ]]; then
    printf '%s' "$AYNA_BIN"
    return
  fi
  if [[ -n "${AYNA_PLUGIN_ROOT:-}" ]]; then
    printf '%s' "$AYNA_PLUGIN_ROOT/bin/ayna.mjs"
    return
  fi

  local src="${BASH_SOURCE[0]}"
  local dir
  dir="$(cd "$(dirname "$src")" && pwd)"
  while [[ "$dir" != "/" ]]; do
    if [[ -f "$dir/package.json" ]] && grep -q '"name":[[:space:]]*"ayna"' "$dir/package.json" 2>/dev/null; then
      printf '%s' "$dir/bin/ayna.mjs"
      return
    fi
    dir="$(dirname "$dir")"
  done

  echo "ayna hook: cannot locate ayna bin. Set AYNA_BIN in your puku-cli settings.json." >&2
  exit 2
}

# Extract a JSON field from stdin with a default. Centralising `jq` here keeps
# the individual hook scripts readable.
#
# Usage: field '.tool_name // "unknown"'
field() {
  local expr="$1"
  read_stdin | jq -r "$expr" 2>/dev/null || true
}

# Whether a shell command looks like it's touching the UI target directory.
# Used by the pre-tool gate: puku-cli's bash tool can `rm` or move files
# inside `target.root` without ayna's blessing, which would invalidate the
# snapshot. A non-zero result means ayna should block it.
#
# This is intentionally coarse: anything that mentions a `target.root`-style
# path is flagged. The user can `--force` via the prompt when they mean it.
is_destructive_against_target() {
  local cmd="$1"
  local target_root="$2"
  [[ -z "$target_root" ]] && return 1
  # rm/mv/cp/>, redirects, etc. targeting a path inside target.root.
  if echo "$cmd" | grep -qE "(rm|mv|cp)[[:space:]].*${target_root}"; then
    return 0
  fi
  return 1
}

# The directory the agent is currently working in. puku-cli may have changed
# cwd since the hook started (CwdChanged fires separately), so we trust the env
# var puku-cli sets and fall back to $PWD only if missing.
project_root() {
  printf '%s' "${PROJECT_DIR:-$PWD}"
}
