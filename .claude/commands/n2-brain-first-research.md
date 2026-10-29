---
description: "Answer questions about a codebase by querying n2 instead of reading files. Load this before you grep, before you open a file to find out what it does, before you trace a call chain by hand, and before you tell anyone the brain has no data. Covers which call to make for which question, how to cross a repository boundary (grep cannot), and how to tell a retrieval miss from a genuine absence. Supersedes reading source as the default move; source is what you read once the brain has told you where to look."
---

# brain-first-research

Confidence: 0% (0 runs)


# Brain-first research

**Never read a source file to find out what it does until you have asked the
brain.**

Not a token-saving tip. Grep returns a string in a file. The brain returns the
function's body, its callers, the file and package it lives in, the service it
runs as, the routes it serves, and who edited it last — and it can answer across
repositories, which grep structurally cannot.

## Pick the call by the question

| Question | Call |
|---|---|
| "what is X / where is X" | `search_brain(query="X")` |
| "tell me everything about X" | `get_entity(id="...")` |
| "how does this repo fit together" | `get_code_context(service="repo-or-service")` |
| "what breaks if I change this" | `get_blast_radius(entity_id=...)` |
| "this repo is not in the brain" | `ingest_codebase(path="/abs/path")`, then ask |

## How to phrase a search

**One or two distinctive tokens beat a sentence.** Search ranks by term
overlap, so ubiquitous words — the product's own name, "service", "handler" —
pull in noise and can outrank the thing you asked for.

    good:  search_brain("StartSweeper")
    good:  search_brain("o2o-cart-order-store-my-ppe")
    poor:  search_brain("how does the dispatch reconciler claim staged rows")

Search first with the rarest token you know. Widen only if it misses.

## Crossing a repository boundary

A call graph stops at the module edge: one repo's function never resolves to
another repo's definition. Services meet on the **route**, not the symbol. To
follow a call from one service into another, walk the `api_endpoint` node:

    caller function --calls_target--> api_endpoint:POST /path --served_by--> handler

Both sides carry `file` and `line`. Note the tier: these edges are `claimed`,
not `observed` — the path names a route, not a host. Say so when you report it.

## Before you say "the brain has nothing"

That sentence is usually wrong, and it is expensive: it sends a person to do by
hand what was already indexed. Check three things first.

1. **Try the single rarest token alone.** Multi-word queries dilute.
2. **If you know the id, call `get_entity`** — it bypasses search entirely.
3. **Confirm the repo was ingested** with `get_code_context` before concluding.

If it really is absent, say which queries you tried. "I searched for X and Y and
found nothing" is a fact. "The brain does not know" is a claim you probably
cannot support.

## The walk: function, then file, then service

Three calls take you from a symbol to its runtime, and each answers a question
the previous one raised.

    get_entity("function:tracewit/n2:internal/correlation/engine.go:SweepAI")
      -> signature, full body, docstring, call graph, cross-source links

    get_entity("file:tracewit/n2:internal/correlation/engine.go")
      -> every function in the file, imports, owning repository

    get_entity("service:n2")
      -> pods, replicas, owning team, repository, recent commits, monitors

## Use this, not that

| To… | Call | Not |
|---|---|---|
| find a function | `search_brain(query="name")` | `grep -r "func name"` |
| read a function | `get_entity(id="function:…")` | `cat file.go` |
| see what calls what | `get_entity` → connections | `grep "functionName"` |
| check service health | `get_entity(id="service:…")` | `kubectl get pods` |
| understand a file | `get_entity(id="file:…")` | `cat file.go | head -50` |

The right-hand column is not forbidden — it is what you reach for AFTER the
brain has told you where to look, and what you reach for when the brain is
genuinely missing the repo.

## What the brain does not have

A function body is capped at **4KB**. When it comes back with `… truncated`,
that is your signal to open the file — you now know exactly which file and
which lines. That is the one routine case for reading source directly.

## The cost, concretely

Reading fifteen source files to understand a subsystem costs roughly 20K tokens
and gives you the code without the context — which service it runs as, what
calls it, what deployed last. The same understanding is three `get_entity` calls
and it arrives already correlated.

## When you are done

- Changed code? The watcher re-indexes within a minute; verify with
  `search_brain` rather than assuming.
- Used a skill? `record_skill_run(skill_name, outcome)` — it is how skills improve.
- Learned something non-obvious? `write_note(...)`. See `write-to-n2`.

## Read the file when

The brain has told you the file and line and you need the surrounding code to
make an edit; or you are editing and need exact current text. That is reading
with a destination, which is the point.

---
After executing: record_skill_run(skill_name="brain-first-research", outcome="success/failure")
