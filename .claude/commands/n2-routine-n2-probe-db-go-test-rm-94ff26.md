---
description: "A routine agents here run again and again, learned from its repeated successful runs: `N2_PROBE_DB='postgres://n2:n2@localhost:5433/n2?sslmode=disable' go test -count=1 -v -timeout {timeout} -run {run} ./internal/skilllearn/` → `rm {path}`. In the agents' own words: checks, probe, verdict. Parameters: {timeout} (e.g. 300s, 120s; given by the asker); {run} (e.g. TestProbeVerdictChecksLive, TestProbeAnswerBacking, TestProbeProcScripts; given by the asker); {path} (e.g. internal/skilllearn/zz_probe_conclusion_test.go, internal/skilllearn/zz_probe_proc_test.go, internal/skilllearn/zz_probe_verdict_test.go; given by the asker)."
---

# routine-n2-probe-db-go-test-rm-94ff26

Confidence: 0% (0 runs)


# Routine N2 Probe Db Go Test Rm 94ff26

A routine agents here run again and again, learned from its repeated successful runs: `N2_PROBE_DB='postgres://n2:n2@localhost:5433/n2?sslmode=disable' go test -count=1 -v -timeout {timeout} -run {run} ./internal/skilllearn/` → `rm {path}`. In the agents' own words: checks, probe, verdict. Parameters: {timeout} (e.g. 300s, 120s; given by the asker); {run} (e.g. TestProbeVerdictChecksLive, TestProbeAnswerBacking, TestProbeProcScripts; given by the asker); {path} (e.g. internal/skilllearn/zz_probe_conclusion_test.go, internal/skilllearn/zz_probe_proc_test.go, internal/skilllearn/zz_probe_verdict_test.go; given by the asker).

## When to use

the work is to checks, probe, verdict — or the next command is `N2_PROBE_DB='postgres://n2:n2@localhost:5433/n2?sslmode=disable' go test -count=1 -v -timeout {timeout} -run {run} ./internal/skilllearn/`

## Steps

1. Run `N2_PROBE_DB='postgres://n2:n2@localhost:5433/n2?sslmode=disable' go test -count=1 -v -timeout {timeout} -run {run} ./internal/skilllearn/`
2. Run `rm {path}`

## Done when

- the last step (rm) exits ok, as it did in every run this was learned from

_Learned from repeated runs; not yet proven here — report the outcome when you use it._

---
After executing: record_skill_run(skill_name="routine-n2-probe-db-go-test-rm-94ff26", outcome="success/failure")
