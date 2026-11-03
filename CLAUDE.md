# ayna

A plugin for coding agents that lets you *see* the UI you built. Playwright
drives real Chrome, screenshots the running page, and you critique and fix from
the image. Claude Code, puku-cli and codex all load the same skill.

## The one rule

**Never critique a UI from its source.** Reading CSS tells you what was intended;
the screenshot tells you what the user gets. If you have not Read the PNG, you have
not seen the page. Everything here exists to serve that.

## Two execution paths — don't confuse them

| | in-session | standalone |
|---|---|---|
| brain | the session already running | spawned agent subprocesses (`claude -p`, `codex exec`) |
| commands | `shot --json`, `snapshot`, `restore`, `record`, `report` | `loop`, `critique` |
| cost | near-free (context is already warm) | ~$1.50–3.30 per iteration |
| code | `SKILL.md` drives it | `src/loop.mjs` drives it |

When working interactively, use the in-session path. `src/loop.mjs` is for
unattended/CI runs only.

## Layout

```
SKILL.md            the in-session loop — the plugin's real behavior
commands/           /ayna, /ayna:look, /ayna:review
bin/ayna.mjs        CLI
src/browser.mjs     Chrome control, screenshots, page diagnostics
src/loop.mjs        standalone orchestration (spawns its own agent sessions)
src/brain.mjs       headless agent wrapper — standalone path only
src/brains.mjs      which agent CLIs ayna can drive
src/snapshot.mjs    backup / restore / changed-file detection
src/report.mjs      HTML report
src/server.mjs      static server for the target
demo/               a deliberately mediocre landing page to improve
```

## Hard-won invariants — do not regress these

- **A transport failure is not a UI regression.** `ERR_CONNECTION_REFUSED` means the
  server died, not that the edit broke the page. Reverting on it destroys good work.
  See `transportError` in `src/browser.mjs` and the `stillUnreachable` branch in
  `src/loop.mjs`.
- **Always keep the `after` capture**, even when reverting. Nulling it throws away
  the only evidence that tells a real regression from a false alarm.
- **One failed iteration must not kill the run.** The per-iteration `try/catch` in
  `src/loop.mjs` exists so the report still gets written.
- **Screenshots go in the user's project**, not the plugin dir — `PROJECT` in
  `bin/ayna.mjs`, never `ROOT`.
- **Headless by default.** This runs inside someone's session; a Chrome window
  stealing focus is worse than not watching. `--headed` opts in.
- **Read a tool's own surface before driving it.** Codex is not Claude with a
  different flag: it is `codex exec`, its stdout is a JSONL event stream rather
  than one JSON envelope, its reply is the `agent_message` item inside that
  stream, and its schema is a *file* (`--output-schema`) rather than an inline
  argument. Guessing any of those produces a failed turn, not a warning.

## Conventions

- Plain ESM `.mjs`, no TypeScript, no build step.
- Only dependency is `playwright-core` — it drives the browser already on the
  machine rather than downloading one. Keep it that way.
- **Playwright has no `brave` channel.** Its `channel` option is a fixed list
  (chrome, msedge, chromium, …), so Brave, Vivaldi and Arc are reached through
  `executablePath` instead. `src/browser-paths.mjs` holds the install paths and
  `resolveBrowser()` in `src/browser.mjs` picks the right shape. A name that is
  not a browser must error, never fall back silently to Chrome.
- The demo is the project's fixture, not a showcase. It is polished because the
  README screenshots are taken from it, but it must keep *real, measurable*
  faults for `audit` and `qa` to find — currently small hit targets, weak focus
  rings and one sub-12px label. Fix a fault only when it is genuinely a fault;
  never pre-polish it to the point where ayna has nothing to report.
