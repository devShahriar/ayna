---
description: "A routine agents here run again and again, learned from its repeated successful runs: `cd {path_2} && git stash push {path} -q` → `N2_TEST_DB='postgres://n2:n2@localhost:5433/n2_t_routines?sslmode=disable' timeout {number} go test -p 1 -count=1 -v -run 'TestALongSession' ./internal/skilllearn/` → `git stash pop -q`. In the agents' own words: code, test, fails, prove. Parameters: {path} (e.g. internal/identity/, internal/identity/harvest.go, internal/skilllearn/store.go internal/skilllearn/routine_store.go; given by the asker); {path_2} (e.g. ~/tracewit/n2, ~/tracewit/n2-wt-i-routines; given by the asker); {number} (e.g. 200, 250; given by the asker)."
---

# routine-git-stash-push-n2-test-db-go-pop-a85eba

Confidence: 0% (0 runs)


# Routine Git Stash Push N2 Test Db Go Pop A85eba

A routine agents here run again and again, learned from its repeated successful runs: `cd {path_2} && git stash push {path} -q` → `N2_TEST_DB='postgres://n2:n2@localhost:5433/n2_t_routines?sslmode=disable' timeout {number} go test -p 1 -count=1 -v -run 'TestALongSession' ./internal/skilllearn/` → `git stash pop -q`. In the agents' own words: code, test, fails, prove. Parameters: {path} (e.g. internal/identity/, internal/identity/harvest.go, internal/skilllearn/store.go internal/skilllearn/routine_store.go; given by the asker); {path_2} (e.g. ~/tracewit/n2, ~/tracewit/n2-wt-i-routines; given by the asker); {number} (e.g. 200, 250; given by the asker).

## When to use

the work is to code, test, fails, prove — or the next command is `cd {path_2} && git stash push {path} -q`

## Steps

1. Run `cd {path_2} && git stash push {path} -q`
2. Run `N2_TEST_DB='postgres://n2:n2@localhost:5433/n2_t_routines?sslmode=disable' timeout {number} go test -p 1 -count=1 -v -run 'TestALongSession' ./internal/skilllearn/`
3. Run `git stash pop -q`

## Done when

- the last step (git stash pop) exits ok, as it did in every run this was learned from

_Learned from repeated runs; not yet proven here — report the outcome when you use it._

---
After executing: record_skill_run(skill_name="routine-git-stash-push-n2-test-db-go-pop-a85eba", outcome="success/failure")
