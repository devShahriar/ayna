---
description: "What n2 is to you and the three things you do with it — look things up instead of reading files, write down what you learned, and get your state back after a compaction. Load this ONCE when you connect to a brain. It is a map, not a manual: it names the other skills and when to load each, so you carry two pages instead of twenty. Load it whenever you are about to grep a repository, open a file to find out what it does, say \"the brain does not seem to have that\", or start a session that continues earlier work."
---

# using-n2

Confidence: 0% (0 runs)


# Using n2

n2 is a graph of everything this environment knows — source code with full
bodies, running infrastructure, traces, documents, and the sessions of every
agent and person who worked here. You reach it over MCP.

It is three things to you, and they are separate skills. **Load only the one
you need.**

| You are about to… | Load |
|---|---|
| read a file, grep, or explore a repo to find out how something works | `brain-first-research` |
| finish something worth another agent knowing | `write-to-n2` |
| continue earlier work, or your context is about to compact | `n2-as-memory` |
| read or emit an `n2://` reference | `n2-context-language` |

## The one rule that matters most

**Ask the brain before you open the file.**

It is not a style preference, it is accuracy. The graph is indexed within a
minute of an edit and holds the function's body, its callers, the service it
runs in and the route it serves. Grep gives you a string in a file and none of
the rest — and it cannot cross a repository boundary at all, which is exactly
where the interesting answers are.

## Four calls cover most of it

- `search_brain(query)` — find it. One or two distinctive words beat a sentence.
- `get_entity(id)` — everything known about one thing, from every source.
- `get_code_context(service)` — a repo's files, functions and call graph.
- `ingest_codebase(path)` — the repo is not in the brain yet. Do this first, then ask.

## When the brain looks empty, check before believing it

An empty answer is usually a retrieval miss, not an absent fact. Before you
conclude n2 does not know:

1. Try the single most distinctive token on its own — a function name, a service
   name — rather than a phrase.
2. If you know the id, call `get_entity` directly; it does not go through search.
3. If it is a repo, confirm it was ingested (`get_code_context`) before assuming.

Telling a person "the brain has nothing on that" when it does is worse than
saying nothing. Say which query you tried.

## What you owe back

The brain is only as good as what the last agent left in it. When you learn
something another agent would have to rediscover, write it down — that is
`write-to-n2`, and it takes one call.

---
After executing: record_skill_run(skill_name="using-n2", outcome="success/failure")
