---
description: "A routine agents here run again and again, learned from its repeated successful runs: `cd {path_2} && ./be-sj skilljudge -dsn 'postgres://n2:n2@localhost:5433/n2?sslmode=disable' -tenant org_418dfae0d3bdc1ac -days 60` → `go build {path}`. In the agents' own words: judge, replay, guard, redeploy. Parameters: {path} (e.g. ./internal/skilljudge/, ./internal/judge/ ./internal/skilljudge/, ./...; given by the asker); {path_2} (e.g. /private/tmp/claude-501/-Users-shahriar-Tekton/<a uuid>/scratchpad; given by the asker)."
---

# routine-be-sj-skilljudge-go-build-ee3607

Confidence: 0% (0 runs)


# Routine Be Sj Skilljudge Go Build Ee3607

A routine agents here run again and again, learned from its repeated successful runs: `cd {path_2} && ./be-sj skilljudge -dsn 'postgres://n2:n2@localhost:5433/n2?sslmode=disable' -tenant org_418dfae0d3bdc1ac -days 60` → `go build {path}`. In the agents' own words: judge, replay, guard, redeploy. Parameters: {path} (e.g. ./internal/skilljudge/, ./internal/judge/ ./internal/skilljudge/, ./...; given by the asker); {path_2} (e.g. /private/tmp/claude-501/-Users-shahriar-Tekton/<a uuid>/scratchpad; given by the asker).

## When to use

the work is to judge, replay, guard, redeploy — or the next command is `cd {path_2} && ./be-sj skilljudge -dsn 'postgres://n2:n2@localhost:5433/n2?sslmode=disable' -tenant org_418dfae0d3bdc1ac -days 60`

## Steps

1. Run `cd {path_2} && ./be-sj skilljudge -dsn 'postgres://n2:n2@localhost:5433/n2?sslmode=disable' -tenant org_418dfae0d3bdc1ac -days 60`
2. Run `go build {path}`

## Done when

- the last step (go build) exits ok, as it did in every run this was learned from

_Learned from repeated runs; not yet proven here — report the outcome when you use it._

---
After executing: record_skill_run(skill_name="routine-be-sj-skilljudge-go-build-ee3607", outcome="success/failure")
