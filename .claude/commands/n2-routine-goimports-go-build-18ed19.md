---
description: "A routine agents here run again and again, learned from its repeated successful runs: `goimports -w {path}` → `go build {path_2}`. Parameters: {path} (e.g. internal/contextgraph/gather.go, internal/contextgraph/gather.go internal/store/postgres/search_network.go, internal/mcp/server.go; given by the asker); {path_2} (e.g. ./..., ./internal/store/postgres/; given by the asker)."
---

# routine-goimports-go-build-18ed19

Confidence: 0% (0 runs)


# Routine Goimports Go Build 18ed19

A routine agents here run again and again, learned from its repeated successful runs: `goimports -w {path}` → `go build {path_2}`. Parameters: {path} (e.g. internal/contextgraph/gather.go, internal/contextgraph/gather.go internal/store/postgres/search_network.go, internal/mcp/server.go; given by the asker); {path_2} (e.g. ./..., ./internal/store/postgres/; given by the asker).

## When to use

the next command is `goimports -w {path}`

## Steps

1. Run `goimports -w {path}`
2. Run `go build {path_2}`

## Done when

- the last step (go build) exits ok, as it did in every run this was learned from

_Learned from repeated runs; not yet proven here — report the outcome when you use it._

---
After executing: record_skill_run(skill_name="routine-goimports-go-build-18ed19", outcome="success/failure")
