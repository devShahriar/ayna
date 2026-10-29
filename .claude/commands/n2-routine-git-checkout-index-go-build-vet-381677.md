---
description: "A routine agents here run again and again, learned from its repeated successful runs: `git checkout-index -a --prefix=${value}/` → `cd ${value_2} && go build {path}` → `go vet {path_2}`. In the agents' own words: staged, isolation, tree. Parameters: {value} (e.g. S, D; given by the asker); {value_2} (e.g. D, S; given by the asker); {path} (e.g. ./..., ./cmd/server/ ./cmd/mcp/ ./cmd/backfill-join-status/ ./internal/...; given by the asker); {path_2} (e.g. ./internal/tables/... ./internal/meaning/ ./api/http/ ./internal/mcp/ ./internal/gateway/, ./internal/departure/, ./internal/skilltrust ./internal/skillstatus ./internal/offers ./internal/skilllearn ./internal/fieldconcept ./api/http ./cmd/server; given by the asker)."
---

# routine-git-checkout-index-go-build-vet-381677

Confidence: 0% (0 runs)


# Routine Git Checkout Index Go Build Vet 381677

A routine agents here run again and again, learned from its repeated successful runs: `git checkout-index -a --prefix=${value}/` → `cd ${value_2} && go build {path}` → `go vet {path_2}`. In the agents' own words: staged, isolation, tree. Parameters: {value} (e.g. S, D; given by the asker); {value_2} (e.g. D, S; given by the asker); {path} (e.g. ./..., ./cmd/server/ ./cmd/mcp/ ./cmd/backfill-join-status/ ./internal/...; given by the asker); {path_2} (e.g. ./internal/tables/... ./internal/meaning/ ./api/http/ ./internal/mcp/ ./internal/gateway/, ./internal/departure/, ./internal/skilltrust ./internal/skillstatus ./internal/offers ./internal/skilllearn ./internal/fieldconcept ./api/http ./cmd/server; given by the asker).

## When to use

the work is to staged, isolation, tree — or the next command is `git checkout-index -a --prefix=${value}/`

## Steps

1. Run `git checkout-index -a --prefix=${value}/`
2. Run `cd ${value_2} && go build {path}`
3. Run `go vet {path_2}`

## Done when

- the last step (go vet) exits ok, as it did in every run this was learned from

_Learned from repeated runs; not yet proven here — report the outcome when you use it._

---
After executing: record_skill_run(skill_name="routine-git-checkout-index-go-build-vet-381677", outcome="success/failure")
