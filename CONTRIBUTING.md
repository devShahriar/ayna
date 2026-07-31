# Contributing to ayna

Thanks for taking a look. Issues and PRs are welcome.

## Getting set up

```bash
git clone https://github.com/devshahriar/ayna.git
cd ayna
npm install
npm test
```

You need Node 20+ and Google Chrome. Ayna drives your installed Chrome through
`playwright-core`; it deliberately does **not** download a browser.

Try it against the bundled demo:

```bash
node bin/ayna.mjs shot --json     # screenshot it
node bin/ayna.mjs annotate        # click-and-comment overlay
```

## Tests

```bash
npm test                     # everything
AYNA_SKIP_BROWSER=1 npm test # unit tests only, no Chrome needed
```

`test/unit.test.mjs` is fast and pure. `test/integration.test.mjs` drives a real
Chrome — it is slower, and it is where the bugs actually get caught, so please keep
it passing.

**A new behavior needs a test.** Several genuine bugs in this repo were found by a
test disagreeing with an assumption, including a port-selection bug that made the
server report a URL nothing was listening on. That class of bug is invisible
without tests.

## Project shape

```
SKILL.md            the in-session loop — what Claude actually follows
commands/           slash commands (/ayna, /ayna-look, /ayna-review)
bin/ayna.mjs        CLI
src/annotate.mjs    click-to-comment capture, crops, source mapping
src/overlay.js      the in-page UI — runs in the browser, not in Node
src/browser.mjs     Chrome control, screenshots, page diagnostics
src/loop.mjs        standalone orchestration (spawns its own Claude sessions)
src/server.mjs      static server for the target
src/snapshot.mjs    backup / restore / changed-file detection
src/report.mjs      HTML report
demo/               a deliberately mediocre landing page to improve
```

`src/overlay.js` is injected into the page under review. It runs in the browser, so
no Node APIs, and keep it dependency-free.

## Regenerating the README demo

```bash
npm run demo:gif      # needs ffmpeg on PATH
```

It drives the real overlay against a throwaway copy of `demo/` and makes a genuine
CSS edit partway through, so the reload in the recording shows something that
actually happened. Don't hand-assemble a staged one.

## Conventions

- Plain ESM `.mjs`, no TypeScript, no build step.
- One runtime dependency (`playwright-core`). Please don't add more without a
  strong reason — the zero-install-friction story is a feature.
- Comments explain *why*, not *what*. If a line looks odd but is deliberate, say so.

## Invariants — please don't regress these

Each of these is a bug that already happened once:

- **A transport failure is not a UI regression.** `ERR_CONNECTION_REFUSED` means the
  server died, not that an edit broke the page. Reverting on it destroys good work.
  See `transportError` in `src/browser.mjs`.
- **Keep the `after` capture even when reverting.** It is the only evidence that
  distinguishes a real regression from a false alarm.
- **One failed iteration must not kill the run.** The report still has to be written.
- **Never resolve a port from a variable a failed `listen` closed over.** Read it
  from `server.address()`. See the comment in `src/server.mjs`.
- **The annotate window belongs to the user.** Only their approval closes it. Don't
  close the browser or kill the process to "finish" a review.
- **Artifacts go in the user's project**, not the plugin directory.
- **The review window follows the OS window; captures do not.** `annotate` is headed
  with `viewport: null` so resizing it re-renders the page. `shot`, `audit` and
  `flow` keep a fixed viewport, because a screenshot has to be the same size every
  time to be worth comparing.
- **Every command in SKILL.md must be runnable as written.** `${CLAUDE_PLUGIN_ROOT}`
  is not expanded in a skill body, so a bare reference to it sends the reader
  hunting for where ayna lives instead of doing the work.
- **Don't add config that isn't enforced.** `editGlobs` used to sit in the default
  config looking like a sandbox while nothing read it. A setting that implies a
  guarantee it doesn't provide is worse than no setting.
- **No unconditional shell-outs.** `grep` and `open` don't exist everywhere;
  see `scanInJs` and `openInDesktop` for the fallbacks.

## Reporting bugs

Visual bugs are much easier to fix with evidence. Please include:

- what you ran, and the output of `node bin/ayna.mjs shot --json`
- the screenshot it produced
- your `ayna.config.json` if you have one
- OS, Node version, Chrome version
