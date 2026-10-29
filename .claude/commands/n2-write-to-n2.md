---
description: "Put what you learned back into the brain so the next agent does not rediscover it. Covers the one endpoint everything enters through, which call to use for a finding, a document, a codebase or a reusable procedure, and what makes a write actually correlate instead of landing as an orphan. Load this when you finish something non-obvious, when a person tells you a fact worth keeping, when you read a repo the brain does not have, or when you catch yourself about to explain the same thing twice."
---

# write-to-n2

Confidence: 0% (0 runs)


# Writing to n2

Everything enters through one door — `POST /api/v1/ingest`. Agents, kormo and
n2's own code walker all post to it, and all get the same treatment behind it:
provider processing, identity resolution, cross-source correlation, mention
extraction, embedding, evidence tier. **There is no privileged path.** What you
write is a first-class citizen of the graph.

## Which call

| You have | Call |
|---|---|
| a finding, decision or correction | `write_note(thread, text, tags)` |
| a repository the brain lacks | `ingest_codebase(path="/abs/path")` |
| a procedure worth reusing | `submit_skill_candidate(...)` |
| used a skill and it worked/failed | `record_skill_run(skill_name, outcome)` |

## What makes a write correlate

Correlation joins on **identifiers**, not on prose. A note that says "the
dispatcher was losing work" links to nothing. A note that names
`pkg/agent/dispatcher.go`, `agent_invocations`, `StartSweeper` links to all
three, because the mention extractor resolves those tokens to nodes.

So: **name things by their real identifiers.** Service names, file paths,
function names, table names, entity ids. Write the sentence you would want to
find later, containing the words you would search for.

## What is worth writing

- A fact that took work to establish — a measurement, a root cause, a number.
- A belief that turned out to be **wrong**, and what is true instead. This is
  the highest-value write: it stops the next agent repeating a dead end.
- A decision and the reason, so it is not relitigated.

## What is not

- Restating what the code already says. The walker has the code.
- Narrating progress. A note is for a conclusion, not a status.
- Anything you have not verified. A confident wrong note is worse than silence,
  because the next agent will trust it.

## Correcting, not appending

If you find an earlier note is wrong, write the correction and say plainly that
it supersedes the earlier claim, naming the same identifiers. Retrieval will
surface both; make sure the reader can tell which is current.

---
After executing: record_skill_run(skill_name="write-to-n2", outcome="success/failure")
