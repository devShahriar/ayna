---
description: "How to work on n2's own web UI with the brain rather than by reading the repo — finding the component that renders a thing, seeing what an endpoint returns before you consume it, and checking what a change to a page touches. Load this when you are editing the Next.js app under web/, changing how an entity page renders, or wiring a new view onto an existing API."
---

# web-dev-workflow

Confidence: 50% (2 runs)


# Working on n2's web UI with the brain

Every step below was used on a real change (the source-attribution fix,
commit a505d04). Where the brain cannot answer, the step says so and says
what to use instead — do not pretend it answered.

## 0. Know which organisation you are reading

The brain answers from the tenant of your credential. An empty `get_entity`
page for code you know exists usually means "wrong organisation", not "no
data".

- `n2 whoami` / `n2 org-list` — who you are and which org you write into.
- `~/.n2/config` — each repo, its path and its org. The watcher for a repo
  logs `pushing as <email> (org <id>)` in
  `~/Library/Logs/n2-watch/sh.kormo.n2.watch.<repo>.log`.
- Only after both agree is an empty answer an empty answer.

## 1. Find the component — brain first

- `search_brain(query="<symbol or text visible on the page>")` →
  `function:tracewit/n2:web/<path>:<name>`
- `get_entity(id=…)` — the code is in `page.sections.body`.
- Files are `file:tracewit/n2:web/<path>` (repo `tracewit/n2`; there is no
  separate web repo).

## 2. Read the endpoint before consuming it

- `web/lib/api.js` is the single client. Every call goes through the server
  proxy `web/app/api/[...path]/route.js`, which forwards the signed-in
  person's token — the person is the actor, not the operator.
- The Go handler: `search_brain(query="<handler>", kind="function")` →
  `get_entity(function:tracewit/n2:api/http/<file>.go:<fn>)`. Read the
  query parameters and the response shape; do not guess them.

## 3. Find who else uses what you change

The brain does NOT hold import edges between the web app's files — a
JavaScript import resolves to a package node. `neighbourhood` on a web file
shows no importers. Use
`grep -rln "<module>" web/components web/lib web/app` and say that the
brain could not answer.

## 4. Attribution rules

- A node's source is what n2 recorded on it (`entity.sources`, e.g.
  `aws:810927266726`), through `sourceForEntity()` in
  `web/lib/dataSources.js`. Never its kind: AWS, Kubernetes and Datadog all
  produce `service`, `endpoint`, `ingress`. Never the cluster the person
  clicked through.
- A placeholder with no recorded source gets no badge, not a guess.
- To list one source's entities: `getNodes(kind, source.key)` →
  `/api/v1/nodes?kind=…&source=…`.

## 5. Verify

- Build: `docker compose up -d --build --no-deps web` — runs `next build`,
  which catches broken imports and JSX.
- Check the API AS THE PERSON'S ORGANISATION. An operator token reads
  `default` and will show data the person cannot see. Use the UI, or the
  person's `n2 login` credential from a script — never print it.
- Look at the page when the change is visual (ayna), and say so when you
  did not.

## 6. Do not re-index by hand

The watcher `sh.kormo.n2.watch.tracewit-n2` (installed by
`n2 install --repo`) pushes every save within seconds into the org named in
`~/.n2/config`. A manual `code-walk` with a different `--repo` files the
same code a second time under another name.

After using this procedure, record the outcome:
`record_skill_run(skill_name="web-dev-workflow", outcome=…, notes=…)`.

---
After executing: record_skill_run(skill_name="web-dev-workflow", outcome="success/failure")
