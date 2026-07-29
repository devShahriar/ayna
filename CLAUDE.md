# ayna

A Claude Code plugin that lets you *see* the UI you built. Playwright drives real
Chrome, screenshots the running page, and you critique and fix from the image.

## The one rule

**Never critique a UI from its source.** Reading CSS tells you what was intended;
the screenshot tells you what the user gets. If you have not Read the PNG, you have
not seen the page. Everything here exists to serve that.

## Two execution paths — don't confuse them

| | in-session | standalone |
|---|---|---|
| brain | the Claude session already running | spawned `claude -p` subprocesses |
| commands | `shot --json`, `snapshot`, `restore`, `record`, `report` | `loop`, `critique` |
| cost | near-free (context is already warm) | ~$1.50–3.30 per iteration |
| code | `SKILL.md` drives it | `src/loop.mjs` drives it |

When working interactively, use the in-session path. `src/loop.mjs` is for
unattended/CI runs only.

## Layout

```
SKILL.md            the in-session loop — the plugin's real behavior
commands/           /ayna, /ayna-look, /ayna-review
bin/ayna.mjs        CLI
src/browser.mjs     Chrome control, screenshots, page diagnostics
src/loop.mjs        standalone orchestration (spawns its own Claude sessions)
src/brain.mjs       `claude -p` wrapper — standalone path only
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

## Conventions

- Plain ESM `.mjs`, no TypeScript, no build step.
- Only dependency is `playwright-core` — it uses installed Chrome (`channel: 'chrome'`)
  rather than downloading a browser. Keep it that way.
- The demo is *supposed* to start ugly. Don't pre-polish it.
