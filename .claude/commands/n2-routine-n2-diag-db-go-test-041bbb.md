---
description: "A routine agents here run again and again, learned from its repeated successful runs: `N2_DIAG_DB='postgres://n2:n2@localhost:5433/n2?sslmode=disable' go test {path} -run {run} -count=1 -v`. In the agents' own words: check. Parameters: {run} (e.g. TestZZDiag, TestZZDiagSplit, ZZLive; given by the asker); {path} (e.g. ./internal/joinlearn/, ./internal/typesearch; given by the asker)."
---

# routine-n2-diag-db-go-test-041bbb

Confidence: 0% (0 runs)


# Routine N2 Diag Db Go Test 041bbb

A routine agents here run again and again, learned from its repeated successful runs: `N2_DIAG_DB='postgres://n2:n2@localhost:5433/n2?sslmode=disable' go test {path} -run {run} -count=1 -v`. In the agents' own words: check. Parameters: {run} (e.g. TestZZDiag, TestZZDiagSplit, ZZLive; given by the asker); {path} (e.g. ./internal/joinlearn/, ./internal/typesearch; given by the asker).

## When to use

the work is to check — or the next command is `N2_DIAG_DB='postgres://n2:n2@localhost:5433/n2?sslmode=disable' go test {path} -run {run} -count=1 -v`

## Steps

1. Run `N2_DIAG_DB='postgres://n2:n2@localhost:5433/n2?sslmode=disable' go test {path} -run {run} -count=1 -v`

## Done when

- the last step (N2_DIAG_DB= go test) exits ok, as it did in every run this was learned from

_Learned from repeated runs; not yet proven here — report the outcome when you use it._

---
After executing: record_skill_run(skill_name="routine-n2-diag-db-go-test-041bbb", outcome="success/failure")
