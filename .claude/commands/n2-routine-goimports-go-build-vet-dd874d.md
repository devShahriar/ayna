---
description: "A routine agents here run again and again, learned from its repeated successful runs: `goimports -w {path}` → `go build {path_2}` → `go vet {path_3}`. In the agents' own words: facts, imports. Parameters: {path} (e.g. api/http/trace.go api/http/sessions.go, internal/skilllearn/routine_store.go, internal/contextgraph/gather.go internal/store/postgres/search_network.go; given by the asker); {path_2} (e.g. ./..., ./internal/skilllearn/, ./internal/store/postgres/; given by the asker); {path_3} (e.g. ./api/http/, ./internal/skilllearn/, ./pkg/reponame ./internal/codewatch ./cmd/mcp; given by the asker)."
---

# routine-goimports-go-build-vet-dd874d

Confidence: 0% (0 runs)


# Routine Goimports Go Build Vet Dd874d

A routine agents here run again and again, learned from its repeated successful runs: `goimports -w {path}` → `go build {path_2}` → `go vet {path_3}`. In the agents' own words: facts, imports. Parameters: {path} (e.g. api/http/trace.go api/http/sessions.go, internal/skilllearn/routine_store.go, internal/contextgraph/gather.go internal/store/postgres/search_network.go; given by the asker); {path_2} (e.g. ./..., ./internal/skilllearn/, ./internal/store/postgres/; given by the asker); {path_3} (e.g. ./api/http/, ./internal/skilllearn/, ./pkg/reponame ./internal/codewatch ./cmd/mcp; given by the asker).

## When to use

the work is to facts, imports — or the next command is `goimports -w {path}`

## Steps

1. Run `goimports -w {path}`
2. Run `go build {path_2}`
3. Run `go vet {path_3}`

## Done when

- the last step (go vet) exits ok, as it did in every run this was learned from

_Learned from repeated runs; not yet proven here — report the outcome when you use it._

---
After executing: record_skill_run(skill_name="routine-goimports-go-build-vet-dd874d", outcome="success/failure")
