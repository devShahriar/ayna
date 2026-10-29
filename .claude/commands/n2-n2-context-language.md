---
description: "Reading and emitting n2:// URIs — the reference format Tracewit uses to address entities, context packs, signals, skills, distilled sessions and their artifacts, and source-anchored citations across the brain. Load this once at session start; from then on, treat any n2:// reference as a citation-grade pointer that can be resolved on demand via the `expand` MCP tool or GET /api/v1/context/uri."
---

# n2-context-language

Confidence: 0% (0 runs)



# n2:// — the context-language for agents

You are reading and writing Tracewit URIs. A URI is one string that
names exactly one thing in the brain.

**A URI is not a compression trick.** Measured with a real tokenizer,
`n2://entity/service:checkout-svc:prod` is 11 tokens and "the checkout
service in prod" is 5 — a URI costs about 40% MORE than the prose it
replaces (docs/N2_URI_SPEC.md §6.1). Use one anyway, for the four
things prose cannot do:

- **Identity** — it names one node, not whichever the reader guesses.
- **Dereferenceability** — anyone can resolve it later, exactly.
- **Deferral** — 13 tokens instead of the 1,788-token body, for every
  reference you mention but do not need to reason about. This is where
  the context actually gets saved.
- **Citation** — an audit entry or review comment that a human can check.

## The grammar (memorise this)

```
n2://<scope>/<path>[?<query>][#<fragment>]
```

Scopes (the first segment) tell you what kind of thing the URI points
at:

| Scope    | What it points at                          | Example                                               |
|----------|--------------------------------------------|-------------------------------------------------------|
| `entity` | A graph entity by id                       | `n2://entity/service:checkout-svc:prod`               |
| `ctx`    | A context pack (community + entity)        | `n2://ctx/comm:a4f2/service:cart?depth=2`             |
| `prd`    | A product requirements document            | `n2://prd/247?t=2026-04-12`                           |
| `slack`  | A slack channel / message / thread         | `n2://slack/checkout/2026-05-08#thread-3142`          |
| `code`   | A code file (optionally a line range)      | `n2://code/svc/pricing.go#L84`                        |
| `linear` | A linear issue                             | `n2://linear/ABC-123`                                 |
| `github` | A github PR / issue                        | `n2://github/acme/payments/pulls/9`                   |
| `search` | A search query                             | `n2://search?q=who+deploys+checkout&limit=10`         |
| `signal` | A signal in the bus                        | `n2://signal/abc123def`                               |
| `skill`  | A skill in the registry                    | `n2://skill/grafana/dashboard@v3`                     |
| `session` | A captured, distilled agent session       | `n2://session/claude_3f2a91c4`                        |
| `decision` `plan` `finding` `result` `mistake` `guardrail` `session_skill` | One artifact a session produced | `n2://finding/claude_3f2a91c4/fluent-bit-oomkilled-0` |

Reserved query parameters (the same meaning across scopes that accept them):

| Param    | Meaning                                                  | Example                              |
|----------|----------------------------------------------------------|--------------------------------------|
| `t`      | Temporal cursor (absolute or relative)                   | `?t=2026-05-08T15:30:00Z`, `?t=-2h`  |
| `depth`  | Expansion depth (0..3)                                   | `?depth=2`                           |
| `facets` | Section allowlist (csv)                                  | `?facets=deploys,errors,owners`      |
| `q`      | Free-form query (search scope only)                      | `?q=incidents+last+24h`              |
| `limit`  | Result limit (search scope only)                         | `?limit=10`                          |

Fragments are scope-specific:

- `code` → `L<n>` or `L<n>-L<m>` for line ranges (`#L84`, `#L84-L120`)
- `slack` → `thread-<id>` for a specific thread (`#thread-3142`)
- `prd` → section anchor (`#section-3`)
- `linear` / `github` → comment id

## When to emit a URI vs when to expand

**Emit a URI when:**
- Citing an entity in your output: write `n2://entity/service:cart`, not "the cart service".
- Handing work to another agent: the session URI is the handoff (see below).
- Passing a reference to another agent: URIs are cheap to send, decode, and re-cite.
- Returning structured findings: each finding's `location` field should be a URI.
- Saving a session cursor: "continue from `n2://...`" is one token.

**Expand a URI (call `tool:n2.expand`) when:**
- You need to reason about the entity's properties to answer a question.
- You're comparing two entities and need their attributes side-by-side.
- The URI's depth is 0 but you need 1-hop neighbours.

**Do NOT expand a URI when:**
- The URI is purely a reference you're forwarding (not reasoning over).
- The URI is in an audit / citation list (the body would just be noise).
- The same URI was already expanded earlier in this session.

## How to expand

Two equivalent ways:

1. **Via tool call** (preferred if you have MCP — the tool is named
   `expand`):
   ```
   expand(uri="n2://entity/service:cart-svc:prod", depth=1)
   ```

2. **Via HTTP** (use this if you have shell/curl):
   ```
   GET /api/v1/context/uri?uri=n2://entity/service:cart-svc:prod&depth=1
   ```

Both return the same JSON shape:

```json
{
  "uri": "n2://entity/service:cart-svc:prod",
  "scope": "entity",
  "kind": "entity",
  "body": {
    "entity_id": "service:cart-svc:prod",
    "entity_kind": "service",
    "name": "cart-svc",
    "properties": { ... },
    "page": { ... },     // if depth >= 1 and pages are wired
    "neighbors": [ ... ] // if depth >= 2
  },
  "hash": "<sha256-of-body>",
  "expires_at": "<rfc3339>"
}
```

The `hash` is the cache key — two resolves with identical results
share a hash, so you can dedupe references and cache locally.

## Three worked examples

### Example 1 — citing a code location

A user asks "where is the discount logic?" After investigation:

**Bad** (verbose, hard to cite):
> The discount logic lives in pricing.go, around line 84, in the
> checkout service repository.

**Good** (compact, citation-grade):
> Discount logic: `n2://code/acme/checkout-svc/pricing.go#L84`

(This is longer in tokens than the prose. It is worth it because the
next reader can resolve it, and the prose version needs a search.)

### Example 2 — cross-source design integrity review

You are reviewing a PR. The PR adds a 15% discount. You discover that
PRD-247 said 15%, but a Slack thread on 2026-05-08 reversed it to 10%.

**Output** (citation-grade):
```
Recommendation: confirm with @pm-checkout before merge.
Discrepancy:
  PRD declared:   n2://prd/247@2026-04-12
  Slack reversed: n2://slack/checkout/2026-05-08#thread-3142
  PR implements:  n2://code/acme/checkout-svc/pricing.go#L84
```

Three URIs name three exact things. They are not shorter than the three
sentences — they are checkable, which the sentences are not.

### Example 3 — handoff between agents

You complete a triage; pass the context to the SRE on-call:

**Bad**: paste a 2KB summary.

**Good**: 
```
Triage context: n2://ctx/comm:checkout/incident:INC-2026-05-08?depth=2
Next steps:
  - n2://linear/SRE-441 (root cause investigation)
  - n2://signal/0abc...def (the originating page event)
```

The receiving agent loads the same `skill:n2:context-language` and
expands what it needs.

## The session knowledge graph

A captured session is distilled into a subgraph: a `session` node with
typed artifacts (`decision`, `plan`, `finding`, `result`, `mistake`,
`guardrail`, `session_skill`), each correlated into the code, pods and
services it touched. Every one of those has an address.

```
n2://session/<session_id>                 → the whole session
n2://<artifact-kind>/<session_id>/<slug>  → one artifact
```

The ids the graph returns map mechanically: the inductor mints
`finding:claude_3f2a91c4:oomkilled-0`, and the URI is
`n2://finding/claude_3f2a91c4/oomkilled-0` — same parts, `/` instead of
`:`. `GET /api/v1/sessions/{id}/graph` now returns the `uri` on the
response and on every node, so you rarely need to build one by hand.

This is the scope that matters most for handoff, because a distilled
session exists to be handed on:

```
Picking up from: n2://session/claude_3f2a91c4
The one that matters: n2://finding/claude_3f2a91c4/fluent-bit-oomkilled-0
```

Expand the session at `depth=2` to get the artifacts WITH the code and
pods they were correlated against. Everything the session points at — a
file, a pod, a service — keeps its ordinary `n2://entity/<id>` address.

## Common mistakes to avoid

1. **Don't paraphrase URIs.** If you see `n2://entity/service:cart` in
   the input, refer to it as `n2://entity/service:cart`, not "the
   cart entity". Stability of references across turns is the whole
   point.

2. **Don't invent URIs.** Only emit URIs whose entity ids you've
   actually seen or that are obvious from a source shortcut
   translation (e.g. `n2://prd/247` is fine if you saw "PRD-247" in
   the input). When in doubt, search first.

3. **Don't expand prophylactically.** This is the ONLY thing that
   saves context — a URI you forward unexpanded costs 13 tokens
   instead of the ~1,800 its body would. Expand only when you need
   the body to answer the question. Forwarding, citing, and listing
   don't need expansion.

4. **Don't confuse the brain's URIs with the LLM's web URLs.** A URI
   starting with `n2://` always resolves through the Tracewit brain.
   A URI starting with `https://` does not.

## Round-trip rules (when emitting URIs from data you have)

If you have an entity id, you can construct the URI:

| Entity kind         | URI form                                              |
|---------------------|-------------------------------------------------------|
| `service:<name>`    | `n2://entity/service:<name>` or with env suffix       |
| `repository:<name>` | `n2://entity/repository:<name>`                       |
| `incident:<id>`     | `n2://entity/incident:<id>`                           |
| `skill:<src>:<type>`| `n2://skill/<src>/<type>` (drops the leading `skill:`)|
| `doc:prd:<id>`      | `n2://prd/<id>` (shortcut)                            |
| `file:<repo>/<path>`| `n2://code/<repo>/<path>`                             |
| `session:<id>`      | `n2://session/<id>`                                   |
| `finding:<sid>:<slug>` | `n2://finding/<sid>/<slug>` (same for decision, plan, result, mistake, guardrail, session_skill) |

Use source shortcuts when they make the citation more readable; use
the `entity` scope when you're addressing something programmatically
or when you don't know the shortcut.

## End of skill

You now know enough to read and emit n2:// URIs. From this point in
the session, prefer URIs over prose whenever you're naming a thing
in the brain. The brain handles the expansion — your job is to be
a precise citizen of the protocol.

---
After executing: record_skill_run(skill_name="n2-context-language", outcome="success/failure")
