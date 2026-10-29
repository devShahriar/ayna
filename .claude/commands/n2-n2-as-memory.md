---
description: "Use n2 as the memory your context window is not. Covers getting your state back after a compaction, picking up a session someone else started, and what to dump before your window is trimmed so nothing is lost. Load this at the start of a session that continues earlier work, when you are told your context is about to compact, when you cannot remember a decision you know was made, or when you are handing work to another agent or harness."
---

# n2-as-memory

Confidence: 0% (0 runs)


# n2 as memory

Your context window forgets. The brain does not. Compaction is only lossless if
the thing that mattered was written down BEFORE the window was trimmed — so the
work is in the dumping, not the recovery.

## Getting your state back

    pull_session(refresh=true)

Returns this session's distilled decisions, findings, plans and touched
entities as a bounded digest — not a transcript replay. Call it right after a
compaction, and at the start of a session that continues earlier work.

To pick up someone else's: `list_sessions()` to find it, then `pull_session`
with its id.

## Before your window is trimmed

Dump anything not already in the graph:

    write_note(thread="<session>", tags="context_dump",
               text="what you built, files changed, decisions, what is next")

Write it as facts with real identifiers — file paths, function names, entity
ids — not as narrative. The digest you get back later is only as good as the
nouns you put in.

## What to keep out of the note

Whatever the graph already holds. The walker has the code, the hook has the
tool calls, the tailer has the conversation. Duplicating them costs tokens on
the way out and on the way back. Write the things that exist **only in your
head**: why you chose this over that, what you ruled out, what you would do
next.

## Handing off

A handoff is the same note with one addition: say what is unfinished and what
the next agent should NOT redo. The most expensive thing a fresh agent does is
repeat a ruled-out approach because nobody recorded that it was ruled out.

## Memory is shared, so mark uncertainty

Humans and other agents read these notes. If something is a guess, label it a
guess. A note read six weeks later carries no tone — only what it literally
says.

---
After executing: record_skill_run(skill_name="n2-as-memory", outcome="success/failure")
