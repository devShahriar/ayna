---
description: "A routine agents here run again and again, learned from its repeated successful runs: `cd $W && N2_UPDATE_CATALOGUE=1 go test -count=1 -run TestBuiltinToolCatalogueIsCurrent ./cmd/mcp/` → `go test -count=1 {value} {value_2} {value_3}`. In the agents' own words: catalogue, regenerate, tool. Parameters: {value} (e.g. -run, ./cmd/mcp; given by the asker); {value_2} (e.g. TestBuiltinToolCatalogueIsCurrent, -run; given by the asker); {value_3} (e.g. ./cmd/mcp/, TestEveryDispatchedToolIsReachable; given by the asker)."
---

# routine-n2-update-catalogue-go-test-9a4e07

Confidence: 0% (0 runs)


# Routine N2 Update Catalogue Go Test 9a4e07

A routine agents here run again and again, learned from its repeated successful runs: `cd $W && N2_UPDATE_CATALOGUE=1 go test -count=1 -run TestBuiltinToolCatalogueIsCurrent ./cmd/mcp/` → `go test -count=1 {value} {value_2} {value_3}`. In the agents' own words: catalogue, regenerate, tool. Parameters: {value} (e.g. -run, ./cmd/mcp; given by the asker); {value_2} (e.g. TestBuiltinToolCatalogueIsCurrent, -run; given by the asker); {value_3} (e.g. ./cmd/mcp/, TestEveryDispatchedToolIsReachable; given by the asker).

## When to use

the work is to catalogue, regenerate, tool — or the next command is `cd $W && N2_UPDATE_CATALOGUE=1 go test -count=1 -run TestBuiltinToolCatalogueIsCurrent ./cmd/mcp/`

## Steps

1. Run `cd $W && N2_UPDATE_CATALOGUE=1 go test -count=1 -run TestBuiltinToolCatalogueIsCurrent ./cmd/mcp/`
2. Run `go test -count=1 {value} {value_2} {value_3}`

## Done when

- the last step (go test) exits ok, as it did in every run this was learned from

_Learned from repeated runs; not yet proven here — report the outcome when you use it._

---
After executing: record_skill_run(skill_name="routine-n2-update-catalogue-go-test-9a4e07", outcome="success/failure")
