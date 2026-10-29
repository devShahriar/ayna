---
description: "A routine agents here run again and again, learned from its repeated successful runs: `cd {path} && N2_UPDATE_CATALOGUE=1 go test -count=1 {value} {value_2} {value_3}` → `go test -count=1 {value} {value_2} {value_4}` → `go test -count=1 {count_3}`. In the agents' own words: catalogue, tool, regenerate. Parameters: {path} (e.g. ~/tracewit/n2, ~/tracewit/n2-wt/dogfood; given by the asker); {value} (e.g. -run, ./cmd/mcp; given by the asker); {value_2} (e.g. TestBuiltinToolCatalogueIsCurrent, -run; given by the asker); {value_3} (e.g. ./cmd/mcp/, TestBuiltinToolCatalogueIsCurrent; given by the asker); {value_4} (e.g. ./cmd/mcp/, TestEveryDispatchedToolIsReachable; given by the asker); {count_3} (e.g. ./internal/mcp/ ./pkg/brain/ ./internal/processor/, ./cmd/mcp ./internal/mcp; given by the asker)."
---

# routine-n2-update-catalogue-go-test-5ebebb

Confidence: 0% (0 runs)


# Routine N2 Update Catalogue Go Test 5ebebb

A routine agents here run again and again, learned from its repeated successful runs: `cd {path} && N2_UPDATE_CATALOGUE=1 go test -count=1 {value} {value_2} {value_3}` → `go test -count=1 {value} {value_2} {value_4}` → `go test -count=1 {count_3}`. In the agents' own words: catalogue, tool, regenerate. Parameters: {path} (e.g. ~/tracewit/n2, ~/tracewit/n2-wt/dogfood; given by the asker); {value} (e.g. -run, ./cmd/mcp; given by the asker); {value_2} (e.g. TestBuiltinToolCatalogueIsCurrent, -run; given by the asker); {value_3} (e.g. ./cmd/mcp/, TestBuiltinToolCatalogueIsCurrent; given by the asker); {value_4} (e.g. ./cmd/mcp/, TestEveryDispatchedToolIsReachable; given by the asker); {count_3} (e.g. ./internal/mcp/ ./pkg/brain/ ./internal/processor/, ./cmd/mcp ./internal/mcp; given by the asker).

## When to use

the work is to catalogue, tool, regenerate — or the next command is `cd {path} && N2_UPDATE_CATALOGUE=1 go test -count=1 {value} {value_2} {value_3}`

## Steps

1. Run `cd {path} && N2_UPDATE_CATALOGUE=1 go test -count=1 {value} {value_2} {value_3}`
2. Run `go test -count=1 {value} {value_2} {value_4}`
3. Run `go test -count=1 {count_3}`

## Done when

- the last step (go test) exits ok, as it did in every run this was learned from

_Learned from repeated runs; not yet proven here — report the outcome when you use it._

---
After executing: record_skill_run(skill_name="routine-n2-update-catalogue-go-test-5ebebb", outcome="success/failure")
