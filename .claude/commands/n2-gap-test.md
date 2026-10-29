---
description: "Test fixture for the gap-handling path in load_procedural_skill. This skill deliberately references a resource (tool:acme-cli) that does NOT have a tool node in the graph, so the runtime returns a gap stub with execution-policy override requiring human approval. Use this only for runtime validation, never for real operations."
---

# gap-test

Confidence: 100% (1 runs)


# Gap handling test skill

This is a deliberately-gapped test fixture. It is not for real operations.

## What it tests

The runtime's handling of missing resources when `load_procedural_skill` is
called:

1. `tool:kubectl` should be returned as a **known** resource with the full
   tool node bundled in the response (status `known`, confidence > 0).
2. `tool:acme-cli` should be returned as a **gap** stub with empty
   breadcrumbs, status `gap`, and confidence 0 — because no such tool node
   exists in the graph.
3. The response's `execution_policy` should include `tool:acme-cli` in
   `approval_required_for_resources`, meaning any agent loading this skill
   is told to pause for human approval before acting on anything that
   depends on `acme-cli`.

## Expected call

```
load_procedural_skill(name="gap-test")
```

No `agent_id` is needed for this test since the skill doesn't enforce
capability matching when no agent is passed — it just inspects the
resolution behavior of `uses_resources`.

## What a passing test looks like

The response body should contain:

```json
{
  "skill": { "name": "gap-test", "uses_resources": ["tool:acme-cli", "tool:kubectl"] },
  "resources": {
    "tool:acme-cli": { "status": "gap", "confidence": 0.0, "notice": "..." },
    "tool:kubectl":  { "status": "known", "confidence": 0.95, "name": "kubectl" }
  },
  "execution_policy": {
    "default_approval_required": true,
    "approval_required_for_resources": ["tool:acme-cli"],
    "reason": "one or more referenced resources are not documented..."
  },
  "gap_count": 1
}
```

If any of those four assertions fail, the runtime's gap handling is broken.

---
After executing: record_skill_run(skill_name="gap-test", outcome="success/failure")
