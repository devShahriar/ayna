---
description: "A routine agents here run again and again, learned from its repeated successful runs: `goimports -w {path}` → `gofmt {value} {path_2}` → `go vet {path_3}`. In the agents' own words: imports. Parameters: {path} (e.g. internal/kindlearn/kindlearn.go, api/http/trace.go api/http/sessions.go; given by the asker); {path_2} (e.g. internal/kindlearn/kindlearn.go, api/http/trace.go api/http/sessions.go, internal/skilllearn; given by the asker); {value} (e.g. -w, -l; given by the asker); {path_3} (e.g. ./api/http/, ./internal/skilllearn/; given by the asker)."
---

# routine-goimports-gofmt-go-vet-9df02e

Confidence: 0% (0 runs)


# Routine Goimports Gofmt Go Vet 9df02e

A routine agents here run again and again, learned from its repeated successful runs: `goimports -w {path}` → `gofmt {value} {path_2}` → `go vet {path_3}`. In the agents' own words: imports. Parameters: {path} (e.g. internal/kindlearn/kindlearn.go, api/http/trace.go api/http/sessions.go; given by the asker); {path_2} (e.g. internal/kindlearn/kindlearn.go, api/http/trace.go api/http/sessions.go, internal/skilllearn; given by the asker); {value} (e.g. -w, -l; given by the asker); {path_3} (e.g. ./api/http/, ./internal/skilllearn/; given by the asker).

## When to use

the work is to imports — or the next command is `goimports -w {path}`

## Steps

1. Run `goimports -w {path}`
2. Run `gofmt {value} {path_2}`
3. Run `go vet {path_3}`

## Done when

- the last step (go vet) exits ok, as it did in every run this was learned from

_Learned from repeated runs; not yet proven here — report the outcome when you use it._

---
After executing: record_skill_run(skill_name="routine-goimports-gofmt-go-vet-9df02e", outcome="success/failure")
