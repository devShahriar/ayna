---
description: "A routine agents here run again and again, learned from its repeated successful runs: `go` → `cd ~/tracewit/n2 && export PATH=$HOME/.orbstack/bin:$PATH && gofmt -d pkg/brain/brain.go` → `go test -count=1 -run 'TestTheBriefNamesThisClient|TestTheAskHook|TestTheStopHook|TestTwoSessions|TestNoWord|TestANewSession' ./cmd/mcp/`. In the agents' own words: test."
---

# routine-go-gofmt-test-fac796

Confidence: 0% (0 runs)


# Routine Go Gofmt Test Fac796

A routine agents here run again and again, learned from its repeated successful runs: `go` → `cd ~/tracewit/n2 && export PATH=$HOME/.orbstack/bin:$PATH && gofmt -d pkg/brain/brain.go` → `go test -count=1 -run 'TestTheBriefNamesThisClient|TestTheAskHook|TestTheStopHook|TestTwoSessions|TestNoWord|TestANewSession' ./cmd/mcp/`. In the agents' own words: test.

## When to use

the work is to test — or the next command is `go`

## Steps

1. Run `go`
2. Run `cd ~/tracewit/n2 && export PATH=$HOME/.orbstack/bin:$PATH && gofmt -d pkg/brain/brain.go`
3. Run `go test -count=1 -run 'TestTheBriefNamesThisClient|TestTheAskHook|TestTheStopHook|TestTwoSessions|TestNoWord|TestANewSession' ./cmd/mcp/`

## Done when

- the last step (go test) exits ok, as it did in every run this was learned from

_Learned from repeated runs; not yet proven here — report the outcome when you use it._

---
After executing: record_skill_run(skill_name="routine-go-gofmt-test-fac796", outcome="success/failure")
