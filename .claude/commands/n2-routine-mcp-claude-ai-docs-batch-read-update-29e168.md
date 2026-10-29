---
description: "A routine agents here run again and again, learned from its repeated successful runs: mcp:claude_ai_Claude_Docs/batch `batch=<array> container=<object>` → mcp:claude_ai_Claude_Docs/read `container=<object> engine={engine} payload=<object> ref=<object>` → mcp:claude_ai_Claude_Docs/update `container=<object> engine=prose payload=<object> ref=<object>`. Parameters: {engine} (e.g. prose, widget; given by the asker)."
---

# routine-mcp-claude-ai-docs-batch-read-update-29e168

Confidence: 0% (0 runs)


# Routine Mcp Claude Ai Docs Batch Read Update 29e168

A routine agents here run again and again, learned from its repeated successful runs: mcp:claude_ai_Claude_Docs/batch `batch=<array> container=<object>` → mcp:claude_ai_Claude_Docs/read `container=<object> engine={engine} payload=<object> ref=<object>` → mcp:claude_ai_Claude_Docs/update `container=<object> engine=prose payload=<object> ref=<object>`. Parameters: {engine} (e.g. prose, widget; given by the asker).

## When to use

the next command is mcp:claude_ai_Claude_Docs/batch `batch=<array> container=<object>`

## Steps

1. mcp:claude_ai_Claude_Docs/batch `batch=<array> container=<object>`
2. mcp:claude_ai_Claude_Docs/read `container=<object> engine={engine} payload=<object> ref=<object>`
3. mcp:claude_ai_Claude_Docs/update `container=<object> engine=prose payload=<object> ref=<object>`

## Done when

- the last step (mcp:claude_ai_Claude_Docs/update) exits ok, as it did in every run this was learned from

_Learned from repeated runs; not yet proven here — report the outcome when you use it._

---
After executing: record_skill_run(skill_name="routine-mcp-claude-ai-docs-batch-read-update-29e168", outcome="success/failure")
